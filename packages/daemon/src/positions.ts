/**
 * Persisted 2D positions for trees in the forest plane.
 *
 * Placement must be stable across restarts (trees shouldn't teleport), so
 * positions are assigned once and saved to a JSON file. New trees land on
 * a phyllotaxis spiral (sunflower packing — dense, roughly round, no
 * overlaps) keyed by a monotonically increasing slot counter; forked trees
 * are instead placed on a ring around their parent, so lineage reads as
 * spatial closeness. M3 replaces slot placement with embedding-kNN
 * placement — the store and API stay the same.
 */

import { promises as fs, existsSync, readFileSync } from "node:fs";
import path from "node:path";

const GOLDEN_ANGLE = Math.PI * (3 - Math.sqrt(5)); // ~2.39996 rad
const SPIRAL_SPACING = 170;
const FORK_RADIUS = 150;

export interface StoredPositions {
  nextSlot: number;
  /** sessionPath -> position */
  trees: Record<string, { x: number; y: number }>;
}

export class PositionStore {
  private state: StoredPositions = { nextSlot: 0, trees: {} };
  private file: string;
  private saveTimer: NodeJS.Timeout | null = null;

  constructor(dataDir: string) {
    this.file = path.join(dataDir, "positions.json");
    if (existsSync(this.file)) {
      try {
        this.state = JSON.parse(readFileSync(this.file, "utf8")) as StoredPositions;
      } catch {
        // corrupt state file: start fresh, positions are re-derivable
      }
    }
  }

  get(sessionPath: string): { x: number; y: number } | undefined {
    return this.state.trees[sessionPath];
  }

  /**
   * Return the position for a tree, assigning one if it's new.
   * `parentSession` places forks near their parent.
   */
  ensure(sessionPath: string, parentSession?: string): { x: number; y: number } {
    const existing = this.state.trees[sessionPath];
    if (existing) return existing;
    let pos: { x: number; y: number };
    const parentPos = parentSession ? this.state.trees[parentSession] : undefined;
    if (parentPos) {
      // Deterministic angle from the fork's path so re-derivation is stable.
      const angle = (hashString(sessionPath) % 360) * (Math.PI / 180);
      pos = {
        x: parentPos.x + Math.cos(angle) * FORK_RADIUS,
        y: parentPos.y + Math.sin(angle) * FORK_RADIUS,
      };
    } else {
      const i = this.state.nextSlot++;
      const r = SPIRAL_SPACING * Math.sqrt(i);
      const theta = i * GOLDEN_ANGLE;
      pos = { x: Math.cos(theta) * r, y: Math.sin(theta) * r };
    }
    this.state.trees[sessionPath] = pos;
    this.scheduleSave();
    return pos;
  }

  set(sessionPath: string, pos: { x: number; y: number }): void {
    this.state.trees[sessionPath] = pos;
    this.scheduleSave();
  }

  remove(sessionPath: string): void {
    if (sessionPath in this.state.trees) {
      delete this.state.trees[sessionPath];
      this.scheduleSave();
    }
  }

  private scheduleSave(): void {
    if (this.saveTimer) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      void this.save();
    }, 500);
    this.saveTimer.unref();
  }

  async save(): Promise<void> {
    await fs.mkdir(path.dirname(this.file), { recursive: true });
    await fs.writeFile(this.file, JSON.stringify(this.state), "utf8");
  }
}

function hashString(s: string): number {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0;
  return h;
}

export function defaultDataDir(): string {
  return (
    process.env.PINES_DATA_DIR ?? path.join(process.env.HOME ?? "~", ".pines")
  );
}
