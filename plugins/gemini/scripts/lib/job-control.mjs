import process from "node:process";

import { isProcessAlive } from "./process.mjs";
import { isTerminalStatus, listJobs, readJobRecord, upsertJob, writeJobRecord } from "./state.mjs";
import { currentClaudeSessionId, nowIso } from "./tracked-jobs.mjs";
import { findWorkspaceRoot } from "./workspace.mjs";

export function sortJobsNewestFirst(jobs) {
  return [...jobs].sort((a, b) => String(b.updatedAt ?? "").localeCompare(String(a.updatedAt ?? "")));
}

export function isActiveStatus(status) {
  return status === "queued" || status === "running";
}

/**
 * Scope jobs to the current Claude session when the SessionStart hook
 * exported a session id; otherwise fall back to all jobs for the workspace
 * (unfiltered — callers should mention this in their output).
 */
export function scopeJobsToSession(jobs, env = process.env) {
  const sessionId = currentClaudeSessionId(env);
  if (!sessionId) {
    return { jobs, sessionFiltered: false, sessionId: null };
  }
  return { jobs: jobs.filter((job) => job.sessionId === sessionId), sessionFiltered: true, sessionId };
}

/**
 * A "running" job whose recorded pid is dead is stale (worker crashed or was
 * killed outside cancel). Mark it failed so status output never shows zombie
 * running entries. Terminal mutual exclusion still applies.
 */
export function reapStaleJob(workspaceRoot, job) {
  if (job.status !== "running" || !job.pid || isProcessAlive(job.pid)) {
    return job;
  }
  const patch = {
    id: job.id,
    status: "failed",
    phase: "failed",
    pid: null,
    finishedAt: nowIso(),
    error: "stale: worker process is no longer running"
  };
  upsertJob(workspaceRoot, patch);
  const stored = readJobRecord(workspaceRoot, job.id);
  if (stored && !isTerminalStatus(stored.status)) {
    writeJobRecord(workspaceRoot, job.id, { ...stored, ...patch });
  }
  return { ...job, ...patch };
}

export function loadWorkspaceJobs(cwd, { reap = true } = {}) {
  const workspaceRoot = findWorkspaceRoot(cwd);
  let jobs = sortJobsNewestFirst(listJobs(workspaceRoot));
  if (reap) {
    jobs = jobs.map((job) => reapStaleJob(workspaceRoot, job));
  }
  return { workspaceRoot, jobs };
}

/** Match a job by exact id or unambiguous id prefix. */
export function matchJobReference(jobs, reference) {
  if (!reference) {
    return jobs[0] ?? null;
  }
  const exact = jobs.find((job) => job.id === reference);
  if (exact) {
    return exact;
  }
  const prefixed = jobs.filter((job) => job.id.startsWith(reference));
  if (prefixed.length === 1) {
    return prefixed[0];
  }
  if (prefixed.length > 1) {
    throw new Error(`Job reference "${reference}" is ambiguous — use a longer id.`);
  }
  throw new Error(`No job found for "${reference}". Run /gemini:status to list jobs.`);
}

/**
 * Pick the job whose result should be shown: an explicit reference wins;
 * otherwise the newest finished job visible to this session.
 */
export function selectResultJob(cwd, reference, env = process.env) {
  const { workspaceRoot, jobs } = loadWorkspaceJobs(cwd);
  const pool = reference ? jobs : scopeJobsToSession(jobs, env).jobs;

  if (reference) {
    const job = matchJobReference(pool, reference);
    if (isActiveStatus(job.status)) {
      throw new Error(`Job ${job.id} is still ${job.status}. Check /gemini:status and retry once it finishes.`);
    }
    return { workspaceRoot, job };
  }

  const finished = pool.find((job) => isTerminalStatus(job.status));
  if (!finished) {
    throw new Error("No finished Gemini jobs found yet. Run /gemini:status to see active jobs.");
  }
  return { workspaceRoot, job: finished };
}

/**
 * Pick the job to cancel: explicit reference, or the single active job in
 * this session.
 */
export function selectCancelableJob(cwd, reference, env = process.env) {
  const { workspaceRoot, jobs } = loadWorkspaceJobs(cwd);
  const active = jobs.filter((job) => isActiveStatus(job.status));

  if (reference) {
    const exact = active.find((job) => job.id === reference);
    if (exact) {
      return { workspaceRoot, job: exact };
    }
    const prefixed = active.filter((job) => job.id.startsWith(reference));
    if (prefixed.length === 1) {
      return { workspaceRoot, job: prefixed[0] };
    }
    if (prefixed.length > 1) {
      throw new Error(`Job reference "${reference}" is ambiguous — use a longer id.`);
    }
    throw new Error(`No active job found for "${reference}".`);
  }

  const scoped = scopeJobsToSession(active, env).jobs;
  if (scoped.length === 1) {
    return { workspaceRoot, job: scoped[0] };
  }
  if (scoped.length > 1) {
    throw new Error("Multiple Gemini jobs are active. Pass a job id to /gemini:cancel.");
  }
  throw new Error("No active Gemini jobs to cancel.");
}

/**
 * Latest task job in this session that finished and carries a resumable
 * Antigravity conversation id. Also reports any still-active task so callers
 * can refuse to stack a resume on top of a running job.
 */
export function findResumeCandidate(cwd, env = process.env, { excludeJobId } = {}) {
  const { jobs } = loadWorkspaceJobs(cwd);
  const scoped = scopeJobsToSession(jobs, env);
  const pool = scoped.jobs.filter((job) => job.id !== excludeJobId && job.jobClass === "task");
  const activeJob = pool.find((job) => isActiveStatus(job.status)) ?? null;
  const candidate = pool.find((job) => isTerminalStatus(job.status) && job.geminiConversationId) ?? null;
  return { candidate, activeJob, sessionFiltered: scoped.sessionFiltered, sessionId: scoped.sessionId };
}

function elapsedLabel(startIso, endIso) {
  const start = Date.parse(startIso ?? "");
  const end = endIso ? Date.parse(endIso) : Date.now();
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) {
    return null;
  }
  const total = Math.round((end - start) / 1000);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

export function decorateJob(job) {
  return {
    ...job,
    elapsed: isActiveStatus(job.status)
      ? elapsedLabel(job.startedAt ?? job.createdAt, null)
      : elapsedLabel(job.startedAt ?? job.createdAt, job.finishedAt ?? job.updatedAt)
  };
}

export function buildStatusSnapshot(cwd, { all = false, env = process.env, maxRecent = 8 } = {}) {
  const { workspaceRoot, jobs } = loadWorkspaceJobs(cwd);
  const scoped = scopeJobsToSession(jobs, env);
  const visible = scoped.jobs;
  const running = visible.filter((job) => isActiveStatus(job.status)).map(decorateJob);
  const finished = visible.filter((job) => isTerminalStatus(job.status));
  const recent = (all ? finished : finished.slice(0, maxRecent)).map(decorateJob);
  return {
    workspaceRoot,
    sessionFiltered: scoped.sessionFiltered,
    running,
    recent
  };
}

export function buildJobSnapshot(cwd, reference) {
  const { workspaceRoot, jobs } = loadWorkspaceJobs(cwd);
  const job = matchJobReference(jobs, reference);
  return { workspaceRoot, job: decorateJob(job) };
}
