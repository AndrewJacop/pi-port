// pi-port.ts — export/import pi agent configuration + cloud sync.
//
// Five commands:
//   /pi-port-local-export [path]     package ~/.pi/agent/ sections into a .pi-backup archive
//   /pi-port-local-import [path]     restore a .pi-backup (selectively, with path remap)
//   /pi-port-setup                   one-time-per-machine backend config via vsync
//   /pi-port-sync-conf               bidirectional sync of the global conf set (diff-first)
//   /pi-port-sync-sessions           per-project session sync (diff-first, push/pull)
//
// Local archives use the system `tar` binary (macOS/Linux in v0.1). Cloud
// sync drives the user's own global `vsync` CLI (vasari-sync) — never
// bundled, never interactive; pi's TUI collects everything first.

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { homedir, hostname, userInfo, platform } from "node:os";
import { join, resolve, dirname, basename } from "node:path";
import { mkdir, readFile, writeFile, stat } from "node:fs/promises";
import {
	type SectionId,
	getSection,
	detectSections,
	sectionSize,
} from "../lib/sections.ts";
import {
	createBackup,
	extractManifest,
	extractSections,
} from "../lib/archive.ts";
import {
	BINDINGS_FILENAME,
	sessionBucket,
	stagingConfig,
	stagingRoot,
	stagingSessions,
	listFiles,
} from "../lib/paths.ts";
import {
	bindLabel,
	labelForPath,
	loadBindings,
	saveBindings,
	validateLabel,
} from "../lib/bindings.ts";
import {
	addPaths,
	defaultRunner,
	ensureProject,
	ghLogin,
	ghRepos,
	meetsFloor,
	readTrackedPaths,
	vsyncVersion,
	VSYNC_MIN_VERSION,
	type StatusJson,
	type TransferJson,
	type VsyncError,
} from "../lib/vsync.ts";
import {
	applyConf,
	diffConf,
	diffSessions,
	stageConf,
	stageSession,
	restoreSession,
	type StageGate,
} from "../lib/stage.ts";

const STATE_FILE = join(homedir(), ".pi", "agent", "pi-port-state.json");

interface PortState {
	lastExportPath?: string;
	lastImportPath?: string;
}

async function loadState(): Promise<PortState> {
	try {
		return JSON.parse(await readFile(STATE_FILE, "utf8"));
	} catch {
		return {};
	}
}

async function saveState(s: PortState): Promise<void> {
	try {
		await mkdir(dirname(STATE_FILE), { recursive: true });
		await writeFile(STATE_FILE, JSON.stringify(s, null, 2), "utf8");
	} catch {
		/* non-fatal */
	}
}

function agentDir(): string {
	return join(homedir(), ".pi", "agent");
}

function defaultExportName(): string {
	const d = new Date();
	const pad = (n: number) => String(n).padStart(2, "0");
	const stamp = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}`;
	return join(homedir(), "pi-backups", `pi-backup-${stamp}.pi-backup`);
}

function formatBytes(n: number): string {
	if (n < 1024) return `${n}B`;
	if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)}K`;
	return `${(n / (1024 * 1024)).toFixed(1)}M`;
}

// ─────────────────────────────────────────────────── vsync backend fields
// Mirrors vasari-sync's BACKEND_FIELDS table (config command): the prompts
// here shape what `vsync config --set k=v` receives. Secrets travel only
// as VSYNC_SECRET_<FIELD> env vars — pi-port never persists them.

interface BackendField {
	name: string;
	label: string;
	required?: boolean;
	secret?: boolean;
	kind?: "text" | "boolean" | "number";
}

