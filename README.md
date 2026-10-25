# DeepSeek Harness Longtime Memory

[![CI](https://github.com/hail7723/deepseek-longtime-plugin/actions/workflows/ci.yml/badge.svg)](https://github.com/hail7723/deepseek-longtime-plugin/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

Local project memory for DeepSeek Harness: task and contract state lives in a project-local SQLite database, and a bounded deterministic recovery package is injected into every model request attempt.

> **Development status.** `0.3.0-dev.1` is a local development build, not a release artifact. It has offline coverage for migration, bindings, recovery rendering, and Host/Client Gateway behavior. It has not been installed into a Desktop profile or used for a paid model request.

> **Package identity.** From `0.2.2` (and `0.1.2` for the host-only line) this project is published as `dsh-longtime-memory`, repository `hail7723/deepseek-longtime-plugin`. Earlier releases used `@hail7723/dsh-project-memory` in an older repository; that identity is superseded.

## Features

Host side:

- explicit `.deepseek-memory/project.json` boundaries with a stable `project_id`;
- local `memory.sqlite` storage in WAL mode;
- project-monotonic event sequences, evidence, checkpoints, idempotency keys, leases, and fencing tokens;
- independent task and contract revisions with compare-and-swap conflict errors;
- persistent session-to-task bindings; one unfinished task may be selected automatically, while multiple tasks always require explicit selection;
- agent-scoped `memory_start_task`, `memory_use_task`, `memory_commit`, `memory_search`, and `memory_propose_contract_change` tools; revisions, leases, and fences remain Host internals;
- schema-v1 to schema-v2 migration with a same-directory `memory.sqlite.v1-backup` recovery copy;
- contract-candidate acceptance/rejection lifecycle and a correlated pending/succeeded/failed/unknown tool-operation record;
- required runtime-context recovery on new sessions, resumed sessions, normal compaction, and overflow retries;
- branch/workspace evidence isolation and pending tool-operation records.

Visual side (`0.2.x` compatibility panel):

- a **Project Memory** icon in the global sidebar and a central panel registered in the `main` Slot;
- overview of project id, task and contract revisions, event sequence, objective, acceptance criteria, next action, and pending operations;
- task claim and checkpoint forms with revision and lease fencing feedback;
- contract candidate proposals that stay pending until confirmed;
- history search over scoped evidence, checkpoint summaries, and recent events;
- styling from Harness theme tokens only, with light and dark layouts.

The panel is local-only: the browser receives JSON through the package-private `projectMemory` Remote service and never opens SQLite directly.

It does not connect to Mem0, a vector database, cloud storage, or another device.

## Compatibility

Built and verified against DeepSeek Harness `0.2.1-rc.3` on Node `24`. The package declares `dsh >=0.2.1-rc.3 <0.3.0` and `node >=24.0.0`.

Required Host contracts were checked through Cordis Inspect: `tools.register`, `workingDirectory.ensure`, `systemPrompt.context`, `systemPrompt.refreshContext`, `agent/created`, `tools/pre-execute`, and `tools/result`. See the dated baseline report for the evidence and limits.

## Project bootstrap and state

The plugin is inactive for a directory until `memory_start_task`, or the compatibility panel's initialize form, creates an explicit marker at the working directory. Marker lookup walks ancestors only for `.deepseek-memory/project.json`; it never treats a parent `.git` directory as project identity.

```text
<project-root>/.deepseek-memory/
  project.json
  memory.sqlite
  memory.sqlite-wal
  memory.sqlite-shm
```

Do not commit the runtime state (the bundled `.gitignore` entry covers `.deepseek-memory/`) and do not run it from a synchronized cloud folder.

## Install

Download the release asset and install it into a profile with the Harness CLI:

```powershell
& $dsh021 plugin --profile <profile> add "<path-to>\dsh-longtime-memory-0.2.2.tgz"
```

Release assets:

- `0.2.2` (visual panel + host memory): `https://github.com/hail7723/deepseek-longtime-plugin/releases/download/v0.2.2/dsh-longtime-memory-0.2.2.tgz`
- `0.1.2` (host-only line): `https://github.com/hail7723/deepseek-longtime-plugin/releases/download/v0.1.2/dsh-longtime-memory-0.1.2.tgz`

A direct directory install may be used on Windows only when the account can create symbolic links. The `.tgz` installation is the tested path.

## Enable or disable

The bundle patch inserts one enabled Host row and loads one Client entry:

```yaml
- insert:
    - id: project-memory
      name: 'dsh-longtime-memory'
      config: {}
```

Use Plugin Manager to enable or disable `project-memory`. Disabling unloads its Agent tools, recovery context, and visual panel; it does not delete any project's `.deepseek-memory` directory.

## Roll back

1. Disable `project-memory` in the profile.
2. Remove bundle `dsh-longtime-memory` from that profile.
3. Restart the profile if the manager reports `restart-required`.
4. Keep or archive each project's `.deepseek-memory` directory; delete it only when its history is intentionally discarded.

```powershell
& $dsh021 plugin --profile <profile> remove dsh-longtime-memory
```

### Restore a v1 database for v0.2.2

Before opening a v1 project, v0.3 creates `memory.sqlite.v1-backup` next to the database (and copies `-wal`/`-shm` when present). To return to v0.2.2, first disable the plugin and close every Harness process using that project. Preserve the current v2 files under a different name, restore the `*.v1-backup` database and any matching sidecars, then set `project.json` back to `"schema_version": 1`. Do not copy database files while SQLite is open.

## Verification

- `npm test` runs 30 offline tests, including real Harness Client/Host Gateway integration, a v1 migration sample, persistent task bindings, and bounded recovery rendering.
- The previous isolated-browser evidence applies only to the v0.2 compatibility panel. Real Desktop new-session, `/compact`, and provider-overflow validation remain outstanding for v0.3.
- Startup regressions from the withdrawn `0.2.0` and `0.2.1` builds are documented in `docs/desktop-boot-incident.md` and guarded by tests.

```powershell
npm run check
npm test
npm run pack:check
```

See [the v0.3 B00 baseline report](docs/v0.3-b00-baseline.md), `docs/test-results.md`, and `docs/installation-report.md` for the matrix and known limits.
