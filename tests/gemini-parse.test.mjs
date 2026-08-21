import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

import { makeTempDir } from "./helpers.mjs";
import {
  buildHeadlessArgv,
  getAgyAuthStatus,
  getAgyAvailability,
  parseHeadlessOutput,
  READ_ONLY_MODE_FLAGS,
  WRITE_MODE_FLAGS
} from "../plugins/gemini/scripts/lib/gemini.mjs";
import { formatSpend } from "../plugins/gemini/scripts/lib/render.mjs";

const FIXTURE_PATH = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "fixtures",
  "agy-headless-json-1.1.10.json"
);

test("parseHeadlessOutput parses the captured real-agy fixture (1.1.10)", () => {
  const stdout = fs.readFileSync(FIXTURE_PATH, "utf8");
  const result = parseHeadlessOutput(stdout);
  assert.equal(result.ok, true);
  assert.equal(result.text, "ok\n");
  assert.equal(result.status, "SUCCESS");
  assert.equal(result.conversationId, "6f1661ef-89f1-4434-8174-b627ec0ba9e2");
  assert.equal(result.numTurns, 1);
  assert.equal(result.usage.total_tokens, 22214);
});

test("parseHeadlessOutput ignores unbalanced/noise braces and takes the real trailing object", () => {
  const stdout = [
    "{ this looks like json but is not",
    "Checking for updates...",
    JSON.stringify({ conversation_id: "abc", status: "SUCCESS", response: "hi\n", num_turns: 1 })
  ].join("\n");
  const result = parseHeadlessOutput(stdout);
  assert.equal(result.ok, true);
  assert.equal(result.text, "hi\n");
  assert.equal(result.conversationId, "abc");
});

test("parseHeadlessOutput recognizes type:error before reading response", () => {
  const stdout = JSON.stringify({ type: "error", message: "Couldn't start session: boom" });
  const result = parseHeadlessOutput(stdout);
  assert.equal(result.ok, false);
  assert.equal(result.kind, "error");
  assert.equal(result.message, "Couldn't start session: boom");
});

test("parseHeadlessOutput treats non-SUCCESS status as an error", () => {
  const stdout = JSON.stringify({
    conversation_id: "abc",
    status: "ERROR",
    error: "quota exceeded"
  });
  const result = parseHeadlessOutput(stdout);
  assert.equal(result.ok, false);
  assert.equal(result.kind, "error");
  assert.equal(result.message, "quota exceeded");
});

test("parseHeadlessOutput reports unparseable when nothing valid is found", () => {
  const result = parseHeadlessOutput("nothing but plain text here");
  assert.equal(result.ok, false);
  assert.equal(result.kind, "unparseable");
});

test("parseHeadlessOutput takes the last of multiple top-level objects", () => {
  const first = JSON.stringify({ conversation_id: "a", status: "SUCCESS", response: "first" });
  const second = JSON.stringify({ conversation_id: "b", status: "SUCCESS", response: "second" });
  const result = parseHeadlessOutput(`${first}\n${second}`);
  assert.equal(result.text, "second");
  assert.equal(result.conversationId, "b");
});

test("formatSpend renders turns and ignores missing cost", () => {
  assert.equal(formatSpend({ numTurns: 1 }), "1 turn");
  assert.equal(formatSpend({ numTurns: 7 }), "7 turns");
  assert.equal(formatSpend({}), null);
});

test("buildHeadlessArgv: write mode uses skip-permissions + accept-edits, not plan", () => {
  const argv = buildHeadlessArgv({ prompt: "do it", write: true });
  for (const flag of WRITE_MODE_FLAGS) {
    assert.ok(argv.includes(flag), `missing ${flag}`);
  }
  assert.ok(!argv.includes("plan"));
  assert.ok(argv.includes("--disable-slash-commands"));
  assert.equal(argv[argv.indexOf("--output-format") + 1], "json");
});

test("buildHeadlessArgv: read-only mode uses --mode plan, no skip-permissions", () => {
  const argv = buildHeadlessArgv({ prompt: "look", write: false });
  assert.equal(argv[argv.indexOf("--mode") + 1], "plan");
  assert.deepEqual(READ_ONLY_MODE_FLAGS, ["--mode", "plan"]);
  assert.ok(!argv.includes("--dangerously-skip-permissions"));
});

test("buildHeadlessArgv: resume carries an explicit conversation id, never -c or --continue", () => {
  const argv = buildHeadlessArgv({ prompt: "continue", write: true, resumeConversationId: "conv-123" });
  const idx = argv.indexOf("--conversation");
  assert.notEqual(idx, -1);
  assert.equal(argv[idx + 1], "conv-123");
  assert.ok(!argv.includes("-c"));
  assert.ok(!argv.includes("--continue"));
});

test("buildHeadlessArgv: fresh run does not invent a session id flag", () => {
  const argv = buildHeadlessArgv({ prompt: "start", write: true });
  assert.ok(!argv.includes("--conversation"));
  assert.ok(!argv.includes("--session-id"));
});

test("buildHeadlessArgv: model and effort are passed through", () => {
  const argv = buildHeadlessArgv({ prompt: "go", write: true, model: "gemini-3.6-flash-high", effort: "high" });
  assert.equal(argv[argv.indexOf("--model") + 1], "gemini-3.6-flash-high");
  assert.equal(argv[argv.indexOf("--effort") + 1], "high");
});

test("getAgyAvailability reports available:false for a nonexistent binary override", () => {
  const result = getAgyAvailability({ ...process.env, GEMINI_COMPANION_AGY_BIN: "C:/nope/does-not-exist-agy.exe" });
  assert.equal(result.available, false);
});

test("getAgyAvailability reports available:true against the fake agy fixture", () => {
  const fakeAgy = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "fake-agy.mjs");
  const result = getAgyAvailability({ ...process.env, GEMINI_COMPANION_AGY_BIN: fakeAgy });
  assert.equal(result.available, true);
});

test("getAgyAuthStatus: oauth_creds.json presence implies logged in", () => {
  const geminiHome = makeTempDir();
  fs.writeFileSync(path.join(geminiHome, "oauth_creds.json"), "{}", "utf8");
  const status = getAgyAuthStatus({ ...process.env, GEMINI_HOME: geminiHome, GEMINI_API_KEY: "" });
  assert.equal(status.loggedIn, true);
  assert.equal(status.method, "oauth_creds.json");
});

test("getAgyAuthStatus: GEMINI_API_KEY is a fallback when oauth file is absent", () => {
  const geminiHome = makeTempDir();
  const status = getAgyAuthStatus({ ...process.env, GEMINI_HOME: geminiHome, GEMINI_API_KEY: "test-key" });
  assert.equal(status.loggedIn, true);
  assert.equal(status.method, "GEMINI_API_KEY");
});

test("getAgyAuthStatus: neither present means not logged in (not a network probe)", () => {
  const geminiHome = makeTempDir();
  const status = getAgyAuthStatus({ ...process.env, GEMINI_HOME: geminiHome, GEMINI_API_KEY: "" });
  assert.equal(status.loggedIn, false);
});
