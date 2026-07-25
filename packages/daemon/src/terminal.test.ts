import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { SessionTree } from "./session.js";
import { TerminalSession } from "./terminal.js";

function makeTree(dir: string): SessionTree {
  const p = path.join(dir, "s.jsonl");
  writeFileSync(
    p,
    JSON.stringify({ type: "session", version: 3, id: "t", timestamp: "t", cwd: dir }) + "\n",
  );
  const t = new SessionTree(p);
  t.append(JSON.stringify({ type: "session", version: 3, id: "t", timestamp: "t", cwd: dir }) + "\n");
  return t;
}

describe("TerminalSession", () => {
  let dir: string;
  let term: TerminalSession | null = null;

  afterEach(() => {
    term?.kill();
    term = null;
    rmSync(dir, { recursive: true, force: true });
  });

  it("spawns the command with the session path, buffers output, replays scrollback", async () => {
    dir = mkdtempSync(path.join(tmpdir(), "pines-term-"));
    const tree = makeTree(dir);
    term = new TerminalSession(tree, {
      piBin: "unused",
      termCmd: 'bash -c "echo session={session}; sleep 30"',
    });
    const got: string[] = [];
    term.on("data", (d: string) => got.push(d));
    await new Promise((r) => setTimeout(r, 700));
    const all = got.join("");
    expect(all).toContain(`session=${tree.sessionPath}`);
    // scrollback replays the same content for late attachers
    expect(term.scrollback()).toContain(`session=${tree.sessionPath}`);
    expect(term.exited).toBe(false);
  });

  it("emits exit and accepts input", async () => {
    dir = mkdtempSync(path.join(tmpdir(), "pines-term-"));
    const tree = makeTree(dir);
    term = new TerminalSession(tree, { piBin: "unused", termCmd: "bash -i" });
    const exited = new Promise<number>((r) => term!.on("exit", (c: number) => r(c)));
    await new Promise((r) => setTimeout(r, 500));
    term.write("exit\r");
    const code = await Promise.race([
      exited,
      new Promise<number>((_, rej) => setTimeout(() => rej(new Error("no exit")), 5000)),
    ]);
    expect(typeof code).toBe("number");
    expect(term.exited).toBe(true);
  });
});