const BACKENDS: Record<string, BackendField[]> = {
	"local-fs": [
		{ name: "basePath", label: "Storage directory path", required: true },
	],
	s3: [
		{ name: "region", label: "Region", required: true },
		{ name: "bucket", label: "Bucket", required: true },
		{ name: "endpoint", label: "Custom endpoint (blank for AWS)" },
		{
			name: "forcePathStyle",
			label: "Use path-style addressing",
			kind: "boolean",
		},
		{ name: "accessKeyId", label: "Access key ID", required: true, secret: true },
		{
			name: "secretAccessKey",
			label: "Secret access key",
			required: true,
			secret: true,
		},
	],
	sftp: [
		{ name: "host", label: "Host", required: true },
		{ name: "port", label: "Port (blank for 22)", kind: "number" },
		{ name: "username", label: "Username", required: true },
		{ name: "password", label: "Password", secret: true },
		{
			name: "privateKeyPath",
			label: "Private key path (optional, instead of password)",
		},
		{ name: "remoteBasePath", label: "Remote base path", required: true },
	],
	webdav: [
		{ name: "url", label: "WebDAV URL", required: true },
		{ name: "username", label: "Username" },
		{ name: "password", label: "Password", secret: true },
		{ name: "remoteBasePath", label: "Remote base path", required: true },
	],
	"github-repo": [
		{ name: "owner", label: "Storage repo owner (user or org)", required: true },
		{
			name: "repo",
			label: "Storage repo (private repo vsync commits your files into)",
			required: true,
		},
		{ name: "branch", label: "Branch (blank for repo default)" },
		{
			name: "token",
			label: "Personal access token (blank = reuse gh CLI login)",
			secret: true,
		},
		{ name: "remoteBasePath", label: "Directory inside the storage repo" },
	],
};

/** camelCase → CONSTANT_CASE env suffix (accessKeyId → ACCESS_KEY_ID). Same rule as vsync. */
function toEnvVarName(field: string): string {
	return field.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toUpperCase();
}

/** Common guard for the cloud commands. Returns true when safe to continue. */
async function requireVsync(ctx: {
	mode?: string;
	ui: {
		notify(m: string, t?: "info" | "warning" | "error"): void;
		setStatus?(key: string, value: string | undefined): void;
	};
}): Promise<boolean> {
	if (ctx.mode !== "tui") {
		ctx.ui.notify("pi-port needs interactive mode", "error");
		return false;
	}
	ctx.ui.setStatus?.("pi-port", "checking vsync…");
	const version = await vsyncVersion();
	ctx.ui.setStatus?.("pi-port", undefined);
	if (!version) {
		ctx.ui.notify(
			"vsync not found on PATH — install it with `npm install -g vasari-sync`, then retry.",
			"error",
		);
		return false;
	}
	if (!meetsFloor(version)) {
		ctx.ui.notify(
			`vsync ${version} is too old — pi-port needs ≥${VSYNC_MIN_VERSION} for --config isolation. ` +
				"Upgrade: npm install -g vasari-sync@latest",
			"error",
		);
		return false;
	}
	return true;
}

