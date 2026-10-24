# Test Results

Run on 2026-10-24 with Node `v24.19.0` and SQLite `3.53.3`.

Command:

```powershell
node --test --test-isolation=none test/store.test.js test/plugin.test.js
```

Result: **15 passed, 0 failed** in 519 ms.

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
- Profile: `memory-plugin-dev`, created from the shipped `headless` profile under a separate `DSH_HOME`.
- Direct directory install: failed as expected on this Windows account because pnpm could not create a symbolic link; it left no dependency or plugin row behind.
- Packed install: `hail7723-dsh-project-memory-0.1.1.tgz` installed successfully.
- Composition: `--dump-config` shows bundle `@hail7723/dsh-project-memory` and enabled row `project-memory`.
- Host boot probe: `--profile memory-plugin-dev --help` loaded the profile and exited normally without a model request.
