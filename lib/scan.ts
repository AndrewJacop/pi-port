// scan.ts — local secret-pattern scan run on every cloud push.
//
// Deliberately dumb: a handful of regexes, node stdlib only, zero
// backend-conditional logic. On a hit the caller shows file + pattern
// NAMES (never values) and asks; the answer is never remembered.

import { readFile } from "node:fs/promises";

export interface ScanPattern {
	name: string;
	re: RegExp;
}

/** Patterns: PEM private keys, GitHub tokens, sk- keys, credential assignments. */
export const PATTERNS: ScanPattern[] = [
	{
		name: "PEM private key",
		re: /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/,
	},
	{
		name: "GitHub token (ghp_/gho_)",
		re: /\bgh[pou]_[A-Za-z0-9]{16,}/,
	},
	{
		name: "API key (sk-…)",
		re: /\bsk-[A-Za-z0-9_-]{16,}/,
	},
	{
		name: "credential assignment (api_key/token/password/secret)",
		re: /\b(?:api_key|apikey|token|password|secret|client_secret)\b\s*[:=]\s*["']?[^\s"']{12,}/i,
	},
];

/**
 * Scan text content; returns the names of patterns that hit (deduped,
 * stable order). Binary-ish content degrades to no-hit — the regexes
 * simply won't match.
 */
export function scanText(text: string): string[] {
	const hits: string[] = [];
	for (const { name, re } of PATTERNS) {
		if (re.test(text)) hits.push(name);
	}
	return hits;
}

/** Read a file (utf8) and scan it. Unreadable file → no hits (caller's push will surface the IO error). */
export async function scanFile(path: string): Promise<string[]> {
	try {
		return scanText(await readFile(path, "utf8"));
	} catch {
		return [];
	}
}
