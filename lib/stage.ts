// stage.ts — content staging between ~/.pi/agent and the vsync tree.
//
// Conf side: mirror the exact conf set (settings.json, keybindings.json,
// trust.json, skills/, prompts/, themes/) into <staging>/config, with
// settings normalized (lastChangelogVersion and local-path packages
// stripped) so both machines produce byte-identical staged copies.
// Session side: copy JSONL files between the local bucket and
// <staging>/projects/<label>/sessions, rewriting ONLY line 1's cwd field
// (path ⇄ label); lines 2+ are copied verbatim.

import { createHash } from "node:crypto";
import {
	copyFile,
	mkdir,
	readFile,
	readdir,
	stat,
	writeFile,
} from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { isAbsolutePath, remapObject } from "./remap.ts";
import { scanText } from "./scan.ts";
import { ensureParent, listFiles } from "./paths.ts";

/** The exact conf set that participates in cloud sync — nothing else. */
export const CONF_FILES = [
	"settings.json",
	"keybindings.json",
	"trust.json",
] as const;
export const CONF_DIRS = ["skills", "prompts", "themes"] as const;

/** Gate: called before writing a staged file; hits are pattern NAMES. Return false to skip. */
export type StageGate = (relPath: string, hits: string[]) => Promise<boolean>;
const allowAll: StageGate = async () => true;

// ─────────────────────────────────────────────────── settings normalization

export interface SettingsJson {
	lastChangelogVersion?: unknown;
	packages?: unknown;
	[key: string]: unknown;
}

/** True for package entries that are local absolute paths (don't exist on other machines). */
function isLocalPackageEntry(p: unknown): boolean {
	return typeof p === "string" && isAbsolutePath(p);
}

/**
 * Normalize a settings.json for staging: strip `lastChangelogVersion` and
 * local-path package entries. Returns the input string unchanged when it
 * isn't parseable JSON (defensive — the agent's own copy stays authoritative).
 */
export function normalizeSettingsForStaging(raw: string): string {
	let obj: SettingsJson;
	try {
		obj = JSON.parse(raw);
	} catch {
		return raw;
	}
	if (!obj || typeof obj !== "object" || Array.isArray(obj)) return raw;
	delete obj.lastChangelogVersion;
	if (Array.isArray(obj.packages)) {
		obj.packages = obj.packages.filter((p) => !isLocalPackageEntry(p));
	}
	return JSON.stringify(obj, null, "\t") + "\n";
}

/** Transformed agent-side content for a conf path (identity except settings.json). */
function transformConfContent(rel: string, content: string): string {
	return rel === "settings.json"
		? normalizeSettingsForStaging(content)
		: content;
}

// ─────────────────────────────────────────────────────────── conf diff

export interface ConfDiff {
	/** Present under ~/.pi/agent, absent in staging. */
	agentOnly: string[];
	/** Present in staging, absent locally. */
	stagingOnly: string[];
	/** Both sides, different (transformed) content. */
	differs: string[];
}

function sha256(s: string): string {
	return createHash("sha256").update(s, "utf8").digest("hex");
}

/** sha256 diff of the agent's conf set vs staging config/, using the same normalization staging applies. */
export async function diffConf(
	agentDir: string,
	stagingConfigDir: string,
): Promise<ConfDiff> {
	const agentFiles = new Set<string>();
	for (const name of CONF_FILES) {
		if (
			await stat(join(agentDir, name)).then(
				() => true,
				() => false,
			)
		)
			agentFiles.add(name);
	}
	for (const dir of CONF_DIRS) {
		for (const f of await listFiles(join(agentDir, dir)))
			agentFiles.add(`${dir}/${f}`);
	}
	const stagingFiles = new Set(await listFiles(stagingConfigDir));

	const diff: ConfDiff = { agentOnly: [], stagingOnly: [], differs: [] };
	for (const rel of agentFiles) {
		if (!stagingFiles.has(rel)) {
			diff.agentOnly.push(rel);
			continue;
		}
		const local = transformConfContent(
			rel,
			await readFile(join(agentDir, rel), "utf8"),
		);
		const staged = await readFile(join(stagingConfigDir, rel), "utf8");
		if (sha256(local) !== sha256(staged)) diff.differs.push(rel);
	}
	for (const rel of stagingFiles)
		if (!agentFiles.has(rel)) diff.stagingOnly.push(rel);
	return diff;
}

