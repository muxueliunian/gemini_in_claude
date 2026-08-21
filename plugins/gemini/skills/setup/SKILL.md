---
name: setup
description: Check whether the local Antigravity CLI is ready (installed, on PATH, authenticated)
when_to_use: Use when the user runs /gemini:setup, or when agy is missing or not logged in.
argument-hint: ''
allowed-tools: Bash(node:*)
shell: bash
---

!`node "${CLAUDE_PLUGIN_ROOT}/scripts/gemini-companion.mjs" setup --json`

Output rules:
- Present the setup output to the user.
- If agy is not installed, tell the user to install Antigravity CLI from https://antigravity.google/download#antigravity-cli — expected at `%LOCALAPPDATA%\agy\bin\agy.exe`. Do not suggest `npm install`.
- If agy is installed but not logged in, tell the user to run `!agy` once and complete Google sign-in, or set `GEMINI_API_KEY`.
- If the report shows the Claude session id was not exported, mention that job status/result/resume will not be scoped to this session until the Claude Code session is restarted (the `SessionStart` hook needs to have run).
- Do not attempt to install or authenticate agy yourself; only relay the guidance.
