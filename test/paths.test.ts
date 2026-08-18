// Unit tests for cloud-sync path translation (bucket mangling).
// Run with: npm test (-> node --test --import tsx test/)
import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import {
	mangleBucket,
	unmangleBucket,
	sessionBucket,
	stagingRoot,
	stagingConfig,
	stagingSessions,
} from "../lib/paths.ts";

test("mangleBucket: verified Windows example", () => {
	assert.equal(mangleBucket("D:\\Me\\pi-port"), "--D--Me-pi-port--");
});

test("mangleBucket: verified macOS example", () => {
	assert.equal(
		mangleBucket("/Users/andrew/Others/pi-port"),
		"--Users-andrew-Others-pi-port--",
	);
});

test("mangleBucket: posix root-ish and empty-ish edge cases", () => {
	// pi strips ONE leading separator before replacing: "/" → empty inner.
	assert.equal(mangleBucket("/"), "----");
	assert.equal(mangleBucket("C:\\"), "--C----");
	assert.equal(mangleBucket("relative"), "--relative--");
});

test("unmangleBucket: best-effort inverse round-trips separator-free names", () => {
	// Inverse is lossy by design; on separator-free names it recovers the input.
	assert.equal(unmangleBucket(mangleBucket("/home/bob/work")), "/home/bob/work");
	assert.equal(
		unmangleBucket(mangleBucket("/Users/andrew/piport"), false),
		"/Users/andrew/piport",
	);
});

test("unmangleBucket: windows style restores drive + backslashes (lossy)", () => {
	assert.equal(unmangleBucket("--D--Me-piport--", true), "D:\\Me\\piport");
});

test("unmangleBucket: strips wrapper of already-bare names", () => {
	assert.equal(unmangleBucket("--abc--"), "/abc");
});

test("bucket/dir helpers compose the documented layout", () => {
	const ad = join("/home/bob/.pi/agent"); // join → platform separators
	assert.equal(
		sessionBucket(ad, "/home/bob/proj"),
		join(ad, "sessions", "--home-bob-proj--"),
	);
	assert.equal(stagingRoot(ad), join(ad, "pi-port-sync"));
	assert.equal(stagingConfig(ad), join(ad, "pi-port-sync", "config"));
	assert.equal(
		stagingSessions(ad, "myproj"),
		join(ad, "pi-port-sync", "projects", "myproj", "sessions"),
	);
});

test("mangle→unmangle: bucket for a cwd with hyphens stays a stable identity", () => {
	// Two different cwds may mangle identically; the sync flow always uses
	// mangle(real cwd), never unmangle, so this only pins current behavior.
	assert.equal(mangleBucket("/a/b-c"), mangleBucket("/a/b\\c"));
});
