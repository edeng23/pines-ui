/**
 * Manages one `pi --mode rpc` child process per running tree.
 *
 * Wire protocol: LF-delimited JSONL over stdin/stdout (see pi's rpc.md).
 * Status is derived from the event stream:
 *   agent_start/turn_start/deltas -> running
 *   extension_ui_request pending  -> waiting
 *   agent_settled                 -> idle
 *   error delta / bad exit        -> error
 *   no child attached             -> dormant
 */

import { EventEmitter } from "node:events";
import { spawn, ChildProcessWithoutNullStreams } from "node:child_process";
import { appendFileSync, readFileSync, existsSync } from "node:fs";
import { randomBytes } from "node:crypto";
import path from "node:path";
import type {
  RpcRequest,
  RpcResponse,
  RpcEvent,
  ExtensionUiRequest,
  TreeStatus,
  PendingUiRequest,
  AnswerUiRequest,
} from "@pines/shared";
import { SessionTree } from "./session.js";
import { resolveExecutable } from "./exec.js";

export interface RunnerOptions {
  piBin: string;
  piArgs?: string[];
}

interface Waiter {
  resolve: (r: RpcResponse) => void;
  reject: (e: Error) => void;
  timer: NodeJS.Timeout;
}

export class PiRunner extends EventEmitter {
  child: ChildProcessWithoutNullStreams | null = null;
  status: TreeStatus = "dormant";
  pendingUiRequest: PendingUiRequest | null = null;
  private buf = "";
  private waiters = new Map<string, Waiter>();
  private reqCounter = 0;
  private stopping = false;

  constructor(
    public tree: SessionTree,
    private opts: RunnerOptions,
  ) {
    super();
  }

  get attached(): boolean {
    return this.child !== null;
  }

  private setStatus(status: TreeStatus): void {
    if (this.status === status) return;
    this.status = status;
    this.emit("status", status, this.pendingUiRequest);
  }

  ensureRunning(): void {
    if (this.child) return;
    const bin = resolveExecutable(this.opts.piBin);
    if (!bin) {
      this.setStatus("error");
      throw new Error(
        `pi binary not found: "${this.opts.piBin}". Install pi or set PINES_PI_BIN ` +
          `to its full path (try: which pi).`,
      );
    }
    let cwd = this.tree.header?.cwd;
    // Sessions can outlive their working directory; spawn would ENOENT.
    if (cwd && !existsSync(cwd)) {
      this.emit("log", `[pines] session cwd missing (${cwd}), running from daemon cwd`);
      cwd = undefined;
    }
    const args = [
      "--mode",
      "rpc",
      "--session",
      this.tree.sessionPath,
      ...(this.opts.piArgs ?? []),
    ];
    this.stopping = false;
    this.child = spawn(bin, args, {
      cwd: cwd && cwd.length > 0 ? cwd : undefined,
      stdio: ["pipe", "pipe", "pipe"],
      env: process.env,
    });
    this.child.stdout.setEncoding("utf8");
    this.child.stdout.on("data", (d: string) => this.onStdout(d));
    this.child.stderr.setEncoding("utf8");
    this.child.stderr.on("data", (d: string) => {
      for (const line of d.split("\n")) {
        if (line.trim()) this.emit("log", `[pi stderr] ${line}`);
      }
    });
    this.child.on("exit", (code) => {
      const wasStopping = this.stopping;
      this.child = null;
      this.buf = "";
      for (const [, w] of this.waiters) {
        clearTimeout(w.timer);
        w.reject(new Error("pi process exited"));
      }
      this.waiters.clear();
      this.pendingUiRequest = null;
      this.setStatus(!wasStopping && code !== 0 && code !== null ? "error" : "dormant");
      this.emit("exit", code);
    });
    this.child.on("error", (err) => {
      this.emit("log", `[pines] failed to spawn ${this.opts.piBin}: ${err.message}`);
      this.child = null;
      this.setStatus("error");
    });
    this.setStatus("idle");
  }

  /** Graceful stop: abort any stream, then terminate the child. */
  async stop(): Promise<void> {
    const child = this.child;
    if (!child) return;
    this.stopping = true;
    try {
      await this.request({ type: "abort" }, 2000);
    } catch {
      // it may already be idle or unresponsive; proceed to kill
    }
    const exited = new Promise<void>((resolve) => {
      child.once("exit", () => resolve());
      setTimeout(() => {
        child.kill("SIGKILL");
        resolve();
      }, 2000).unref();
    });
    child.kill("SIGTERM");
    await exited;
  }

  private onStdout(data: string): void {
    this.buf += data;
    const lines = this.buf.split("\n");
    this.buf = lines.pop() ?? "";
    for (const raw of lines) {
      const line = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
      if (!line.trim()) continue;
      let msg: RpcResponse | RpcEvent;
      try {
        msg = JSON.parse(line);
      } catch {
        this.emit("log", `[pi] ${line}`);
        continue;
      }
      if ((msg as RpcResponse).type === "response") this.onResponse(msg as RpcResponse);
      else this.onEvent(msg as RpcEvent);
    }
  }

  private onResponse(res: RpcResponse): void {
    const id = res.id;
    if (id && this.waiters.has(id)) {
      const w = this.waiters.get(id)!;
      this.waiters.delete(id);
      clearTimeout(w.timer);
      w.resolve(res);
    }
  }

