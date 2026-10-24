# Test Results

Run on 2026-10-24 with Node `v24.19.0` and SQLite `3.53.3`.

Package identity: `dsh-longtime-memory@0.2.2`.

Command:

```powershell
npm run check
npm test
```

Result: **26 passed, 0 failed**.

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
| History search over checkpoints | checkpoint summaries searched with scope and limit assertions |
| First request recovery provider | agent registration exposes required recovery context before requests |
| Cross-dialog recovery | a second agent reads the first agent's SQLite checkpoint |
| Three consecutive compaction refreshes | required provider invoked three times with identical latest revisions |
| Overflow retry behavior | verified from installed AgentLoop/compaction source that every retry calls `refreshContext`; the provider is synchronous and repeatable |
| Crash/pending recovery | pending tool boundary remains visible to a new agent |
| Database failure | corrupt persistence state returns `PROJECT_MEMORY_ERROR`, never false success |
| Client assembly lifecycle | descriptor mount before Slot registration, cleanup on disposal |
| Startup safety | a rejected Remote mount stays inside the panel instead of failing Web boot |
| Real Client/Host Gateway | real `dsh-api-gateway` packages mount the Client contribution, dispatch all six operations, reject stale CAS, dispose the namespace, and remount cleanly |
| Invalid codec regression | the real Client gateway rejects `src-json` inputs, which is the withdrawn `0.2.1` defect |

## Isolated browser verification

Verified in an isolated Web profile (`memory-ui-dev`) served from the workspace-local `DSH_HOME`:

- the page booted with the Client entry active and no startup error;
- the Project Memory icon appeared in the global sidebar;
- the main panel rendered the uninitialized state for the chosen directory;
- initialization created the project and task;
- task claim succeeded and produced a lease;
- a checkpoint with summary, next action, and evidence was saved;
- the contract candidate appeared as pending without changing the confirmed contract;
- history search returned the checkpoint result.

## Not executed

- A paid real-model request was not made; the recovery provider is exercised deterministically offline.
- A provider-forced real context-window overflow was not triggered. Retry ordering was verified against installed `0.2.1-rc.3` source and the recovery provider was exercised repeatedly.
- Cross-device and cloud synchronization are deliberately out of scope.

Windows note: the default Node test runner isolates files by spawning child processes, which is blocked by this Harness sandbox. `--test-isolation=none` runs the same test files in-process and is the recorded test command.

## Isolated profile verification

- CLI runner: `@deepseek-ai/dsh 0.2.1-rc.3` installed under the workspace with dependency install scripts disabled.
- The packed `.tgz` embeds `dsh-longtime-memory` in both `package.json` and `cordis.patch.yml`.
- `--dump-config` composes bundle `dsh-longtime-memory` and enabled row `project-memory`.
- Boot probe: `--no-open --host 127.0.0.1 --port 0` printed the Web URL and stayed running with no startup error.
