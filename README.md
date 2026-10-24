# DeepSeek Harness Longtime Memory

[![CI](https://github.com/hail7723/deepseek-longtime-plugin/actions/workflows/ci.yml/badge.svg)](https://github.com/hail7723/deepseek-longtime-plugin/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

Local project memory for DeepSeek Harness: task and contract state lives in a project-local SQLite database, deterministic recovery is injected into every model request attempt, and a native sidebar panel manages the same state visually.

> **Package identity.** From `0.2.2` (and `0.1.2` for the host-only line) this project is published as `dsh-longtime-memory`, repository `hail7723/deepseek-longtime-plugin`. Earlier releases used `@hail7723/dsh-project-memory` in an older repository; that identity is superseded.

## Features

Host side:

- explicit `.deepseek-memory/project.json` boundaries with a stable `project_id`;
- local `memory.sqlite` storage in WAL mode;
- project-monotonic event sequences, evidence, checkpoints, idempotency keys, leases, and fencing tokens;
- independent task and contract revisions with compare-and-swap conflict errors;
- agent-scoped `memory_bootstrap`, `memory_read`, `memory_claim`, `memory_checkpoint`, `memory_search`, and `memory_propose_contract_change` tools;
- required runtime-context recovery on new sessions, resumed sessions, normal compaction, and overflow retries;
- branch/workspace evidence isolation and pending tool-operation records.

Visual side (`0.2.x`):

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

Required Host contracts were checked through Cordis Inspect: `tools.register`, `workingDirectory.ensure`, `systemPrompt.context`, `systemPrompt.refreshContext`, `agent/created`, `agent/pre-step`, `agent/request-error`, `tools/pre-execute`, `tools/result`, and `session/event`. The Client panel was verified against the live `sidebar.panellist` and `main` Slot declarations.

## Project bootstrap and state

The plugin is inactive for a directory until `memory_bootstrap`, or the panel's initialize form, creates an explicit marker at the working directory. Marker lookup walks ancestors only for `.deepseek-memory/project.json`; it never treats a parent `.git` directory as project identity.

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

## Verification

- `npm test` runs 26 tests, including real Harness Client/Host Gateway integration for all six Remote operations, CAS and fencing conflicts, disposal, and remount.
- Browser verification covered Client activation, the sidebar and main Slots, initialization, task claim, checkpoint, contract candidate proposal, and history search in an isolated Web profile.
- Startup regressions from the withdrawn `0.2.0` and `0.2.1` builds are documented in `docs/desktop-boot-incident.md` and guarded by tests.

```powershell
npm run check
npm test
npm run pack:check
```

See `docs/test-results.md` and `docs/installation-report.md` for the full matrix and known limits.
