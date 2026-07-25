/**
 * Git-log style graph layout: nodes in append order become rows, branches
 * get lanes, edges are vertical rails with quarter-curves at branch
 * points — the way git GUIs draw commit DAGs.
 *
 * Pi session files append entries chronologically (parents always precede
 * children), so append order is already topological.
 */

import type { TreeNode } from "@pines/shared";

export interface GraphRow {
  node: TreeNode;
  row: number;
  lane: number;
}

export interface GraphEdge {
  fromRow: number;
  fromLane: number;
  toRow: number;
  toLane: number;
}

export interface Graph {
  rows: GraphRow[];
  edges: GraphEdge[];
  laneCount: number;
}

export function buildGraph(nodes: TreeNode[]): Graph {
  const rows: GraphRow[] = [];
  const edges: GraphEdge[] = [];
  const rowById = new Map<string, number>();
  const laneById = new Map<string, number>();
  // lane -> id of the node currently at that lane's tip (awaiting its
  // first child). A first child continues the lane; later children swing
  // out into a new lane.
  const laneTips: (string | null)[] = [];

  nodes.forEach((n, row) => {
    let lane: number;
    const parentLane = n.parentId != null ? laneById.get(n.parentId) : undefined;
    if (n.parentId != null && parentLane !== undefined) {
      if (laneTips[parentLane] === n.parentId) {
        lane = parentLane; // continue the parent's rail
      } else {
        // Sibling branch: take the first free lane right of the parent,
        // or open a new one.
        let free = -1;
        for (let i = parentLane + 1; i < laneTips.length; i++) {
          if (laneTips[i] === null) {
            free = i;
            break;
          }
        }
        lane = free >= 0 ? free : laneTips.push(null) - 1;
      }
      edges.push({
        fromRow: rowById.get(n.parentId)!,
        fromLane: parentLane,
        toRow: row,
        toLane: lane,
      });
    } else {
      // Root (or orphan): first free lane.
      let free = laneTips.indexOf(null);
      lane = free >= 0 ? free : laneTips.push(null) - 1;
    }
    laneTips[lane] = n.id;
    laneById.set(n.id, lane);
    rowById.set(n.id, row);
    rows.push({ node: n, row, lane });
  });

  return { rows, edges, laneCount: laneTips.length };
}

/** GitHub-ish lane palette. */
const LANE_COLORS = [
  "#3fb950",
  "#58a6ff",
  "#a371f7",
  "#d29922",
  "#39c5cf",
  "#f778ba",
  "#f85149",
  "#8b949e",
];

export function laneColor(lane: number): string {
  return LANE_COLORS[lane % LANE_COLORS.length];
}
