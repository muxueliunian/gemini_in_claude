import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { readJsonFileOrNull, removeFileQuiet, writeJsonAtomic } from "./fs.mjs";
import { findWorkspaceRoot } from "./workspace.mjs";

const STATE_VERSION = 1;
const MAX_TRACKED_JOBS = 50;
const TERMINAL_STATUSES = new Set(["completed", "failed", "cancelled"]);

export function isTerminalStatus(status) {
  return TERMINAL_STATUSES.has(status);
}

/**
 * State lives under `$CLAUDE_PLUGIN_DATA/state/<slug>-<hash16>/`, keyed by the
 * workspace root, with an os.tmpdir() fallback when the plugin data dir is
 * not exported into the environment.
 */
export function stateDirFor(cwd, env = process.env) {
  const workspaceRoot = findWorkspaceRoot(cwd);
  let canonical = workspaceRoot;
  try {
    canonical = fs.realpathSync.native(workspaceRoot);
  } catch {
    // keep the uncanonicalized path
  }
  const baseName = path.basename(workspaceRoot) || "workspace";
  const slug = baseName.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "workspace";
  const hash = createHash("sha256").update(canonical).digest("hex").slice(0, 16);
  const root = env.CLAUDE_PLUGIN_DATA
    ? path.join(env.CLAUDE_PLUGIN_DATA, "state")
    : path.join(os.tmpdir(), "gemini-companion");
  return path.join(root, `${slug}-${hash}`);
}

export function stateFileFor(cwd, env = process.env) {
  return path.join(stateDirFor(cwd, env), "state.json");
}

export function jobsDirFor(cwd, env = process.env) {
  return path.join(stateDirFor(cwd, env), "jobs");
}

export function jobFilePath(cwd, jobId, env = process.env) {
  return path.join(jobsDirFor(cwd, env), `${jobId}.json`);
}

export function jobLogPath(cwd, jobId, env = process.env) {
  return path.join(jobsDirFor(cwd, env), `${jobId}.log`);
}

function emptyState() {
  return { version: STATE_VERSION, config: {}, jobs: [] };
}

export function loadState(cwd) {
  const parsed = readJsonFileOrNull(stateFileFor(cwd));
  if (!parsed || typeof parsed !== "object") {
    return emptyState();
  }
  return {
    version: STATE_VERSION,
    config: typeof parsed.config === "object" && parsed.config ? parsed.config : {},
    jobs: Array.isArray(parsed.jobs) ? parsed.jobs : []
  };
}

function byUpdatedAtDesc(a, b) {
  return String(b.updatedAt ?? "").localeCompare(String(a.updatedAt ?? ""));
}

/**
 * Persist state. Prunes to the most recent MAX_TRACKED_JOBS entries and
 * deletes job/log files for anything pruned away.
 */
export function saveState(cwd, state) {
  const previous = loadState(cwd);
  fs.mkdirSync(jobsDirFor(cwd), { recursive: true });

  const kept = [...(state.jobs ?? [])].sort(byUpdatedAtDesc).slice(0, MAX_TRACKED_JOBS);
  const keptIds = new Set(kept.map((job) => job.id));
  for (const job of previous.jobs) {
    if (keptIds.has(job.id)) {
      continue;
    }
    removeFileQuiet(jobFilePath(cwd, job.id));
    removeFileQuiet(job.logFile ?? jobLogPath(cwd, job.id));
  }

  const next = { version: STATE_VERSION, config: state.config ?? {}, jobs: kept };
  writeJsonAtomic(stateFileFor(cwd), next);
  return next;
}

export function listJobs(cwd) {
  return loadState(cwd).jobs;
}

export function generateJobId(prefix = "task") {
  const random = Math.random().toString(36).slice(2, 8);
  return `${prefix}-${Date.now().toString(36)}-${random}`;
}

/**
 * Merge a patch into a job entry with terminal-state protection: once a job
 * reached completed/failed/cancelled, no other terminal (or lifecycle) update
 * may overwrite it — first writer wins. Returns null when the patch must be
 * discarded entirely.
 */
export function mergeJobPatch(existing, patch) {
  if (!existing) {
    return { ...patch };
  }
  if (isTerminalStatus(existing.status) && patch.status && patch.status !== existing.status) {
    return null;
  }
  return { ...existing, ...patch };
}

/**
 * Insert or update the index entry for a job. Terminal states are mutually
 * exclusive (see mergeJobPatch).
 */
export function upsertJob(cwd, patch) {
  const state = loadState(cwd);
  const now = new Date().toISOString();
  const index = state.jobs.findIndex((job) => job.id === patch.id);
  if (index === -1) {
    state.jobs.unshift({ createdAt: now, updatedAt: now, ...patch });
  } else {
    const merged = mergeJobPatch(state.jobs[index], patch);
    if (merged === null) {
      return state;
    }
    state.jobs[index] = { ...merged, updatedAt: now };
  }
  return saveState(cwd, state);
}

/** Read the full stored job record (job file, not the index entry). */
export function readJobRecord(cwd, jobId) {
  return readJsonFileOrNull(jobFilePath(cwd, jobId));
}

/**
 * Write the full job record with the same terminal-state protection as the
 * index. Returns the record actually on disk afterwards.
 */
export function writeJobRecord(cwd, jobId, record) {
  const existing = readJobRecord(cwd, jobId);
  const merged = mergeJobPatch(existing, record);
  if (merged === null) {
    return existing;
  }
  fs.mkdirSync(jobsDirFor(cwd), { recursive: true });
  writeJsonAtomic(jobFilePath(cwd, jobId), merged);
  return merged;
}

export function removeJobsWhere(cwd, predicate) {
  const state = loadState(cwd);
  const removed = state.jobs.filter((job) => predicate(job));
  if (removed.length === 0) {
    return { removed: [] };
  }
  const remaining = state.jobs.filter((job) => !predicate(job));
  for (const job of removed) {
    removeFileQuiet(jobFilePath(cwd, job.id));
    removeFileQuiet(job.logFile ?? jobLogPath(cwd, job.id));
  }
  saveState(cwd, { ...state, jobs: remaining });
  return { removed };
}
