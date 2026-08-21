# gemini-plugin-cc

和 `grok-plugin-cc` / Codex 的 Claude Code 插件类似，`gemini-plugin-cc` 让你能把一部分任务顺手甩给本机的 **Antigravity CLI**（`agy`，默认走你在 `agy` 里选中的模型，本机当前是 Gemini 3.6 Flash Medium）去处理——修 bug、跑排查、写点边角代码，都可以交给它，你只需要回来看结果。这类任务不占用 Claude 的订阅额度。

技术上，这是一个 Claude Code marketplace 插件，通过 headless 模式（`agy -p ... --output-format json`）调用本机安装的 Antigravity CLI。结构上镜像 `grok_in_claude`：slash 命令、一个薄转发子代理、一个负责跟踪后台任务的 companion 运行时。

## 环境要求

- Node.js 18.18+
- 本机已安装并登录 Antigravity CLI（`agy --version` 确认已装；本机路径通常是 `%LOCALAPPDATA%\agy\bin\agy.exe`）。首次使用需运行一次 `agy` 完成 Google 登录，或设置 `GEMINI_API_KEY`。

## 安装

从本地克隆/检出目录安装：

```text
/plugin marketplace add C:\Users\atlas\Desktop\gemini_in_claude
/plugin install gemini@gemini-plugin-cc
/gemini:setup
```

`/gemini:setup` 会报告 Node、`agy` 二进制、登录状态是否都就绪；若有缺失会给出下一步操作提示。

## 用法

```text
/gemini:rescue fix the failing tests in src/parser
/gemini:rescue --background do a deep investigation of the flaky test suite
/gemini:rescue --model gemini-3.6-flash-high --effort high rewrite the parser
/gemini:status
/gemini:status task-abc123
/gemini:result task-abc123
/gemini:cancel task-abc123
```

- `/gemini:rescue` 默认走**可写模式**：agy 以 `--dangerously-skip-permissions` + `--mode accept-edits` 运行，可以直接编辑文件、执行 shell 命令，不会逐条询问确认。如果你只想让它做只读的调研/诊断/审查，明确说清楚即可（会走 `--mode plan`）。
- `--resume` 会接续本次 Claude Code 会话里最近的 Gemini 会话；`--fresh` 强制开新的。两个都不传时，如果存在可续跑的会话，会问你一次。
- `--background` 会把任务放进后台队列并 detach 一个 worker 进程；用 `/gemini:status` 看进度，用 `/gemini:result` 取最终文本。
- 每个完成的 job 都会记录一个 Antigravity `conversation_id`。离开 Claude Code 之后，你也可以直接用 `agy --conversation <id>` 续跑。
- `--model` 可选值（本机 `agy models` 实测）：`gemini-3.6-flash-high` / `medium` / `low`、`gemini-3.5-flash-*`、`gemini-3.1-pro-high` / `low`、`claude-sonnet-4-6`、`claude-opus-4-6-thinking`、`gpt-oss-120b-medium`。
- `--effort` 仅接受 `low` | `medium` | `high`。

## 工作原理

```text
/gemini:rescue ...
  -> skills/rescue/SKILL.md（slash 命令）
    -> Agent 工具：subagent_type "gemini:gemini-rescue"
      -> Bash: node scripts/gemini-companion.mjs task ...
        -> spawn: agy.exe -p "..." --output-format json --dangerously-skip-permissions --mode accept-edits
        -> 解析 JSON、写入 job 状态、打印结果
```

`status` / `result` / `cancel` 通过 `!` 直接调用 companion 脚本（不经过模型往返）。后台任务会 spawn 一个 detached 的 `gemini-companion.mjs task-worker` 进程，跑同样的 headless 调用，完成后把结果写进 job 文件。

## 与 grok_in_claude 的关键差异

| 点 | grok_in_claude | gemini_in_claude |
| --- | --- | --- |
| 二进制 | `grok.exe` | `agy.exe` |
| 可写 | `--always-approve` | `--dangerously-skip-permissions --mode accept-edits` |
| 只读 | `--tools` 白名单 + `--no-subagents` | `--mode plan` |
| 续跑 | `--resume <sessionId>`，可预分配 `--session-id` | `--conversation <id>`，id 只在首次成功后从 JSON 拿到 |
| 禁止的“续最近一次” | `-c` / 无参 `-r` | `-c` / `--continue` |
| 工作目录 | `--cwd` | spawn 的 cwd（agy 无 `--cwd`） |
| 长 prompt | `--prompt-file` | `-p` 直接传（agy 无 `--prompt-file`） |
| 鉴权 | `~/.grok/auth.json` / `XAI_API_KEY` | `~/.gemini/oauth_creds.json` / `GEMINI_API_KEY` |

## 数据存储与隐私

Job 状态存放在 `$CLAUDE_PLUGIN_DATA/state/<workspace-slug>-<hash16>/` 下（若 `CLAUDE_PLUGIN_DATA` 未设置，退化到 `%TEMP%\gemini-companion\`）：

- `state.json` —— 该工作区最近 50 条 job 的索引
- `jobs/<job-id>.json` —— 完整 job 记录，**包含完整的 prompt 原文和 agy 的完整回复**
- `jobs/<job-id>.log` —— 简要进度日志

超出 50 条的旧 job 会被自动裁剪。prompt 与输出以明文形式留存在磁盘上，直到被裁剪清理。

## 安全提示

- **写模式以 `--dangerously-skip-permissions` 运行。** agy 可以在目标工作目录里编辑任意文件、执行任意 shell 命令，不会逐条确认。请在一个你愿意检查并可以回退的分支上使用。
- **只读模式是尽力而为，不是沙箱。** 它把 agy 放到 `--mode plan`，不传 skip-permissions。不要把它当成安全边界。
- **cancel 杀的是进程树，不是共享服务。** `/gemini:cancel` 对 worker 自己的进程树执行 `taskkill /PID <pid> /T /F`。
- **agy 不能预分配 conversation id。** 第一次调用失败、还没写出 JSON 时，这次任务无法 resume。
- **按会话过滤依赖 `SessionStart` 钩子已经运行过一次。** 中途安装或 reload 插件后，重启一次会话即可让钩子生效。

## 开发

```text
npm test
```

跑全套测试（`tests/*.test.mjs`），针对的是一个假的 `agy` 二进制 fixture——不联网，不会真的调用 Antigravity。`tests/fixtures/agy-headless-json-1.1.10.json` 是真实采集的 `agy -p "..." --output-format json` 响应。

## 许可证

Apache-2.0。结构参考来源见 `NOTICE`。
