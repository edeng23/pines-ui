import type { TreeNode } from "@pines/shared";

export interface LaidOutNode {
  node: TreeNode;
  x: number; // depth * COL
  y: number; // row * ROW
  depth: number;
}

export const COL = 46;
export const ROW = 34;

/**
 * Simple tidy-ish layout for a left-to-right tree: leaves get sequential
 * rows in DFS order; an internal node sits at the midpoint of its
 * children. Entries whose parent is missing (shouldn't happen, but be
 * tolerant) are treated as roots.
 */
export function layoutTree(nodes: TreeNode[]): Map<string, LaidOutNode> {
  const children = new Map<string, TreeNode[]>();
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const roots: TreeNode[] = [];
  for (const n of nodes) {
    if (n.parentId && byId.has(n.parentId)) {
      const list = children.get(n.parentId) ?? [];
      list.push(n);
      children.set(n.parentId, list);
    } else {
      roots.push(n);
    }
  }

  const out = new Map<string, LaidOutNode>();
  let nextRow = 0;

  const place = (n: TreeNode, depth: number): number => {
    const kids = children.get(n.id) ?? [];
    let y: number;
    if (kids.length === 0) {
      y = nextRow++ * ROW;
    } else {
      const ys = kids.map((k) => place(k, depth + 1));
      y = (Math.min(...ys) + Math.max(...ys)) / 2;
    }
    out.set(n.id, { node: n, x: depth * COL, y, depth });
    return y;
  };

  for (const r of roots) place(r, 0);
  return out;
}
