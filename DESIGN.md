# Pines — Design Document

**Pines** (pi + trees) is a tree-first orchestration environment for local [pi](https://github.com/badlogic/pi-mono) coding agents. The conversation tree is the primary navigation and organization surface — not a sidebar list. Trees live in a **forest view** (an Obsidian-graph-style map), agents keep running when you navigate away, and semantically related trees sit near each other.

This document captures the research-backed architecture decisions before writing code.

---

## 1. What we learned from prior art

### 1.1 How superset keeps agents running in the background

Researched from `superset-sh/superset` source (Elastic License 2.0, Electron + React 19):

- **No tmux.** Superset runs a dedicated, long-lived **PTY daemon** (`packages/pty-daemon`) built on **node-pty**. It's spawned **detached** so PTYs survive restarts of both the Electron app and the supervising "host-service" process, and it serves a Unix domain socket (0600 perms) that the UI attaches/detaches to. Each session keeps a 64KB ring buffer for scrollback replay on reattach. A manifest file + PID liveness polling lets a restarted supervisor *adopt* an already-running daemon rather than kill it.
- **Status detection is a workaround**, because terminal agents (Claude Code, Codex, …) are opaque TUIs: superset injects hook definitions into `~/.claude/settings.json` that POST lifecycle events to a localhost HTTP endpoint, then normalizes them to `Start | Stop | PermissionRequest | Failed | Attached | Detached`. "Waiting for input" = the `Notification`/`PreToolUse`/approval-request hooks.
- **Conversation bodies are never copied into superset's DB.** Two SQLite databases hold only metadata (projects, workspaces, session registry, bindings); transcripts stay in the agent's own native session store and are streamed back on resume. Isolation between parallel agents is done with **git worktrees** (`~/.superset/worktrees/<project>/<branch>`).

### 1.2 What pi gives us natively

Researched from `badlogic/pi-mono` (docs: `session-format.md`, `rpc.md`, `extensions.md`):

- **Sessions are already trees.** Format v3 JSONL at `~/.pi/agent/sessions/--<cwd-slug>--/<timestamp>_<uuid>.jsonl`. Every entry has `id` (8-char hex), `parentId`, `timestamp`; multiple children per node = branches, all in **one file**; the active branch tip is a `leafId`. Entry types include `message`, `compaction`, `branch_summary`, `label`, `custom`, `custom_message`, `session_info`. Forked files record `parentSession` in the header.
- **Full headless control exists: `pi --mode rpc`** — bidirectional JSONL over stdio. Commands: `prompt`, `steer`, `follow_up`, `abort`, `get_state`, `get_tree`, `get_entries`, `fork`, `clone`, `switch_session`, `new_session`, `set_model`, `compact`, … Events: `agent_start`, `turn_start/end`, `message_update` (streaming deltas), `tool_execution_*`, `agent_end`, and — critically — **`agent_settled`** (fully idle) and **`extension_ui_request`** (pi is asking a question), which the orchestrator can answer over RPC (`extension_ui_response`).
- **Extension API** (`~/.pi/agent/extensions/*.ts`) can register tools/commands, append entries, set labels, and reports `ctx.mode` (`"rpc"` vs `"tui"`), so a pines companion extension can run inside pi when needed.

**Key insight:** superset needed a PTY daemon + settings-file hook injection because its agents are closed TUIs. Pi is not — it hands us a structured, documented control channel and a stable on-disk tree format. Pines can therefore be dramatically simpler than superset while being *more* capable on the tree axis.

---

## 2. Architecture

Two processes, kept deliberately small:

```
┌─────────────────────────────┐        ┌──────────────────────────────────┐
│  pines-ui (browser/Tauri)   │  WS +  │  pinesd (daemon, Node/Bun)       │
│  React + canvas forest view │◄──────►│  • spawns pi --mode rpc children │
│  tree view, node inspector  │  HTTP  │  • watches ~/.pi/agent/sessions  │
└─────────────────────────────┘        │  • SQLite index (FTS + vectors)  │
                                       │  • layout & embedding jobs       │
                                       └───────────┬──────────────────────┘
                                                   │ stdio JSONL (RPC)
                                     ┌─────────────┼─────────────┐
                                 pi (rpc)      pi (rpc)      pi (rpc)
                                     │             │             │
                          ~/.pi/agent/sessions/**.jsonl  (source of truth)
```

### 2.1 `pinesd` — the daemon

A single Node/Bun process (no Electron requirement; the UI is a local web app first, wrappable in Tauri later).

- **Agent runtime:** each *running* node spawns one `pi --mode rpc` child on the relevant session file (`--session <path>`). Children are spawned **detached with stdio piped through the daemon**, so closing the UI costs nothing — this is superset's daemon pattern, minus the PTY layer we don't need. If `pinesd` itself dies, nothing is lost: sessions are pi's own JSONL files; restart re-attaches by resuming `--session <path>`. (We adopt superset's manifest + PID-liveness trick only if we later split runner from daemon; for v1, daemon restart = re-resume, which pi makes cheap.)
- **Status model**, derived from RPC events instead of hook hacks:

  | pines status | source signal |
  |---|---|
  | `running` (green, pulsing) | `agent_start` / `turn_start` / streaming deltas |
  | `waiting` (amber) | `extension_ui_request` pending, or `agent_settled` after a turn that ended with a question |
  | `idle` (gray) | `agent_settled`, no pending prompt |
  | `error` (red) | error deltas / `extension_error` / child exit ≠ 0 |
  | `dormant` (bark brown) | no pi process attached (tree exists on disk only) |

