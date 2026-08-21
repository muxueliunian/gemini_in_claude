# Preflight results (agy 1.1.10)

Captured 2026-08-16 on Windows 11.

## Binary

- Path: `C:\Users\atlas\AppData\Local\agy\bin\agy.exe`
- `agy --version` → `1.1.10`
- Changelog on the same machine also lists 1.1.11–1.1.13 notes (binary still reports 1.1.10)

## Models (`agy models`)

```
gemini-3.6-flash-high
gemini-3.6-flash-medium
gemini-3.6-flash-low
gemini-3.5-flash-high
gemini-3.5-flash-medium
gemini-3.5-flash-low
gemini-3.1-pro-high
gemini-3.1-pro-low
claude-sonnet-4-6
claude-opus-4-6-thinking
gpt-oss-120b-medium
```

## Headless JSON

Command:

```
agy -p "Reply with only the word ok. No punctuation." --output-format json --model gemini-3.6-flash-low --print-timeout 3m --disable-slash-commands
```

Stdout (single line):

```json
{
  "conversation_id": "6f1661ef-89f1-4434-8174-b627ec0ba9e2",
  "status": "SUCCESS",
  "response": "ok\n",
  "duration_seconds": 6.9299524,
  "num_turns": 1,
  "usage": {
    "input_tokens": 22209,
    "output_tokens": 5,
    "thinking_tokens": 0,
    "cache_read_tokens": 0,
    "total_tokens": 22214
  }
}
```

## Resume

```
agy -p "Reply with only the word resumed." --conversation 6f1661ef-89f1-4434-8174-b627ec0ba9e2 --output-format json --model gemini-3.6-flash-low --print-timeout 3m --disable-slash-commands
```

Returned the same `conversation_id`, `num_turns: 2`, `response: "resumed\n"`. Explicit `--conversation <id>` works.

A nonexistent UUID (`00000000-0000-0000-0000-000000000000`) did **not** fail: agy started a new conversation and returned a new `conversation_id` with `status: SUCCESS`. Companion therefore must never invent or guess an id.

`--prompt-file` is not a flag (`flags provided but not defined: -prompt-file`).

Notes:

- No `--cwd`. Workspace is the process cwd.
- No `--prompt-file`. Prompt is `-p`.
- No `--session-id` pre-assignment. Resume is `--conversation <id>`.
- Do not use `-c` / `--continue` (picks the user's most recent interactive conversation).
- Write: `--dangerously-skip-permissions` + `--mode accept-edits`.
- Read-only: `--mode plan`.
- Auth: `~/.gemini/oauth_creds.json` present; `GEMINI_API_KEY` is a 1.1.13 fallback.
- `--print-timeout` default is `5m0s`; companion always passes `20m`.

---

## Recheck: agy 1.1.16 (2026-08-21)

`agy --version` → `1.1.16`. All contract assumptions above still hold: no `--cwd`,
no `--prompt-file`, no session-id pre-assignment, resume is `--conversation <id>`,
`--print-timeout` still defaults to `5m0s`.

### Models added since 1.1.10

`agy models` now also lists the 3.7 flash tier:

```
gemini-3.7-flash-high
gemini-3.7-flash-medium
gemini-3.7-flash-low
```

Everything from the 1.1.10 list is still present. The companion does not keep a
model allowlist, so new ids work without a code change.

### Flags added since 1.1.10

- `--add-dir <dir>` — add another directory to the workspace (repeatable).
- `--sandbox` — run with terminal restrictions enabled. Not used by the companion
  today; a candidate for hardening read-only mode beyond `--mode plan`.
