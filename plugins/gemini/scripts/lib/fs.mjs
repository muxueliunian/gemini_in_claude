import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

/**
 * Atomically replace `filePath` with `content`: write to a sibling temp file,
 * then rename over the target. On Windows, rename onto an existing file can
 * transiently fail (EPERM/EACCES) when a reader holds the target open, so we
 * retry a few times before giving up.
 */
export function writeFileAtomic(filePath, content) {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  const tempPath = path.join(dir, `.${path.basename(filePath)}.${randomBytes(6).toString("hex")}.tmp`);
  fs.writeFileSync(tempPath, content, "utf8");
  let lastError = null;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      fs.renameSync(tempPath, filePath);
      return;
    } catch (error) {
      lastError = error;
      if (error?.code !== "EPERM" && error?.code !== "EACCES" && error?.code !== "EBUSY") {
        break;
      }
      busyWait(20 * (attempt + 1));
    }
  }
  try {
    fs.unlinkSync(tempPath);
  } catch {
    // best effort cleanup
  }
  throw lastError;
}

function busyWait(ms) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    // synchronous spin; only used on rare Windows rename contention
  }
}

export function writeJsonAtomic(filePath, value) {
  writeFileAtomic(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

export function readJsonFile(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

export function readJsonFileOrNull(filePath) {
  try {
    return readJsonFile(filePath);
  } catch {
    return null;
  }
}

export function removeFileQuiet(filePath) {
  if (!filePath) {
    return;
  }
  try {
    fs.rmSync(filePath, { force: true });
  } catch {
    // ignore
  }
}