export default function piPort(pi: ExtensionAPI): void {
	// ------------------------------------------------ /pi-port-local-export
	pi.registerCommand("pi-port-local-export", {
		description: "Export pi agent configuration to a .pi-backup archive",
		handler: async (args, ctx) => {
			if (ctx.mode !== "tui") {
				ctx.ui.notify("pi-port needs interactive mode", "error");
				return;
			}
			const ad = agentDir();
			const state = await loadState();

			// 1. Resolve output path.
			let outPath = (args || "").trim();
			if (!outPath) {
				const input = await ctx.ui.input(
					`Output path for .pi-backup:`,
					defaultExportName(),
				);
				if (!input) {
					ctx.ui.notify("Export cancelled", "info");
					return;
				}
				outPath = input;
			}
			outPath = resolve(outPath.trim());
			if (!outPath.endsWith(".pi-backup")) outPath += ".pi-backup";

			// 2. Detect sections.
			const present = detectSections(ad);
			if (present.length === 0) {
				ctx.ui.notify(`Nothing to export under ${ad}`, "error");
				return;
			}

			// 3. Wizard: confirm each section. `settings` is forced on.
			const selected = new Set<SectionId>();
			for (const id of present) {
				const def = getSection(id);
				const size = sectionSize(ad, id);
				const forced = id === "settings";
				const label = `${def.label}${size ? ` (${formatBytes(size)})` : ""}${def.note ? ` — ${def.note}` : ""}`;
				if (forced) {
					selected.add(id);
					continue;
				}
				const msg = def.secret
					? "⚠️ Contains API keys in plaintext"
					: (def.note ?? "");
				const include = await ctx.ui.confirm(`Include ${label}?`, msg);
				if (include) selected.add(id);
			}

			if (selected.size === 0) {
				ctx.ui.notify("Nothing selected, export cancelled", "info");
				return;
			}

			// 4. Summary + confirm.
			const list = [...selected]
				.map((id) => {
					const s = getSection(id);
					return `  • ${s.label} (${formatBytes(sectionSize(ad, id))})`;
				})
				.join("\n");
			const totalBytes = [...selected].reduce(
				(a, id) => a + sectionSize(ad, id),
				0,
			);
			const summary = `Sections:\n${list}\n\nTotal: ${formatBytes(totalBytes)}\nOutput: ${outPath}`;
			const go = await ctx.ui.confirm("Export these sections?", summary);
			if (!go) {
				ctx.ui.notify("Export cancelled", "info");
				return;
			}

			// 5. Archive.
			ctx.ui.setStatus("pi-port", "archiving…");
			try {
				const source = {
					os: platform(),
					username: userInfo().username,
					home: homedir(),
					hostname: hostname(),
				};
				const manifest = await createBackup({
					agentDir: ad,
					sections: [...selected],
					source,
					outPath,
				});
				ctx.ui.setStatus("pi-port", undefined);
				await saveState({ ...state, lastExportPath: outPath });
				ctx.ui.notify(
					`Exported ${manifest.sections.length} sections → ${basename(outPath)}`,
					"info",
				);
			} catch (e) {
				ctx.ui.setStatus("pi-port", undefined);
				ctx.ui.notify(`Export failed: ${(e as Error).message}`, "error");
			}
		},
	});

	// ------------------------------------------------ /pi-port-local-import
	pi.registerCommand("pi-port-local-import", {
		description: "Import pi agent configuration from a .pi-backup archive",
		handler: async (args, ctx) => {
			if (ctx.mode !== "tui") {
				ctx.ui.notify("pi-port needs interactive mode", "error");
				return;
			}
			const ad = agentDir();
			const state = await loadState();

			// 1. Resolve input path.
			let inPath = (args || "").trim();
			if (!inPath) {
				const input = await ctx.ui.input(
					`Path to .pi-backup:`,
					state.lastImportPath ?? "~/pi-backups/pi-backup.pi-backup",
				);
				if (!input) {
					ctx.ui.notify("Import cancelled", "info");
					return;
				}
				inPath = input;
			}
			inPath = resolve(inPath.replace(/^~(?=$|\/|\\)/, homedir()));
			try {
				await stat(inPath);
			} catch {
				ctx.ui.notify(`File not found: ${inPath}`, "error");
				return;
			}

			// 2. Read + validate manifest.
			let manifest;
			try {
				manifest = await extractManifest(inPath);
			} catch (e) {
				ctx.ui.notify(`Invalid backup: ${(e as Error).message}`, "error");
				return;
			}

			// 3. Wizard: select sections to import.
			const available: SectionId[] = manifest.sections;
			const targetHome = homedir();
			const needRemap = manifest.source.home !== targetHome;

			const selected = new Set<SectionId>();
			for (const id of available) {
				const def = getSection(id);
				// `auth` gets an explicit key warning but is still opt-in per section.
				const include = await ctx.ui.confirm(
					`Import ${def.label}?`,
					def.secret ? "⚠️ contains API keys" : (def.note ?? ""),
				);
				if (include) selected.add(id);
			}
			if (selected.size === 0) {
				ctx.ui.notify("Nothing selected, import cancelled", "info");
				return;
			}

			// 4. Path remap preview. v0.1 auto-remaps the source-home prefix only;
			// unknown roots are surfaced post-extract in v0.2.
			if (needRemap) {
				ctx.ui.notify(
					`Remapping paths: ${manifest.source.home} → ${targetHome}`,
					"info",
				);
			}

			// 5. Confirm.
			const list = [...selected]
				.map((id) => `  • ${getSection(id).label}`)
				.join("\n");
			const remapNote = needRemap
				? `\nPaths under ${manifest.source.home} will be rewritten to ${targetHome}.`
				: "";
			const backupNote = selected.has("settings")
				? "\nCurrent settings.json will be backed up to settings.json.preimport.bak."
				: "";
			const summary = `Importing:\n${list}${remapNote}${backupNote}`;
			const go = await ctx.ui.confirm("Apply import?", summary);
			if (!go) {
				ctx.ui.notify("Import cancelled", "info");
				return;
			}

			// 6. Apply.
			ctx.ui.setStatus("pi-port", "importing…");
			try {
				await mkdir(ad, { recursive: true });
				await extractSections(inPath, {
					agentDir: ad,
					sections: [...selected],
					sourceHome: manifest.source.home,
					targetHome,
					onSection: (id) => ctx.ui.setStatus("pi-port", `importing ${id}…`),
				});
				ctx.ui.setStatus("pi-port", undefined);
				await saveState({ ...state, lastImportPath: inPath });
				ctx.ui.notify(
					`Imported ${selected.size} sections. Run pi to reinstall npm packages.`,
					"info",
				);
			} catch (e) {
				ctx.ui.setStatus("pi-port", undefined);
				ctx.ui.notify(`Import failed: ${(e as Error).message}`, "error");
			}
		},
	});

	// ------------------------------------------------------- /pi-port-setup
	pi.registerCommand("pi-port-setup", {
		description: "One-time-per-machine backend config for cloud sync (via vsync)",
		handler: async (_args, ctx) => {
			if (!(await requireVsync(ctx))) return;

			// 1. Pick a backend.
			const backend = await ctx.ui.select(
				"Which storage backend for pi-port cloud sync?",
				Object.keys(BACKENDS),
			);
			if (!backend) {
				ctx.ui.notify("Setup cancelled", "info");
				return;
			}

			// 1.5 gh CLI prefill (github-repo): an authenticated `gh` offers
			// the owner via confirm (pi inputs have no submit-default — the 2nd
			// arg is a placeholder) and vsync auto-reuses its token when blank.
			ctx.ui.setStatus("pi-port", "checking GitHub CLI…");
			const gh = backend === "github-repo" ? await ghLogin() : null;
			ctx.ui.setStatus("pi-port", undefined);
			if (gh)
				ctx.ui.notify(
					`GitHub CLI detected — signed in as ${gh}; owner/token can be accepted with one keypress`,
					"info",
				);

			// 2. Non-secret fields. Required ones re-ask until non-empty.
			// github-repo's repo field becomes a picker of the gh login's actual
			// repos when gh is authenticated (manual entry always available).
			const setArgs: string[] = [];
			for (const field of BACKENDS[backend]) {
				if (field.secret) continue;
				if (field.kind === "boolean") {
					const on = await ctx.ui.confirm(field.label, "Set this flag?");
					setArgs.push(`--set`, `${field.name}=${on ? "true" : "false"}`);
					continue;
				}
				if (backend === "github-repo" && field.name === "repo" && gh) {
					ctx.ui.setStatus("pi-port", "listing your GitHub repos…");
					const repos = await ghRepos();
					ctx.ui.setStatus("pi-port", undefined);
					if (repos && repos.length > 0) {
						const MANUAL = "Type a name/URL manually…";
						const choice = await ctx.ui.select(field.label, [
							...repos.map((r) => `${r.name}${r.isPrivate ? " (private)" : ""}`),
							MANUAL,
						]);
						if (choice === undefined) {
							ctx.ui.notify("Setup cancelled", "info");
							return;
						}
						if (choice !== MANUAL) {
							setArgs.push(
								`--set`,
								`${field.name}=${choice.replace(/ \(private\)$/, "")}`,
							);
							continue;
						}
					}
				}
				if (backend === "github-repo" && field.name === "owner" && gh) {
					const use = await ctx.ui.confirm(
						`Repo owner: ${gh} (from your gh CLI login)`,
						"Use this owner?",
					);
					if (use === undefined) {
						ctx.ui.notify("Setup cancelled", "info");
						return;
					}
					if (use) {
						setArgs.push(`--set`, `${field.name}=${gh}`);
						continue;
					}
				}
				let value: string | undefined;
				while (true) {
					value = await ctx.ui.input(
						`${field.label}${field.required ? "" : " (optional)"}`,
					);
					if (value === undefined) {
						ctx.ui.notify("Setup cancelled", "info");
						return;
					}
					if (value.trim() || !field.required) break;
					ctx.ui.notify(`${field.label} is required`, "warning");
				}
				if (value.trim()) setArgs.push(`--set`, `${field.name}=${value.trim()}`);
			}

			// 3. Secrets: typed once, passed as env vars only — never persisted
			//    by pi-port. A blank github-repo token means vsync reuses the
			//    `gh` CLI login (or a previously saved secret).
			const env: Record<string, string> = {};
			for (const field of BACKENDS[backend]) {
				if (!field.secret) continue;
				const value = await ctx.ui.input(
					`${field.label}${field.name === "token" ? ` (blank = reuse gh CLI login${gh ? `: ${gh}` : ""})` : ""}`,
				);
				if (value === undefined) {
					ctx.ui.notify("Setup cancelled", "info");
					return;
				}
				if (value.trim())
					env[`VSYNC_SECRET_${toEnvVarName(field.name)}`] = value.trim();
			}

			// 4. Let vsync test the connection and save the profile. A failed
			//    test aborts on vsync's side — nothing is saved.
			ctx.ui.setStatus("pi-port", "testing connection…");
			try {
				await defaultRunner(
					["config", "--backend", backend, ...setArgs, "--json"],
					{ env },
				);
				ctx.ui.setStatus("pi-port", undefined);
				ctx.ui.notify(`Connection OK, profile saved (${backend})`, "info");
			} catch (e) {
				ctx.ui.setStatus("pi-port", undefined);
				ctx.ui.notify(`Setup failed: ${(e as Error).message}`, "error");
			}
		},
	});

	// --------------------------------------------------- /pi-port-sync-conf
	pi.registerCommand("pi-port-sync-conf", {
		description:
			"Bidirectional cloud sync of global pi config (settings, skills, prompts, themes…)",
		handler: async (_args, ctx) => {
			if (!(await requireVsync(ctx))) return;
			const ad = agentDir();
			const root = stagingRoot(ad);
			const config = stagingConfig(ad);

			// 1. Ensure the vsync project exists (silent when already done).
			ctx.ui.setStatus("pi-port", "checking sync state…");
			try {
				await ensureProject(root);
				const status = (await defaultRunner(["status", "--json"])) as StatusJson;
				const local = await diffConf(ad, config);
				// Staged-but-untracked conf files are invisible to `status` (it
				// reports only on manifest entries) — a run that died between
				// staging and `add` would otherwise read as "in sync" forever.
				const tracked = (await readTrackedPaths(root)) ?? new Set<string>();
				const untracked = (await listFiles(config)).filter(
					(rel) => !tracked.has(`config/${rel}`),
				);
				ctx.ui.setStatus("pi-port", undefined);

				// 2. Both sides identical → done.
				const remoteDrift = status.files.filter((f) => f.status !== "unchanged");
				if (
					local.agentOnly.length === 0 &&
					local.stagingOnly.length === 0 &&
					local.differs.length === 0 &&
					remoteDrift.length === 0 &&
					untracked.length === 0
				) {
					ctx.ui.notify("Conf in sync", "info");
					return;
				}

				// 3. File-level summary, then direction.
				const lines: string[] = [];
				for (const rel of local.differs)
					lines.push(`  ${rel} — differs from last synced`);
				for (const rel of local.agentOnly) lines.push(`  ${rel} — new locally`);
				for (const rel of local.stagingOnly) lines.push(`  ${rel} — remote only`);
				for (const rel of untracked) lines.push(`  ${rel} — staged but never pushed`);
				for (const f of remoteDrift) {
					if (local.stagingOnly.some((rel) => `config/${rel}` === f.path)) continue; // already shown
					if (f.status === "remote-missing")
						lines.push(`  ${f.path} — not pushed yet`);
					else lines.push(`  ${f.path} — staged ≠ remote (${f.status})`);
				}
				const choice = await ctx.ui.select(
					`Conf differences:\n${lines.join("\n")}\n\nDirection?`,
					["Push (local → cloud)", "Pull (cloud → local)", "Cancel"],
				);
				if (!choice || choice === "Cancel") {
					ctx.ui.notify("Conf sync cancelled", "info");
					return;
				}

				if (choice.startsWith("Pull")) {
					// 4a. Refresh staging from the backend, then apply → ~/.pi/agent.
					ctx.ui.setStatus("pi-port", "pulling…");
					await defaultRunner(["pull", "--json"]);
					ctx.ui.setStatus("pi-port", "applying…");
					const applied = await applyConf(ad, config, homedir());
					ctx.ui.setStatus("pi-port", undefined);
					ctx.ui.notify(
						`Pulled ${applied.applied.length} file(s)` +
							(applied.packagesChanged ? " — packages changed, reload pi" : ""),
						"info",
					);
					return;
				}

				// 4b. Stage local → staging config/, scan for secrets, add, push.
				ctx.ui.setStatus("pi-port", "staging…");
				const gate: StageGate = async (rel, hits) =>
					ctx.ui.confirm(
						`Push ${rel} anyway?`,
						`⚠️ Secret scan: ${hits.join(", ")} (values not shown)`,
					);
				const staged = await stageConf(ad, config, gate);
				await addPaths(
					root,
					staged.staged.map((rel) => `config/${rel}`),
				);
				ctx.ui.setStatus("pi-port", "pushing…");
				try {
					const push = (await defaultRunner(["push", "--json"])) as TransferJson;
					ctx.ui.setStatus("pi-port", undefined);
					ctx.ui.notify(
						`Pushed ${push.summary.pushed ?? 0}, skipped ${push.summary["skipped-unchanged"] ?? 0}` +
							(staged.skipped.length > 0
								? `, ${staged.skipped.length} blocked by secret scan`
								: ""),
						"info",
					);
				} catch (e) {
					ctx.ui.setStatus("pi-port", undefined);
					const partial = (e as VsyncError).json as TransferJson | undefined;
					ctx.ui.notify(
						`Push incomplete: ${(e as Error).message}` +
							(partial ? ` (pushed ${partial.summary.pushed ?? 0})` : ""),
						"error",
					);
				}
			} catch (e) {
				ctx.ui.setStatus("pi-port", undefined);
				ctx.ui.notify(`Conf sync failed: ${(e as Error).message}`, "error");
			}
		},
	});

	// ----------------------------------------------- /pi-port-sync-sessions
	pi.registerCommand("pi-port-sync-sessions", {
		description:
			"Cloud sync of this project's pi sessions (push/pull, diff-first)",
		handler: async (_args, ctx) => {
			if (!(await requireVsync(ctx))) return;
			const ad = agentDir();

			// 1. Resolve this project's label from the local bindings.
			const bindingsPath = join(ad, BINDINGS_FILENAME);
			const bindings = await loadBindings(bindingsPath);
			let label = labelForPath(bindings, ctx.cwd);
			while (!label) {
				const input = await ctx.ui.input(
					"Project label (your chosen identity for this directory across machines):",
					basename(ctx.cwd),
				);
				if (!input) {
					ctx.ui.notify("Session sync cancelled", "info");
					return;
				}
				const t = input.trim();
				const problem = validateLabel(t) ?? bindLabel(bindings, t, ctx.cwd);
				if (problem) {
					ctx.ui.notify(problem, "warning");
					continue;
				}
				label = t;
				await saveBindings(bindingsPath, bindings);
			}

			const root = stagingRoot(ad);
			const stagedDir = stagingSessions(ad, label);
			const bucket = sessionBucket(ad, ctx.cwd);

			try {
				// 2. Ensure project, then pull FIRST — the mirror-semantics guard
				//    (a later push must never delete remote-only sessions).
				ctx.ui.setStatus("pi-port", "syncing staging…");
				await ensureProject(root);
				await defaultRunner(["pull", "--json"]);

				// 3. Diff by session id (header-normalized: staged cwd = label).
				const diff = await diffSessions(bucket, stagedDir, label);
				ctx.ui.setStatus("pi-port", undefined);
				if (
					diff.localOnly.length === 0 &&
					diff.stagedOnly.length === 0 &&
					diff.collisions.length === 0
				) {
					ctx.ui.notify(`Sessions in sync for '${label}'`, "info");
					return;
				}

				// 4. Counts + newest timestamps per side, then direction. Zero rows
				// stay bare (no "(newest unknown)" noise); collisions show which
				// side is newer per the same mtime rule push/pull apply.
				const newest = (ts: (string | undefined)[]): string =>
					ts.filter(Boolean).sort().at(-1) ?? "unknown";
				const row = (name: string, n: number, ts: (string | undefined)[]) =>
					`${name}: ${n}` + (n > 0 ? ` (newest ${newest(ts)})` : "");
				let collisionNote = "";
				if (diff.collisions.length > 0) {
					let localNewer = 0;
					for (const info of diff.collisions) {
						const stagedMtime = await stat(join(stagedDir, info.file))
							.then((s) => s.mtimeMs)
							.catch(() => 0);
						if (info.mtimeMs > stagedMtime) localNewer++;
					}
					collisionNote = ` (local newer: ${localNewer}, remote newer: ${diff.collisions.length - localNewer})`;
				}
				const summary =
					`${row(
						"Local ahead",
						diff.localOnly.length,
						diff.localOnly.map((s) => s.timestamp),
					)}\n` +
					`${row(
						"Remote ahead",
						diff.stagedOnly.length,
						diff.stagedOnly.map((s) => s.timestamp),
					)}\n` +
					`Same id, different content: ${diff.collisions.length}${collisionNote}`;
				const options = [
					"Push (local → cloud)",
					"Pull (cloud → local)",
					// Bidirectional, newest-wins-per-file: pushes local-new +
					// locally-newer collisions, pulls remote-new + remotely-newer
					// collisions — the two branches' mtime rules are complementary.
					"Reconcile (both ways, newest wins)",
				];
				options.push("Cancel");
				const choice = await ctx.ui.select(
					`Sessions for '${label}' (${ctx.cwd}):\n${summary}\n\nDirection?`,
					options,
				);
				if (!choice || choice === "Cancel") {
					ctx.ui.notify("Session sync cancelled", "info");
					return;
				}

				const gate: StageGate = async (file, hits) =>
					ctx.ui.confirm(
						`Push ${basename(file)} anyway?`,
						`⚠️ Secret scan: ${hits.join(", ")} (values not shown)`,
					);

				if (choice.startsWith("Push") || choice.startsWith("Reconcile")) {
					// 5. Stage local-new + locally-newer collisions → push.
					ctx.ui.setStatus("pi-port", "staging sessions…");
					const rels: string[] = [];
					let stale = 0;
					let blocked = 0;
					const stageOne = async (file: string): Promise<void> => {
						const ok = await stageSession(
							join(bucket, file),
							join(stagedDir, file),
							label,
							gate,
						);
						if (ok) rels.push(`projects/${label}/sessions/${file}`);
						else blocked++;
					};
					for (const info of diff.localOnly) await stageOne(info.file);
					for (const info of diff.collisions) {
						// ponytail: last-edited-wins via local mtime vs staged-file mtime
						// (proxy for the remote push time — vsync status --json has no
						// pushedAt; wall-clock skew between machines can misjudge).
						const stagedMtime = await stat(join(stagedDir, info.file))
							.then((s) => s.mtimeMs)
							.catch(() => 0);
						if (info.mtimeMs > stagedMtime) await stageOne(info.file);
						else stale++;
					}
					await addPaths(root, rels);
					ctx.ui.setStatus("pi-port", "pushing…");
					const push = (await defaultRunner(["push", "--json"])) as TransferJson;
					ctx.ui.setStatus("pi-port", undefined);
					ctx.ui.notify(
						`Pushed ${push.summary.pushed ?? 0} session(s)` +
							(stale > 0 ? `, ${stale} kept (remote newer)` : "") +
							(blocked > 0 ? `, ${blocked} blocked by secret scan` : ""),
						"info",
					);
				}

				if (choice.startsWith("Pull") || choice.startsWith("Reconcile")) {
					// 6. Restore staged-only + collisions → local bucket (idempotent).
					// Collisions respect last-edited-wins: local is kept when it is newer.
					ctx.ui.setStatus("pi-port", "restoring sessions…");
					let written = 0;
					let skipped = 0;
					let keptLocal = 0;
					for (const info of diff.stagedOnly) {
						const out = await restoreSession(
							join(stagedDir, info.file),
							bucket,
							ctx.cwd,
						);
						out === "written" ? written++ : skipped++;
					}
					for (const info of diff.collisions) {
						// ponytail: mirror of the push-side mtime comparison; staged-file
						// mtime proxies the remote push time (no pushedAt in status --json).
						const stagedMtime = await stat(join(stagedDir, info.file))
							.then((s) => s.mtimeMs)
							.catch(() => Infinity);
						if (stagedMtime > info.mtimeMs) {
							const out = await restoreSession(
								join(stagedDir, info.file),
								bucket,
								ctx.cwd,
							);
							out === "written" ? written++ : skipped++;
						} else {
							keptLocal++;
						}
					}
					ctx.ui.setStatus("pi-port", undefined);
					ctx.ui.notify(
						`Restored ${written} session(s)` +
							(skipped > 0 ? `, ${skipped} already current` : "") +
							(keptLocal > 0 ? `, ${keptLocal} kept local (local newer)` : ""),
						"info",
					);
				}
			} catch (e) {
				ctx.ui.setStatus("pi-port", undefined);
				ctx.ui.notify(`Session sync failed: ${(e as Error).message}`, "error");
			}
		},
	});
}
