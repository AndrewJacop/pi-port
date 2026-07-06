// archive.ts — tar create/extract via the system `tar` binary.
// macOS ships bsdtar, Linux GNU tar; both accept czf/xzf with the same flags
// for our needs. Windows has no system tar pre-Win10 1803 — we warn and bail.

import { spawn } from "node:child_process";
import {
	mkdir,
	mkdtemp,
	readFile,
	writeFile,
	rm,
	access,
} from "node:fs/promises";
import { tmpdir, platform } from "node:os";
import { join, dirname } from "node:path";
import {
	type Manifest,
	readManifest,
	writeManifest,
	sha256File,
	emptyManifest,
} from "./manifest.ts";
import { getSection, type SectionId } from "./sections.ts";
import { remapObject } from "./remap.ts";

export class ArchiveError extends Error {}

function assertTarAvailable(): void {
	if (platform() === "win32") {
		// ponytail: Win10 1803+ ships bsdtar, but detection is fiddly; v0.2 will
		// add a node:zlib fallback. For now, surface a clear error.
		throw new ArchiveError(
			"pi-port v0.1 does not support Windows (no reliable system tar). Track v0.2 for a native fallback.",
		);
	}
}

/** Run a command and reject on non-zero exit, surfacing stderr. */
function run(
	cmd: string,
	args: string[],
	cwd?: string,
): Promise<{ stdout: string; stderr: string }> {
	return new Promise((resolve, reject) => {
		const child = spawn(cmd, args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
		let stdout = "";
		let stderr = "";
		child.stdout.on("data", (d) => (stdout += d));
		child.stderr.on("data", (d) => (stderr += d));
		child.on("error", reject);
		child.on("close", (code) => {
			if (code === 0) resolve({ stdout, stderr });
			else reject(new ArchiveError(`tar exited ${code}: ${stderr || stdout}`));
		});
	});
}

export interface CreateBackupOptions {
	agentDir: string;
	/** Selected section ids — must exist on disk. */
	sections: SectionId[];
	source: Manifest["source"];
	outPath: string;
}

/**
 * Build a .pi-backup tarball. Writes manifest.json (with per-member sha256)
 * plus each selected section, then gzips everything into outPath.
 */
export async function createBackup(
	opts: CreateBackupOptions,
): Promise<Manifest> {
	assertTarAvailable();
	const { agentDir, sections, source, outPath } = opts;

	// Stage everything in a temp dir so tar can archive a clean tree.
	const stage = await mkdtemp(join(tmpdir(), "pi-port-stage-"));
	try {
		const manifest = emptyManifest(source);

		const members: string[] = [];
		for (const id of sections) {
			const def = getSection(id);
			const srcPath = join(agentDir, def.path);
			// Skip if the source doesn't exist (defensive — detectSections should have filtered).
			try {
				await access(srcPath);
			} catch {
				continue;
			}
			await run("tar", ["-cf", join(stage, `${id}.tar`), def.path], agentDir);
			const memberName = `${id}.tar`;
			members.push(memberName);
			manifest.checksums[memberName] = await sha256File(
				join(stage, memberName),
			);
		}

		manifest.sections = members.map(
			(m) => m.replace(/\.tar$/, "") as SectionId,
		);
		const manifestPath = join(stage, "manifest.json");
		await writeManifest(manifestPath, manifest);

		await mkdir(dirname(outPath), { recursive: true });
		// Archive: manifest.json + one <section>.tar per section (uncompressed inner,
		// gzip outer). Keeps individual sections independently extractable.
		const allArgs = ["-czf", outPath, "-C", stage, "manifest.json", ...members];
		await run("tar", allArgs);
		await run("chmod", ["600", outPath]).catch(() => {
			/* non-fatal on some filesystems */
		});
		return manifest;
	} finally {
		await rm(stage, { recursive: true, force: true });
	}
}

/** List member names in an archive (without extracting bodies). */
export async function listMembers(archivePath: string): Promise<string[]> {
	assertTarAvailable();
	const { stdout } = await run("tar", ["-tzf", archivePath]);
	return stdout
		.split("\n")
		.map((l) => l.trim())
		.filter(Boolean);
}

/** Extract only manifest.json from the archive, parse, and validate. */
export async function extractManifest(archivePath: string): Promise<Manifest> {
	assertTarAvailable();
	const stage = await mkdtemp(join(tmpdir(), "pi-port-mani-"));
	try {
		await run("tar", ["-xzf", archivePath, "-C", stage, "manifest.json"]);
		return await readManifest(join(stage, "manifest.json"));
	} finally {
		await rm(stage, { recursive: true, force: true });
	}
}

export interface ExtractOptions {
	agentDir: string;
	/** Section ids present in the archive to actually extract. */
	sections: SectionId[];
	sourceHome: string;
	targetHome: string;
	/** Per-section conflict policy. Default "overwrite". */
	conflict?: Record<SectionId, "merge" | "overwrite" | "skip-existing">;
	/** Called for each section as it is applied; optional progress hook. */
	onSection?: (id: SectionId) => void;
}

/**
 * Extract selected sections from the archive into agentDir.
 * Before overwriting settings.json, the current file is backed up to
 * settings.json.preimport.bak. Path remapping is applied to the known
 * path-bearing files (trust.json, projects-memory, sessions cwd fields).
 */
export async function extractSections(
	archivePath: string,
	opts: ExtractOptions,
): Promise<void> {
	assertTarAvailable();
	const { agentDir, sections, sourceHome, targetHome } = opts;

	// Pre-backup settings.json if we're about to touch it.
	if (sections.includes("settings")) {
		const settingsPath = join(agentDir, "settings.json");
		try {
			const cur = await readFile(settingsPath);
			await writeFile(join(agentDir, "settings.json.preimport.bak"), cur);
		} catch {
			/* no existing settings — nothing to back up */
		}
	}

	const stage = await mkdtemp(join(tmpdir(), "pi-port-extract-"));
	try {
		// Extract all requested <section>.tar members into stage.
		const memberArgs = sections.map((s) => `${s}.tar`);
		await run("tar", ["-xzf", archivePath, "-C", stage, ...memberArgs]);

		for (const id of sections) {
			opts.onSection?.(id);
			const def = getSection(id);
			const innerTar = join(stage, `${id}.tar`);
			// Extract the inner tar into agentDir.
			await run("tar", ["-xf", innerTar, "-C", agentDir]);

			// Apply path remapping for path-bearing sections.
			const targetPath = join(agentDir, def.path);
			if (id === "trust") {
				await remapJsonFile(targetPath, sourceHome, targetHome);
			} else if (id === "projects-memory" || id === "sessions") {
				await remapTree(targetPath, sourceHome, targetHome);
			}
		}
	} finally {
		await rm(stage, { recursive: true, force: true });
	}
}

async function remapJsonFile(
	path: string,
	sourceHome: string,
	targetHome: string,
): Promise<void> {
	if (sourceHome === targetHome) return;
	let raw: string;
	try {
		raw = await readFile(path, "utf8");
	} catch {
		return;
	}
	try {
		const obj = JSON.parse(raw);
		const remapped = remapObject(obj, sourceHome, targetHome);
		await writeFile(path, JSON.stringify(remapped, null, 2) + "\n", "utf8");
	} catch {
		/* leave file as-is if remap fails */
	}
}

async function remapTree(
	dir: string,
	sourceHome: string,
	targetHome: string,
): Promise<void> {
	if (sourceHome === targetHome) return;
	const { readdir } = await import("node:fs/promises");
	let entries: string[];
	try {
		entries = await readdir(dir);
	} catch {
		return;
	}
	for (const entry of entries) {
		const p = join(dir, entry);
		const stat = await import("node:fs/promises").then((m) => m.stat(p));
		if (stat.isDirectory()) {
			await remapTree(p, sourceHome, targetHome);
		} else if (entry.endsWith(".json")) {
			await remapJsonFile(p, sourceHome, targetHome);
		}
	}
}
