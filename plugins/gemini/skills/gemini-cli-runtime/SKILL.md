---
name: gemini-cli-runtime
description: Internal helper contract for calling the gemini-companion runtime from Claude Code
when_to_use: Use only inside gemini:gemini-rescue when assembling the companion task command.
user-invocable: false
---

# Gemini Runtime

Use this skill only inside the `gemini:gemini-rescue` subagent.

Primary helper:
- `node "${CLAUDE_PLUGIN_ROOT}/scripts/gemini-companion.mjs" task "<raw arguments>"`

Execution rules:
- The rescue subagent is a forwarder, not an orchestrator. Its only job is to invoke `task` once and return that stdout unchanged.
- Prefer the helper over hand-rolled `agy` CLI strings or any other Bash activity.
- Do not call `setup`, `status`, `result`, or `cancel` from `gemini:gemini-rescue`.
- Use `task` for every rescue request, including diagnosis, planning, research, and explicit fix requests.
- Leave `--effort` unset unless the user explicitly requests a specific effort. Accepted values: `low`, `medium`, `high`.
- Leave model unset by default. Add `--model` only when the user explicitly asks for one.
- Default to a write-capable agy run by adding `--write` unless the user explicitly asks for read-only behavior or only wants review, diagnosis, or research without edits.

Command selection:
- Use exactly one `task` invocation per rescue handoff.
- If the forwarded request includes `--background` or `--wait`, treat that as Claude-side execution control only. Strip it before calling `task`, and do not treat it as part of the natural-language task text.
- If the forwarded request includes `--model` or `--effort`, pass it through to `task`.
- If the forwarded request includes `--resume`, strip that token from the task text and add `--resume-last`.
- If the forwarded request includes `--fresh`, strip that token from the task text and do not add `--resume-last`.

Safety rules:
- Write mode (`--write`) runs agy with `--dangerously-skip-permissions` and `--mode accept-edits` — full autonomy to edit files and run shell commands with no per-action confirmation. Only use it when the user's request implies changes should be made.
- Read-only mode uses `--mode plan`. This is a best-effort constraint, not a hard security boundary.
- Preserve the user's task text as-is apart from stripping routing flags.
- Do not inspect the repository, read files, grep, monitor progress, poll status, fetch results, cancel jobs, summarize output, or do any follow-up work of your own.
- Return the stdout of the `task` command exactly as-is.
- If the Bash call fails or agy cannot be invoked, return nothing.
