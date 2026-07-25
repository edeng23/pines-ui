/**
 * The Forest ties the indexer and runners together: one SessionTree per
 * session file on disk, one PiRunner per tree that is (or has been)
 * running. Emits UI-facing events for the server to broadcast.
 */

import { EventEmitter } from "node:events";
import type {
  ServerEvent,
  TreeSummary,
  TreeDetail,
  TreeStatus,
  NodeDetail,
  SearchResult,
} from "@pines/shared";
import { SessionIndexer } from "./indexer.js";
import { SessionTree } from "./session.js";
import { PiRunner, RunnerOptions } from "./runner.js";
import { PositionStore } from "./positions.js";
import { searchTrees } from "./search.js";
import { TerminalSession, TerminalOptions } from "./terminal.js";

export class Forest extends EventEmitter {
  runners = new Map<string, PiRunner>(); // keyed by sessionPath
  terminals = new Map<string, TerminalSession>(); // keyed by sessionPath
  private termStatusTimer: NodeJS.Timeout;

  constructor(
    public indexer: SessionIndexer,
    private runnerOpts: RunnerOptions,
    private positions: PositionStore,
    private terminalOpts: TerminalOptions = { piBin: runnerOpts.piBin },
  ) {
    super();
    indexer.on("added", (tree: SessionTree) => {
      this.broadcast({ event: "tree_updated", tree: this.summarize(tree) });
    });
    indexer.on("updated", (tree: SessionTree) => {
      // Terminal-driven trees have no RPC events; file growth is the
      // "running" signal.
      const term = this.terminals.get(tree.sessionPath);
      if (term) {
        const wasActive = term.isActive();
        term.lastActivityAt = Date.now();
        if (!wasActive) this.emitTermStatus(tree, term);
      }
      this.broadcast({ event: "tree_updated", tree: this.summarize(tree) });
    });
    // Flip terminal trees back to idle once file appends stop.
    this.termStatusTimer = setInterval(() => {
      for (const [path, term] of this.terminals) {
        if (!term.isActive() && term.lastActivityAt !== 0) {
          term.lastActivityAt = 0;
          const tree = this.indexer.trees.get(path);
          if (tree) this.emitTermStatus(tree, term);
        }
      }
    }, 1500);
    this.termStatusTimer.unref();
    indexer.on("removed", (sessionPath: string) => {
      const runner = this.runners.get(sessionPath);
      if (runner) {
        void runner.stop();
        this.runners.delete(sessionPath);
      }
      this.terminals.get(sessionPath)?.kill();
      this.terminals.delete(sessionPath);
      this.positions.remove(sessionPath);
      this.broadcast({ event: "tree_removed", treeId: sessionPath });
    });
  }

  private emitTermStatus(tree: SessionTree, term: TerminalSession): void {
    this.broadcast({
      event: "status",
      treeId: tree.id,
      status: term.isActive() ? "running" : "idle",
      terminalAttached: true,
    });
  }

  private broadcast(ev: ServerEvent): void {
    this.emit("broadcast", ev);
  }

  statusOf(tree: SessionTree): TreeStatus {
    const term = this.terminals.get(tree.sessionPath);
    if (term) return term.isActive() ? "running" : "idle";
    return this.runners.get(tree.sessionPath)?.status ?? "dormant";
  }

  summarize(tree: SessionTree): TreeSummary {
    const s = tree.summary(this.statusOf(tree));
    const pending = this.runners.get(tree.sessionPath)?.pendingUiRequest;
    if (pending) s.pendingUiRequest = pending;
    s.pos = this.positions.ensure(tree.sessionPath, tree.header?.parentSession);
    const g = tree.glyph();
    s.glyph = g.glyph;
    s.glyphLeaf = g.glyphLeaf;
    if (this.terminals.has(tree.sessionPath)) s.terminalAttached = true;
    return s;
  }

  /**
   * Open (or return) the embedded terminal for a tree. The headless RPC
   * runner and the TUI can't share the session file, so the runner is
   * stopped first.
   */
  async openTerminal(tree: SessionTree): Promise<TerminalSession> {
    const existing = this.terminals.get(tree.sessionPath);
    if (existing && !existing.exited) return existing;
    const runner = this.runners.get(tree.sessionPath);
    if (runner?.attached) await runner.stop();
    const term = new TerminalSession(tree, this.terminalOpts);
    this.terminals.set(tree.sessionPath, term);
    term.on("exit", () => {
      this.terminals.delete(tree.sessionPath);
      this.broadcast({
        event: "status",
        treeId: tree.id,
        status: this.statusOf(tree),
        terminalAttached: false,
      });
    });
    this.broadcast({ event: "status", treeId: tree.id, status: "idle", terminalAttached: true });
    return term;
  }

  closeTerminal(tree: SessionTree): void {
    this.terminals.get(tree.sessionPath)?.kill();
  }

  search(query: string): SearchResult[] {
    return searchTrees(this.indexer.trees.values(), (t) => this.statusOf(t), query);
  }

  list(): TreeSummary[] {
    return [...this.indexer.trees.values()]
      .map((t) => this.summarize(t))
      .sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
  }

  find(treeId: string): SessionTree | undefined {
    // Accept either the session uuid or the file path as id.
    return this.indexer.byId(treeId) ?? this.indexer.trees.get(treeId);
  }

  detail(treeId: string): TreeDetail | undefined {
    const tree = this.find(treeId);
    if (!tree) return undefined;
    const d = tree.detail(this.statusOf(tree));
    const pending = this.runners.get(tree.sessionPath)?.pendingUiRequest;
    if (pending) d.pendingUiRequest = pending;
    return d;
  }

  nodeDetail(treeId: string, nodeId: string): NodeDetail | undefined {
    return this.find(treeId)?.nodeDetail(nodeId) ?? undefined;
  }

  runnerFor(tree: SessionTree): PiRunner {
    let runner = this.runners.get(tree.sessionPath);
    if (!runner) {
      runner = new PiRunner(tree, this.runnerOpts);
      this.runners.set(tree.sessionPath, runner);
      const treeId = tree.id;
      runner.on("status", (status: TreeStatus, pending) => {
        this.broadcast({ event: "status", treeId, status, pendingUiRequest: pending ?? null });
      });
      runner.on("stream", (kind: "text" | "thinking" | "tool", delta: string) => {
        this.broadcast({ event: "stream", treeId, kind, delta });
      });
      runner.on("log", (line: string) => {
        this.broadcast({ event: "runner_log", treeId, line });
      });
    }
    return runner;
  }

  hasTerminal(tree: SessionTree): boolean {
    return this.terminals.has(tree.sessionPath);
  }

  async shutdown(): Promise<void> {
    clearInterval(this.termStatusTimer);
    for (const term of this.terminals.values()) term.kill();
    await Promise.all([...this.runners.values()].map((r) => r.stop()));
    await this.indexer.stop();
  }
}
