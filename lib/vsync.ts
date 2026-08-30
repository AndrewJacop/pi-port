// vsync.ts — child_process wrapper around the global `vsync` CLI.
//
// Strategy B: pi-port NEVER bundles vsync. Every call runs non-interactively
// (--json; spawned without a TTY so vsync never prompts) with the persistent
// staging tree as cwd — vsync uses process.cwd() as its project root. The
// runner is injectable so tests can fake the CLI.

import { spawn } from "node:child_process";
import { mkdir, readFile, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import {
	listFiles,
	stagingRoot,
	vsyncConfigPath,
	VSYNC_PROJECT_ID,
} from "./paths.ts";

/** Run vsync, resolve with the parsed stdout JSON (undefined when non-JSON).
 * `opts.input` is piped to vsync's stdin — how large file lists travel
 * (`add -` / `init --files -`): argv stays a fixed size, immune to the
 * OS command-line length caps (cmd.exe ~8k chars). */
export type VsyncRunner = (
	args: string[],
	opts?: { env?: Record<string, string>; input?: string },
) => Promise<unknown>;

export class VsyncError extends Error {
	/** Parsed stdout when vsync printed a result object before failing (push/pull). */
	json?: unknown;
}

export interface StatusFile {
	path: string;
	status: "unchanged" | "differs" | "missing-locally" | "remote-missing";
	note?: string;
}

export interface StatusJson {
	projectId: string;
	backend: string;
	files: StatusFile[];
}

export interface TransferJson {
	projectId: string;
	backend: string;
	files: { path: string; outcome: string; note?: string }[];
	summary: Record<string, number>;
}

function defaultAgentDir(): string {
	return join(homedir(), ".pi", "agent");
}

/** cmd.exe needs args with spaces/metacharacters quoted (shell:true joins them). */
function winQuote(a: string): string {
	if (!/[ &()[\]{}^=;!'+,`~<>|"']/.test(a)) return a;
	return `"${a.replace(/"/g, '""')}"`;
}

async function spawnVsync(
	args: string[],
	cwd: string,
	env?: Record<string, string>,
	input?: string,
): Promise<{ stdout: string; stderr: string; code: number | null }> {
	// First-ever run: the staging tree (spawn cwd) may not exist yet —
	// cmd.exe ENOENTs on a missing cwd before vsync even starts.
	await mkdir(cwd, { recursive: true }).catch(() => undefined);
	return new Promise((resolve, reject) => {
		// Every spawn pins --config to pi-port's private file: full isolation
		// from any ~/.vsync/config.json the user keeps for their own vsync
		// projects. Appending works in either position (global flag), and the
		// flag beats ambient VSYNC_CONFIG/VSYNC_HOME inside the child.
		const withConfig = [...args, "--config", vsyncConfigPath(defaultAgentDir())];
		const stdio: Array<"pipe" | "ignore"> = [input === undefined ? "ignore" : "pipe", "pipe", "pipe"];
		const spawnOpts = {
			cwd,
			...(process.platform === "win32" ? { shell: true as const } : {}),
			stdio,
			env: env ? { ...process.env, ...env } : process.env,
		};
		const child =
			process.platform === "win32"
					? spawn("vsync", withConfig.map(winQuote), spawnOpts)
					: spawn("vsync", withConfig, spawnOpts);
		if (input !== undefined) {
			child.stdin?.end(input); // EPIPE (child exits early) is fine on "close"
			child.stdin?.on("error", () => undefined);
		}
		let stdout = "";
		let stderr = "";
		child.stdout!.on("data", (d) => (stdout += d));
		child.stderr!.on("data", (d) => (stderr += d));
		child.on("error", reject);
		child.on("close", (code) => resolve({ stdout, stderr, code }));
	});
}

/** Default runner: real vsync, cwd = this machine's staging root. */
export const defaultRunner: VsyncRunner = async (args, opts) => {
	const { stdout, stderr, code } = await spawnVsync(
		args,
		stagingRoot(join(homedir(), ".pi", "agent")),
		opts?.env,
		opts?.input,
	);
	if (code === 0) {
		try {
			return JSON.parse(stdout);
		} catch {
			return undefined; // e.g. --version prose — success is the exit code
		}
	}
	const err = new VsyncError(
		(stderr || stdout || `vsync exited ${code}`)
			.replace(/^\[vsync\]\s*/, "")
			.trim(),
	);
	try {
		err.json = JSON.parse(stdout); // push/pull print the result BEFORE the error
	} catch {
		/* no result object */
	}
	throw err;
};

/** Minimum vsync version: `--config` landed in 0.6.0, stdin `-` file lists in 0.6.1. */
export const VSYNC_MIN_VERSION = "0.6.1";

/** Parse "1.2.3" from `vsync --version`; null when the CLI is not on PATH. */
export async function vsyncVersion(): Promise<string | null> {
	try {
		const { stdout, code } = await spawnVsync(["--version"], defaultAgentDir());
		if (code !== 0) return null;
		const m = stdout.match(/(\d+)\.(\d+)\.(\d+)/);
		return m ? `${m[1]}.${m[2]}.${m[3]}` : null;
	} catch {
		return null;
	}
}

/** Numeric major.minor.patch compare; missing parts count as 0. */
export function meetsFloor(
	v: string | null | undefined,
	floor: string = VSYNC_MIN_VERSION,
): boolean {
	if (!v) return false;
	const nums = (s: string) =>
		s.split(".").map((n) => Number.parseInt(n, 10) || 0);
	const a = nums(v);
	const f = nums(floor);
	for (let i = 0; i < 3; i++) {
		if ((a[i] ?? 0) !== (f[i] ?? 0)) return (a[i] ?? 0) > (f[i] ?? 0);
	}
	return true;
}

/**
 * GitHub CLI login name via `gh api user`, or null when gh is missing/
 * not authenticated. gh.exe is a native binary — no shell shim needed.
 */
export async function ghLogin(): Promise<string | null> {
	try {
		const { stdout, code } = await new Promise<{
			stdout: string;
			code: number | null;
		}>((resolve, reject) => {
			const child = spawn("gh", ["api", "user", "--jq", ".login"], {
				stdio: ["ignore", "pipe", "ignore"],
			});
			let out = "";
			child.stdout.on("data", (d) => (out += d));
			child.on("error", reject);
			child.on("close", (c) => resolve({ stdout: out, code: c }));
		});
		const login = code === 0 ? stdout.trim() : "";
		return login || null;
	} catch {
		return null;
	}
}

/**
 * The gh user's repos via `gh repo list` (name + visibility, newest-updated
 * first), or null when gh is unavailable or the call fails.
 */
export async function ghRepos(): Promise<Array<{
	name: string;
	isPrivate: boolean;
}> | null> {
	try {
		const { stdout, code } = await new Promise<{
			stdout: string;
			code: number | null;
		}>((resolve, reject) => {
			const child = spawn(
				"gh",
				["repo", "list", "--limit", "50", "--json", "name,isPrivate"],
				{ stdio: ["ignore", "pipe", "ignore"] },
			);
			let out = "";
			child.stdout.on("data", (d) => (out += d));
			child.on("error", reject);
			child.on("close", (c) => resolve({ stdout: out, code: c }));
		});
		if (code !== 0) return null;
		const parsed = JSON.parse(stdout);
		if (!Array.isArray(parsed)) return null;
		return parsed.flatMap((r: { name?: unknown; isPrivate?: unknown }) =>
			typeof r?.name === "string"
				? [{ name: r.name, isPrivate: r.isPrivate === true }]
				: [],
		);
	} catch {
		return null;
	}
}

/** Tracked paths from the staging manifest (read-only — pi-port never edits it). Null when no manifest yet. */
export async function readTrackedPaths(
	root: string,
): Promise<Set<string> | null> {
	try {
		const parsed = JSON.parse(
			await readFile(join(root, ".vsync", "manifest.json"), "utf8"),
		);
		if (!parsed || !Array.isArray(parsed.files)) return new Set();
		return new Set(parsed.files.map((f: { path?: unknown }) => String(f?.path)));
	} catch {
		return null;
	}
}

/**
 * Ensure the single `pi-port` vsync project exists in the staging tree —
 * and refresh it from the backend. The manifest is derived state that
 * never travels: `pull`/`status` iterate manifest entries only, so a
 * clone goes stale the moment another machine pushes files it has never
 * seen. Every run therefore re-links: link is vsync's rebuild-the-
 * manifest-from-the-backend op, and with a manifest present it refuses
 * ("would clobber") — so drop the stale one first. Local files are
 * never touched; a push re-adds anything the index doesn't know yet.
 * `root` is the staging tree itself (vsync's project root).
 */
export async function ensureProject(
	root: string,
	run: VsyncRunner = defaultRunner,
): Promise<"linked" | "initialized"> {
	const priorManifest = (await readTrackedPaths(root)) !== null;
	if (priorManifest) {
		await rm(join(root, ".vsync", "manifest.json"), { force: true });
	}
	try {
		await run(["link", VSYNC_PROJECT_ID, "--pull", "--json"]);
		return "linked";
	} catch (e) {
		// Only machine-A states fall back to init: the backend has nothing
		// under this project, or no profile is configured yet. Any other
		// failure (auth, network, a bad pull…) must surface — swallowing it
		// here masks the real error and leaves link's half-written manifest.
		if (!/no files found|no saved profile/i.test((e as Error).message)) throw e;
		const files = await listFiles(root, [".vsync", ".gitignore"]);
		const args = ["init", "--project-id", VSYNC_PROJECT_ID, "--json"];
		// Large trees overflow the OS command-line caps — the file list is
		// piped (init --files - reads newline-separated paths from stdin).
		if (files.length > 0) args.push("--files", "-");
		try {
			await run(args, files.length > 0 ? { input: `${files.join("\n")}\n` } : undefined);
			return "initialized";
		} catch (e) {
			throw new VsyncError(
				`${(e as Error).message} — run /pi-port-setup first to configure a backend`,
			);
		}
	}
}

/** `vsync add` only the paths not already tracked (add is all-or-nothing on duplicates). Returns what was added. */
export async function addPaths(
	root: string,
	relPaths: string[],
	run: VsyncRunner = defaultRunner,
): Promise<string[]> {
	const tracked = (await readTrackedPaths(root)) ?? new Set<string>();
	const fresh = relPaths.filter((p) => !tracked.has(p));
	// Paths go over stdin (`add -`) — a 100+ path session list overflows the
	// OS command-line length caps (cmd.exe ~8k chars) when passed as argv.
	if (fresh.length > 0)
		await run(["add", "-", "--json"], { input: `${fresh.join("\n")}\n` });
	return fresh;
}
