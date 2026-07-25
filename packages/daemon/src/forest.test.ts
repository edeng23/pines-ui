import { describe, it, expect } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { SessionTree } from "./session.js";
import { PositionStore } from "./positions.js";
import { searchTrees } from "./search.js";

const HEADER = `{"type":"session","version":3,"id":"uuid-%","timestamp":"2026-07-25T10:00:00.000Z","cwd":"/tmp/proj"}`;

function makeTree(n: number, texts: string[]): SessionTree {
  const t = new SessionTree(`/x/s${n}.jsonl`);
  const lines = [HEADER.replace("%", String(n))];
  let parent: string | null = null;
  texts.forEach((text, i) => {
    const id = `t${n}e${i}00`.padEnd(8, "0");
    lines.push(
      JSON.stringify({
        type: "message",
        id,
        parentId: parent,
        timestamp: "2026-07-25T10:00:01.000Z",
        message: { role: i % 2 === 0 ? "user" : "assistant", content: text, timestamp: i },
      }),
    );
    parent = id;
  });
  t.append(lines.join("\n") + "\n");
  return t;
}

describe("PositionStore", () => {
  it("assigns stable positions and places forks near parents", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "pines-pos-"));
    try {
      const store = new PositionStore(dir);
      const a = store.ensure("/x/a.jsonl");
      const b = store.ensure("/x/b.jsonl");
      expect(store.ensure("/x/a.jsonl")).toEqual(a); // stable
      expect(a).not.toEqual(b);
      const fork = store.ensure("/x/a-fork.jsonl", "/x/a.jsonl");
      const dist = Math.hypot(fork.x - a.x, fork.y - a.y);
      expect(dist).toBeGreaterThan(1);
      expect(dist).toBeLessThan(300);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("persists across instances", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "pines-pos-"));
    try {
      const store = new PositionStore(dir);
      const a = store.ensure("/x/a.jsonl");
      await store.save();
      const store2 = new PositionStore(dir);
      expect(store2.get("/x/a.jsonl")).toEqual(a);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("searchTrees", () => {
  const trees = [
    makeTree(1, ["refactor the auth module", "done, refactored the login flow"]),
    makeTree(2, ["fix the flaky websocket test", "the websocket reconnect logic was racy"]),
    makeTree(3, ["write docs", "documentation written"]),
  ];
  const idle = () => "idle" as const;

  it("finds trees by node text with all tokens required", () => {
    const r = searchTrees(trees, idle, "websocket racy");
    expect(r).toHaveLength(1);
    expect(r[0].treeId).toBe("uuid-2");
    expect(r[0].matches.length).toBe(1);
    expect(r[0].matches[0].preview.toLowerCase()).toContain("racy");
  });

  it("ranks title matches higher and is case-insensitive", () => {
    const r = searchTrees(trees, idle, "REFACTOR");
    expect(r[0].treeId).toBe("uuid-1");
    expect(r[0].score).toBeGreaterThan(1);
  });

  it("returns empty for no hits or empty query", () => {
    expect(searchTrees(trees, idle, "zzzznope")).toHaveLength(0);
    expect(searchTrees(trees, idle, "   ")).toHaveLength(0);
  });
});

describe("glyph topology", () => {
  it("encodes parent indices including branches", () => {
    const t = new SessionTree("/x/g.jsonl");
    t.append(
      [
        HEADER.replace("%", "g"),
        JSON.stringify({ type: "message", id: "aaaa0001", parentId: null, timestamp: "t", message: { role: "user", content: "a", timestamp: 1 } }),
        JSON.stringify({ type: "message", id: "aaaa0002", parentId: "aaaa0001", timestamp: "t", message: { role: "assistant", content: "b", timestamp: 2 } }),
        JSON.stringify({ type: "custom", id: "aaaa0003", parentId: "aaaa0001", timestamp: "t", customType: "pines.branch", data: {} }),
        JSON.stringify({ type: "message", id: "aaaa0004", parentId: "aaaa0003", timestamp: "t", message: { role: "user", content: "c", timestamp: 3 } }),
      ].join("\n") + "\n",
    );
    const g = t.glyph();
    expect(g.glyph).toEqual([-1, 0, 0, 2]);
    expect(g.glyphLeaf).toBe(3);
  });
});
