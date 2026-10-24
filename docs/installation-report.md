# Installation and Verification Report

Date: 2026-10-24

## Delivered

- Source: `D:\practice\deepseek-memory-plugin`
- Package: `dsh-longtime-memory@0.1.2`
- Packed artifact: `D:\practice\deepseek-memory-plugin\dist\dsh-longtime-memory-0.1.2.tgz`
- Isolated profiles: `memory-plugin-dev` (headless) and `memory-ui-dev` (web) under a workspace-local `DSH_HOME`
- Repository: `https://github.com/hail7723/deepseek-longtime-plugin`

No file under the global Harness installation directory was changed.

## Installation result

1. Installed an isolated `@deepseek-ai/dsh 0.2.1-rc.3` CLI runner in the workspace with `--ignore-scripts`.
2. Packed the bundle after renaming the package to `dsh-longtime-memory`; the archive contains the new name in `package.json` and `cordis.patch.yml`.
3. Installed the `.tgz` into the headless `memory-plugin-dev` profile. `--dump-config` shows bundle `dsh-longtime-memory` and enabled row `project-memory`.
4. Installed the same `.tgz` into the web `memory-ui-dev` profile and booted it with `--no-open --host 127.0.0.1 --port 0`; the Host printed its URL, stayed running, and emitted no startup error.
5. Removed the superseded `@hail7723/dsh-project-memory` identity from the isolated profiles.

## Enable

The installed bundle is already selected and its `project-memory` row is enabled. Start the profile with the same `DSH_HOME`, or enable the row in Plugin Manager if it was later disabled.

## Rollback

```powershell
$env:DSH_HOME = 'D:\practice\Deepseekharness\memory\dev-profile-home'
& $dsh021 plugin --profile memory-plugin-dev remove dsh-longtime-memory
```

If the manager reports `restart-required`, restart that profile. Removing the plugin does not delete project databases; archive or delete `.deepseek-memory` separately only when the history is intentionally discarded.

## Tests

- JavaScript syntax: passed.
- Package manifest, two locales, and SVG icon: passed.
- Offline suite: 15 passed, 0 failed.
- Packed file list: passed; runtime, docs, locales, patch, and icon present.
- Isolated headless composition and web Host boot probe: passed.
- Real paid model request: not executed.
- Forced provider context overflow: not executed; installed `0.2.1-rc.3` control flow was inspected and the refresh provider was exercised repeatedly offline.