// ─────────────────────────────────────────────────────── conf stage (push)

export interface StageResult {
	staged: string[];
	skipped: string[];
}

/** Stage ~/.pi/agent conf → <staging>/config. Scan runs on staged content; gate can veto per file. */
export async function stageConf(
	agentDir: string,
	stagingConfigDir: string,
	gate: StageGate = allowAll,
): Promise<StageResult> {
	const res: StageResult = { staged: [], skipped: [] };
	const stageOne = async (rel: string, content: string): Promise<void> => {
		const hits = scanText(content);
		if (hits.length > 0 && !(await gate(rel, hits))) {
			res.skipped.push(rel);
			return;
		}
		const target = join(stagingConfigDir, rel);
		await ensureParent(target);
		await writeFile(target, content, "utf8");
		res.staged.push(rel);
	};
	for (const name of CONF_FILES) {
		try {
			await stageOne(
				name,
				transformConfContent(name, await readFile(join(agentDir, name), "utf8")),
			);
		} catch {
			/* absent locally — nothing to stage */
		}
	}
	for (const dir of CONF_DIRS) {
		for (const f of await listFiles(join(agentDir, dir))) {
			const rel = `${dir}/${f}`;
			try {
				await stageOne(rel, await readFile(join(agentDir, rel), "utf8"));
			} catch {
				/* vanished mid-walk — skip */
			}
		}
	}
	return res;
}

// ─────────────────────────────────────────────────────── conf apply (pull)

export interface ConfApplyResult {
	applied: string[];
	packagesChanged: boolean;
}

/**
 * Sniff a foreign home root (e.g. /Users/alice, /home/bob, C:\Users\carol)
 * from absolute-path strings in `obj` that aren't under `localHome`.
 * Returns undefined when nothing applicable.
 */
export function detectForeignHome(
	obj: unknown,
	localHome: string,
): string | undefined {
	const local = localHome.replace(/\\/g, "/").replace(/\/+$/, "");
	let found: string | undefined;
	const visit = (o: unknown): void => {
		if (found !== undefined) return;
		if (typeof o === "string") check(o);
		else if (Array.isArray(o)) o.forEach(visit);
		else if (o && typeof o === "object") {
			for (const [k, v] of Object.entries(o as Record<string, unknown>)) {
				check(k);
				visit(v);
			}
		}
	};
	const check = (s: string): void => {
		if (found !== undefined || !isAbsolutePath(s)) return;
		const n = s.replace(/\\/g, "/");
		if (n === local || n.startsWith(`${local}/`)) return;
		const posix = n.match(/^\/(?:home|Users)\/[^/]+/); // /home/x | /Users/x
		const win = n.match(/^[A-Za-z]:\/(?:Users|home)\/[^/]+/); // C:/Users/x
		const hit = posix?.[0] ?? win?.[0];
		if (hit) found = hit;
	};
	visit(obj);
	return found;
}

/** Back up an existing file to <name>.preimport.bak (same pattern as lib/archive.ts). */
async function backupFile(path: string): Promise<void> {
	try {
		await copyFile(path, `${path}.preimport.bak`);
	} catch {
		/* absent — nothing to back up */
	}
}

/** Merge incoming settings over local: incoming keys win, local-only keys stay, abs-path packages dropped. */
export function mergeSettings(
	local: Record<string, unknown> | null,
	incoming: Record<string, unknown>,
): { merged: Record<string, unknown>; packagesChanged: boolean } {
	const merged: Record<string, unknown> = { ...(local ?? {}), ...incoming };
	const localPkgs = Array.isArray(local?.packages)
		? (local.packages as unknown[])
		: [];
	const incomingPkgs = Array.isArray(incoming.packages)
		? (incoming.packages as unknown[]).filter((p) => !isLocalPackageEntry(p))
		: [];
	merged.packages = [
		...new Set([...localPkgs, ...incomingPkgs].map((p) => String(p))),
	];
	const before = JSON.stringify([...new Set(localPkgs.map((p) => String(p)))]);
	const after = JSON.stringify(merged.packages);
	return { merged, packagesChanged: before !== after };
}

