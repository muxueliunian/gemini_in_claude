import test from "node:test";
import assert from "node:assert/strict";

import { companionEnv, ensureFakeAuthFile, makeTempDir, runCompanion } from "./helpers.mjs";

function readJson(result) {
  assert.equal(result.status, 0, `expected exit 0, got ${result.status}. stderr: ${result.stderr}`);
  return JSON.parse(result.stdout);
}

function authedEnv(overrides = {}) {
  const geminiHome = makeTempDir("gemini-home-authed-");
  ensureFakeAuthFile(geminiHome);
  return companionEnv({ geminiHome, FAKE_AGY_BEHAVIOR: "ok", ...overrides });
}

async function waitFor(predicate, { timeoutMs = 8000, intervalMs = 100 } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = predicate();
    if (value) {
      return value;
    }
    if (Date.now() > deadline) {
      throw new Error("waitFor timed out");
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

// ---------------------------------------------------------------------------
// setup

test("setup --json: reports not ready when agy binary is missing", () => {
  const cwd = makeTempDir();
  const env = companionEnv({ GEMINI_COMPANION_AGY_BIN: "C:/nope/missing-agy.exe" });
  const result = runCompanion(["setup", "--json"], { cwd, env });
  const payload = readJson(result);
  assert.equal(payload.ready, false);
  assert.equal(payload.agy.available, false);
});

test("setup --json: reports not ready when agy is available but not authenticated", () => {
  const cwd = makeTempDir();
  const geminiHome = makeTempDir();
  const env = companionEnv({ geminiHome, FAKE_AGY_BEHAVIOR: "ok" });
  delete env.GEMINI_API_KEY;
  const result = runCompanion(["setup", "--json"], { cwd, env });
  const payload = readJson(result);
  assert.equal(payload.agy.available, true);
  assert.equal(payload.auth.loggedIn, false);
  assert.equal(payload.ready, false);
});

test("setup --json: ready when agy is installed and oauth_creds.json is present", () => {
  const cwd = makeTempDir();
  const env = authedEnv();
  const result = runCompanion(["setup", "--json"], { cwd, env });
  const payload = readJson(result);
  assert.equal(payload.ready, true);
});

// ---------------------------------------------------------------------------
// task (foreground)

test("task: read-only foreground run round-trips the prompt without --write", () => {
  const cwd = makeTempDir();
  const env = authedEnv();
  const result = runCompanion(["task", "--json", "hello there"], { cwd, env });
  const payload = readJson(result);
  assert.equal(payload.status, "completed");
  assert.equal(payload.write, false);
  assert.equal(payload.resultText, "readonly-echo:hello there\n");
});

test("task: --write foreground run uses skip-permissions path", () => {
  const cwd = makeTempDir();
  const env = authedEnv();
  const result = runCompanion(["task", "--write", "--json", "make the change"], { cwd, env });
  const payload = readJson(result);
  assert.equal(payload.write, true);
  assert.equal(payload.resultText, "write-echo:make the change\n");
});

test("task: requires a prompt when not resuming", () => {
  const cwd = makeTempDir();
  const env = authedEnv();
  const result = runCompanion(["task", "--json"], { cwd, env });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Provide a prompt/);
});

test("task: refuses to run when agy is not authenticated", () => {
  const cwd = makeTempDir();
  const geminiHome = makeTempDir();
  const env = companionEnv({ geminiHome, FAKE_AGY_BEHAVIOR: "ok" });
  delete env.GEMINI_API_KEY;
  const result = runCompanion(["task", "hello"], { cwd, env });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /not logged in/);
});

test("task: an agy-side error is surfaced as a failed job, not a crash", () => {
  const cwd = makeTempDir();
  const env = authedEnv({ FAKE_AGY_BEHAVIOR: "error" });
  const result = runCompanion(["task", "--json", "trigger failure"], { cwd, env });
  const payload = JSON.parse(result.stdout);
  assert.notEqual(result.status, 0);
  assert.equal(payload.status, "failed");
  assert.match(payload.error, /simulated agy failure/);
});

