#!/usr/bin/env node
// Fake `agy` binary for tests. Mimics the subset of headless-mode behavior
// the companion depends on: -p, --conversation, --output-format json,
// --mode, --dangerously-skip-permissions, --model, --effort.
import process from "node:process";
import { randomUUID } from "node:crypto";

function readArgValue(argv, flag) {
  const index = argv.indexOf(flag);
  return index === -1 ? null : argv[index + 1];
}

function main() {
  const argv = process.argv.slice(2);

  if (argv[0] === "--version") {
    console.log("1.1.10-test");
    process.exit(0);
  }

  const behavior = process.env.FAKE_AGY_BEHAVIOR ?? "ok";
  const prompt = readArgValue(argv, "-p") ?? "";
  const resumeId = readArgValue(argv, "--conversation");
  const conversationId = resumeId ?? randomUUID();
  const hasSkipPermissions = argv.includes("--dangerously-skip-permissions");
  const mode = readArgValue(argv, "--mode");
  const hasContinue = argv.includes("-c") || argv.includes("--continue");

  const run = () => {
    if (hasContinue) {
      process.stderr.write("fake-agy: -c/--continue must not be used\n");
      process.exit(2);
      return;
    }

    if (behavior === "malformed") {
      process.stdout.write("this is not json at all\n");
      process.exit(0);
      return;
    }

    if (behavior === "error" || prompt.includes("FAKE_AGY_FORCE_ERROR")) {
      process.stderr.write("update check noise\n");
      process.stdout.write(
        `${JSON.stringify({ conversation_id: conversationId, status: "ERROR", error: "simulated agy failure" })}\n`
      );
      process.exit(1);
      return;
    }

    const access = hasSkipPermissions ? "write" : mode === "plan" ? "readonly" : "unknown";
    const text = resumeId ? `resumed:${access}:${resumeId}:${prompt.trim()}` : `${access}-echo:${prompt.trim()}`;

    const payload = {
      conversation_id: conversationId,
      status: "SUCCESS",
      response: `${text}\n`,
      duration_seconds: 0.01,
      num_turns: 1,
      usage: { input_tokens: 10, output_tokens: 2, thinking_tokens: 0, cache_read_tokens: 0, total_tokens: 12 }
    };

    if (behavior === "noisy") {
      process.stdout.write("{ this looks like json but is not\n");
      process.stderr.write("Checking for updates...\n");
    }

    process.stdout.write(`${JSON.stringify(payload)}\n`);
    process.exit(0);
  };

  if (behavior === "slow") {
    const delayMs = Number(process.env.FAKE_AGY_DELAY_MS ?? 3000);
    setTimeout(run, delayMs);
    return;
  }

  run();
}

main();
