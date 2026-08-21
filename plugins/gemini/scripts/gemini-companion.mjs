#!/usr/bin/env node

import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { normalizeSubcommandArgv, parseCliArgs } from "./lib/args.mjs";
import { getAgyAuthStatus, getAgyAvailability, runAgyHeadless } from "./lib/gemini.mjs";
import {
  buildJobSnapshot,
  buildStatusSnapshot,
  findResumeCandidate,
  selectCancelableJob,
  selectResultJob
} from "./lib/job-control.mjs";
import { killProcessTree, probeBinary } from "./lib/process.mjs";
import { generateJobId, readJobRecord, upsertJob, writeJobRecord } from "./lib/state.mjs";
import {
  appendJobLog,
  currentClaudeSessionId,
  finishJob,
  initJobLog,
  markJobRunning,
  newJobRecord,
  nowIso
} from "./lib/tracked-jobs.mjs";
import { findWorkspaceRoot } from "./lib/workspace.mjs";
import {
  renderCancelReport,
  renderJobStatusReport,
  renderQueuedTask,
  renderResumeCandidate,
  renderSetupReport,
  renderStatusReport,
  renderStoredJobResult,
  renderTaskResult
} from "./lib/render.mjs";

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const VALID_EFFORTS = new Set(["low", "medium", "high"]);

function printUsage() {
  console.log(
    [
      "Usage:",
      "  node scripts/gemini-companion.mjs setup [--json]",
      "  node scripts/gemini-companion.mjs task [--background] [--write] [--resume|--resume-last|--fresh] [--model <m>] [--effort <e>] [--cwd <dir>] [--json] [prompt]",
      "  node scripts/gemini-companion.mjs task-worker --job-id <id> [--cwd <dir>]",
      "  node scripts/gemini-companion.mjs task-resume-candidate [--json]",
      "  node scripts/gemini-companion.mjs status [job-id] [--all] [--json]",
      "  node scripts/gemini-companion.mjs result [job-id] [--json]",
      "  node scripts/gemini-companion.mjs cancel [job-id] [--json]"
    ].join("\n")
  );
}

function emit(payload, rendered, asJson) {
  if (asJson) {
    console.log(JSON.stringify(payload, null, 2));
  } else {
    process.stdout.write(rendered);
  }
}

function parseSub(argv, spec) {
  return parseCliArgs(normalizeSubcommandArgv(argv), {
    ...spec,
    valueFlags: ["cwd", ...(spec.valueFlags ?? [])],
    switchFlags: ["json", ...(spec.switchFlags ?? [])],
    aliases: { C: "cwd", m: "model", ...(spec.aliases ?? {}) }
  });
}

function resolveCwd(flags) {
  return flags.cwd ? path.resolve(process.cwd(), flags.cwd) : process.cwd();
}

function shorten(text, limit = 96) {
  const oneLine = String(text ?? "")
    .trim()
    .replace(/\s+/g, " ");
  return oneLine.length <= limit ? oneLine : `${oneLine.slice(0, limit - 3)}...`;
}

function normalizeEffort(value) {
  if (value == null || value === "") {
    return null;
  }
  const effort = String(value).trim().toLowerCase();
  if (!VALID_EFFORTS.has(effort)) {
    throw new Error(`Unsupported reasoning effort "${value}". Use one of: low, medium, high.`);
  }
  return effort;
}

function ensureAgyReady(env = process.env) {
  const availability = getAgyAvailability(env);
  if (!availability.available) {
    throw new Error("Antigravity CLI (agy) is not available. Run /gemini:setup for install and login guidance.");
  }
  const auth = getAgyAuthStatus(env);
  if (!auth.loggedIn) {
    throw new Error("Antigravity CLI is not logged in. Run `!agy` once to sign in, or set GEMINI_API_KEY, then retry.");
  }
  return { availability, auth };
}

// ---------------------------------------------------------------------------
// setup

