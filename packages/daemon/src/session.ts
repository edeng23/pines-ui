/**
 * Parser for pi session JSONL files (format v3).
 *
 * Files are append-only, so `SessionTree.append()` supports incremental
 * parsing: the indexer re-feeds only bytes past the last parsed offset.
 * The active branch (leaf) is the chain from the most recently appended
 * entry back to the root via parentId links — pi moves the leaf by
 * appending (e.g. a branch_summary entry pointing at an earlier node).
 */

import {
  SessionHeader,
  SessionEntry,
  MessageEntry,
  contentText,
  GLYPH_MAX_NODES,
} from "@pines/shared";
import type { TreeNode, TreeSummary, TreeDetail, NodeDetail, TreeStatus } from "@pines/shared";

const PREVIEW_LEN = 200;

export class SessionTree {
  header: SessionHeader | null = null;
  entries: SessionEntry[] = [];
  byId = new Map<string, SessionEntry>();
  /** targetId -> latest label text (null label = cleared). */
  labels = new Map<string, string>();
  /** Most recently appended entry id = active branch tip. */
  leafId: string | null = null;
  name: string | null = null;
  /** Byte offset within the file up to which we have parsed. */
  parsedBytes = 0;
  /** Carry-over for a trailing partial line between incremental reads. */
  private partial = "";

  constructor(public sessionPath: string) {}

  get id(): string {
    return this.header?.id ?? this.sessionPath;
  }

  /**
   * Feed a chunk of file content starting at the current parse offset.
   * Returns the number of complete entries appended.
   */
  append(chunk: string): number {
    this.parsedBytes += Buffer.byteLength(chunk, "utf8");
    const text = this.partial + chunk;
    const lines = text.split("\n");
    // Last element is either "" (chunk ended with \n) or a partial line.
    this.partial = lines.pop() ?? "";
    let added = 0;
    for (const raw of lines) {
      const line = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
      if (!line.trim()) continue;
      let obj: unknown;
      try {
        obj = JSON.parse(line);
      } catch {
        continue; // tolerate corrupt lines rather than dropping the tree
      }
      const entry = obj as { type?: string };
      if (entry.type === "session") {
        this.header = obj as SessionHeader;
        continue;
      }
      const e = obj as SessionEntry;
      if (!e.id || !e.type) continue;
      this.entries.push(e);
      this.byId.set(e.id, e);
      this.leafId = e.id;
      if (e.type === "label") this.labels.set(e.targetId, e.label ?? "");
      if (e.type === "session_info") this.name = e.name;
      added++;
    }
    return added;
  }

  /** Reset parse state (e.g. file was truncated/rewritten). */
  reset(): void {
    this.header = null;
    this.entries = [];
    this.byId.clear();
    this.labels.clear();
    this.leafId = null;
    this.name = null;
    this.parsedBytes = 0;
    this.partial = "";
  }

  /** Walk leaf -> root, return ids root -> leaf. */
  activePath(): string[] {
    const path: string[] = [];
    let cur = this.leafId ? this.byId.get(this.leafId) : undefined;
    const seen = new Set<string>();
    while (cur && !seen.has(cur.id)) {
      seen.add(cur.id);
      path.push(cur.id);
      cur = cur.parentId ? this.byId.get(cur.parentId) : undefined;
    }
    return path.reverse();
  }

  /** Derive a human title: session name > first user message > file name. */
  title(): string {
    if (this.name) return this.name;
    for (const e of this.entries) {
      if (e.type === "message" && (e as MessageEntry).message.role === "user") {
        const t = contentText((e as MessageEntry).message.content);
        if (t) return t.length > 80 ? t.slice(0, 77) + "…" : t;
      }
    }
    const base = this.sessionPath.split("/").pop() ?? this.sessionPath;
    return base.replace(/\.jsonl$/, "");
  }

