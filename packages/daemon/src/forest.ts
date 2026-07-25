/**
 * The Forest ties the indexer and runners together: one SessionTree per
 * session file on disk, one PiRunner per tree that is (or has been)
 * running. Emits UI-facing events for the server to broadcast.
 */

import { EventEmitter } from "node:events";
import type { ServerEvent, TreeSummary, TreeDetail, TreeStatus, NodeDetail } from "@pines/shared";
import { SessionIndexer } from "./indexer.js";
import { SessionTree } from "./session.js";
import { PiRunner, RunnerOptions } from "./runner.js";

export class Forest extends EventEmitter {
  runners = new Map<string, PiRunner>(); // keyed by sessionPath

  constructor(
    public indexer: SessionIndexer,
    private runnerOpts: RunnerOptions,
  ) {
    super();
    indexer.on("added", (tree: SessionTree) => {
      this.broadcast({ event: "tree_updated", tree: this.summarize(tree) });
    });
    indexer.on("updated", (tree: SessionTree) => {
      this.broadcast({ event: "tree_updated", tree: this.summarize(tree) });
    });
    indexer.on("removed", (sessionPath: string) => {
      const runner = this.runners.get(sessionPath);
      if (runner) {
        void runner.stop();
        this.runners.delete(sessionPath);
      }
      this.broadcast({ event: "tree_removed", treeId: sessionPath });
    });
  }

  private broadcast(ev: ServerEvent): void {
    this.emit("broadcast", ev);
  }

  statusOf(tree: SessionTree): TreeStatus {
    return this.runners.get(tree.sessionPath)?.status ?? "dormant";
  }

  summarize(tree: SessionTree): TreeSummary {
    const s = tree.summary(this.statusOf(tree));
    const pending = this.runners.get(tree.sessionPath)?.pendingUiRequest;
    if (pending) s.pendingUiRequest = pending;
    return s;
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

  async shutdown(): Promise<void> {
    await Promise.all([...this.runners.values()].map((r) => r.stop()));
    await this.indexer.stop();
  }
}
