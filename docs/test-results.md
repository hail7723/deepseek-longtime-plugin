# Test Results

Run on 2026-10-24 with Node `v24.19.0` and SQLite `3.53.3`.

Package identity: `dsh-longtime-memory@0.1.2`.

Command:

```powershell
node --test --test-isolation=none test/store.test.js test/plugin.test.js
```

Result: **15 passed, 0 failed** in 485 ms.

## Covered

| Requirement | Evidence |
|---|---|
| Stable explicit project identity | snake_case marker persistence test |
| Parent Git root isolation | two boundary tests |
| SQLite WAL and local database | marker/WAL test |
| Project-monotonic event sequence | task/contract sequence test |
| Task revision conflict | stale task update and cross-agent claim tests |
| Contract revision conflict | stale contract update and candidate proposal tests |
| Lease and fencing | stale writer rejection test |
| Idempotency | replay returns original result without sequence advance |
| Atomic checkpoint snapshot | task+contract+fence check and covered event sequence assertions |
| Branch/workspace evidence isolation | scoped list/search test |
| First request recovery provider | agent registration exposes required recovery context before requests |
| Cross-dialog recovery | a second agent reads the first agent's SQLite checkpoint |
| Three consecutive compaction refreshes | required provider invoked three times with identical latest revisions |
| Overflow retry behavior | verified from installed AgentLoop/compaction source that every retry calls `refreshContext`; provider is synchronous and repeatable |
| Crash/pending recovery | pending tool boundary remains visible to a new agent |
| Database failure | corrupt persistence state returns `PROJECT_MEMORY_ERROR`, never false success |

## Not executed

- A paid real-model request was not needed for correctness and was not made.
- A provider-forced, real context-window overflow was not triggered. The retry order was verified against installed `0.2.1-rc.3` source and the recovery provider was exercised repeatedly offline.
- Cross-device and cloud synchronization are deliberately out of scope.

Windows note: the default Node test runner isolates files by spawning child processes, which is blocked by this Harness sandbox. `--test-isolation=none` runs the same test files in-process and is the recorded test command.

## Isolated profile verification

- CLI runner: `@deepseek-ai/dsh 0.2.1-rc.3` installed under the workspace with all dependency install scripts disabled.
- Packed artifact: `dsh-longtime-memory-0.1.2.tgz` (SHA-256 recorded in the GitHub release notes).
- Headless profile `memory-plugin-dev`: installed from the `.tgz`; `--dump-config` composes bundle `dsh-longtime-memory` and enabled row `project-memory`.
- Web profile `memory-ui-dev`: installed from the same `.tgz`, booted with `--no-open --host 127.0.0.1 --port 0`; the Host printed its URL and stayed running with no startup error.
- Package rename check: the release asset's embedded `package.json` reports `dsh-longtime-memory@0.1.2` and the patch row uses the same name. The previously renamed `v0.1.1` asset still contained the old `@hail7723/dsh-project-memory` identity, which is why `0.1.2` replaces it.
