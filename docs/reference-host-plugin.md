# Bundles and Host plugins

Source copy used for this implementation. The installed Harness skill is authoritative.

- A Host bundle exports `apply(ctx, config)` or one service class.
- Register resources inside Cordis effects and preserve disposers.
- `package.json` exports locale metadata and an icon; `files` includes every runtime resource.
- `plugin_manager install_bundle` owns profile installation and activation.
- Verify `application` and warnings, then confirm the live registration through Inspect.
- Replacing installed JavaScript can require a restart; never infer activation from logs alone.

Original installed reference:
`@deepseek-ai/dsh-agent-preset/skills/cordis-plugin-development/references/host-plugin.md`
