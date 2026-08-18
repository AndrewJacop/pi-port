// paths.ts — machine-specific path translation for cloud sync.
//
// pi stores each project's sessions in a bucket directory named after the
// project's absolute path (mangled), which differs between machines. Cloud
// sync stages sessions under a machine-agnostic project label instead;
// these helpers convert between the two worlds and locate the sync tree.

import { mkdir, readdir, stat } from "node:fs/promises";
import { join, dirname } from "node:path";

/** Directory under ~/.pi/agent/ holding the persistent vsync staging tree. */
export const STAGING_DIRNAME = "pi-port-sync";
/** Machine-local label↔path bindings file (never synced). */
export const BINDINGS_FILENAME = "pi-port-bindings.json";
/** The one and only vsync project id used by pi-port. */
export const VSYNC_PROJECT_ID = "pi-port";
/** pi-port's private vsync config file (needs vsync ≥0.6.0 for `--config`). */
export const VSYNC_CONFIG_FILENAME = "pi-port-vsync.json";

/**
 * Mangle an absolute cwd into pi's session bucket name: ONE leading
 * separator stripped, then every `/`, `\` and `:` replaced by `-`, wrapped
 * in `--...--` (matches pi's session-manager verbatim).
 * Verified: `D:\Me\pi-port` → `--D--Me-pi-port--`,
 * `/Users/andrew/Others/pi-port` → `--Users-andrew-Others-pi-port--`.
 */
export function mangleBucket(cwd: string): string {
	return `--${cwd.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;
}

/**
 * Best-effort inverse of mangleBucket. Inherently lossy: original `-`
 * characters are indistinguishable from separators after mangling, so the
 * inverse reinserts the platform's separator everywhere. Only suitable for
 * display/guesswork — the sync flow always rebuilds buckets from real
 * cwd paths, never from bucket names.
 */
export function unmangleBucket(bucket: string, winStyle = false): string {
	const inner = bucket.replace(/^--/, "").replace(/--$/, "");
	// Windows drive letter: "D--Me-pi-port" → "D:\Me\pi\port" (lossy).
	if (winStyle && /^[A-Za-z]-/.test(inner)) {
		return `${inner[0]}:${inner.slice(2).replace(/-/g, "\\")}`;
	}
	return `/${inner.replace(/-/g, "/")}`;
}

/** Local session bucket dir for a cwd: <agentDir>/sessions/--<mangled>--. */
export function sessionBucket(agentDir: string, cwd: string): string {
	return join(agentDir, "sessions", mangleBucket(cwd));
}

/** Staging tree root: <agentDir>/pi-port-sync. */
export function stagingRoot(agentDir: string): string {
	return join(agentDir, STAGING_DIRNAME);
}

/** pi-port's own vsync config file: <agentDir>/pi-port-vsync.json. */
export function vsyncConfigPath(agentDir: string): string {
	return join(agentDir, VSYNC_CONFIG_FILENAME);
}

/** Staging mirror of the global conf set: <staging>/config. */
export function stagingConfig(agentDir: string): string {
	return join(stagingRoot(agentDir), "config");
}

/** Staging sessions dir for a project label: <staging>/projects/<label>/sessions. */
export function stagingSessions(agentDir: string, label: string): string {
	return join(stagingRoot(agentDir), "projects", label, "sessions");
}

/**
 * Recursively list files under `root` as project-relative posix paths.
 * Entries (files or dirs) whose basename is in `skip` are pruned.
 * Missing root yields [] (empty bucket is normal).
 */
export async function listFiles(
	root: string,
	skip: string[] = [],
): Promise<string[]> {
	const out: string[] = [];
	const walk = async (rel: string): Promise<void> => {
		let entries: string[];
		try {
			entries = await readdir(join(root, rel));
		} catch {
			return; // missing dir
		}
		for (const entry of entries) {
			if (skip.includes(entry)) continue;
			const relPath = rel ? `${rel}/${entry}` : entry;
			const st = await stat(join(root, relPath)).catch(() => null);
			if (!st) continue;
			if (st.isDirectory()) await walk(relPath);
			else out.push(relPath);
		}
	};
	await walk("");
	return out.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

/** Ensure the parent dir of `filePath` exists (mkdir -p style). */
export async function ensureParent(filePath: string): Promise<void> {
	await mkdir(dirname(filePath), { recursive: true });
}
