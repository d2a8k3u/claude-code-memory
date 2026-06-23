---
description: Turn this project's automatic memory recall off or back on (storing stays active)
argument-hint: "[off | normal | status]"
---

Run this Bash and relay the result to the user. It toggles the per-project recall kill-switch: when set to `off`, the SessionStart, UserPromptSubmit, PreToolUse, and error-context hooks inject nothing, while auto-save (session-end) and the MCP memory tools keep working. `normal` re-enables recall; `status` (the default) just reports the current mode.

```bash
node "${CLAUDE_PLUGIN_ROOT}/server/dist/cli.js" recall-mode $ARGUMENTS
```

Then tell the user the mode now in effect. If they switched it `off`, remind them recall is silenced for this project only and that memories are still being saved; they can run `/memory-recall normal` to turn it back on.
