// remap.ts — pure path-rewriting helpers used on import.
// The only non-trivial logic in pi-port, so it's the only thing unit-tested.
//
// Strategy: any absolute path starting with `sourceHome` gets its prefix
// swapped to `targetHome`. Anything else (e.g. /opt/foo) is left untouched
// and surfaced to the caller (the wizard) for manual mapping. We do NOT
// silently rewrite roots we don't recognize — that's how trust breaks.

/** True if `p` looks like an absolute filesystem path. */
export function isAbsolutePath(p: string): boolean {
	// POSIX absolute, or Windows drive-absolute (C:\) or UNC (\\).
	return /^\/|^([a-zA-Z]:[\\/])|^\\\\/.test(p);
}

/**
 * Rewrite a single path: if it starts with sourceHome, swap the prefix.
 * Returns the original string for non-matching paths (caller decides).
 */
export function remapPath(
	p: string,
	sourceHome: string,
	targetHome: string,
): string {
	if (typeof p !== "string") return p;
	if (!isAbsolutePath(p)) return p;
	const norm = (s: string) => s.replace(/\\/g, "/").replace(/\/+$/, "");
	const src = norm(sourceHome);
	if (p === src) return targetHome;
	// Match src followed by a separator, on either slash style.
	const pNorm = p.replace(/\\/g, "/");
	if (pNorm === src || pNorm.startsWith(src + "/")) {
		const tail = pNorm.slice(src.length); // includes leading "/" or is ""
		// Follow the target's own separator style — a posix target must never
		// receive backslashes just because the host is Windows (or vice versa).
		const sepStyle = targetHome.includes("\\") ? "\\" : "/";
		return targetHome + tail.replace(/\//g, sepStyle);
	}
	return p;
}

/**
 * Deep-walk an object/array, rewriting any string value that looks like an
 * absolute path under sourceHome. Non-path strings, numbers, booleans are
 * left alone. Returns a new object (does not mutate input).
 *
 * Used on parsed trust.json (keys AND values), session JSON (cwd fields),
 * projects-memory metadata.
 */
export function remapObject<T>(
	obj: T,
	sourceHome: string,
	targetHome: string,
): T {
	if (sourceHome === targetHome) return obj;
	if (typeof obj === "string")
		return remapPath(obj, sourceHome, targetHome) as unknown as T;
	if (Array.isArray(obj))
		return obj.map((x) => remapObject(x, sourceHome, targetHome)) as unknown as T;
	if (obj && typeof obj === "object") {
		const out: Record<string, unknown> = {};
		for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
			// Keys can be paths too (trust.json shape: { "/Users/x": true }).
			const remappedKey = remapPath(k, sourceHome, targetHome);
			out[remappedKey] = remapObject(v, sourceHome, targetHome);
		}
		return out as unknown as T;
	}
	return obj;
}

/**
 * Collect absolute-path strings under `obj` that do NOT start with sourceHome.
 * The wizard shows these for manual mapping. Returns deduplicated.
 */
export function collectUnknownRoots(
	obj: unknown,
	sourceHome: string,
): string[] {
	const found = new Set<string>();
	const norm = (s: string) => s.replace(/\\/g, "/").replace(/\/+$/, "");
	const src = norm(sourceHome);
	const visit = (o: unknown): void => {
		if (typeof o === "string") {
			if (isAbsolutePath(o)) {
				const oNorm = o.replace(/\\/g, "/");
				if (oNorm !== src && !oNorm.startsWith(src + "/")) {
					// Surface the top-level root, not the full path — keeps the list short.
					const parts = oNorm.split("/").filter(Boolean);
					const root = "/" + (parts[0] ?? "");
					found.add(root);
				}
			}
		} else if (Array.isArray(o)) {
			o.forEach(visit);
		} else if (o && typeof o === "object") {
			for (const [k, v] of Object.entries(o as Record<string, unknown>)) {
				if (isAbsolutePath(k)) {
					const kNorm = k.replace(/\\/g, "/");
					if (kNorm !== src && !kNorm.startsWith(src + "/")) {
						const parts = kNorm.split("/").filter(Boolean);
						const root = "/" + (parts[0] ?? "");
						found.add(root);
					}
				}
				visit(v);
			}
		}
	};
	visit(obj);
	return [...found].sort();
}
