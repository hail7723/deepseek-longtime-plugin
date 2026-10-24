# Installation and Verification Report

Date: 2026-10-24

## Delivered

- Source: `D:\practice\deepseek-memory-plugin`
- Package: `dsh-project-memory@0.1.0`
- Packed artifact: `D:\practice\deepseek-memory-plugin\dist\dsh-project-memory-0.1.0.tgz`
- Isolated profile: `D:\practice\Deepseekharness\memory\dev-profile-home\profiles\memory-plugin-dev`

No file under the global Harness installation directory was changed.

## Installation result

1. Installed an isolated `@deepseek-ai/dsh 0.2.1-rc.3` CLI runner in the workspace with `--ignore-scripts`.
2. Created `memory-plugin-dev` from the shipped `headless` profile under a separate workspace-local `DSH_HOME`.
3. A direct directory add was rejected because this Windows account cannot create the required symlink. The failed operation left neither a dependency nor an installed plugin.
4. Packed the exact bundle file list and installed the `.tgz` successfully.
5. Confirmed the profile dependency, selected bundle, and composed `project-memory` row.
6. Booted the isolated profile with `--help`; it exited normally without any model request.

## Enable

The installed bundle is already selected and its `project-memory` row is enabled. Start the profile with the same `DSH_HOME`, or enable the row in Plugin Manager if it was later disabled.

## Rollback

```powershell
$env:DSH_HOME = 'D:\practice\Deepseekharness\memory\dev-profile-home'
& $dsh021 plugin --profile memory-plugin-dev remove dsh-project-memory
```

If the manager reports `restart-required`, restart that profile. Removing the plugin does not delete project databases; archive or delete `.deepseek-memory` separately only when the history is intentionally discarded.

## Tests

- JavaScript syntax: passed.
- Package manifest, two locales, and SVG icon: passed.
- Offline suite: 15 passed, 0 failed.
- Packed file list: passed; runtime, docs, locales, patch, and icon present.
- Isolated profile composition and Host boot probe: passed.
- Real paid model request: not executed.
- Forced provider context overflow: not executed; installed `0.2.1-rc.3` control flow was inspected and the refresh provider was exercised repeatedly offline.
