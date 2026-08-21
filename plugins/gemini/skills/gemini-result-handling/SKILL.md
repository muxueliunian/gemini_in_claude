---
name: gemini-result-handling
description: Internal guidance for presenting Gemini helper output back to the user
when_to_use: Use when presenting gemini-companion stdout, a failed Gemini job, or /gemini:result output.
user-invocable: false
---

# Gemini Result Handling

When the helper returns Gemini output:
- Preserve the helper's structure verbatim — job id, status, result text, Antigravity conversation id, resume hint, and spend (turns) when present.
- Use file paths and line numbers exactly as the helper reports them.
- For `gemini:gemini-rescue`, do not turn a failed or incomplete Gemini run into a Claude-side implementation attempt. Report the failure and stop.
- For `gemini:gemini-rescue`, if Gemini was never successfully invoked, do not generate a substitute answer at all.
- If the helper reports malformed output or a failed Gemini run, include the most actionable stderr/error lines and stop there instead of guessing.
- If the helper reports that setup or authentication is required, direct the user to `/gemini:setup` and do not improvise alternate auth flows.
- If the job ran in write mode, say so explicitly — the changes were made by agy with `--dangerously-skip-permissions`, not reviewed by Claude before being applied.
