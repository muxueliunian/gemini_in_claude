import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

import { makeTempDir } from "./helpers.mjs";
import {
  generateJobId,
  jobFilePath,
  jobLogPath,
  listJobs,
  loadState,
  mergeJobPatch,
  readJobRecord,
  stateDirFor,
  upsertJob,
  writeJobRecord
} from "../plugins/gemini/scripts/lib/state.mjs";

test("stateDirFor falls back to os.tmpdir() without CLAUDE_PLUGIN_DATA", () => {
  const workspace = makeTempDir();
  const previous = process.env.CLAUDE_PLUGIN_DATA;
  delete process.env.CLAUDE_PLUGIN_DATA;
  try {
    const dir = stateDirFor(workspace);
    assert.equal(dir.startsWith(path.join(os.tmpdir(), "gemini-companion")), true);
    assert.match(path.basename(dir), /-[a-f0-9]{16}$/);
  } finally {
    if (previous !== undefined) process.env.CLAUDE_PLUGIN_DATA = previous;
  }
});

test("stateDirFor uses CLAUDE_PLUGIN_DATA/state when set", () => {
  const workspace = makeTempDir();
  const pluginData = makeTempDir();
  const dir = stateDirFor(workspace, { CLAUDE_PLUGIN_DATA: pluginData });
  assert.equal(dir.startsWith(path.join(pluginData, "state")), true);
});

test("generateJobId produces unique, prefixed ids", () => {
  const a = generateJobId("task");
  const b = generateJobId("task");
  assert.match(a, /^task-/);
  assert.notEqual(a, b);
});

test("upsertJob inserts then updates, bumping updatedAt", async () => {
  const workspace = makeTempDir();
  upsertJob(workspace, { id: "job-1", status: "queued" });
  const first = listJobs(workspace).find((j) => j.id === "job-1");
  assert.equal(first.status, "queued");

  await new Promise((resolve) => setTimeout(resolve, 5));
  upsertJob(workspace, { id: "job-1", status: "running" });
  const second = listJobs(workspace).find((j) => j.id === "job-1");
  assert.equal(second.status, "running");
  assert.notEqual(second.updatedAt, first.updatedAt);
});

test("mergeJobPatch enforces terminal-state mutual exclusion (first writer wins)", () => {
  const completed = { id: "job-1", status: "completed", resultText: "done" };
  const attemptCancel = mergeJobPatch(completed, { id: "job-1", status: "cancelled" });
  assert.equal(attemptCancel, null);

  const stillRunning = { id: "job-1", status: "running" };
  const cancel = mergeJobPatch(stillRunning, { id: "job-1", status: "cancelled" });
  assert.equal(cancel.status, "cancelled");
});

test("upsertJob silently drops a terminal-state overwrite attempt", () => {
  const workspace = makeTempDir();
  upsertJob(workspace, { id: "job-1", status: "completed", resultText: "first" });
  upsertJob(workspace, { id: "job-1", status: "failed", error: "should not apply" });
  const job = listJobs(workspace).find((j) => j.id === "job-1");
  assert.equal(job.status, "completed");
  assert.equal(job.resultText, "first");
});

test("writeJobRecord enforces the same terminal-state protection as the index", () => {
  const workspace = makeTempDir();
  writeJobRecord(workspace, "job-1", { id: "job-1", status: "completed", resultText: "first" });
  writeJobRecord(workspace, "job-1", { id: "job-1", status: "cancelled" });
  const record = readJobRecord(workspace, "job-1");
  assert.equal(record.status, "completed");
});

test("saveState prunes to 50 jobs and deletes the dropped job/log files", () => {
  const workspace = makeTempDir();
  for (let i = 0; i < 51; i += 1) {
    const id = `job-${i}`;
    fs.mkdirSync(path.dirname(jobFilePath(workspace, id)), { recursive: true });
    fs.writeFileSync(jobFilePath(workspace, id), JSON.stringify({ id }), "utf8");
    fs.writeFileSync(jobLogPath(workspace, id), `log ${id}`, "utf8");
    upsertJob(workspace, {
      id,
      status: "completed",
      updatedAt: new Date(Date.UTC(2026, 0, 1, 0, i)).toISOString()
    });
  }

  const state = loadState(workspace);
  assert.equal(state.jobs.length, 50);
  assert.equal(fs.existsSync(jobFilePath(workspace, "job-0")), false);
  assert.equal(fs.existsSync(jobLogPath(workspace, "job-0")), false);
  assert.equal(fs.existsSync(jobFilePath(workspace, "job-50")), true);
  assert.equal(fs.existsSync(jobLogPath(workspace, "job-50")), true);
});

test("loadState returns an empty state for a workspace with no state file yet", () => {
  const workspace = makeTempDir();
  const state = loadState(workspace);
  assert.deepEqual(state.jobs, []);
});