test("task: prompt with embedded newlines round-trips through -p", () => {
  const cwd = makeTempDir();
  const env = authedEnv();
  const prompt = "line one\nline two\nline three";
  const result = runCompanion(["task", "--json", prompt], { cwd, env });
  const payload = readJson(result);
  assert.equal(payload.resultText, `readonly-echo:${prompt}\n`);
});

test("task: noisy stdout (unbalanced brace + update-check noise) still parses the real result", () => {
  const cwd = makeTempDir();
  const env = authedEnv({ FAKE_AGY_BEHAVIOR: "noisy" });
  const result = runCompanion(["task", "--json", "ping"], { cwd, env });
  const payload = readJson(result);
  assert.equal(payload.status, "completed");
  assert.equal(payload.resultText, "readonly-echo:ping\n");
});

// ---------------------------------------------------------------------------
// resume

test("task: --resume-last resumes the conversation id from the prior task in this session", () => {
  const cwd = makeTempDir();
  const env = authedEnv({ GEMINI_COMPANION_SESSION_ID: "claude-session-a" });

  const first = readJson(runCompanion(["task", "--write", "--json", "start work"], { cwd, env }));
  assert.ok(first.geminiConversationId);

  const second = readJson(runCompanion(["task", "--resume-last", "--json", "keep going"], { cwd, env }));
  assert.equal(second.geminiConversationId, first.geminiConversationId);
  assert.equal(second.resultText, `resumed:write:${first.geminiConversationId}:keep going\n`);
});

test("task: --resume-last without --write inherits the original job's write mode", () => {
  const cwd = makeTempDir();
  const env = authedEnv({ GEMINI_COMPANION_SESSION_ID: "claude-session-inherit" });

  readJson(runCompanion(["task", "--write", "--json", "start work"], { cwd, env }));
  const second = readJson(runCompanion(["task", "--resume-last", "--json", "continue"], { cwd, env }));
  assert.equal(second.write, true);
  assert.match(second.resultText, /^resumed:write:/);
});

test("task: --resume-last --write=false explicitly overrides the inherited write mode", () => {
  const cwd = makeTempDir();
  const env = authedEnv({ GEMINI_COMPANION_SESSION_ID: "claude-session-override" });

  readJson(runCompanion(["task", "--write", "--json", "start work"], { cwd, env }));
  const second = readJson(
    runCompanion(["task", "--resume-last", "--write=false", "--json", "continue read-only"], { cwd, env })
  );
  assert.equal(second.write, false);
  assert.match(second.resultText, /^resumed:readonly:/);
});

test("task: --resume-last is scoped to the current Claude session id", () => {
  const cwd = makeTempDir();
  const envA = authedEnv({ GEMINI_COMPANION_SESSION_ID: "claude-session-a" });
  const envB = { ...envA, GEMINI_COMPANION_SESSION_ID: "claude-session-b" };

  readJson(runCompanion(["task", "--write", "--json", "session A work"], { cwd, env: envA }));
  const result = runCompanion(["task", "--resume-last", "--json"], { cwd, env: envB });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /No previous Gemini task conversation/);
});

test("task: --resume-last and --fresh together is a usage error", () => {
  const cwd = makeTempDir();
  const env = authedEnv();
  const result = runCompanion(["task", "--resume-last", "--fresh", "go"], { cwd, env });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Choose either/);
});

// ---------------------------------------------------------------------------
// background + status + result + cancel

test("task --background: queues, completes, and result/status reflect it", async () => {
  const cwd = makeTempDir();
  const env = authedEnv();
  const queued = readJson(runCompanion(["task", "--background", "--json", "long running work"], { cwd, env }));
  assert.equal(queued.status, "queued");
  assert.ok(queued.jobId);

  await waitFor(() => {
    const status = readJson(runCompanion(["status", queued.jobId, "--json"], { cwd, env }));
    return status.job.status === "completed" ? status : null;
  });

  const result = readJson(runCompanion(["result", queued.jobId, "--json"], { cwd, env }));
  assert.equal(result.job.status, "completed");
  assert.equal(result.record.resultText, "readonly-echo:long running work\n");
});

