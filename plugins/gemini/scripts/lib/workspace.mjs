import fs from "node:fs";
import path from "node:path";

/**
 * Resolve the workspace root for a directory: the nearest ancestor containing
 * a `.git` entry, or the directory itself when not inside a git repository.
 * Pure filesystem walk — no `git` subprocess needed.
 */
export function findWorkspaceRoot(cwd) {
  let dir = path.resolve(cwd ?? process.cwd());
  for (;;) {
    if (fs.existsSync(path.join(dir, ".git"))) {
      return dir;
    }
    const parent = path.dirname(dir);
    if (parent === dir) {
      return path.resolve(cwd ?? process.cwd());
    }
    dir = parent;
  }
}
