// pi-port.ts — export/import pi agent configuration.
//
// Two commands:
//   /export-pi [path]   package ~/.pi/agent/ sections into a .pi-backup archive
//   /import-pi [path]   restore a .pi-backup (selectively, with path remap)
//
// Zero runtime deps beyond Node stdlib + the system `tar` binary.
// macOS/Linux supported in v0.1; Windows native tar fallback is v0.2.

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

export default function piPort(pi: ExtensionAPI): void {
	// ---------------------------------------------------------------- /export-pi
	pi.registerCommand("export-pi", {
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

	// ---------------------------------------------------------------- /import-pi
	pi.registerCommand("import-pi", {
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
}
