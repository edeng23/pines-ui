/**
 * Executable resolution helpers. node-pty and child_process report spawn
 * failures cryptically ("posix_spawnp failed", ENOENT), so we resolve
 * commands up front and produce actionable errors instead.
 */

import { accessSync, constants, existsSync } from "node:fs";
import path from "node:path";

/**
 * Resolve a command to an absolute executable path via PATH (or directly
 * if it contains a slash). Returns null when not found.
 */
export function resolveExecutable(cmd: string): string | null {
  if (cmd.includes("/")) {
    return isExecutable(cmd) ? path.resolve(cmd) : null;
  }
  for (const dir of (process.env.PATH ?? "").split(path.delimiter)) {
    if (!dir) continue;
    const candidate = path.join(dir, cmd);
    if (isExecutable(candidate)) return candidate;
  }
  return null;
}

function isExecutable(p: string): boolean {
  try {
    if (!existsSync(p)) return false;
    accessSync(p, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** The user's login shell, for PATH-faithful command execution. */
export function userShell(): string {
  return process.env.SHELL && existsSync(process.env.SHELL) ? process.env.SHELL : "bash";
}
