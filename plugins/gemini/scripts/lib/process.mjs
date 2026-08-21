import { spawnSync } from "node:child_process";
import process from "node:process";

/**
 * Run a command synchronously with captured output. Never uses a shell:
 * callers pass an absolute binary path (or a bare name resolvable by the OS)
 * plus an argv array.
 */
export function runCommandSync(command, args = [], options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    env: options.env ?? process.env,
    encoding: "utf8",
    shell: false,
    windowsHide: true,
    timeout: options.timeoutMs
  });
  return {
    exitCode: result.status ?? (result.error ? -1 : 0),
    signal: result.signal ?? null,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    spawnError: result.error ?? null
  };
}

/** Probe whether a binary exists and responds to a version flag. */
export function probeBinary(command, versionArgs = ["--version"], options = {}) {
  const result = runCommandSync(command, versionArgs, options);
  if (result.spawnError) {
    const code = /** @type {NodeJS.ErrnoException} */ (result.spawnError).code;
    return { available: false, detail: code === "ENOENT" ? "not found" : result.spawnError.message };
  }
  if (result.exitCode !== 0) {
    return {
      available: false,
      detail: result.stderr.trim() || result.stdout.trim() || `exit code ${result.exitCode}`
    };
  }
  return { available: true, detail: result.stdout.trim() || result.stderr.trim() || "ok" };
}

/** Check whether a PID refers to a live process. */
export function isProcessAlive(pid) {
  if (!Number.isFinite(pid) || pid <= 0) {
    return false;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error?.code === "EPERM") {
      return true;
    }
    return false;
  }
}

const GONE_PATTERN = /not found|no such process|does not exist|cannot find/i;

/**
 * Kill a process and all of its descendants. On Windows this shells out to
 * `taskkill /T /F`, which is the only reliable way to take down the
 * node worker -> agy.exe -> helper tree. A process that is already gone is
 * treated as success (idempotent cancel).
 */
export function killProcessTree(pid, options = {}) {
  if (!Number.isFinite(pid) || pid <= 0) {
    return { attempted: false, killed: false };
  }
  const platform = options.platform ?? process.platform;

  if (platform === "win32") {
    const run = options.runCommandImpl ?? runCommandSync;
    const result = run("taskkill", ["/PID", String(pid), "/T", "/F"]);
    if (!result.spawnError && result.exitCode === 0) {
      return { attempted: true, killed: true, method: "taskkill" };
    }
    const output = `${result.stderr}\n${result.stdout}`;
    if (!result.spawnError && GONE_PATTERN.test(output)) {
      return { attempted: true, killed: false, method: "taskkill", alreadyGone: true };
    }
    // taskkill missing or failed: fall back to a direct kill of the root pid.
    try {
      process.kill(pid);
      return { attempted: true, killed: true, method: "kill" };
    } catch (error) {
      if (error?.code === "ESRCH") {
        return { attempted: true, killed: false, method: "kill", alreadyGone: true };
      }
      throw error;
    }
  }

  try {
    process.kill(-pid, "SIGTERM");
    return { attempted: true, killed: true, method: "process-group" };
  } catch {
    try {
      process.kill(pid, "SIGTERM");
      return { attempted: true, killed: true, method: "kill" };
    } catch (error) {
      if (error?.code === "ESRCH") {
        return { attempted: true, killed: false, method: "kill", alreadyGone: true };
      }
      throw error;
    }
  }
}