- **Indexer:** a chokidar watch on the session dir; JSONL is append-only, so incremental tail-parsing keeps the index hot. The index is **derived, always rebuildable** — like superset, we never copy transcripts as the source of truth; SQLite holds metadata, search text, embeddings, and layout positions.
- **API:** WebSocket for event streams (status changes, streaming tokens for the focused node), HTTP/JSON for queries (forest snapshot, tree detail, search).

### 2.2 Terminal access escape hatch

Sometimes you want the raw pi TUI. Because state is in the session file, "open in terminal" is just: detach the RPC child (or leave it if idle) and print `pi --session <path>` for the user to run — no PTY multiplexing needed in v1. If we later want embedded terminals, superset's node-pty daemon is the proven recipe; it slots in beside the RPC runner without changing the data model.

### 2.3 Workspace isolation

Adopt superset's convention directly: optional **git worktree per tree** (`~/.pines/worktrees/<project>/<branch>`), created on demand when a branch of work needs its own checkout. Not required for v1 single-checkout use.

---

## 3. Data model

SQLite (WAL mode), all derived from the JSONL files:

```
trees      (id, session_path, cwd, title, created_at, updated_at,
            status, leaf_id, node_count, parent_session,      -- lineage for forks
            pos_x, pos_y, embedding BLOB)                     -- cached layout
nodes      (tree_id, id, parent_id, ts, role, kind, summary)  -- summary = first ~200 chars
grafts     (tree_id, source_tree_a, node_a, source_tree_b, node_b)
node_fts   (FTS5 over node text)                              -- keyword search
vec index  (sqlite-vec over tree/node embeddings)             -- semantic search
```