/**
 * Apply <staging>/config → ~/.pi/agent (pull direction). Every overwritten
 * file is backed up to <name>.preimport.bak first. settings.json is MERGED
 * (never replaced); incoming absolute paths under a detected foreign home
 * are remapped to this machine's home via lib/remap.ts.
 */
export async function applyConf(
	agentDir: string,
	stagingConfigDir: string,
	localHome: string,
): Promise<ConfApplyResult> {
	const result: ConfApplyResult = { applied: [], packagesChanged: false };
	const staged = await listFiles(stagingConfigDir);
	if (staged.length === 0) return result;
	await mkdir(agentDir, { recursive: true });

	for (const rel of staged) {
		const stagedPath = join(stagingConfigDir, rel);
		const target = join(agentDir, rel);
		if (rel === "settings.json") {
			let incoming: Record<string, unknown>;
			try {
				incoming = JSON.parse(await readFile(stagedPath, "utf8"));
			} catch {
				continue; // corrupt staged settings — never touch the local copy
			}
			let local: Record<string, unknown> | null = null;
			try {
				local = JSON.parse(await readFile(target, "utf8"));
			} catch {
				/* no local settings yet */
			}
			const foreign = detectForeignHome(incoming, localHome);
			if (foreign) incoming = remapObject(incoming, foreign, localHome); // returns a new object; input is never mutated
			await backupFile(target);
			const { merged, packagesChanged } = mergeSettings(local, incoming);
			result.packagesChanged ||= packagesChanged;
			await ensureParent(target);
			await writeFile(target, JSON.stringify(merged, null, "\t") + "\n", "utf8");
			result.applied.push(rel);
			continue;
		}
		await backupFile(target);
		if (rel === "trust.json") {
			// Path-bearing keys/values — remap when the incoming tree came from another home.
			try {
				const incoming = JSON.parse(await readFile(stagedPath, "utf8"));
				const foreign = detectForeignHome(incoming, localHome);
				const out = foreign ? remapObject(incoming, foreign, localHome) : incoming;
				await ensureParent(target);
				await writeFile(target, JSON.stringify(out, null, "\t") + "\n", "utf8");
				result.applied.push(rel);
				continue;
			} catch {
				/* fall through to verbatim copy */
			}
		}
		await ensureParent(target);
		await copyFile(stagedPath, target);
		result.applied.push(rel);
	}
	return result;
}

// ─────────────────────────────────────────────── session header rewriting

export interface SessionHeader {
	id?: string;
	timestamp?: string;
	cwd?: string;
}

/** Parse line 1 of a session JSONL; missing/corrupt header yields {}. */
export function readSessionHeader(raw: string): SessionHeader {
	const line1 = raw.split("\n", 1)[0];
	try {
		const obj = JSON.parse(line1);
		if (obj && typeof obj === "object") return obj as SessionHeader;
	} catch {
		/* corrupt */
	}
	return {};
}

/**
 * Rewrite ONLY line 1's `cwd` field of a session JSONL; lines 2+ are
 * returned verbatim (byte-identical, including their original newlines).
 * Best-effort: a non-JSON line 1 returns `raw` unchanged (never throws) —
 * identical malformed bytes then compare as in-sync, which is correct.
 */
export function rewriteSessionHeader(raw: string, cwd: string): string {
	const nl = raw.indexOf("\n");
	const line1 = nl === -1 ? raw : raw.slice(0, nl);
	const rest = nl === -1 ? "" : raw.slice(nl);
	let obj: SessionHeader | null = null;
	try {
		obj = JSON.parse(line1) as SessionHeader; // Key order is preserved by parse/stringify.
	} catch {
		return raw;
	}
	obj.cwd = cwd;
	return JSON.stringify(obj) + rest;
}

// ─────────────────────────────────────────────────────── session diffing

export interface SessionInfo {
	file: string;
	id: string;
	timestamp?: string;
	mtimeMs: number;
}

export interface SessionDiff {
	localOnly: SessionInfo[];
	stagedOnly: SessionInfo[];
	/** Same session id on both sides with different content. */
	collisions: SessionInfo[];
	/** Same id on both sides, identical after header normalization. */
	inSync: number;
}

