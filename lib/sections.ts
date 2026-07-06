// Section table: what can be exported/imported, where it lives, defaults.
// A section maps to either a file or directory under ~/.pi/agent/.

import { statSync, readdirSync } from "node:fs";
import { join } from "node:path";

export type SectionId =
	| "settings"
	| "auth"
	| "trust"
	| "skills"
	| "git-packages"
	| "bin"
	| "memory"
	| "projects-memory"
	| "sessions";

export interface SectionDef {
	id: SectionId;
	label: string;
	/** Path relative to ~/.pi/agent/. */
	path: string;
	/** "file" or "dir". */
	kind: "file" | "dir";
	/** Default-checked in the export wizard. */
	defaultExport: boolean;
	/** True if the section contains secrets (shows a warning when toggled). */
	secret?: boolean;
	/** Optional: human-readable note shown in the wizard. */
	note?: string;
}

export const SECTIONS: readonly SectionDef[] = [
	{
		id: "settings",
		label: "Settings",
		path: "settings.json",
		kind: "file",
		defaultExport: true,
		note: "providers, model, package list, theme",
	},
	{
		id: "auth",
		label: "Auth (API keys)",
		path: "auth.json",
		kind: "file",
		defaultExport: false,
		secret: true,
		note: "contains API keys in plaintext",
	},
	{
		id: "trust",
		label: "Trusted dirs",
		path: "trust.json",
		kind: "file",
		defaultExport: true,
	},
	{
		id: "skills",
		label: "Skills",
		path: "skills",
		kind: "dir",
		defaultExport: true,
	},
	{
		id: "git-packages",
		label: "Git packages",
		path: "git",
		kind: "dir",
		defaultExport: true,
	},
	{
		id: "bin",
		label: "Binaries",
		path: "bin",
		kind: "dir",
		defaultExport: true,
		note: "may contain arch-specific binaries",
	},
	{
		id: "memory",
		label: "Hermes memory",
		path: "pi-hermes-memory",
		kind: "dir",
		defaultExport: false,
		note: "large; only if you want memory continuity",
	},
	{
		id: "projects-memory",
		label: "Projects memory",
		path: "projects-memory",
		kind: "dir",
		defaultExport: false,
	},
	{
		id: "sessions",
		label: "Sessions",
		path: "sessions",
		kind: "dir",
		defaultExport: false,
		note: "large; only if you want history",
	},
];

export function getSection(id: SectionId): SectionDef {
	const s = SECTIONS.find((x) => x.id === id);
	if (!s) throw new Error(`unknown section: ${id}`);
	return s;
}

/** Return ids of sections that currently exist on disk under agentDir. */
export function detectSections(agentDir: string): SectionId[] {
	const present: SectionId[] = [];
	for (const s of SECTIONS) {
		const full = join(agentDir, s.path);
		try {
			statSync(full);
			present.push(s.id);
		} catch {
			// absent
		}
	}
	return present;
}

/** Approximate size in bytes of a section (0 if absent). */
export function sectionSize(agentDir: string, id: SectionId): number {
	const s = getSection(id);
	const full = join(agentDir, s.path);
	let total = 0;
	const walk = (p: string): void => {
		let st;
		try {
			st = statSync(p);
		} catch {
			return;
		}
		if (st.isFile()) {
			total += st.size;
			return;
		}
		// dir: cheap recursive sum. ponytail: fine for the small trees we touch.
		try {
			for (const entry of readdirSync(p)) walk(join(p, entry));
		} catch {
			// permission etc — ignore
		}
	};
	walk(full);
	return total;
}
