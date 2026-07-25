/**
 * Layout for forest glyphs: the actual branch silhouette of a tree,
 * grown upward like a little pine. Input is the compact topology from
 * TreeSummary.glyph (parent index per node, -1 = root).
 */

export interface GlyphPoint {
  x: number; // -0.5..0.5 across
  y: number; // 0 (root, bottom) .. -1 (tallest tip)
  parent: number;
  depth: number;
  isLeaf: boolean;
}

export function layoutGlyph(parents: number[]): GlyphPoint[] {
  const n = parents.length;
  if (n === 0) return [];
  const children: number[][] = Array.from({ length: n }, () => []);
  const roots: number[] = [];
  for (let i = 0; i < n; i++) {
    if (parents[i] >= 0 && parents[i] < n) children[parents[i]].push(i);
    else roots.push(i);
  }

  const col = new Array<number>(n).fill(0);
  const depth = new Array<number>(n).fill(0);
  let nextCol = 0;
  let maxDepth = 0;

  const place = (i: number, d: number): number => {
    depth[i] = d;
    maxDepth = Math.max(maxDepth, d);
    const kids = children[i];
    if (kids.length === 0) {
      col[i] = nextCol++;
    } else {
      const cols = kids.map((k) => place(k, d + 1));
      col[i] = (Math.min(...cols) + Math.max(...cols)) / 2;
    }
    return col[i];
  };
  for (const r of roots) place(r, 0);

  const wide = Math.max(nextCol - 1, 1);
  const tall = Math.max(maxDepth, 1);
  return parents.map((p, i) => ({
    x: nextCol > 1 ? col[i] / wide - 0.5 : 0,
    y: -(depth[i] / tall),
    parent: p,
    depth: depth[i],
    isLeaf: children[i].length === 0,
  }));
}