- **A tree = one pi session file.** In-file branches (pi's native `id`/`parentId` structure) are branches *within* a tree. A pi `fork` (new file with `parentSession`) is a **new tree** with a dotted lineage edge back to its origin — visible in the forest, not inside either tree.
- Nothing in this DB is precious. `rm pines.db` → full reindex from JSONL.

---

## 4. The forest view

### 4.1 Rendering

- **Forest (zoomed out):** custom canvas (plain Canvas2D; PixiJS only if profiling demands it). Each tree renders as a compact glyph — its actual branch silhouette, computed from the node topology, at ~40–80px. Status is a single color-coded ring/dot per the table above; a running tree's active leaf glows. Hover → title, last activity, cwd; click → zoom into the tree.
- **Tree (zoomed in):** the same canvas continuously zooms into a full DAG layout of that session's nodes (tidy-tree layout, e.g. d3-hierarchy/flextree). Nodes are color-coded by role/kind; the active `leafId` path is highlighted. Selecting a node shows the transcript pane up to that node.
- **Keyboard-first:** arrows walk nodes, `Esc`/`←` at root zooms back to the forest **without touching the agent** — the RPC child keeps streaming; the forest glyph keeps showing live status. This is the Claude-Agents-view behavior, but the "list" is the forest.

### 4.2 Interactions on a node

- **Continue here** → RPC tree navigation to that node (pi appends a `branch_summary` and moves `leafId`) and focus the composer. New sibling branch grows in place.
- **Fork to new tree** → RPC `fork` at that node; new tree sprouts in the forest near its parent with a lineage edge.
- **Label / bookmark** → pi's native `label` entries; labeled nodes get a small marker in the tree view.
- **Answer a waiting agent** → the pending `extension_ui_request` (select/confirm/input) renders as an inline form on the node; the response goes back over RPC.

---

## 5. Semantic layout — kept deliberately light

Requirements: forest loads instantly; nearby trees are semantically related; trees don't teleport between sessions.

- **Embeddings are computed lazily in the daemon, never at render time.** One vector per tree: embed `title + first user message + latest compaction/branch summaries` (pi already writes these summaries — free signal). Model: a small local embedder (fastembed / MiniLM ONNX, ~90MB, ~ms per doc) with an optional API fallback. Re-embed only when a tree's summary material changes, debounced.
- **Layout is incremental, not global.** No UMAP/t-SNE runs at load:
  1. Positions are **persisted** in the DB; opening the forest is a single indexed read.
  2. A *new* tree is placed at the embedding-weighted centroid of its k=3 nearest neighbors (kNN via sqlite-vec), jittered to avoid overlap; forked/grafted trees bias toward their lineage parents.
  3. A cheap force pass (repulsion + spring toward kNN, ~100ms budget) runs **in the daemon after changes**, moving each tree at most a small bounded distance per pass — the forest drifts toward semantic order instead of snapping, and never blocks the UI.
- **Search** is two-tier and instant: FTS5 keyword search across all node text (results highlight matching nodes inside their trees), plus semantic search over the same embeddings ("find the conversation where I reasoned about X"). Search results dim the forest and spotlight matches in place, preserving spatial memory.

---

## 6. Grafting — a new tree from two nodes

Pi has no native merge, but its format makes one buildable without patching pi:

1. User picks node A (tree 1) and node B (tree 2) in the forest.
2. For each, `pinesd` produces a **path summary** of root→node using pi's own compaction machinery (RPC `compact` on a temporary clone, or direct summarization of `buildContextEntries`-equivalent walk). Cache these per node.
3. Write a fresh v3 session file whose opening entries are two `custom_message` entries (these **are** included in LLM context) — "Context inherited from ⟨tree A / node a3f2⟩: …" — plus an optional file-state note if the trees worked in different checkouts.
4. Record provenance: a `custom` entry `{customType: "pines.graft", data: {parents: [...]}}` in the session file, mirrored in the `grafts` table.
5. Spawn pi on it. In the forest, the new tree renders with **two dotted lineage edges** — lineage is a DAG *over* the forest; individual trees stay strict pi trees, so nothing about pi's format is violated.

Summaries (not raw concatenation) are the right seed: two full transcripts would blow context and confuse role structure, while pi-style compaction summaries are exactly the "context reached up to that node" distilled.

---

## 7. Build order

| Milestone | Deliverable |
|---|---|
| **M1 — Trunk** | `pinesd`: session indexer + `pi --mode rpc` runner + status model; minimal UI: tree list → tree view, continue/branch from any node, background running with live status. *(This alone beats stock pi's `/tree`.)* |
| **M2 — Forest** | Canvas forest with tree glyphs + status rings, zoom forest↔tree, keyboard nav, FTS search. |
| **M3 — Terrain** | Embeddings + incremental semantic layout + semantic search. |
| **M4 — Grafts** | Two-node graft flow + lineage DAG edges. |
| **Later** | Tauri shell, embedded PTY terminals (superset's node-pty daemon recipe), git-worktree-per-tree, multi-machine daemons. |

## 8. Stack

- **Daemon:** TypeScript on Node ≥ 20 (Bun-compatible), better-sqlite3 + sqlite-vec, chokidar, ws. Reuse `@earendil-works/pi-coding-agent` SDK types where importable.
- **UI:** Vite + React, zustand, Canvas2D forest/tree renderer, Tailwind. No Electron in v1 — `pinesd` serves the UI at `localhost`, which also keeps the door open for reaching your forest from another device.
