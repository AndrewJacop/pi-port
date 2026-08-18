// Unit tests for staging: session header rewriting, conf normalization,
// settings merge, diffing, and the scan gate. All on temp dirs.
// Run with: npm test (-> node --test --import tsx test/)
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	normalizeSettingsForStaging,
	mergeSettings,
	detectForeignHome,
	rewriteSessionHeader,
	readSessionHeader,
	diffSessions,
	stageSession,
	restoreSession,
	stageConf,
	diffConf,
	applyConf,
} from "../lib/stage.ts";

async function tmp(): Promise<string> {
	return mkdtemp(join(tmpdir(), "pi-port-stage-"));
}

// ─────────────────────────────────────────────── session header rewriting

const SESSION = `{"type":"session","version":3,"id":"11111111-2222-3333-4444-555555555555","timestamp":"2026-07-06T10:00:00.000Z","cwd":"/Users/andrew/Others/pi-port"}\n{"type":"message","cwd":"/Users/andrew/Others/pi-port","text":"hi"}\n{"type":"tool","cwd":"verbatim"}\n`;

test("rewriteSessionHeader: path → label, id preserved, lines 2+ untouched", () => {
	const out = rewriteSessionHeader(SESSION, "pi-port");
	const [l1, ...rest] = out.split("\n");
	const h = JSON.parse(l1);
	assert.equal(h.id, "11111111-2222-3333-4444-555555555555");
	assert.equal(h.cwd, "pi-port");
	assert.equal(h.timestamp, "2026-07-06T10:00:00.000Z");
	assert.equal(h.version, 3);
	// Original key order preserved on line 1.
	assert.equal(l1.startsWith('{"type":"session","version":3,"id":'), true);
	// Lines 2+ byte-identical.
	assert.equal(rest.join("\n"), SESSION.split("\n").slice(1).join("\n"));
});

test("rewriteSessionHeader: label → path restores a local cwd", () => {
	const staged = rewriteSessionHeader(SESSION, "pi-port");
	const restored = rewriteSessionHeader(staged, "D:\\Me\\pi-port");
	const h = JSON.parse(restored.split("\n", 1)[0]);
	assert.equal(h.cwd, "D:\\Me\\pi-port");
	assert.equal(h.id, "11111111-2222-3333-4444-555555555555");
});

test("rewriteSessionHeader: header without trailing newline still works", () => {
	const solo = SESSION.split("\n", 1)[0];
	const out = rewriteSessionHeader(solo, "label");
	assert.equal(JSON.parse(out).cwd, "label");
});

test("readSessionHeader: extracts id/timestamp/cwd; corrupt line yields {}", () => {
	const h = readSessionHeader(SESSION);
	assert.equal(h.id, "11111111-2222-3333-4444-555555555555");
	assert.equal(h.cwd, "/Users/andrew/Others/pi-port");
	assert.deepEqual(readSessionHeader("not json\n"), {});
	assert.deepEqual(readSessionHeader(""), {});
});

// ─────────────────────────────────────────────── conf staging normalization

test("normalizeSettingsForStaging: strips lastChangelogVersion + local-path packages", () => {
	const raw = JSON.stringify({
		lastChangelogVersion: 42,
		theme: "dark",
		packages: [
			"npm:@andrewjacop/pi-port",
			"git:github.com/x/y@v1",
			"D:\\Me\\pi-port",
			"/Users/andrew/hack/local-pkg",
		],
	});
	const out = JSON.parse(normalizeSettingsForStaging(raw));
	assert.equal("lastChangelogVersion" in out, false);
	assert.deepEqual(out.packages, [
		"npm:@andrewjacop/pi-port",
		"git:github.com/x/y@v1",
	]);
	assert.equal(out.theme, "dark");
});

test("normalizeSettingsForStaging: non-JSON passthrough, no packages key kept as-is", () => {
	assert.equal(normalizeSettingsForStaging("not json"), "not json");
	const out = JSON.parse(normalizeSettingsForStaging('{"a":1}'));
	assert.equal("packages" in out, false);
});

test("mergeSettings: incoming keys win, local-only keys stay, incoming abs-path packages dropped", () => {
	const local = {
		theme: "light",
		keepMe: true,
		packages: ["npm:a", "/home/me/local"],
	};
	const incoming = {
		theme: "dark",
		packages: ["npm:b", "/Users/other/local", "npm:a"],
	};
	const { merged, packagesChanged } = mergeSettings(local, incoming);
	assert.equal(merged.theme, "dark");
	assert.equal(merged.keepMe, true);
	// Incoming abs path dropped; local abs path exists on THIS machine and stays.
	assert.deepEqual(merged.packages, ["npm:a", "/home/me/local", "npm:b"]);
	assert.equal(packagesChanged, true);
});

test("mergeSettings: unchanged packages report packagesChanged=false", () => {
	const local = { packages: ["npm:a"] };
	const incoming = { packages: ["npm:a"] };
	const { packagesChanged } = mergeSettings(local, incoming);
	assert.equal(packagesChanged, false);
});

