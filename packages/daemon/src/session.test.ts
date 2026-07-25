import { describe, it, expect } from "vitest";
import { SessionTree } from "./session.js";

const HEADER = `{"type":"session","version":3,"id":"uuid-1","timestamp":"2026-07-25T10:00:00.000Z","cwd":"/tmp/proj"}`;

function entry(id: string, parentId: string | null, extra: Record<string, unknown>): string {
  return JSON.stringify({ id, parentId, timestamp: "2026-07-25T10:00:01.000Z", ...extra });
}

const userMsg = (id: string, parentId: string | null, text: string) =>
  entry(id, parentId, { type: "message", message: { role: "user", content: text, timestamp: 1 } });
const asstMsg = (id: string, parentId: string | null, text: string) =>
  entry(id, parentId, {
    type: "message",
    message: { role: "assistant", content: [{ type: "text", text }], timestamp: 2 },
  });

describe("SessionTree", () => {
  it("parses a linear session", () => {
    const t = new SessionTree("/x/s.jsonl");
    t.append([HEADER, userMsg("aaaa0001", null, "hello pi"), asstMsg("aaaa0002", "aaaa0001", "hi!")].join("\n") + "\n");
    expect(t.header?.cwd).toBe("/tmp/proj");
    expect(t.entries).toHaveLength(2);
    expect(t.leafId).toBe("aaaa0002");
    expect(t.activePath()).toEqual(["aaaa0001", "aaaa0002"]);
    expect(t.title()).toBe("hello pi");
  });

  it("handles branches: leaf follows the last appended entry", () => {
    const t = new SessionTree("/x/s.jsonl");
    t.append(
      [
        HEADER,
        userMsg("aaaa0001", null, "root"),
        asstMsg("aaaa0002", "aaaa0001", "answer A"),
        // branch: second child of aaaa0001
        entry("aaaa0003", "aaaa0001", { type: "branch_summary", fromId: "aaaa0002", summary: "left branch A" }),
        userMsg("aaaa0004", "aaaa0003", "try again"),
      ].join("\n") + "\n",
    );
    expect(t.leafId).toBe("aaaa0004");
    expect(t.activePath()).toEqual(["aaaa0001", "aaaa0003", "aaaa0004"]);
    // Both children of aaaa0001 exist in the node list
    const nodes = t.nodes();
    const children = nodes.filter((n) => n.parentId === "aaaa0001").map((n) => n.id);
    expect(children.sort()).toEqual(["aaaa0002", "aaaa0003"]);
  });

  it("parses incrementally across partial lines", () => {
    const t = new SessionTree("/x/s.jsonl");
    const full = [HEADER, userMsg("aaaa0001", null, "hello"), asstMsg("aaaa0002", "aaaa0001", "world")].join("\n") + "\n";
    const cut = Math.floor(full.length * 0.6);
    t.append(full.slice(0, cut));
    t.append(full.slice(cut));
    expect(t.entries).toHaveLength(2);
    expect(t.parsedBytes).toBe(Buffer.byteLength(full, "utf8"));
    expect(t.leafId).toBe("aaaa0002");
  });

  it("applies labels and session name", () => {
    const t = new SessionTree("/x/s.jsonl");
    t.append(
      [
        HEADER,
        userMsg("aaaa0001", null, "hello"),
        entry("aaaa0002", "aaaa0001", { type: "label", targetId: "aaaa0001", label: "checkpoint" }),
        entry("aaaa0003", "aaaa0002", { type: "session_info", name: "My tree" }),
      ].join("\n") + "\n",
    );
    expect(t.title()).toBe("My tree");
    const nodes = t.nodes();
    // label + session_info entries are folded away, label applied to target
    expect(nodes.map((n) => n.id)).toEqual(["aaaa0001"]);
    expect(nodes[0].label).toBe("checkpoint");
  });

  it("tolerates corrupt lines", () => {
    const t = new SessionTree("/x/s.jsonl");
    t.append([HEADER, "not json{{{", userMsg("aaaa0001", null, "ok")].join("\n") + "\n");
    expect(t.entries).toHaveLength(1);
  });
});
