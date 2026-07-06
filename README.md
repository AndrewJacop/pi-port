# Pi Port

Export and import your [pi](https://pi.dev) agent configuration between machines — settings, auth, trusted dirs, skills, git packages, and optionally memory/sessions — as a single portable `.pi-backup` archive.

The npm package cache (`~/.pi/agent/npm/`, often 400MB+) is **never copied**: packages are recorded as a list in `settings.json` and reinstalled automatically on the target's first `pi` run. A typical backup is under 10MB.

## Install

```bash
pi install npm:@andrewjacop/pi-port          # from npm
# or
pi install git:github.com/andrewjacop/pi-port@v0.1.0
```

Both commands (`/export-pi`, `/import-pi`) load automatically.

## Usage

### Export

```
/export-pi [path]
```

Runs an interactive wizard: resolves an output path (defaults to `~/pi-backups/pi-backup-<timestamp>.pi-backup`, remembers your last location), auto-detects which sections exist, and asks whether to include each one. `settings` is always included; `auth` (API keys) warns when toggled on.

### Import

```
/import-pi [path]
```

Reads the archive's manifest, validates format and checksums, then walks you through selecting which sections to restore. Absolute paths under the source machine's home are automatically rewritten to the target home (e.g. `/Users/alice/...` → `/home/bob/...`). Paths outside the source home (e.g. `/opt/...`) are left untouched.

Before overwriting `settings.json`, the current file is backed up to `settings.json.preimport.bak`.

## Backup format

A `.pi-backup` file is a gzip-compressed tar containing:

```
manifest.json        # metadata, source machine, section list, sha256 checksums
settings.tar         # one inner tar per exported section
trust.tar
skills.tar
...
```

`manifest.json`:

```json
{
  "format": "pi-backup",
  "version": 1,
  "createdAt": "2026-07-06T09:55:00Z",
  "source": { "os": "darwin", "username": "alice", "home": "/Users/alice", "hostname": "macbook" },
  "sections": ["settings", "trust", "skills"],
  "checksums": { "settings.tar": "sha256:..." },
  "exportedBy": "pi-port@0.1.0"
}
```

The format is versioned. Importing a backup made by a newer Pi Port than you have installed fails with a clear upgrade message.

## Sections

| Section | Source | Default in export |
|---------|--------|-------------------|
| `settings` | `settings.json` | ✅ always |
| `auth` | `auth.json` | ⚠️ opt-in (contains API keys) |
| `trust` | `trust.json` | ✅ |
| `skills` | `skills/` | ✅ |
| `git-packages` | `git/` | ✅ |
| `bin` | `bin/` | ✅ |
| `memory` | `pi-hermes-memory/` | ❌ opt-in (large) |
| `projects-memory` | `projects-memory/` | ❌ opt-in |
| `sessions` | `sessions/` | ❌ opt-in (large) |

## Security

- `auth.json` contains your API keys in plaintext (same as pi stores them). Export warns twice; import defaults to including it but asks explicitly.
- Backups are written with mode `0600`.
- Checksums are verified on import; mismatches are reported.
- No network access, no telemetry.

## Platform support

- **v0.1:** macOS and Linux (uses the system `tar` binary).
- **Windows:** not yet supported — v0.2 will add a native tar fallback.

## Development

```bash
git clone https://github.com/andrewjacop/pi-port
cd pi-port
npm install
npm test          # unit tests for path remapping
npx tsc --noEmit  # typecheck
```

Quick test without installing:

```bash
pi -e ./extensions/pi-port.ts
```

## License

MIT