  private onEvent(ev: RpcEvent): void {
    switch (ev.type) {
      case "agent_start":
      case "turn_start":
        this.setStatus("running");
        break;
      case "message_update": {
        this.setStatus("running");
        const delta = (ev as { assistantMessageEvent?: { type?: string; delta?: string } })
          .assistantMessageEvent;
        if (delta?.type === "text_delta" && delta.delta) {
          this.emit("stream", "text", delta.delta);
        } else if (delta?.type === "thinking_delta" && delta.delta) {
          this.emit("stream", "thinking", delta.delta);
        } else if (delta?.type === "error") {
          this.setStatus("error");
        }
        break;
      }
      case "tool_execution_start": {
        const name = (ev as { toolName?: string }).toolName ?? "tool";
        this.emit("stream", "tool", name);
        break;
      }
      case "agent_settled":
        if (!this.pendingUiRequest) this.setStatus("idle");
        break;
      case "extension_ui_request": {
        const req = ev as ExtensionUiRequest;
        // notify/status-style methods need no answer; only interactive ones block
        if (["select", "confirm", "input", "editor"].includes(req.method)) {
          this.pendingUiRequest = {
            id: req.id,
            method: req.method,
            title: req.title,
            message: req.message,
            options: req.options,
            placeholder: req.placeholder,
            prefill: req.prefill,
          };
          this.setStatus("waiting");
          this.emit("status", this.status, this.pendingUiRequest);
        }
        break;
      }
      case "extension_error":
        this.emit("log", `[pi extension_error] ${JSON.stringify(ev)}`);
        break;
    }
    this.emit("event", ev);
  }

  send(req: RpcRequest): void {
    if (!this.child) throw new Error("pi process not running");
    this.child.stdin.write(JSON.stringify(req) + "\n");
  }

  request(req: RpcRequest, timeoutMs = 30_000): Promise<RpcResponse> {
    this.ensureRunning();
    const id = `pines-${++this.reqCounter}`;
    const withId = { ...req, id };
    return new Promise<RpcResponse>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiters.delete(id);
        reject(new Error(`pi rpc timeout for ${req.type}`));
      }, timeoutMs);
      timer.unref();
      this.waiters.set(id, { resolve, reject, timer });
      try {
        this.send(withId);
      } catch (e) {
        clearTimeout(timer);
        this.waiters.delete(id);
        reject(e as Error);
      }
    });
  }

  /**
   * Prompt, optionally continuing from a specific node. If the node is not
   * the current leaf, we branch there first: pi has no RPC command to move
   * the leaf in place, so we do what pi does on branch switch — append an
   * entry whose parentId is the target. We use a context-excluded `custom`
   * entry so the branch's LLM context is exactly root->target. The file
   * must not be written while pi holds it, so we stop/respawn around it.
   */
  async prompt(message: string, fromNodeId?: string): Promise<void> {
    const needBranch = !!fromNodeId && fromNodeId !== this.tree.leafId;
    if (needBranch) {
      if (!this.tree.byId.has(fromNodeId!)) {
        throw new Error(`unknown node ${fromNodeId}`);
      }
      if (this.attached) await this.stop();
      this.appendBranchEntry(fromNodeId!);
    }
    this.ensureRunning();
    const res = await this.request({ type: "prompt", message });
    if (!res.success) throw new Error(res.error ?? "prompt failed");
    this.setStatus("running");
  }

  async abort(): Promise<void> {
    if (!this.attached) return;
    const res = await this.request({ type: "abort" }, 5000);
    if (!res.success) throw new Error(res.error ?? "abort failed");
  }

  answerUi(answer: AnswerUiRequest): void {
    if (!this.attached) throw new Error("pi process not running");
    this.send({
      type: "extension_ui_response",
      id: answer.requestId,
      value: answer.value,
      confirmed: answer.confirmed,
      cancelled: answer.cancelled,
    });
    this.pendingUiRequest = null;
    this.setStatus("running");
  }

  /** Fork at a node into a new session file (a new tree in the forest). */
  async fork(entryId: string): Promise<string | null> {
    this.ensureRunning();
    const res = await this.request({ type: "fork", entryId });
    if (!res.success) throw new Error(res.error ?? "fork failed");
    const data = res.data as { sessionPath?: string; sessionFile?: string } | undefined;
    return data?.sessionPath ?? data?.sessionFile ?? null;
  }

  /** Generate an entry id that doesn't collide with existing ones. */
  private newEntryId(): string {
    for (;;) {
      const id = randomBytes(4).toString("hex");
      if (!this.tree.byId.has(id)) return id;
    }
  }

  private appendBranchEntry(targetId: string): void {
    // Guard against writing into a file that changed under us.
    const onDisk = readFileSync(this.tree.sessionPath, "utf8");
    if (!onDisk.includes(`"id":"${targetId}"`)) {
      throw new Error(`node ${targetId} not found in session file on disk`);
    }
    const entry = {
      type: "custom",
      id: this.newEntryId(),
      parentId: targetId,
      timestamp: new Date().toISOString(),
      customType: "pines.branch",
      data: { fromId: this.tree.leafId },
    };
    const needsLeadingNewline = onDisk.length > 0 && !onDisk.endsWith("\n");
    appendFileSync(
      this.tree.sessionPath,
      (needsLeadingNewline ? "\n" : "") + JSON.stringify(entry) + "\n",
      "utf8",
    );
  }
}

export function defaultPiBin(): string {
  return process.env.PINES_PI_BIN ?? "pi";
}

export function defaultSessionDir(): string {
  return (
    process.env.PINES_SESSION_DIR ??
    path.join(process.env.HOME ?? "~", ".pi", "agent", "sessions")
  );
}