async function readSessionDir(dir: string): Promise<Map<string, SessionInfo>> {
	const map = new Map<string, SessionInfo>();
	let entries: string[];
	try {
		entries = await readdir(dir);
	} catch {
		return map; // no bucket yet — normal on a fresh machine
	}
	for (const entry of entries) {
		if (!entry.endsWith(".jsonl")) continue;
		const path = join(dir, entry);
		const info = await stat(path).catch(() => null);
		if (!info) continue;
		const header = readSessionHeader(
			await readFile(path, "utf8").catch(() => ""),
		);
		if (!header.id) continue;
		map.set(header.id, {
			file: entry,
			id: header.id,
			timestamp: header.timestamp,
			mtimeMs: info.mtimeMs,
		});
	}
	return map;
}

/**
 * Diff local bucket vs staged sessions by session id (line-1 header). Same
 * id + same bytes = in sync. `remoteFiles` (vsync manifest paths — backend
 * truth) gates the staged side: files sitting in staging but never actually
 * pushed (a failed/interrupted push leaves them behind) do NOT count as
 * remote — they resurface as localOnly and get pushed on the next run.
 */
export async function diffSessions(
	bucketDir: string,
	stagedDir: string,
	/** Project label — staged headers carry the label, not the local path. */
	label: string,
	/** Backend-tracked paths (e.g. `projects/x/sessions/a.jsonl`); omitted = trust staging. */
	remoteFiles?: Set<string>,
): Promise<SessionDiff> {
	const isRemote = (file: string) =>
		!remoteFiles || remoteFiles.has(`projects/${label}/sessions/${file}`);
	const local = await readSessionDir(bucketDir);
	const staged = await readSessionDir(stagedDir);
	const diff: SessionDiff = { localOnly: [], stagedOnly: [], collisions: [], inSync: 0 };
	for (const [id, info] of local) {
		const remote = staged.get(id);
		if (!remote || !isRemote(remote.file)) {
			diff.localOnly.push(info);
			continue;
		}
		// Compare AFTER normalizing the local header to its staged form —
		// the cwd field differs by design (abs path vs label); raw-byte
		// compare would flag every pushed session as a collision forever.
		const a = await readFile(join(bucketDir, info.file), "utf8").catch(() => "");
		const b = await readFile(join(stagedDir, remote.file), "utf8").catch(
			() => "\u0000",
		);
		const differs = rewriteSessionHeader(a, label) !== b;
		if (differs) {
			// ponytail: content compare after id match; mtime proxy decides conflicts (see command flow).
			diff.collisions.push(info);
		} else {
			diff.inSync++;
		}
	}
	for (const [id, info] of staged) {
		if (!local.has(id) && isRemote(info.file)) diff.stagedOnly.push(info);
	}
	return diff;
}

// ─────────────────────────────────────────────── session stage / restore

/** Stage one local session file → staging dir with header cwd rewritten to the label. Scan-gated. */
export async function stageSession(
	localFile: string,
	stagedFile: string,
	label: string,
	gate: StageGate = allowAll,
): Promise<boolean> {
	const raw = await readFile(localFile, "utf8");
	const staged = rewriteSessionHeader(raw, label);
	const hits = scanText(staged);
	if (hits.length > 0 && !(await gate(stagedFile, hits))) return false;
	await ensureParent(stagedFile);
	await writeFile(stagedFile, staged, "utf8");
	return true;
}

/** Restore one staged session → local bucket with header cwd rewritten to the local path. Idempotent on identical content. */
export async function restoreSession(
	stagedFile: string,
	bucketDir: string,
	localCwd: string,
): Promise<"written" | "skipped"> {
	const raw = await readFile(stagedFile, "utf8");
	const restored = rewriteSessionHeader(raw, localCwd);
	const target = join(bucketDir, basename(stagedFile));
	const existing = await readFile(target).catch(() => null);
	if (existing && existing.equals(Buffer.from(restored, "utf8")))
		return "skipped";
	await mkdir(dirname(target), { recursive: true });
	await writeFile(target, restored, "utf8");
	return "written";
}
