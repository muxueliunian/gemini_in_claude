import fs from "node:fs";
import path from "node:path";
import process from "node:process";

import {
  isTerminalStatus,
  jobLogPath,
  readJobRecord,
  upsertJob,
  writeJobRecord
} from "./state.mjs";

export const SESSION_ID_ENV = "GEMINI_COMPANION_SESSION_ID";

export function nowIso() {
  return new Date().toISOString();
}

export function currentClaudeSessionId(env = process.env) {
  return env[SESSION_ID_ENV] || null;
}

export function appendJobLog(logFile, message) {
  const text = String(message ?? "").trim();
  if (!logFile || !text) {
    return;
  }
  try {
    fs.appendFileSync(logFile, `[${nowIso()}] ${text}\n`, "utf8");
  } catch {
    // logging must never break the job itself
  }
}

/**
 * Build a fresh job record. The Claude session id is captured from the
 * environment (exported by the SessionStart hook) so status/resume filtering
 * can scope to the current Claude session.
 */
export function newJobRecord({
  id,
  workspaceRoot,
  title,
  summary,
  prompt,
  write,
  model,
  effort,
  geminiConversationId,
  env
}) {
  const sessionId = currentClaudeSessionId(env ?? process.env);
  return {
    id,
    jobClass: "task",
    status: "queued",
    phase: "queued",
    title,
    summary,
    prompt: prompt ?? null,
    write: Boolean(write),
    model: model ?? null,
    effort: effort ?? null,
    sessionId,
    geminiConversationId: geminiConversationId ?? null,
    workspaceRoot,
    pid: null,
    logFile: jobLogPath(workspaceRoot, id),
    createdAt: nowIso(),
    updatedAt: nowIso(),
    finishedAt: null,
    resultText: null,
    error: null
  };
}

export function initJobLog(job) {
  fs.mkdirSync(path.dirname(job.logFile), { recursive: true });
  fs.writeFileSync(job.logFile, "", "utf8");
  appendJobLog(job.logFile, `Job ${job.id} created: ${job.title}`);
}

export function markJobRunning(job, pid) {
  const patch = {
    id: job.id,
    status: "running",
    phase: "running",
    pid: pid ?? process.pid,
    startedAt: nowIso()
  };
  writeJobRecord(job.workspaceRoot, job.id, { ...job, ...patch });
  upsertJob(job.workspaceRoot, patch);
}

/**
 * Write the final state of a job. Terminal states are first-writer-wins
 * (state.mjs enforces the mutual exclusion), so a completed worker cannot
 * overwrite a user cancel or vice versa.
 */
export function finishJob(job, outcome) {
  const finishedAt = nowIso();
  const status = outcome.status;
  if (!isTerminalStatus(status)) {
    throw new Error(`finishJob requires a terminal status, got "${status}".`);
  }
  const patch = {
    id: job.id,
    status,
    phase: status === "completed" ? "done" : status,
    pid: null,
    finishedAt,
    resultText: outcome.resultText ?? null,
    error: outcome.error ?? null,
    geminiConversationId: outcome.geminiConversationId ?? job.geminiConversationId ?? null,
    numTurns: outcome.numTurns ?? job.numTurns ?? null,
    totalCostUsd: outcome.totalCostUsd ?? job.totalCostUsd ?? null,
    ...(outcome.summary ? { summary: outcome.summary } : {})
  };
  const stored = readJobRecord(job.workspaceRoot, job.id) ?? job;
  writeJobRecord(job.workspaceRoot, job.id, { ...stored, ...patch, rendered: outcome.rendered ?? null });
  upsertJob(job.workspaceRoot, patch);
  appendJobLog(job.logFile, `Job finished: ${status}${outcome.error ? ` (${outcome.error})` : ""}`);
  return readJobRecord(job.workspaceRoot, job.id);
}
