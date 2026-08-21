import test from "node:test";
import assert from "node:assert/strict";

import { isProcessAlive, killProcessTree, probeBinary } from "../plugins/gemini/scripts/lib/process.mjs";

test("probeBinary reports unavailable for a missing command", () => {
  const result = probeBinary("this-binary-does-not-exist-xyz");
  assert.equal(result.available, false);
});

test("probeBinary reports available for node --version", () => {
  const result = probeBinary(process.execPath, ["--version"]);
  assert.equal(result.available, true);
  assert.match(result.detail, /^v?\d+\.\d+/);
});

test("isProcessAlive is true for the current process and false for a bogus pid", () => {
  assert.equal(isProcessAlive(process.pid), true);
  assert.equal(isProcessAlive(999999999), false);
});

test("killProcessTree is idempotent when the pid is already gone (fake runCommandImpl)", () => {
  const fakeRun = () => ({
    exitCode: 1,
    spawnError: null,
    stdout: "",
    stderr: "ERROR: The process \"999999999\" not found."
  });
  const result = killProcessTree(999999999, { platform: "win32", runCommandImpl: fakeRun });
  assert.equal(result.attempted, true);
  assert.equal(result.killed, false);
  assert.equal(result.alreadyGone, true);
});

test("killProcessTree reports success on a real taskkill/kill call against a spawned child", async () => {
  const { spawn } = await import("node:child_process");
  const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 30000)"], { stdio: "ignore" });
  await new Promise((resolve) => setTimeout(resolve, 200));
  const result = killProcessTree(child.pid);
  assert.equal(result.attempted, true);
  assert.equal(result.killed, true);
  await new Promise((resolve) => setTimeout(resolve, 200));
  assert.equal(isProcessAlive(child.pid), false);
});

test("killProcessTree returns attempted:false for a non-finite pid", () => {
  const result = killProcessTree(Number.NaN);
  assert.equal(result.attempted, false);
});
