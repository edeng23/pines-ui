/**
 * Executable resolution helpers. node-pty and child_process report spawn
 * failures cryptically ("posix_spawnp failed", ENOENT), so we resolve
 * commands up front and produce actionable errors instead.
 */

import { accessSync, constants, existsSync } from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

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

/**
 * node-pty's native helper (macOS: build/Release/spawn-helper). A broken
 * helper — wrong arch, lost exec bit, quarantine — makes every pty.spawn
 * throw "posix_spawnp failed".
 */
export function ptyHelperPath(): string | null {
  try {
    const req = createRequire(import.meta.url);
    const entry = req.resolve("node-pty");
    const helper = path.join(path.dirname(entry), "..", "build", "Release", "spawn-helper");
    return existsSync(helper) ? helper : null;
  } catch {
    return null;
  }
}

/**
 * Try one trivial PTY spawn; returns null when healthy, or a diagnosis
 * string. Run at startup so a broken node-pty build is reported before
 * anyone opens a terminal.
 */
export async function ptySelfTest(): Promise<string | null> {
  try {
    const pty = await import("node-pty");
    const p = pty.spawn(userShell(), ["-c", "true"], { cols: 20, rows: 5 });
    await new Promise<void>((resolve) => {
      p.onExit(() => resolve());
      setTimeout(() => {
        try {
          p.kill();
        } catch {}
        resolve();
      }, 2000).unref?.();
    });
    return null;
  } catch (e) {
    return `${(e as Error).message}\n${ptyFailureHint()}`;
  }
}

/** Multi-line diagnosis for pty spawn failures, tailored to the platform. */
export function ptyFailureHint(): string {
  const lines = [
    `node-pty could not start a process ("posix_spawnp failed"). Likely causes:`,
  ];
  if (process.platform === "darwin") {
    const helper = ptyHelperPath();
    if (helper && !isExecutable(helper)) {
      lines.push(`- its spawn-helper lost the exec bit — run: chmod +x "${helper}"`);
    }
    lines.push(
      `- node-pty was built for a different CPU arch than this node (${process.arch}).` +
        ` If you installed deps under Rosetta or switched Node versions, run: npm rebuild node-pty`,
      `- macOS quarantine on the native binary — run: xattr -dr com.apple.quarantine node_modules/node-pty`,
    );
  } else {
    lines.push(`- node-pty built against a different Node ABI — run: npm rebuild node-pty`);
  }
  return lines.join("\n");
}
