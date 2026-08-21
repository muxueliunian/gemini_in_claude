import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";

import { killProcessTree, probeBinary } from "./process.mjs";

/**
 * agy has no `--tools` allowlist. Read-only runs use `--mode plan` (the
 * documented headless plan mode). Write runs use
 * `--dangerously-skip-permissions` plus `--mode accept-edits`. This is a
 * best-effort constraint, not a security boundary.
 */
export const WRITE_MODE_FLAGS = ["--dangerously-skip-permissions", "--mode", "accept-edits"];
export const READ_ONLY_MODE_FLAGS = ["--mode", "plan"];

const AGY_BIN_ENV = "GEMINI_COMPANION_AGY_BIN";
const DEFAULT_PRINT_TIMEOUT = "20m";

export function geminiHomeDir(env = process.env) {
  return env.GEMINI_HOME || path.join(os.homedir(), ".gemini");
}

/**
 * Locate the agy binary. Order: explicit env override (tests use a .mjs
 * fake here), the documented Windows install location, then PATH.
 */
export function resolveAgyBinary(env = process.env) {
  const override = env[AGY_BIN_ENV];
  if (override) {
    return override;
  }
  const installed = path.join(
    env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local"),
    "agy",
    "bin",
    process.platform === "win32" ? "agy.exe" : "agy"
  );
  if (fs.existsSync(installed)) {
    return installed;
  }
  return process.platform === "win32" ? "agy.exe" : "agy";
}

/**
 * When the binary path is a Node script (test fake), spawn it through the
 * current Node executable so `shell: false` keeps working on Windows.
 */
export function spawnCommandFor(binary) {
  if (/\.(mjs|cjs|js)$/i.test(binary)) {
    return { command: process.execPath, argvPrefix: [binary] };
  }
  return { command: binary, argvPrefix: [] };
}

export function getAgyAvailability(env = process.env) {
  const binary = resolveAgyBinary(env);
  const { command, argvPrefix } = spawnCommandFor(binary);
  const probe = probeBinary(command, [...argvPrefix, "--version"], { env });
  return { available: probe.available, detail: probe.detail, binary };
}

/**
 * Auth detection: cached OAuth in ~/.gemini/oauth_creds.json, or
 * GEMINI_API_KEY as a fallback (Antigravity CLI 1.1.13+). Network
 * reachability is deliberately not probed.
 */
export function getAgyAuthStatus(env = process.env) {
  const home = geminiHomeDir(env);
  const oauthFile = path.join(home, "oauth_creds.json");
  const hasOauth = fs.existsSync(oauthFile);
  const hasApiKey = Boolean(env.GEMINI_API_KEY);
  return {
    loggedIn: hasOauth || hasApiKey,
    method: hasOauth ? "oauth_creds.json" : hasApiKey ? "GEMINI_API_KEY" : null,
    oauthFile
  };
}

/**
 * Build the agy argv for one headless run.
 *
 * request: { prompt, cwd, write, model, effort, resumeConversationId, printTimeout }
 *
 * - write mode: --dangerously-skip-permissions --mode accept-edits
 * - read mode: --mode plan
 * - resume MUST carry an explicit conversation id (`-c` / `--continue` are
 *   banned: they pick up the user's own most recent interactive session)
 * - agy does not accept a pre-assigned session id; conversation_id only
 *   appears in the JSON envelope after the first successful turn
 * - agy has no --cwd / --prompt-file; cwd is the spawn cwd, prompt is `-p`
 */
export function buildHeadlessArgv(request) {
  const argv = ["-p", request.prompt ?? ""];
  argv.push("--output-format", "json");
  argv.push("--disable-slash-commands");
  argv.push("--print-timeout", request.printTimeout || DEFAULT_PRINT_TIMEOUT);
  if (request.resumeConversationId) {
    argv.push("--conversation", request.resumeConversationId);
  }
  if (request.write) {
    argv.push(...WRITE_MODE_FLAGS);
  } else {
    argv.push(...READ_ONLY_MODE_FLAGS);
  }
  if (request.model) {
    argv.push("--model", request.model);
  }
  if (request.effort) {
    argv.push("--effort", request.effort);
  }
  return argv;
}

/**
 * Extract the final JSON object from agy's stdout.
 *
 * Captured 1.1.10 envelope is a single line, but we still scan for a
 * trailing top-level object so pretty-printed or noisy output still parses.
 */
