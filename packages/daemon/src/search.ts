/**
 * In-memory search over all node text in all trees.
 *
 * Sessions already live fully parsed in memory (they're small — text, not
 * artifacts), so a linear scan with token matching is instant at the scale
 * of thousands of nodes and keeps M2 free of native DB dependencies.
 * SQLite (FTS + sqlite-vec) arrives in M3 alongside embeddings, where
 * persistence genuinely pays for itself.
 */

import type { SearchResult, SearchMatch, TreeStatus } from "@pines/shared";
import { SessionTree } from "./session.js";

const MAX_RESULTS = 30;
const MAX_MATCHES_PER_TREE = 5;
const PREVIEW = 160;

export function searchTrees(
  trees: Iterable<SessionTree>,
  statusOf: (t: SessionTree) => TreeStatus,
  query: string,
): SearchResult[] {
  const tokens = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return [];
  const results: SearchResult[] = [];

  for (const tree of trees) {
    let score = 0;
    const matches: SearchMatch[] = [];
    const title = tree.title();
    const titleLc = title.toLowerCase();
    if (tokens.every((t) => titleLc.includes(t))) score += 5;

    for (const e of tree.entries) {
      const d = tree.nodeDetail(e.id);
      if (!d || !d.text) continue;
      const textLc = d.text.toLowerCase();
      if (!tokens.every((t) => textLc.includes(t))) continue;
      score += 1;
      if (matches.length < MAX_MATCHES_PER_TREE) {
        matches.push({
          nodeId: e.id,
          role: d.role,
          preview: snippet(d.text, tokens[0], PREVIEW),
        });
      }
    }

    if (score > 0) {
      results.push({ treeId: tree.id, title, status: statusOf(tree), score, matches });
    }
  }

  results.sort((a, b) => b.score - a.score);
  return results.slice(0, MAX_RESULTS);
}

/** A window of text around the first hit of `token`. */
function snippet(text: string, token: string, len: number): string {
  const idx = text.toLowerCase().indexOf(token);
  if (idx < 0) return text.slice(0, len);
  const start = Math.max(0, idx - Math.floor(len / 3));
  const cut = text.slice(start, start + len).replace(/\s+/g, " ").trim();
  return (start > 0 ? "…" : "") + cut + (start + len < text.length ? "…" : "");
}
