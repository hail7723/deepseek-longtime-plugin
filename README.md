# DeepSeek Harness Local Project Memory

[![CI](https://github.com/hail7723/deepseek-memory-plugin/actions/workflows/ci.yml/badge.svg)](https://github.com/hail7723/deepseek-memory-plugin/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

A Host-only DeepSeek Harness plugin that stores project task state in local SQLite and injects a deterministic recovery package into every model request attempt.

## Scope

Version 0.1 implements:

- explicit `.deepseek-memory/project.json` boundaries with a stable `project_id`;
- local `memory.sqlite` storage in WAL mode;
- project-monotonic event sequences, evidence, checkpoints, idempotency keys, leases, and fencing tokens;
- independent task and contract revisions with compare-and-swap conflict errors;
- agent-scoped `memory_bootstrap`, `memory_read`, `memory_claim`, `memory_checkpoint`, `memory_search`, and `memory_propose_contract_change` tools;
- required runtime-context recovery on new sessions, resumed sessions, normal compaction, and overflow retries;
- branch/workspace evidence isolation and pending tool-operation records.

It does not connect to Mem0, a vector database, cloud storage, or another device.

## Compatibility

The implementation is pinned to the installed Desktop Host API `0.2.1-rc.3` and requires `dsh >=0.2.1-rc.3 <0.3.0`. The unrelated CLI currently found first on this machine's PATH is `0.1.5-rc.1` and must not be used to validate this plugin.

Required live contracts were checked through Cordis Inspect: `tools.register`, `workingDirectory.ensure`, `systemPrompt.context`, `systemPrompt.refreshContext`, `agent/created`, `agent/pre-step`, `agent/request-error`, `tools/pre-execute`, `tools/result`, and `session/event`.

> **Do not install `dsh-project-memory@0.1.0` from npm.** That name belongs to an unrelated plugin targeting DSH `0.1.0-rc.6`. This repository uses the unique package name `@hail7723/dsh-project-memory` from version `0.1.1` onward and targets DSH `0.2.1-rc.3`.

## Project bootstrap

The plugin is inactive for a directory until `memory_bootstrap` creates an explicit marker at the Agent's current working directory. Marker lookup walks ancestors only for `.deepseek-memory/project.json`; it never treats a parent `.git` directory as project identity.

Generated project state:

```text
<project-root>/.deepseek-memory/
  project.json
  memory.sqlite
  memory.sqlite-wal
  memory.sqlite-shm
```

Do not commit the live SQLite files or run them from a synchronized cloud folder.

## Install in an isolated profile

Use a Harness `0.2.1-rc.3` CLI. First create the separate profile, then install the packed bundle:

```powershell
$env:DSH_HOME = "<isolated-dsh-home>"
& $dsh021 --profile memory-plugin-dev --from-default-profile headless --dump-config
& $dsh021 plugin --profile memory-plugin-dev add "<path-to>\hail7723-dsh-project-memory-0.1.1.tgz"
```

The verified development profile is under `D:\practice\Deepseekharness\memory\dev-profile-home`, and the deliverable archive is `D:\practice\deepseek-memory-plugin\dist\hail7723-dsh-project-memory-0.1.1.tgz`. Its composed config contains bundle `@hail7723/dsh-project-memory` and enabled row `project-memory`.

A direct directory install may be used on Windows only when the account can create symbolic links. On this machine it was deliberately rejected with `ERR_PNPM_PACKAGE_MANAGER_SYMLINK_FAILED`; the `.tgz` installation above succeeded and is the tested path.

## Enable or disable

The installed bundle patch inserts one enabled Host row:

```yaml
- insert:
    - id: project-memory
      name: '@hail7723/dsh-project-memory'
      config: {}
```

Use Plugin Manager to disable/enable `project-memory`. Disabling unloads its agent-scoped tools and runtime context; it does not delete any project's `.deepseek-memory` directory.

## Roll back

1. Disable `project-memory` in the isolated profile.
2. Remove bundle `@hail7723/dsh-project-memory` from that profile.
3. Restart the profile if the manager reports `restart-required`.
4. Keep or archive each project's `.deepseek-memory` directory. Delete it only when its local history is intentionally discarded.

CLI equivalent:

```powershell
& $dsh021 plugin --profile memory-plugin-dev remove @hail7723/dsh-project-memory
```

## Test

```powershell
node --check index.js
node --check src/plugin.js
node --check src/store.js
node --test --test-isolation=none test/store.test.js test/plugin.test.js
```

See `docs/test-results.md` for the verified matrix and remaining live-model limits.