function extractBalancedObject(raw, start) {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = raw.indexOf("{", start); i >= 0 && i < raw.length; i += 1) {
    const ch = raw[i];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (ch === "\\") {
        escaped = true;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }
    if (ch === '"') {
      inString = true;
    } else if (ch === "{") {
      depth += 1;
    } else if (ch === "}") {
      depth -= 1;
      if (depth === 0) {
        return raw.slice(raw.indexOf("{", start), i + 1);
      }
    }
  }
  return null;
}

function isSuccessStatus(status) {
  if (status == null || status === "") {
    return true;
  }
  const normalized = String(status).trim().toUpperCase();
  return normalized === "SUCCESS" || normalized === "OK" || normalized === "COMPLETED" || normalized === "COMPLETE";
}

export function parseHeadlessOutput(stdout) {
  const raw = String(stdout ?? "").replace(/^\uFEFF/, "");
  const candidates = [];
  const lineStartBrace = /^[ \t]*\{/gm;
  let match;
  while ((match = lineStartBrace.exec(raw)) !== null) {
    const candidate = extractBalancedObject(raw, match.index);
    if (candidate) {
      candidates.push(candidate);
    }
  }

  let parsed = null;
  for (const candidate of candidates) {
    try {
      const value = JSON.parse(candidate);
      if (value && typeof value === "object") {
        parsed = value;
      }
    } catch {
      // keep scanning
    }
  }

  if (!parsed) {
    return { ok: false, kind: "unparseable", raw };
  }
  if (parsed.type === "error") {
    return { ok: false, kind: "error", message: String(parsed.message ?? "unknown agy error"), raw };
  }
  if (!isSuccessStatus(parsed.status)) {
    const message =
      parsed.error ??
      parsed.message ??
      parsed.error_message ??
      parsed.response ??
      `agy status ${parsed.status}`;
    return { ok: false, kind: "error", message: String(message), raw };
  }

  const text =
    typeof parsed.response === "string"
      ? parsed.response
      : typeof parsed.text === "string"
        ? parsed.text
        : "";

  return {
    ok: true,
    kind: "result",
    text,
    status: parsed.status ?? null,
    conversationId: parsed.conversation_id ?? parsed.conversationId ?? null,
    durationSeconds: Number.isFinite(Number(parsed.duration_seconds)) ? Number(parsed.duration_seconds) : null,
    numTurns: Number.isFinite(Number(parsed.num_turns)) ? Number(parsed.num_turns) : null,
    usage: parsed.usage && typeof parsed.usage === "object" ? parsed.usage : null,
    raw
  };
}

const DEFAULT_HEADLESS_TIMEOUT_MS = 20 * 60 * 1000;

/**
 * Run one headless agy turn. Spawns with shell:false and an argv array.
 *
 * options.onSpawn(pid) fires as soon as the child exists so the caller can
 * record the pid for cancel. options.timeoutMs overrides the default hang
 * guard (env GEMINI_COMPANION_TIMEOUT_MS also works).
 */
export function runAgyHeadless(request, options = {}) {
  const env = options.env ?? process.env;
  const binary = resolveAgyBinary(env);
  const { command, argvPrefix } = spawnCommandFor(binary);
  const timeoutMs = options.timeoutMs ?? (Number(env.GEMINI_COMPANION_TIMEOUT_MS) || DEFAULT_HEADLESS_TIMEOUT_MS);
  const argv = [...argvPrefix, ...buildHeadlessArgv(request)];

  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(command, argv, {
        cwd: request.cwd,
        env,
        shell: false,
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"]
      });
    } catch (error) {
      reject(error);
      return;
    }

    options.onSpawn?.(child.pid ?? null);

    let stdout = "";
    let stderr = "";
    let timedOut = false;
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });

    const timer = setTimeout(() => {
      timedOut = true;
      try {
        killProcessTree(child.pid ?? Number.NaN);
      } catch {
        // best effort; the close handler still resolves either way
      }
    }, timeoutMs);
    timer.unref?.();

    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (exitCode, signal) => {
      clearTimeout(timer);
      resolve({
        exitCode: timedOut ? -1 : exitCode ?? (signal ? 1 : 0),
        signal: signal ?? null,
        stdout,
        stderr,
        timedOut,
        parsed: timedOut
          ? {
              ok: false,
              kind: "error",
              message: `agy did not respond within ${timeoutMs}ms and was terminated.`,
              raw: stdout
            }
          : parseHeadlessOutput(stdout)
      });
    });
  });
}
