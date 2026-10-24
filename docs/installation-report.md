# Installation and Verification Report

Date: 2026-10-24

## Delivered

- Source: `D:\practice\deepseek-memory-plugin`
- Package: `dsh-longtime-memory@0.2.2`
- Packed artifact: `D:\practice\deepseek-memory-plugin\dist\dsh-longtime-memory-0.2.2.tgz`
- Host-only line: `dsh-longtime-memory@0.1.2` (`dist\dsh-longtime-memory-0.1.2.tgz`)
- Isolated profile: `D:\practice\Deepseekharness\memory\dev-profile-home\profiles\memory-ui-dev`
- Repository: `https://github.com/hail7723/deepseek-longtime-plugin`

No file under the global Harness installation directory was changed.

## Package rename

The project was unified under the package name `dsh-longtime-memory`:

- `0.1.2` replaces the host-only `0.1.1` build;
- `0.2.2` replaces the withdrawn `0.2.0` / `0.2.1` development builds;
- the previously renamed `v0.1.1` release asset still embedded `@hail7723/dsh-project-memory`, so it was rebuilt rather than only renamed.

## Installation result

1. Installed an isolated `@deepseek-ai/dsh 0.2.1-rc.3` CLI runner in the workspace with `--ignore-scripts`.
2. Installed the host-only `0.1.2` archive into a headless profile; `--dump-config` shows bundle `dsh-longtime-memory` and enabled row `project-memory`.
3. Installed the `0.2.2` archive into the Web profile `memory-ui-dev` and booted it with `--no-open --host 127.0.0.1 --port 0`; the Host printed its URL and stayed running.
4. Browser verification in that profile covered the sidebar entry, panel, initialization, task claim, checkpoint, contract candidate, and history search.
5. Removed the superseded `@hail7723/dsh-project-memory` identity from the isolated profiles.

## Enable

The installed bundle is already selected and its `project-memory` row is enabled. Start the profile with the same `DSH_HOME`, or enable the row in Plugin Manager if it was later disabled.

## Rollback

```powershell
$env:DSH_HOME = 'D:\practice\Deepseekharness\memory\dev-profile-home'
& $dsh021 plugin --profile memory-ui-dev remove dsh-longtime-memory
```

If the manager reports `restart-required`, restart that profile. Removing the plugin does not delete project databases; archive or delete `.deepseek-memory` separately only when the history is intentionally discarded.

## Tests

- JavaScript syntax: passed for all six runtime files.
- Package manifest, two locales, and SVG icon: passed.
- Offline suite: 26 passed, 0 failed, including real Harness Client/Host Gateway integration.
- Packed file list: passed; runtime, Client bundle, docs, locales, patch, and icon present.
- Isolated headless composition and Web Host boot: passed.
- Isolated browser flow: passed.
- Real paid model request: not executed.
- Forced provider context overflow: not executed; installed `0.2.1-rc.3` control flow was inspected and the refresh provider was exercised repeatedly offline.
