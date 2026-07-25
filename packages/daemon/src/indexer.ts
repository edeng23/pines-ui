/**
 * Watches the pi session directory tree and maintains an in-memory index
 * of SessionTree objects. Session files are append-only JSONL, so updates
 * re-read only the bytes past the last parsed offset; a shrinking file
 * (rewrite/migration) triggers a full re-parse.
 */

import { EventEmitter } from "node:events";
import { promises as fs, existsSync } from "node:fs";
import path from "node:path";
import chokidar, { FSWatcher } from "chokidar";
import { SessionTree } from "./session.js";

export interface IndexerEvents {
  added: (tree: SessionTree) => void;
  updated: (tree: SessionTree) => void;
  removed: (sessionPath: string) => void;
}

export class SessionIndexer extends EventEmitter {
  /** sessionPath -> tree */
  trees = new Map<string, SessionTree>();
  private watcher: FSWatcher | null = null;

  constructor(public sessionDir: string) {
    super();
  }

  byId(id: string): SessionTree | undefined {
    for (const t of this.trees.values()) if (t.id === id) return t;
    return undefined;
  }

  async start(): Promise<void> {
    if (!existsSync(this.sessionDir)) {
      await fs.mkdir(this.sessionDir, { recursive: true });
    }
    await this.scan();
    this.watcher = chokidar.watch(this.sessionDir, {
      ignoreInitial: true,
      awaitWriteFinish: { stabilityThreshold: 150, pollInterval: 50 },
    });
    this.watcher.on("add", (p) => this.onFile(p));
    this.watcher.on("change", (p) => this.onFile(p));
    this.watcher.on("unlink", (p) => {
      if (!p.endsWith(".jsonl")) return;
      if (this.trees.delete(p)) this.emit("removed", p);
    });
  }

  async stop(): Promise<void> {
    await this.watcher?.close();
    this.watcher = null;
  }

  private async scan(): Promise<void> {
    const files = await this.findSessionFiles(this.sessionDir);
    for (const f of files) await this.onFile(f, true);
  }

  private async findSessionFiles(dir: string): Promise<string[]> {
    const out: string[] = [];
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return out;
    }
    for (const e of entries) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) out.push(...(await this.findSessionFiles(p)));
      else if (e.isFile() && e.name.endsWith(".jsonl")) out.push(p);
    }
    return out;
  }

  /** Parse a new or changed session file (incrementally where possible). */
  async onFile(p: string, initial = false): Promise<void> {
    if (!p.endsWith(".jsonl")) return;
    let stat;
    try {
      stat = await fs.stat(p);
    } catch {
      return; // vanished between event and read
    }
    let tree = this.trees.get(p);
    const isNew = !tree;
    if (!tree) {
      tree = new SessionTree(p);
      this.trees.set(p, tree);
    }
    if (stat.size < tree.parsedBytes) tree.reset(); // truncated/rewritten
    if (stat.size > tree.parsedBytes) {
      const chunk = await this.readFrom(p, tree.parsedBytes);
      tree.append(chunk);
    }
    if (isNew) this.emit("added", tree);
    else if (!initial) this.emit("updated", tree);
  }

  private async readFrom(p: string, offset: number): Promise<string> {
    const fh = await fs.open(p, "r");
    try {
      const size = (await fh.stat()).size;
      const len = size - offset;
      if (len <= 0) return "";
      const buf = Buffer.alloc(len);
      await fh.read(buf, 0, len, offset);
      return buf.toString("utf8");
    } finally {
      await fh.close();
    }
  }
}
