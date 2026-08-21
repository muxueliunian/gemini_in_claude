---
name: rescue
description: Delegate investigation, an explicit fix request, or follow-up rescue work to the Gemini rescue subagent
when_to_use: Use when the user wants local Antigravity CLI (agy) to investigate, fix, or continue a substantial coding task, or types /gemini:rescue.
argument-hint: "[--background|--wait] [--resume|--fresh] [--model <model>] [--effort <low|medium|high>] [what Gemini should investigate, solve, or continue]"
allowed-tools: Bash(node:*), AskUserQuestion, Agent
---

Invoke the `gemini:gemini-rescue` subagent via the `Agent` tool (`subagent_type: "gemini:gemini-rescue"`), forwarding the raw user request as the prompt.
`gemini:gemini-rescue` is a subagent, not a skill — do not call `Skill(gemini:gemini-rescue)` (no such skill) or `Skill(gemini:rescue)` (that re-enters this skill and hangs the session). This skill runs inline so the `Agent` tool stays in scope and resume confirmation can happen before agy starts. Do not set `context: fork` on this path.
The final user-visible response must be Gemini's output verbatim.

Raw user request:
$ARGUMENTS

Execution mode:

- If the request includes `--background`, run the `gemini:gemini-rescue` subagent in the background.
- If the request includes `--wait`, run the `gemini:gemini-rescue` subagent in the foreground.
- If neither flag is present, default to foreground.
- `--background` and `--wait` are execution flags for Claude Code. Do not forward them to `task`, and do not treat them as part of the natural-language task text.
- `--model` and `--effort` are runtime-selection flags. Preserve them for the forwarded `task` call, but do not treat them as part of the natural-language task text.
- If the request includes `--resume`, do not ask whether to continue. The user already chose.
- If the request includes `--fresh`, do not ask whether to continue. The user already chose.
- Otherwise, before starting Gemini, check for a resumable rescue session from this Claude session by running:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/gemini-companion.mjs" task-resume-candidate --json
```

- If that helper reports an `activeJob`, do not ask. Stop and tell the user a task is already running; point them at `/gemini:status`.
- If it reports `available: true`, use `AskUserQuestion` exactly once to ask whether to continue the current Gemini session or start a new one.
- The two choices must be:
  - `Continue current Gemini session`
  - `Start a new Gemini session`
- If the user is clearly giving a follow-up instruction such as "continue", "keep going", "resume", "apply the top fix", or "dig deeper", put `Continue current Gemini session (Recommended)` first.
- Otherwise put `Start a new Gemini session (Recommended)` first.
- If the user chooses continue, add `--resume` before routing to the subagent.
- If the user chooses a new session, add `--fresh` before routing to the subagent.
- If the helper reports `available: false` and no active job, do not ask. Route normally.

Operating rules:

- The subagent is a thin forwarder only. It should use one `Bash` call to invoke `node "${CLAUDE_PLUGIN_ROOT}/scripts/gemini-companion.mjs" task ...` and return that command's stdout as-is.
- Return the Gemini companion stdout verbatim to the user.
- Do not paraphrase, summarize, rewrite, or add commentary before or after it.
- Do not ask the subagent to inspect files, monitor progress, poll `/gemini:status`, fetch `/gemini:result`, call `/gemini:cancel`, summarize output, or do follow-up work of its own.
- Leave `--effort` unset unless the user explicitly asks for a specific reasoning effort.
- Leave the model unset unless the user explicitly asks for one. Available model ids include `gemini-3.6-flash-high`, `gemini-3.6-flash-medium`, `gemini-3.6-flash-low`, `gemini-3.5-flash-high`, `gemini-3.1-pro-high`, `claude-sonnet-4-6`, `claude-opus-4-6-thinking`, `gpt-oss-120b-medium`.
- Leave `--resume` and `--fresh` in the forwarded request. The subagent handles that routing when it builds the `task` command.
- The rescue subagent defaults to write mode (`--write`, `--dangerously-skip-permissions` on the agy side). This is destructive-capable: agy can edit files and run shell commands with no per-action confirmation. If the user did not clearly ask for changes (they only want investigation, review, or an explanation), tell the subagent to omit `--write` so agy stays in `--mode plan` instead.
- If the helper reports that agy is missing or unauthenticated, stop and tell the user to run `/gemini:setup`.
- If the user did not supply a request, ask what Gemini should investigate or fix.
