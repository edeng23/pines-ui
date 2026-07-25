import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { SessionTree } from "./session.js";
import { PiRunner } from "./runner.js";
import type { TreeStatus } from "@pines/shared";

const here = path.dirname(fileURLToPath(import.meta.url));
const MOCK_PI = path.resolve(here, "../mock/mock-pi.cjs");

function makeSession(dir: string): string {
  const p = path.join(dir, "test-session.jsonl");
  const header = {
    type: "session",
    version: 3,
    id: "test-uuid",
    timestamp: new Date().toISOString(),
    cwd: dir,
  };
  writeFileSync(p, JSON.stringify(header) + "\n");
  return p;
}

async function loadTree(p: string): Promise<SessionTree> {
  const t = new SessionTree(p);
  t.append(readFileSync(p, "utf8"));
  return t;
}

function waitForStatus(runner: PiRunner, want: TreeStatus, timeoutMs = 8000): Promise<void> {
  return new Promise((resolve, reject) => {
    if (runner.status === want) return resolve();
    const timer = setTimeout(
      () => reject(new Error(`timeout waiting for status ${want}, last=${runner.status}`)),
      timeoutMs,
    );
    runner.on("status", function onStatus(s: TreeStatus) {
      if (s === want) {
        clearTimeout(timer);
        runner.off("status", onStatus);
        resolve();
      }
    });
  });
}

describe("PiRunner + mock-pi", () => {
  let dir: string;
  let runner: PiRunner | null = null;

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "pines-test-"));
  });
  afterEach(async () => {
    await runner?.stop();
    runner = null;
    rmSync(dir, { recursive: true, force: true });
  });

  function mockRunner(tree: SessionTree): PiRunner {
    return new PiRunner(tree, { piBin: MOCK_PI, piArgs: ["--delay", "5"] });
  }

  it("prompt streams and settles to idle, entries land in the file", async () => {
    const p = makeSession(dir);
    const tree = await loadTree(p);
    runner = mockRunner(tree);
    const deltas: string[] = [];
    runner.on("stream", (_kind: string, d: string) => deltas.push(d));
    await runner.prompt("do something useful");
    await waitForStatus(runner, "running");
    await waitForStatus(runner, "idle");
    expect(deltas.join("")).toContain("Understood");
    const after = await loadTree(p);
    expect(after.entries.length).toBe(2); // user + assistant
    expect(after.entries[0].type).toBe("message");
  });

  it("branching from an earlier node appends a pines.branch entry", async () => {
    const p = makeSession(dir);
    let tree = await loadTree(p);
    runner = mockRunner(tree);
    await runner.prompt("first question");
    await waitForStatus(runner, "idle");
    await runner.stop();

    tree = await loadTree(p);
    const firstUser = tree.entries[0].id;
    runner = mockRunner(tree);
    await runner.prompt("second question, from the first node", firstUser);
    await waitForStatus(runner, "idle");

    const after = await loadTree(p);
    const branch = after.entries.find((e) => e.type === "custom");
    expect(branch).toBeDefined();
    expect(branch!.parentId).toBe(firstUser);
    // the new user message hangs off the branch entry
    const newUser = after.entries.find((e) => e.parentId === branch!.id);
    expect(newUser).toBeDefined();
    // two children of firstUser's subtree exist: old assistant + branch entry
    const children = after.entries.filter((e) => e.parentId === firstUser);
    expect(children.length).toBe(2);
  });

  it("extension_ui_request sets waiting; answering resumes to idle", async () => {
    const p = makeSession(dir);
    const tree = await loadTree(p);
    runner = mockRunner(tree);
    await runner.prompt("please ask me something");
    await waitForStatus(runner, "waiting");
    expect(runner.pendingUiRequest?.method).toBe("select");
    runner.answerUi({ requestId: runner.pendingUiRequest!.id, value: "Option A" });
    await waitForStatus(runner, "idle");
    const after = await loadTree(p);
    const assistant = after.entries.filter(
      (e) => e.type === "message" && (e as { message: { role: string } }).message.role === "assistant",
    );
    expect(assistant.length).toBe(1);
  });

  it("stop() terminates the child and lands on dormant", async () => {
    const p = makeSession(dir);
    const tree = await loadTree(p);
    runner = mockRunner(tree);
    await runner.prompt("do something useful");
    await runner.stop();
    expect(runner.status).toBe("dormant");
    expect(runner.attached).toBe(false);
  });
});
