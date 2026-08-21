---
name: cancel
description: Cancel an active background Gemini job in this repository
argument-hint: '[job-id]'
disable-model-invocation: true
allowed-tools: Bash(node:*)
shell: bash
---

!`node "${CLAUDE_PLUGIN_ROOT}/scripts/gemini-companion.mjs" cancel "$ARGUMENTS"`
