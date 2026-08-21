#!/usr/bin/env node

import fs from "node:fs";
import process from "node:process";

import { killProcessTree } from "./lib/process.mjs";
import { removeJobsWhere } from "./lib/state.mjs";
import { SESSION_ID_ENV } from "./lib/tracked-jobs.mjs";
import { findWorkspaceRoot } from "./lib/workspace.mjs";

const PLUGIN_DATA_ENV = "CLAUDE_PLUGIN_DATA";

function readHookInput() {
  const raw = fs.readFileSync(0, "utf8").trim();
  if (!raw) {
    return {};
  }
  return JSON.parse(raw);
}

function shellEscape(value) {
  return `'${String(value).replace(/'/g, "'\"'\"'")}'`;
}

/**
 * Re-export env vars into CLAUDE_ENV_FILE so later Bash calls (including
 * inside subagents) can see them. CLAUDE_PLUGIN_DATA is not otherwise
 * guaranteed visible to subagent Bash.
 */
function appendEnvVar(name, value) {
  if (!process.env.CLAUDE_ENV_FILE || value == null || value === "") {
    return;
  }
  fs.appendFileSync(process.env.CLAUDE_ENV_FILE, `export ${name}=${shellEscape(value)}\n`, "utf8");
}

function handleSessionStart(input) {
  appendEnvVar(SESSION_ID_ENV, input.session_id);
  appendEnvVar(PLUGIN_DATA_ENV, process.env[PLUGIN_DATA_ENV]);
}

function handleSessionEnd(input) {
  const cwd = input.cwd || process.cwd();
  const sessionId = input.session_id || process.env[SESSION_ID_ENV];
  if (!sessionId) {
    return;
  }
  const workspaceRoot = findWorkspaceRoot(cwd);
  const { removed } = removeJobsWhere(
    workspaceRoot,
    (job) => job.sessionId === sessionId && (job.status === "queued" || job.status === "running")
  );
  for (const job of removed) {
    try {
      killProcessTree(job.pid ?? Number.NaN);
    } catch {
      // best effort during shutdown
    }
  }
}

function main() {
  const input = readHookInput();
  const eventName = process.argv[2] ?? input.hook_event_name ?? "";

  if (eventName === "SessionStart") {
    handleSessionStart(input);
    return;
  }
  if (eventName === "SessionEnd") {
    handleSessionEnd(input);
  }
}

main();