function handleSetup(argv) {
  const { flags } = parseSub(argv, {});
  const env = process.env;
  const node = probeBinary(process.execPath, ["--version"], { env });
  const agy = getAgyAvailability(env);
  const auth = getAgyAuthStatus(env);
  const sessionId = currentClaudeSessionId(env);

  const nextSteps = [];
  if (!agy.available) {
    nextSteps.push(
      "Install Antigravity CLI (https://antigravity.google/download#antigravity-cli); expected at %LOCALAPPDATA%\\agy\\bin\\agy.exe."
    );
  }
  if (agy.available && !auth.loggedIn) {
    nextSteps.push("Run `!agy` once and complete Google sign-in, or set GEMINI_API_KEY (plus modelProvider: \"gemini\" in ~/.gemini/settings.json).");
  }
  if (!sessionId) {
    nextSteps.push(
      "Claude session id is not exported; restart the Claude Code session so the SessionStart hook runs (jobs will not be session-filtered until then)."
    );
  }

  const report = {
    ready: node.available && agy.available && auth.loggedIn,
    node,
    agy,
    auth: { loggedIn: auth.loggedIn, method: auth.method },
    sessionId,
    nextSteps
  };
  emit(report, renderSetupReport(report), flags.json);
}

// ---------------------------------------------------------------------------
// task

function parseTaskInput(argv) {
  const { flags, positionals } = parseSub(argv, {
    valueFlags: ["model", "effort", "prompt-file"],
    switchFlags: ["background", "write", "resume", "resume-last", "fresh"]
  });
  const cwd = resolveCwd(flags);
  let prompt = positionals.join(" ").trim();
  if (flags["prompt-file"]) {
    prompt = fs.readFileSync(path.resolve(cwd, flags["prompt-file"]), "utf8");
  }
  const resumeLast = Boolean(flags.resume || flags["resume-last"]);
  if (resumeLast && flags.fresh) {
    throw new Error("Choose either --resume/--resume-last or --fresh.");
  }
  return {
    cwd,
    json: Boolean(flags.json),
    background: Boolean(flags.background),
    writeExplicit: flags.write === undefined ? null : Boolean(flags.write),
    resumeLast,
    model: flags.model?.trim() || null,
    effort: normalizeEffort(flags.effort),
    prompt
  };
}

const DEFAULT_CONTINUE_PROMPT = "Continue the previous task from where it stopped.";

function prepareTaskJob(input) {
  ensureAgyReady();
  const workspaceRoot = findWorkspaceRoot(input.cwd);

  let resumeConversationId = null;
  let candidateWrite = null;
  if (input.resumeLast) {
    const { candidate, activeJob } = findResumeCandidate(workspaceRoot, process.env, {});
    if (activeJob) {
      throw new Error(`Task ${activeJob.id} is still ${activeJob.status}. Use /gemini:status before resuming.`);
    }
    if (!candidate) {
      throw new Error("No previous Gemini task conversation found to resume for this Claude session.");
    }
    resumeConversationId = candidate.geminiConversationId;
    candidateWrite = Boolean(candidate.write);
  }

  if (!input.prompt && !input.resumeLast) {
    throw new Error("Provide a prompt (or --prompt-file), or use --resume-last.");
  }

  // Inherit the original job's write mode on resume unless the caller
  // explicitly overrides it. agy --mode plan vs --dangerously-skip-permissions
  // mismatch is untested against a live hang; inherit to stay consistent
  // with the grok companion's verified policy.
  const write = input.writeExplicit !== null ? input.writeExplicit : candidateWrite ?? false;

  const prompt = input.prompt || DEFAULT_CONTINUE_PROMPT;
  const job = newJobRecord({
    id: generateJobId("task"),
    workspaceRoot,
    title: input.resumeLast ? "Gemini Resume" : "Gemini Task",
    summary: shorten(prompt),
    prompt,
    write,
    model: input.model,
    effort: input.effort,
    geminiConversationId: resumeConversationId
  });
  const request = {
    cwd: input.cwd,
    prompt,
    write,
    model: input.model,
    effort: input.effort,
    resumeConversationId
  };
  return { workspaceRoot, job, request };
}

