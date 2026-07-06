// manifest.ts — backup manifest types, read/write, version gate, checksums.
// The manifest lives at the root of every .pi-backup archive and describes
// what's inside, where it came from, and how to verify it.

import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import type { SectionId } from "./sections.ts";

/** Backup format version. Bump only when the on-disk layout changes. */
export const FORMAT_VERSION = 1;

export interface ManifestSource {
	os: NodeJS.Platform;
	username: string;
	home: string;
	hostname: string;
}

export interface Manifest {
	format: "pi-backup";
	version: number;
	createdAt: string;
	piVersion?: string;
	source: ManifestSource;
	/** Section ids actually included in this archive. */
	sections: SectionId[];
	/** sha256:<hex> per member path (relative to archive root). */
	checksums: Record<string, string>;
	exportedBy: string;
}

/** Latest pi version known at export time; read lazily, may be undefined. */
export function getPiVersion(): string | undefined {
	// ponytail: read from the agent's settings if present, else undefined.
	// Not critical for restore; informational only.
	try {
		// eslint-disable-next-line @typescript-eslint/no-require-imports
		const pkg = require("@earendil-works/pi-coding-agent/package.json");
		return pkg.version;
	} catch {
		return undefined;
	}
}

export function emptyManifest(source: ManifestSource): Manifest {
	return {
		format: "pi-backup",
		version: FORMAT_VERSION,
		createdAt: new Date().toISOString(),
		piVersion: getPiVersion(),
		source,
		sections: [],
		checksums: {},
		exportedBy: `pi-port@${getSelfVersion()}`,
	};
}

function getSelfVersion(): string {
	try {
		// eslint-disable-next-line @typescript-eslint/no-require-imports
		const pkg = require("../../package.json");
		return pkg.version ?? "0.0.0";
	} catch {
		return "0.0.0";
	}
}

export async function writeManifest(path: string, m: Manifest): Promise<void> {
	await writeFile(path, JSON.stringify(m, null, 2) + "\n", "utf8");
}

export async function readManifest(path: string): Promise<Manifest> {
	const raw = await readFile(path, "utf8");
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch (e) {
		throw new Error(
			`manifest: invalid JSON in ${path}: ${(e as Error).message}`,
		);
	}
	validateManifest(parsed);
	return parsed;
}

export function validateManifest(m: unknown): asserts m is Manifest {
	if (typeof m !== "object" || m === null)
		throw new Error("manifest: not an object");
	const o = m as Record<string, unknown>;
	if (o.format !== "pi-backup")
		throw new Error(`manifest: bad format "${o.format}"`);
	if (typeof o.version !== "number")
		throw new Error("manifest: missing version");
	if (o.version > FORMAT_VERSION) {
		throw new Error(
			`manifest: version ${o.version} is newer than supported (${FORMAT_VERSION}). Upgrade the pi-port plugin.`,
		);
	}
	if (typeof o.createdAt !== "string")
		throw new Error("manifest: missing createdAt");
	if (typeof o.source !== "object" || o.source === null)
		throw new Error("manifest: missing source");
}

export function sha256Hex(buf: Buffer | string): string {
	return createHash("sha256").update(buf).digest("hex");
}

/** Compute checksum for a file path on disk. */
export async function sha256File(path: string): Promise<string> {
	const buf = await readFile(path);
	return sha256Hex(buf);
}
