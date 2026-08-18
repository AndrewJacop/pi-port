// Unit tests for the secret scan: hit + clean, per pattern.
// Run with: npm test (-> node --test --import tsx test/)
import { test } from "node:test";
import assert from "node:assert/strict";
import { scanText, PATTERNS } from "../lib/scan.ts";

test("scanText: clean content hits nothing", () => {
	assert.deepEqual(
		scanText('{"cwd":"/home/bob/proj","model":"opus"}\nhello world\n'),
		[],
	);
});

test("scanText: PEM private key", () => {
	assert.deepEqual(scanText("-----BEGIN RSA PRIVATE KEY-----\nabc\n"), [
		"PEM private key",
	]);
});

test("scanText: GitHub token", () => {
	assert.deepEqual(scanText("token is ghp_0123456789abcdefXYZ done"), [
		"GitHub token (ghp_/gho_)",
	]);
});

test("scanText: short gh token does not match", () => {
	// <16 chars after the prefix is noise, not a token.
	assert.deepEqual(scanText("see ghp_short"), []);
});

test("scanText: sk- style key (assignment keyword absent → only sk- fires)", () => {
	assert.deepEqual(scanText('key = "sk-proj-0123456789abcdef"'), [
		"API key (sk-…)",
	]);
});

test("scanText: credential assignments to 12+ char values", () => {
	assert.equal(scanText('api_key: "abcdefgh123456"').length > 0, true);
	assert.equal(scanText("password = hunter2secret12").length > 0, true);
	assert.equal(scanText('client_secret="0123456789ab"').length > 0, true);
});

test("scanText: short credential values do not match", () => {
	assert.deepEqual(scanText('password: "short"'), []);
	assert.deepEqual(scanText("token=abc"), []);
});

test("scanText: hit names are deduped and stable (PATTERNS declaration order)", () => {
	const hits = scanText(
		"sk-abcdefghijklmnopqrst token=abcdefghijklmnopqrstuvwxyz1234",
	);
	assert.deepEqual(hits, [
		"API key (sk-…)",
		"credential assignment (api_key/token/password/secret)",
	]);
});

test("PATTERNS: the spec's four pattern families exist", () => {
	assert.equal(PATTERNS.length, 4);
});