  private entryPreview(e: SessionEntry): { preview: string; role?: string } {
    switch (e.type) {
      case "message": {
        const m = e.message;
        let text: string;
        if (m.role === "bashExecution") text = `$ ${m.command ?? ""}`;
        else if (m.role === "branchSummary" || m.role === "compactionSummary")
          text = m.summary ?? "";
        else text = contentText(m.content);
        return { preview: text.slice(0, PREVIEW_LEN), role: m.role };
      }
      case "compaction":
        return { preview: `compaction: ${e.summary.slice(0, PREVIEW_LEN)}` };
      case "branch_summary":
        return { preview: `branched from ${e.fromId}: ${e.summary.slice(0, PREVIEW_LEN)}` };
      case "custom_message":
        return { preview: contentText(e.content).slice(0, PREVIEW_LEN), role: "custom" };
      case "model_change":
        return { preview: `model → ${e.provider}/${e.modelId}` };
      case "thinking_level_change":
        return { preview: `thinking → ${e.thinkingLevel}` };
      case "session_info":
        return { preview: `named: ${e.name}` };
      case "label":
        return { preview: `label ${e.label ?? "(cleared)"} on ${e.targetId}` };
      default:
        return { preview: e.type };
    }
  }

  /**
   * Nodes as exposed to the UI. Bookkeeping entries (labels, session_info)
   * are folded away — they annotate the tree rather than being part of it.
   */
  nodes(): TreeNode[] {
    const out: TreeNode[] = [];
    for (const e of this.entries) {
      if (e.type === "label" || e.type === "session_info") continue;
      const { preview, role } = this.entryPreview(e);
      out.push({
        id: e.id,
        parentId: e.parentId,
        type: e.type,
        role,
        timestamp: e.timestamp,
        preview,
        label: this.labels.get(e.id) || undefined,
      });
    }
    return out;
  }

  nodeDetail(id: string): NodeDetail | null {
    const e = this.byId.get(id);
    if (!e) return null;
    let text = "";
    let role: string | undefined;
    let toolName: string | undefined;
    let isError: boolean | undefined;
    let model: string | undefined;
    if (e.type === "message") {
      const m = e.message;
      role = m.role;
      toolName = m.toolName;
      isError = m.isError;
      model = m.model;
      if (m.role === "bashExecution") text = `$ ${m.command ?? ""}\n${m.output ?? ""}`;
      else if (m.role === "branchSummary" || m.role === "compactionSummary") text = m.summary ?? "";
      else text = contentText(m.content);
    } else if (e.type === "compaction" || e.type === "branch_summary") {
      text = e.summary;
    } else if (e.type === "custom_message") {
      role = "custom";
      text = contentText(e.content);
    } else {
      text = this.entryPreview(e).preview;
    }
    return { id: e.id, parentId: e.parentId, type: e.type, role, timestamp: e.timestamp, text, toolName, isError, model };
  }

  /**
   * Compact topology for the forest glyph: parent index per node in
   * append order (-1 = root). Bookkeeping entries are skipped, matching
   * nodes(). Trees over the cap keep their first GLYPH_MAX_NODES nodes —
   * the silhouette of an old tree barely changes at the tip.
   */
  glyph(): { glyph: number[]; glyphLeaf?: number } {
    const glyph: number[] = [];
    const indexById = new Map<string, number>();
    let leafIndex: number | undefined;
    for (const e of this.entries) {
      if (e.type === "label" || e.type === "session_info") continue;
      if (glyph.length >= GLYPH_MAX_NODES) break;
      const idx = glyph.length;
      indexById.set(e.id, idx);
      glyph.push(e.parentId != null ? (indexById.get(e.parentId) ?? -1) : -1);
      if (e.id === this.leafId) leafIndex = idx;
    }
    return { glyph, glyphLeaf: leafIndex };
  }

  summary(status: TreeStatus): TreeSummary {
    const first = this.entries[0];
    const last = this.entries[this.entries.length - 1];
    return {
      id: this.id,
      sessionPath: this.sessionPath,
      cwd: this.header?.cwd ?? "",
      title: this.title(),
      createdAt: this.header?.timestamp ?? first?.timestamp ?? "",
      updatedAt: last?.timestamp ?? this.header?.timestamp ?? "",
      nodeCount: this.entries.length,
      status,
      leafId: this.leafId,
      parentSession: this.header?.parentSession,
    };
  }

  detail(status: TreeStatus): TreeDetail {
    return {
      ...this.summary(status),
      nodes: this.nodes(),
      activePath: this.activePath(),
    };
  }
}