test("detectForeignHome: finds foreign home, ignores local + non-path strings", () => {
	const localHome = "/home/bob";
	assert.equal(
		detectForeignHome({ a: "/Users/alice/x" }, localHome),
		"/Users/alice",
	);
	assert.equal(detectForeignHome({ a: "/home/bob/x" }, localHome), undefined);
	assert.equal(detectForeignHome({ a: "relative" }, localHome), undefined);
	assert.equal(
		detectForeignHome({ "C:\\Users\\carol\\proj": true }, localHome),
		"C:/Users/carol",
	);
});

// ───────────────────────────────────────────────────────── session diffing

async function writeSession(
	dir: string,
	file: string,
	id: string,
	cwd: string,
	body: string,
): Promise<void> {
	await mkdir(dir, { recursive: true });
	await writeFile(
		join(dir, file),
		`{"type":"session","version":3,"id":"${id}","timestamp":"2026-07-06T10:00:00.000Z","cwd":${JSON.stringify(cwd)}}\n${body}`,
	);
}

test("diffSessions: local-only, staged-only, collision, same-content skip", async () => {
	const t = await tmp();
	const bucket = join(t, "bucket");
	const staged = join(t, "staged");
	const LABEL = "myproj";
	await writeSession(bucket, "a.jsonl", "id-a", "/local/path", "one\n");
	await writeSession(bucket, "b.jsonl", "id-b", "/local/path", "two\n");
	await writeSession(bucket, "c.jsonl", "id-c", "/local/path", "three-v1\n");
	await writeSession(staged, "c.jsonl", "id-c", LABEL, "three-v2\n");
	await writeSession(staged, "d.jsonl", "id-d", LABEL, "four\n");
	// Same id + same body, DIFFERENT header cwd (local path vs label) — the
	// normalization must treat this as in sync, not a collision.
	await writeSession(bucket, "e.jsonl", "id-e", "/local/path", "five\n");
	await writeSession(staged, "e.jsonl", "id-e", LABEL, "five\n");

	const diff = await diffSessions(bucket, staged, LABEL);
	assert.deepEqual(diff.localOnly.map((s) => s.file).sort(), [
		"a.jsonl",
		"b.jsonl",
	]);
	assert.deepEqual(
		diff.stagedOnly.map((s) => s.file),
		["d.jsonl"],
	);
	assert.deepEqual(
		diff.collisions.map((s) => s.file),
		["c.jsonl"],
	);
});

test("diffSessions: missing dirs are empty diffs, not errors", async () => {
	const t = await tmp();
	const diff = await diffSessions(join(t, "nope1"), join(t, "nope2"), "x");
	assert.deepEqual(diff, { localOnly: [], stagedOnly: [], collisions: [] });
});

test("diffSessions: staged copy of identical content is in sync (header-rewrite regression)", async () => {
	// The user-hit bug: after a successful push, every session showed as
	// "same id, different content" because raw-byte compare sees the header
	// cwd difference (abs path vs label) that staging introduces by design.
	const t = await tmp();
	const bucket = join(t, "bucket");
	const stagedDir = join(t, "staged");
	const LABEL = "pi-port";
	await writeSession(bucket, "s1.jsonl", "id-1", "D:\\Me\\pi-port", "hello\n");
	await writeSession(bucket, "s2.jsonl", "id-2", "D:\\Me\\pi-port", "world\n");
	// Real staging transform, exactly what a push does:
	await stageSession(
		join(bucket, "s1.jsonl"),
		join(stagedDir, "s1.jsonl"),
		LABEL,
	);
	await stageSession(
		join(bucket, "s2.jsonl"),
		join(stagedDir, "s2.jsonl"),
		LABEL,
	);

	const diff = await diffSessions(bucket, stagedDir, LABEL);
	assert.equal(diff.localOnly.length, 0);
	assert.equal(diff.stagedOnly.length, 0);
	assert.equal(diff.collisions.length, 0);
});

// ───────────────────────────────────────────── session stage/restore (IO)

test("stageSession + restoreSession round-trip: cwd label ⇄ local path", async () => {
	const t = await tmp();
	await writeSession(
		join(t, "bucket"),
		"s.jsonl",
		"id-s",
		"/Users/andrew/proj",
		"payload\n",
	);
	const stagedFile = join(
		t,
		"staged",
		"projects",
		"myproj",
		"sessions",
		"s.jsonl",
	);
	assert.equal(
		await stageSession(join(t, "bucket", "s.jsonl"), stagedFile, "myproj"),
		true,
	);
	assert.equal(
		JSON.parse((await readFile(stagedFile, "utf8")).split("\n", 1)[0]).cwd,
		"myproj",
	);

	const bucket2 = join(t, "bucket2");
	assert.equal(
		await restoreSession(stagedFile, bucket2, "/home/bob/proj"),
		"written",
	);
	const restored = await readFile(join(bucket2, "s.jsonl"), "utf8");
	assert.equal(JSON.parse(restored.split("\n", 1)[0]).cwd, "/home/bob/proj");
	// Idempotent: restoring again with same content skips.
	assert.equal(
		await restoreSession(stagedFile, bucket2, "/home/bob/proj"),
		"skipped",
	);
});

