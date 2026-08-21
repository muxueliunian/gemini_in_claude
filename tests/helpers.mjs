import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

export function makeTempDir(prefix = "gemini-plugin-test-") {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

export function run(command, args, options = {}) {
  return spawnSync(command, args, {
    cwd: options.cwd,
    env: options.env,
    encoding: "utf8",
    shell: false,
    windowsHide: true
  });
}

const TESTS_DIR = path.dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT = path.resolve(TESTS_DIR, "..", "plugins", "gemini");
const COMPANION_SCRIPT = path.join(PLUGIN_ROOT, "scripts", "gemini-companion.mjs");
const FAKE_AGY = path.join(TESTS_DIR, "fixtures", "fake-agy.mjs");

export function companionEnv(overrides = {}) {
  return {
    ...process.env,
    GEMINI_COMPANION_AGY_BIN: FAKE_AGY,
    GEMINI_HOME: overrides.geminiHome ?? makeTempDir("gemini-home-"),
    ...overrides
  };
}

export function runCompanion(argv, options = {}) {
  return run(process.execPath, [COMPANION_SCRIPT, ...argv], {
    cwd: options.cwd,
    env: options.env ?? companionEnv(options.envOverrides)
  });
}

export function ensureFakeAuthFile(geminiHome) {
  fs.mkdirSync(geminiHome, { recursive: true });
  fs.writeFileSync(path.join(geminiHome, "oauth_creds.json"), JSON.stringify({ token: "fake" }), "utf8");
}