async function executeTaskJob(job, request) {
  initJobLog(job);
  writeJobRecord(job.workspaceRoot, job.id, { ...job, request });
  upsertJob(job.workspaceRoot, { ...job });
  appendJobLog(
    job.logFile,
    `Spawning agy (${request.resumeConversationId ? `resume ${request.resumeConversationId}` : "new conversation"}, ${request.write ? "write" : "read-only"}).`
  );

  let run;
  try {
    run = await runAgyHeadless(request, {
      onSpawn: (agyPid) => {
        markJobRunning({ ...job, request }, process.pid);
        appendJobLog(job.logFile, `agy pid ${agyPid} (worker pid ${process.pid}).`);
      }
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const record = finishJob(job, { status: "failed", error: `Failed to spawn agy: ${message}` });
    return { job: record ?? job, run: { resultText: null, error: message } };
  }

  const parsed = run.parsed;
  let outcome;
  if (run.exitCode === 0 && parsed.ok) {
    outcome = {
      status: "completed",
      resultText: parsed.text,
      geminiConversationId: parsed.conversationId ?? job.geminiConversationId,
      summary: shorten(parsed.text) || job.summary,
      numTurns: parsed.numTurns
    };
  } else if (parsed.kind === "error") {
    outcome = { status: "failed", error: parsed.message };
  } else {
    const stderrTail = run.stderr.trim().split(/\r?\n/).slice(-5).join("\n");
    outcome = {
      status: "failed",
      error: `agy exited with code ${run.exitCode}${run.signal ? ` (signal ${run.signal})` : ""}${stderrTail ? `: ${stderrTail}` : ""}`,
      resultText: parsed.ok ? parsed.text : run.stdout.trim() || null
    };
  }
  const record = finishJob(job, outcome);
  return { job: record ?? { ...job, ...outcome }, run: { resultText: outcome.resultText ?? null, error: outcome.error ?? null } };
}

function spawnDetachedWorker(cwd, jobId) {
  const child = spawn(process.execPath, [SCRIPT_PATH, "task-worker", "--cwd", cwd, "--job-id", jobId], {
    cwd,
    env: process.env,
    detached: true,
    stdio: "ignore",
    windowsHide: true
  });
  child.unref();
  return child;
}

async function handleTask(argv) {
  const input = parseTaskInput(argv);
  const { job, request } = prepareTaskJob(input);

  if (input.background) {
    initJobLog(job);
    appendJobLog(job.logFile, "Queued for background execution.");
    const child = spawnDetachedWorker(input.cwd, job.id);
    const queued = { ...job, status: "queued", phase: "queued", pid: child.pid ?? null, request };
    writeJobRecord(job.workspaceRoot, job.id, queued);
    upsertJob(job.workspaceRoot, queued);
    emit(
      {
        jobId: job.id,
        status: "queued",
        title: job.title,
        summary: job.summary,
        geminiConversationId: job.geminiConversationId
      },
      renderQueuedTask(job),
      input.json
    );
    return;
  }

  const { job: finalJob, run } = await executeTaskJob(job, request);
  const payload = {
    jobId: finalJob.id,
    status: finalJob.status,
    write: finalJob.write,
    geminiConversationId: finalJob.geminiConversationId,
    resultText: run.resultText,
    error: run.error
  };
  emit(payload, renderTaskResult(finalJob, run), input.json);
  if (finalJob.status !== "completed") {
    process.exitCode = 1;
  }
}

async function handleTaskWorker(argv) {
  const { flags } = parseSub(argv, { valueFlags: ["job-id"] });
  const jobId = flags["job-id"];
  if (!jobId) {
    throw new Error("task-worker requires --job-id.");
  }
  const cwd = resolveCwd(flags);
  const workspaceRoot = findWorkspaceRoot(cwd);
  const stored = readJobRecord(workspaceRoot, jobId);
  if (!stored) {
    throw new Error(`No stored job found for ${jobId}.`);
  }
  if (!stored.request || typeof stored.request !== "object") {
    throw new Error(`Stored job ${jobId} has no request payload.`);
  }
  await executeTaskJob({ ...stored, workspaceRoot }, stored.request);
}

// ---------------------------------------------------------------------------
// status / result / cancel / resume-candidate

function handleStatus(argv) {
  const { flags, positionals } = parseSub(argv, { switchFlags: ["all"] });
  const cwd = resolveCwd(flags);
  const reference = positionals[0] ?? "";

  if (reference) {
    const snapshot = buildJobSnapshot(cwd, reference);
    emit(snapshot, renderJobStatusReport(snapshot.job), flags.json);
    return;
  }
  const snapshot = buildStatusSnapshot(cwd, { all: Boolean(flags.all) });
  emit(snapshot, renderStatusReport(snapshot), flags.json);
}

function handleResult(argv) {
  const { flags, positionals } = parseSub(argv, {});
  const cwd = resolveCwd(flags);
  const { workspaceRoot, job } = selectResultJob(cwd, positionals[0] ?? "");
  const record = readJobRecord(workspaceRoot, job.id);
  emit({ job, record }, renderStoredJobResult(job, record), flags.json);
}

function handleCancel(argv) {
  const { flags, positionals } = parseSub(argv, {});
  const cwd = resolveCwd(flags);
  const { workspaceRoot, job } = selectCancelableJob(cwd, positionals[0] ?? "");

  const kill = killProcessTree(job.pid ?? Number.NaN);
  const finishedAt = nowIso();
  const patch = {
    id: job.id,
    status: "cancelled",
    phase: "cancelled",
    pid: null,
    finishedAt,
    error: "Cancelled by user."
  };
  upsertJob(workspaceRoot, patch);
  const stored = readJobRecord(workspaceRoot, job.id);
  writeJobRecord(workspaceRoot, job.id, { ...(stored ?? job), ...patch });
  appendJobLog(job.logFile, "Cancel requested by user.");

  const finalRecord = readJobRecord(workspaceRoot, job.id) ?? { ...job, ...patch };
  emit(
    {
      jobId: job.id,
      status: finalRecord.status,
      killed: kill.killed ?? false,
      geminiConversationId: finalRecord.geminiConversationId ?? null
    },
    renderCancelReport(finalRecord, kill),
    flags.json
  );
}

function handleTaskResumeCandidate(argv) {
  const { flags } = parseSub(argv, {});
  const cwd = resolveCwd(flags);
  const result = findResumeCandidate(cwd, process.env, {});
  const payload = {
    available: Boolean(result.candidate) && !result.activeJob,
    sessionFiltered: result.sessionFiltered,
    sessionId: result.sessionId,
    activeJob: result.activeJob ? { id: result.activeJob.id, status: result.activeJob.status } : null,
    candidate: result.candidate
      ? {
          id: result.candidate.id,
          status: result.candidate.status,
          summary: result.candidate.summary ?? null,
          geminiConversationId: result.candidate.geminiConversationId,
          finishedAt: result.candidate.finishedAt ?? null
        }
      : null
  };
  emit(payload, renderResumeCandidate(result), flags.json);
}

// ---------------------------------------------------------------------------

async function main() {
  const [subcommand, ...argv] = process.argv.slice(2);
  if (!subcommand || subcommand === "help" || subcommand === "--help") {
    printUsage();
    return;
  }
  switch (subcommand) {
    case "setup":
      handleSetup(argv);
      break;
    case "task":
      await handleTask(argv);
      break;
    case "task-worker":
      await handleTaskWorker(argv);
      break;
    case "task-resume-candidate":
      handleTaskResumeCandidate(argv);
      break;
    case "status":
      handleStatus(argv);
      break;
    case "result":
      handleResult(argv);
      break;
    case "cancel":
      handleCancel(argv);
      break;
    default:
      throw new Error(`Unknown subcommand: ${subcommand}`);
  }
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
