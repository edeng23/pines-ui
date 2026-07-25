/**
 * Embedded terminal sessions — superset's model, adapted to pines.
 *
 * Each tree can have one PTY running the real pi TUI (`pi --session
 * <path>`). The PTY lives in the daemon, so navigating away in the UI
 * detaches the view while the process keeps running; reattaching replays
 * a ring buffer of scrollback (same trick as superset's pty-daemon).
 *
 * A terminal and the headless RPC runner both hold the same session
 * file, so they are mutually exclusive per tree — the Forest enforces
 * stopping one before starting the other.
 */

import { EventEmitter } from "node:events";
import { existsSync } from "node:fs";
import * as pty from "node-pty";
import { SessionTree } from "./session.js";
import { resolveExecutable, userShell } from "./exec.js";

const RING_BUFFER_LIMIT = 256 * 1024; // bytes of scrollback replayed on attach
const IDLE_AFTER_MS = 4000;

export interface TerminalOptions {
  piBin: string;
  /** Override the spawned command; "{session}" is replaced by the path. */
  termCmd?: string;
}

export class TerminalSession extends EventEmitter {
  private proc: pty.IPty;
  private ring: Buffer[] = [];
  private ringBytes = 0;
  /** Timestamp of the last session-file append (fed by the indexer). */
  lastActivityAt = 0;
  exited = false;

  constructor(
    public tree: SessionTree,
    opts: TerminalOptions,
  ) {
    super();
    let cwd = tree.header?.cwd;
    if (cwd && !existsSync(cwd)) cwd = undefined;
    const cmdline = (opts.termCmd ?? `${opts.piBin} --session {session}`).replace(
      "{session}",
      tree.sessionPath,
    );
    const [file, ...args] = splitCommand(cmdline);
    // Resolve the binary ourselves; if it isn't on the daemon's PATH,
    // run through the user's login shell so their profile PATH applies
    // (pi installed via nvm/volta/etc.). Raw node-pty failures surface
    // as an unhelpful "posix_spawnp failed" otherwise.
    const resolved = resolveExecutable(file);
    const [spawnFile, spawnArgs] = resolved
      ? [resolved, args]
      : [userShell(), ["-lc", cmdline]];
    try {
      this.proc = pty.spawn(spawnFile, spawnArgs, {
        name: "xterm-256color",
        cols: 120,
        rows: 32,
        cwd: cwd ?? process.cwd(),
        env: process.env as Record<string, string>,
      });
    } catch (e) {
      throw new Error(
        `failed to start terminal (${cmdline}): ${(e as Error).message}. ` +
          `Is pi installed and on PATH? Set PINES_PI_BIN to the binary's full path ` +
          `(try: which pi) or override PINES_TERM_CMD.`,
      );
    }
    this.proc.onData((data) => {
      const buf = Buffer.from(data, "utf8");
      this.ring.push(buf);
      this.ringBytes += buf.length;
      while (this.ringBytes > RING_BUFFER_LIMIT && this.ring.length > 1) {
        this.ringBytes -= this.ring.shift()!.length;
      }
      this.emit("data", data);
    });
    this.proc.onExit(({ exitCode }) => {
      this.exited = true;
      this.emit("exit", exitCode);
    });
  }

  scrollback(): string {
    return Buffer.concat(this.ring).toString("utf8");
  }

  write(data: string): void {
    if (!this.exited) this.proc.write(data);
  }

  resize(cols: number, rows: number): void {
    if (this.exited) return;
    if (cols > 0 && rows > 0 && cols < 1000 && rows < 1000) {
      this.proc.resize(cols, rows);
    }
  }

  /** Idle when the session file hasn't grown recently. */
  isActive(): boolean {
    return Date.now() - this.lastActivityAt < IDLE_AFTER_MS;
  }

  kill(): void {
    if (!this.exited) {
      // SIGHUP mirrors a closing TTY; interactive programs handle it sanely.
      this.proc.kill("SIGHUP");
      setTimeout(() => {
        if (!this.exited) this.proc.kill("SIGKILL");
      }, 2000).unref();
    }
  }
}

/** Minimal shell-less splitter: whitespace, honoring double quotes. */
function splitCommand(cmd: string): string[] {
  const out: string[] = [];
  const re = /"([^"]*)"|(\S+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(cmd))) out.push(m[1] ?? m[2]);
  return out;
}
