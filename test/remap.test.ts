// Unit tests for the only non-trivial logic in pi-port: path remapping.
// Run with: npm test (-> node --test --import tsx test/)
import { test } from "node:test";
import assert from "node:assert/strict";
import {
	remapPath,
	remapObject,
	collectUnknownRoots,
	isAbsolutePath,
} from "../lib/remap.ts";

test("remapPath: swaps sourceHome prefix", () => {
	assert.equal(
		remapPath("/Users/alice/.pi", "/Users/alice", "/home/bob"),
		"/home/bob/.pi",
	);
});

test("remapPath: exact home match returns target", () => {
	assert.equal(
		remapPath("/Users/alice", "/Users/alice", "/home/bob"),
		"/home/bob",
	);
});

test("remapPath: non-matching absolute path is left untouched", () => {
	assert.equal(
		remapPath("/opt/projects/foo", "/Users/alice", "/home/bob"),
		"/opt/projects/foo",
	);
});

test("remapPath: relative paths are not treated as paths", () => {
	assert.equal(
		remapPath("relative/path", "/Users/alice", "/home/bob"),
		"relative/path",
	);
	assert.equal(remapPath("just-a-string", "/x", "/y"), "just-a-string");
});

test("remapPath: trailing slash normalization", () => {
	// Source home with trailing slash should still match.
	assert.equal(
		remapPath("/Users/alice/foo", "/Users/alice/", "/home/bob"),
		"/home/bob/foo",
	);
});

test("isAbsolutePath: detects absolute, rejects relative", () => {
	assert.equal(isAbsolutePath("/usr/local"), true);
	assert.equal(isAbsolutePath("usr/local"), false);
	assert.equal(isAbsolutePath("./foo"), false);
	assert.equal(isAbsolutePath("C:\\"), true); // windows drive-absolute
});

test("remapObject: rewrites trust.json shape (path keys)", () => {
	const trust = {
		"/Users/alice": true,
		"/Users/alice/projects/foo": true,
		"/opt/shared": true,
	};
	const out = remapObject(trust, "/Users/alice", "/home/bob");
	assert.deepEqual(out, {
		"/home/bob": true,
		"/home/bob/projects/foo": true,
		"/opt/shared": true, // unknown root — left alone
	});
});

test("remapObject: rewrites session cwd field", () => {
	const session = {
		cwd: "/Users/alice/work/repo",
		entries: [{ type: "message", cwd: "/Users/alice/work/repo" }],
		name: "session-1", // non-path string, untouched
	};
	const out = remapObject(session, "/Users/alice", "/home/bob");
	assert.equal(out.cwd, "/home/bob/work/repo");
	assert.equal(out.entries[0].cwd, "/home/bob/work/repo");
	assert.equal(out.name, "session-1");
});

test("remapObject: no-op when sourceHome === targetHome", () => {
	const obj = { cwd: "/Users/alice/x" };
	assert.equal(remapObject(obj, "/Users/alice", "/Users/alice"), obj);
});

test("remapObject: handles nested arrays and objects", () => {
	const obj = {
		a: ["/Users/alice/1", { b: "/Users/alice/2" }, "string"],
	};
	const out = remapObject(obj, "/Users/alice", "/home/bob");
	assert.deepEqual(out, {
		a: ["/home/bob/1", { b: "/home/bob/2" }, "string"],
	});
});

test("remapObject: does not mutate input", () => {
	const obj = { cwd: "/Users/alice/x" };
	remapObject(obj, "/Users/alice", "/home/bob");
	assert.equal(obj.cwd, "/Users/alice/x"); // unchanged
});

test("collectUnknownRoots: surfaces non-home absolute paths", () => {
	const obj = {
		"/Users/alice": true,
		"/opt/shared/proj": true,
		"/var/data": true,
		cwd: "/Users/alice/x",
	};
	const roots = collectUnknownRoots(obj, "/Users/alice");
	assert.deepEqual(roots, ["/opt", "/var"]);
});

test("collectUnknownRoots: empty when everything is under home", () => {
	const obj = { cwd: "/Users/alice/x", "/Users/alice/y": true };
	assert.deepEqual(collectUnknownRoots(obj, "/Users/alice"), []);
});
