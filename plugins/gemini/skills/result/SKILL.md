---
name: result
description: Show the stored final output for a finished Gemini job in this repository
argument-hint: '[job-id]'
disable-model-invocation: true
allowed-tools: Bash(node:*)
shell: bash
---

!`node "${CLAUDE_PLUGIN_ROOT}/scripts/gemini-companion.mjs" result "$ARGUMENTS"`

Present the full command output to the user. Do not summarize or condense it. Preserve all details including:
- Job ID and status
- The complete result text, exactly as agy returned it
- The Antigravity conversation id and the `agy --conversation <id>` resume hint
- Spend (turns) when the helper reports it
- Any error messages
