# DeepSeek Harness Longtime Memory

[![CI](https://github.com/hail7723/deepseek-longtime-plugin/actions/workflows/ci.yml/badge.svg)](https://github.com/hail7723/deepseek-longtime-plugin/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

A Host-only DeepSeek Harness plugin that stores project task state in local SQLite and injects a deterministic recovery package into every model request attempt.

> **Package identity.** From `0.1.2` onward this project is published as `dsh-longtime-memory`, and the repository is `hail7723/deepseek-longtime-plugin`. Earlier releases used the package name `@hail7723/dsh-project-memory`; that name is superseded and no longer updated. The visual panel line is published separately as `dsh-longtime-memory@0.2.2`.

## Scope

Version 0.1.x implements:

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

Use a Harness `0.2.1-rc.3` CLI. First create the separate profile, then install the packed bundle from the release asset:

```powershell
$env:DSH_HOME = "<isolated-dsh-home>"
& $dsh021 --profile memory-plugin-dev --from-default-profile headless --dump-config
& $dsh021 plugin --profile memory-plugin-dev add "<path-to>\dsh-longtime-memory-0.1.2.tgz"
```

Release asset:
`https://github.com/hail7723/deepseek-longtime-plugin/releases/download/v0.1.2/dsh-longtime-memory-0.1.2.tgz`

A direct directory install may be used on Windows only when the account can create symbolic links. On this machine it was deliberately rejected with `ERR_PNPM_PACKAGE_MANAGER_SYMLINK_FAILED`; the `.tgz` installation is the tested path.

## Enable or disable

The installed bundle patch inserts one enabled Host row:

```yaml
- insert:
    - id: project-memory
      name: 'dsh-longtime-memory'
      config: {}
```

Use Plugin Manager to disable/enable `project-memory`. Disabling unloads its agent-scoped tools and runtime context; it does not delete any project's `.deepseek-memory` directory.

## Roll back

1. Disable `project-memory` in the isolated profile.
2. Remove bundle `dsh-longtime-memory` from that profile.
3. Restart the profile if the manager reports `restart-required`.
4. Keep or archive each project's `.deepseek-memory` directory. Delete it only when its local history is intentionally discarded.

CLI equivalent:

```powershell
& $dsh021 plugin --profile memory-plugin-dev remove dsh-longtime-memory
```

## Visual panel

Version `0.2.2` adds a native **Project Memory** sidebar entry and main panel on top of this Host-only core. Open it to initialize a directory, claim the active task, write checkpoints, propose contract candidates, and search scoped history. The panel and Agent tools share the same Host operations, so task and contract CAS checks plus lease fencing behave identically from either caller.

## Test

```powershell
node --check index.js
node --check src/plugin.js
node --check src/store.js
node --test --test-isolation=none test/store.test.js test/plugin.test.js
```

See `docs/test-results.md` for the verified matrix and remaining live-model limits.