test("cancel: kills a slow background job and marks it cancelled", async () => {
  const cwd = makeTempDir();
  const env = authedEnv({ FAKE_AGY_BEHAVIOR: "slow", FAKE_AGY_DELAY_MS: "60000" });
  const queued = readJson(runCompanion(["task", "--background", "--write", "--json", "slow task"], { cwd, env }));

  await waitFor(() => {
    const status = readJson(runCompanion(["status", queued.jobId, "--json"], { cwd, env }));
    return status.job.status === "running" && status.job.pid ? status : null;
  });

  const cancelled = readJson(runCompanion(["cancel", queued.jobId, "--json"], { cwd, env }));
  assert.equal(cancelled.status, "cancelled");

  const status = readJson(runCompanion(["status", queued.jobId, "--json"], { cwd, env }));
  assert.equal(status.job.status, "cancelled");
});

test("cancel: refuses to cancel a job that already finished (terminal-state protection)", () => {
  const cwd = makeTempDir();
  const env = authedEnv();
  const done = readJson(runCompanion(["task", "--json", "quick job"], { cwd, env }));
  const result = runCompanion(["cancel", done.jobId, "--json"], { cwd, env });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /No active job found/);
});

test("cancel: with no job id and no active jobs reports a clear error", () => {
  const cwd = makeTempDir();
  const env = authedEnv();
  const result = runCompanion(["cancel", "--json"], { cwd, env });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /No active Gemini jobs/);
});

// ---------------------------------------------------------------------------
// task-resume-candidate (session scoping)

test("task-resume-candidate: unavailable with no prior jobs", () => {
  const cwd = makeTempDir();
  const env = authedEnv({ GEMINI_COMPANION_SESSION_ID: "claude-session-x" });
  const payload = readJson(runCompanion(["task-resume-candidate", "--json"], { cwd, env }));
  assert.equal(payload.available, false);
  assert.equal(payload.candidate, null);
});

test("task-resume-candidate: available after a finished task in the same session", () => {
  const cwd = makeTempDir();
  const env = authedEnv({ GEMINI_COMPANION_SESSION_ID: "claude-session-y" });
  const job = readJson(runCompanion(["task", "--write", "--json", "do a thing"], { cwd, env }));

  const payload = readJson(runCompanion(["task-resume-candidate", "--json"], { cwd, env }));
  assert.equal(payload.available, true);
  assert.equal(payload.candidate.geminiConversationId, job.geminiConversationId);
});

test("task-resume-candidate: reports the active job instead of a stale candidate while one is running", async () => {
  const cwd = makeTempDir();
  const env = authedEnv({
    GEMINI_COMPANION_SESSION_ID: "claude-session-z",
    FAKE_AGY_BEHAVIOR: "slow",
    FAKE_AGY_DELAY_MS: "60000"
  });
  const queued = readJson(runCompanion(["task", "--background", "--write", "--json", "slow"], { cwd, env }));

  await waitFor(() => {
    const status = readJson(runCompanion(["status", queued.jobId, "--json"], { cwd, env }));
    return status.job.status === "running" ? status : null;
  });

  const payload = readJson(runCompanion(["task-resume-candidate", "--json"], { cwd, env }));
  assert.equal(payload.available, false);
  assert.equal(payload.activeJob.id, queued.jobId);

  runCompanion(["cancel", queued.jobId, "--json"], { cwd, env });
});

// ---------------------------------------------------------------------------
// status rendering

test("status --json with no jobs yet returns empty running/recent lists", () => {
  const cwd = makeTempDir();
  const env = authedEnv();
  const payload = readJson(runCompanion(["status", "--json"], { cwd, env }));
  assert.deepEqual(payload.running, []);
  assert.deepEqual(payload.recent, []);
});

test("status: unknown job id produces a clear error", () => {
  const cwd = makeTempDir();
  const env = authedEnv();
  const result = runCompanion(["status", "nonexistent-job", "--json"], { cwd, env });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /No job found/);
});
