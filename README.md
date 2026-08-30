# Pi Port

Move your [pi](https://pi.dev) agent setup between machines — two ways:

- **Local archive** — `/pi-port-local-export` packs a portable `.pi-backup` file you carry yourself.
- **Cloud sync** — `/pi-port-sync-conf` and `/pi-port-sync-sessions` sync your global config and per-project sessions through storage **you already own** (S3, SFTP, WebDAV, a private GitHub repo, or a local/synced folder) via the [`vsync`](https://www.npmjs.com/package/vasari-sync) CLI.

The npm package cache (`~/.pi/agent/npm/`, often 400MB+) is **never copied**: packages are recorded as a list in `settings.json` and reinstalled automatically on the target's first `pi` run. A typical backup is under 10MB.

## Install

```bash
pi install npm:@andrewjacop/pi-port
# or
pi install git:github.com/andrewjacop/pi-port
```

All commands load automatically.

**Cloud sync prerequisite:** [`vsync`](https://www.npmjs.com/package/vasari-sync) ≥ 0.6.3 on your PATH:

```bash
npm install -g vasari-sync
```

pi-port keeps its own vsync config (`~/.pi/agent/pi-port-vsync.json`, passed via `vsync --config` on every call). If you already use vsync for your own projects, pi-port never reads or writes your `~/.vsync/config.json` — the two installations are fully isolated.

## Usage

### Local export

```
/pi-port-local-export [path]
```

Interactive wizard: resolves an output path (defaults to `~/pi-backups/pi-backup-<timestamp>.pi-backup`, remembers your last location), auto-detects which sections exist, and asks whether to include each one. `settings` is always included; `auth` (API keys) warns when toggled on.

### Local import

```
/pi-port-local-import [path]
```

Reads the archive's manifest, validates format and checksums, then walks you through selecting which sections to restore. Absolute paths under the source machine's home are automatically rewritten to the target home (e.g. `/Users/alice/...` → `/home/bob/...`). Paths outside the source home are left untouched. Before overwriting `settings.json`, the current file is backed up to `settings.json.preimport.bak`.

### Cloud setup

```
/pi-port-setup
```

One-time-per-machine backend configuration. Picks a backend (s3, sftp, webdav, github-repo, local-fs), prompts for its fields, and lets vsync test the connection — a failed test saves nothing. Secrets are passed to vsync via environment variables only; pi-port never persists them.

**GitHub repo + `gh` CLI:** if the GitHub CLI is installed and authenticated, setup is nearly automatic — the repo owner is offered from your gh login (one keypress to accept), the repo field becomes a picker listing your actual repos (private ones marked), and the token can be left blank (vsync reuses the gh login). Without gh, everything falls back to typed input.

### Config sync

```
/pi-port-sync-conf
```

Bidirectional sync of the global pi config: `settings.json`, `keybindings.json`, `trust.json`, `skills/`, `prompts/`, `themes/`. The staging manifest is re-derived from the backend on every run, so files another machine pushed after this machine last synced are seen. Diff-first — shows exactly what differs (including files staged by an interrupted earlier run but never pushed), then asks the direction:

- **Pull** — remote changes are applied with a `.preimport.bak` backup of everything overwritten; `settings.json` is *merged* over local (machine-local package paths are dropped), and paths are remapped between homes when they differ.
- **Push** — local config is staged (`lastChangelogVersion` and machine-local package paths stripped), scanned for secrets, then uploaded.

### Session sync

```
/pi-port-sync-sessions
```

Syncs sessions **for the project pi is opened in**. Because pi stores sessions under machine-specific absolute paths, each project gets a short **label** you choose once per project (suggested from the folder name); the label — not the path — is what travels through the cloud. First run in a project asks for its label; every other machine just works.

Sessions are diffed by session id, so nothing is duplicated and the usual flow is: work on machine A → push; sit down at machine B → pull → A's sessions appear in `/resume` immediately. A session changed on both machines (rare) resolves last-edited-wins.

When the two sides differ you pick a direction:

- **Push** — upload local-only and locally-newer sessions.
- **Pull** — download remote-only and remotely-newer sessions.
- **Reconcile** — both ways at once, newest-wins per session: pushes what's local-new/newer, pulls what's remote-new/newer. One keypress instead of two rounds.

### What syncs where

| | Local archive | Cloud sync |
|---|---|---|
| settings, keybindings, trust, skills, prompts, themes | ✅ | ✅ |
| auth (API keys) | ⚠️ opt-in | ❌ never |
| git packages, bin, memory, projects-memory, sessions | ✅ opt-in | sessions only (per project) |

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
  "exportedBy": "pi-port@0.2.0"
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
| `keybindings` | `keybindings.json` | ✅ |
| `prompts` | `prompts/` | ✅ |
| `themes` | `themes/` | ✅ |
| `memory` | `pi-hermes-memory/` | ❌ opt-in (large) |
| `projects-memory` | `projects-memory/` | ❌ opt-in |
| `sessions` | `sessions/` | ❌ opt-in (large) |

## Security

- `auth.json` contains your API keys in plaintext (same as pi stores them). Export warns twice; import defaults to including it but asks explicitly. Cloud sync never touches it.
- Backups are written with mode `0600`.
- Checksums are verified on import; mismatches are reported.
- Cloud sync pushes run a local secret scan (PEM keys, gh tokens, sk- keys, credential assignments); hits ask per file and are never remembered.
- Cloud-sync secrets (backend credentials) are passed to vsync via environment variables only — pi-port never persists them anywhere.
- **Cloud sync stores your sessions and config in plaintext in your own backend.** Use a private backend. Sessions can contain anything that appeared in them — treat the backend as sensitive.
- No telemetry.

## Platform support

- **Cloud sync:** macOS, Linux, Windows (drives the `vsync` CLI).
- **Local archive:** macOS and Linux (uses the system `tar` binary). Windows local export/import is not yet supported.

## Development

```bash
git clone https://github.com/andrewjacop/pi-port
cd pi-port
npm install
npm test          # 56 unit tests (paths, staging, scan, vsync wrapper, remap)
npx tsc --noEmit  # typecheck
```

Quick test without installing:

```bash
pi -e ./extensions/pi-port.ts
```

## License

MIT