test("stageSession: gate veto skips the write entirely", async () => {
	const t = await tmp();
	await writeSession(
		join(t, "bucket"),
		"x.jsonl",
		"id-x",
		"/p",
		"ghp_abcdefghijklmnopqrst\n",
	);
	const stagedFile = join(t, "staged", "x.jsonl");
	const blocked = await stageSession(
		join(t, "bucket", "x.jsonl"),
		stagedFile,
		"l",
		async () => false,
	);
	assert.equal(blocked, false);
	await assert.rejects(() => readFile(stagedFile));
});

// ─────────────────────────────────────────────── conf stage/diff/apply (IO)

async function seedAgent(t: string): Promise<string> {
	const agent = join(t, "agent");
	await mkdir(join(agent, "skills", "api-design"), { recursive: true });
	await writeFile(
		join(agent, "settings.json"),
		JSON.stringify({
			lastChangelogVersion: 9,
			model: "opus",
			packages: ["npm:@andrewjacop/pi-port", "/Users/andrew/dev/local-pkg"],
		}),
	);
	await writeFile(join(agent, "keybindings.json"), "{}\n");
	await writeFile(join(agent, "skills", "api-design", "SKILL.md"), "# skill\n");
	return agent;
}

test("stageConf + diffConf: normalized staging, then local == staged", async () => {
	const t = await tmp();
	const agent = await seedAgent(t);
	const staging = join(t, "staging", "config");
	const res = await stageConf(agent, staging);
	assert.deepEqual(res.staged.sort(), [
		"keybindings.json",
		"settings.json",
		"skills/api-design/SKILL.md",
	]);

	const stagedSettings = JSON.parse(
		await readFile(join(staging, "settings.json"), "utf8"),
	);
	assert.equal("lastChangelogVersion" in stagedSettings, false);
	assert.deepEqual(stagedSettings.packages, ["npm:@andrewjacop/pi-port"]);

	const diff = await diffConf(agent, staging);
	assert.deepEqual(diff, { agentOnly: [], stagingOnly: [], differs: [] });
});

test("diffConf: detects local edits, staging-only, and drift", async () => {
	const t = await tmp();
	const agent = await seedAgent(t);
	const staging = join(t, "staging", "config");
	await stageConf(agent, staging);

	// Local edit after staging → differs.
	await writeFile(
		join(agent, "settings.json"),
		JSON.stringify({ model: "sonnet" }),
	);
	// New local file → agentOnly.
	await writeFile(join(agent, "trust.json"), "{}\n");
	// Staging-only file → stagingOnly.
	await writeFile(join(staging, "skills", "other.md"), "x\n");

	const diff = await diffConf(agent, staging);
	assert.deepEqual(diff.differs, ["settings.json"]);
	assert.deepEqual(diff.agentOnly, ["trust.json"]);
	assert.deepEqual(diff.stagingOnly, ["skills/other.md"]);
});

test("applyConf: merge, backups, packagesChanged, home remap", async () => {
	const t = await tmp();
	const agent = await seedAgent(t);
	// Local trust + settings get overwritten → must be backed up.
	await writeFile(
		join(agent, "trust.json"),
		JSON.stringify({ "/home/bob/proj": true }),
	);
	const staging = join(t, "staging", "config");
	await mkdir(staging, { recursive: true });
	await writeFile(
		join(staging, "settings.json"),
		JSON.stringify({
			theme: "dark",
			packages: ["npm:z", "/Users/alice/dev/pkg"],
		}),
	);
	await writeFile(
		join(staging, "trust.json"),
		JSON.stringify({ "/Users/alice/old": true }),
	);

	const out = await applyConf(agent, staging, "/home/bob");
	assert.equal(out.packagesChanged, true);
	const merged = JSON.parse(
		await readFile(join(agent, "settings.json"), "utf8"),
	);
	assert.equal(merged.theme, "dark");
	assert.equal(merged.model, "opus"); // local-only key survives
	assert.deepEqual(
		merged.packages.sort(),
		["/Users/andrew/dev/local-pkg", "npm:@andrewjacop/pi-port", "npm:z"].sort(),
	); // local abs pkg stays, incoming abs pkg dropped
	// Incoming abs-path package dropped; incoming home remapped to local.
	const trust = JSON.parse(await readFile(join(agent, "trust.json"), "utf8"));
	assert.deepEqual(trust, { "/home/bob/old": true });
	// Backups exist.
	await readFile(join(agent, "settings.json.preimport.bak"));
	await readFile(join(agent, "trust.json.preimport.bak"));
});
