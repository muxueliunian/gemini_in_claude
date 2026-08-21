---
name: status
description: Show active and recent Gemini jobs for this repository
argument-hint: '[job-id] [--all]'
disable-model-invocation: true
allowed-tools: Bash(node:*)
shell: bash
---

!`node "${CLAUDE_PLUGIN_ROOT}/scripts/gemini-companion.mjs" status "$ARGUMENTS"`

If the user did not pass a job ID:
- Render the command output as a single Markdown table for running and recent jobs.
- Keep it compact. Do not include extra prose outside the table.
- Preserve the actionable fields: job ID, status, elapsed/duration, write mode, summary, and follow-up commands.

If the user did pass a job ID:
- Present the full command output to the user.
- Do not summarize or condense it.
