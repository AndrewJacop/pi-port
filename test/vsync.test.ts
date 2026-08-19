// Unit tests for the vsync wrapper: ensureProject + addPaths with an
// injected fake runner (no real vsync CLI involved).
// Run with: npm test (-> node --test --import tsx test/)
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	addPaths,
	ensureProject,
	meetsFloor,
	readTrackedPaths,
} from "../lib/vsync.ts";
import type { VsyncRunner } from "../lib/vsync.ts";

async function tmp(): Promise<string> {
	return mkdtemp(join(tmpdir(), "pi-port-vsync-"));
}

test("meetsFloor: 0.6.1 is the floor (--config + stdin file lists)", () => {
	assert.equal(meetsFloor("0.6.1"), true);
	assert.equal(meetsFloor("0.6.2"), true);
	assert.equal(meetsFloor("0.7.0"), true);
	assert.equal(meetsFloor("1.0.0"), true);
	assert.equal(meetsFloor("0.6"), false); // missing patch counts as .0
	assert.equal(meetsFloor("0.6.0"), false);
	assert.equal(meetsFloor("0.5.9"), false);
	assert.equal(meetsFloor(null), false);
	assert.equal(meetsFloor(undefined), false);
});

test("readTrackedPaths: null without manifest, set with one", async () => {
	const t = await tmp();
	assert.equal(await readTrackedPaths(t), null);
	await mkdir(join(t, ".vsync"), { recursive: true });
	await writeFile(
		join(t, ".vsync", "manifest.json"),
		'{"projectId":"pi-port","backend":"s3","files":[{"path":"config/settings.json"}]}',
	);
	assert.deepEqual(await readTrackedPaths(t), new Set(["config/settings.json"]));
});

test("ensureProject: existing manifest → ready, runner never called", async () => {
	const t = await tmp();
	await mkdir(join(t, ".vsync"), { recursive: true });
	await writeFile(join(t, ".vsync", "manifest.json"), '{"files":[]}');
	let calls = 0;
	const run: VsyncRunner = async () => {
		calls++;
		return {};
	};
	assert.equal(await ensureProject(t, run), "ready");
	assert.equal(calls, 0);
});

test("ensureProject: manifest missing, link succeeds → linked", async () => {
	const t = await tmp();
	const seen: string[][] = [];
	const run: VsyncRunner = async (args) => {
		seen.push(args);
		return {};
	};
	assert.equal(await ensureProject(t, run), "linked");
	assert.deepEqual(seen, [["link", "pi-port", "--pull", "--json"]]);
});

test("ensureProject: link fails → init with enumerated staged files", async () => {
	const t = await tmp();
	// Pre-staged content (machine A) must be piped into `init --files -`.
	await mkdir(join(t, "config", "skills"), { recursive: true });
	await writeFile(join(t, "config", "settings.json"), "{}");
	await writeFile(join(t, "config", "skills", "SKILL.md"), "x");
	await mkdir(join(t, ".vsync"), { recursive: true });
	await writeFile(join(t, ".vsync", "manifest.json"), "STALE-IGNORED"); // still "missing" per readTrackedPaths? no — it exists…
	const seen: Array<{ args: string[]; input?: string }> = [];
	const run: VsyncRunner = async (args, opts) => {
		seen.push({ args, input: opts?.input });
		if (args[0] === "link")
			throw new Error("no files found for project 'pi-port'");
		return {};
	};
	// Remove the stale manifest so ensureProject sees the project as new.
	const { rm } = await import("node:fs/promises");
	await rm(join(t, ".vsync", "manifest.json"));
	assert.equal(await ensureProject(t, run), "initialized");
	assert.equal(seen.length, 2);
	assert.equal(seen[0].args[0], "link");
	assert.deepEqual(seen[1], {
		args: [
			"init",
			"--project-id",
			"pi-port",
			"--json",
			"--files",
			"-",
		],
		input: "config/settings.json\nconfig/skills/SKILL.md\n",
	});
});

test("ensureProject: link AND init fail → error carries the setup hint", async () => {
	const t = await tmp();
	const run: VsyncRunner = async (args) => {
		if (args[0] === "link") throw new Error("No files found");
		throw new Error(
			"Non-interactive init: no default backend configured — pass --backend <name>",
		);
	};
	await assert.rejects(
		() => ensureProject(t, run),
		/no default backend configured.*\/pi-port-setup/,
	);
});

test("addPaths: only untracked paths reach vsync add (via stdin)", async () => {
	const t = await tmp();
	await mkdir(join(t, ".vsync"), { recursive: true });
	await writeFile(
		join(t, ".vsync", "manifest.json"),
		'{"files":[{"path":"config/settings.json"}]}',
	);
	const seen: Array<{ args: string[]; input?: string }> = [];
	const run: VsyncRunner = async (args, opts) => {
		seen.push({ args, input: opts?.input });
		return { added: [] };
	};
	const added = await addPaths(
		t,
		["config/settings.json", "config/trust.json"],
		run,
	);
	assert.deepEqual(added, ["config/trust.json"]);
	assert.deepEqual(seen, [
		{ args: ["add", "-", "--json"], input: "config/trust.json\n" },
	]);
});

test("addPaths: nothing new → no vsync call", async () => {
	const t = await tmp();
	await mkdir(join(t, ".vsync"), { recursive: true });
	await writeFile(
		join(t, ".vsync", "manifest.json"),
		'{"files":[{"path":"a"}]}',
	);
	let calls = 0;
	const run: VsyncRunner = async () => {
		calls++;
		return {};
	};
	assert.deepEqual(await addPaths(t, ["a"], run), []);
	assert.equal(calls, 0);
});
