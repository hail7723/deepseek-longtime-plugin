# Harness plugin practices

Source copy used for this implementation. The installed Harness skill is authoritative.

- Anything shown to the model must be reconstructable from committed session events.
- Register per-agent behavior on `agent.ctx` and retain its disposer in the plugin owner.
- A waterfall listener that does not own the decision must call `next()` and preserve fields.
- Add prompt context with `systemPrompt.context()`; `agent.inject()` is durably logged.
- Observe final tool outcomes on `tools/result`; do not invent session event types.
- Confirm all Service methods and Event modes with Cordis Inspect before coding.

Original installed reference:
`@deepseek-ai/dsh-agent-preset/skills/cordis-plugin-development/references/practices.md`
