// bindings.ts — machine-local map of project label ↔ absolute path.
//
// Labels are user-chosen project identities used as directory names in the
// staging tree and as the cwd value inside staged session headers, because
// pi's real session buckets encode absolute machine-specific paths. The
// bindings file is LOCAL-ONLY and never synced.

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";

export type Bindings = Record<string, string>;

/** Load bindings from disk; missing/corrupt file yields {} (re-bind on ask). */
export async function loadBindings(path: string): Promise<Bindings> {
	try {
		const parsed = JSON.parse(await readFile(path, "utf8"));
		if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
			return parsed as Bindings;
		}
	} catch {
		/* missing or corrupt — start fresh */
	}
	return {};
}

export async function saveBindings(path: string, b: Bindings): Promise<void> {
	await mkdir(dirname(path), { recursive: true });
	await writeFile(path, JSON.stringify(b, null, 2) + "\n", "utf8");
}

/**
 * Validate a label: non-empty, and a single safe path segment (it names a
 * directory under the staging tree and appears in vsync `--files` lists,
 * which are comma-separated — so no separators and no commas).
 * Returns an error message, or null when valid.
 */
export function validateLabel(label: string): string | null {
	const t = label.trim();
	if (!t) return "Label is required";
	if (/[\\/]/.test(t)) return "Label must not contain '/' or '\\'";
	if (/[,]/.test(t)) return "Label must not contain ','";
	if (/[:]/.test(t)) return "Label must not contain ':'";
	if (t === "." || t === "..") return "Label must not be '.' or '..'";
	return null;
}

/** Find the label bound to an absolute path, if any. */
export function labelForPath(b: Bindings, absPath: string): string | undefined {
	const target = resolve(absPath);
	for (const [label, path] of Object.entries(b)) {
		if (resolve(path) === target) return label;
	}
	return undefined;
}

/**
 * Bind label → path. Returns an error message when the label is already
 * bound to a DIFFERENT path (the caller should ask for another label);
 * null on success. `b` is mutated in place.
 */
export function bindLabel(
	b: Bindings,
	label: string,
	absPath: string,
): string | null {
	const existing = b[label];
	if (existing !== undefined && resolve(existing) !== resolve(absPath)) {
		return `Label '${label}' is already bound to ${existing} — pick another`;
	}
	b[label] = absPath;
	return null;
}
