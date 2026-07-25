/**
 * The pines daemon <-> UI API surface.
 * HTTP for queries/actions, WebSocket for the event stream.
 */

/** Lifecycle status of a tree (one pi session file). */
export type TreeStatus = "running" | "waiting" | "idle" | "error" | "dormant";

/** A node in a tree, as exposed to the UI (summary form). */
export interface TreeNode {
  id: string;
  parentId: string | null;
  type: string;
  /** Role for message entries: user/assistant/toolResult/... */
  role?: string;
  timestamp: string;
  /** Short plain-text preview (~200 chars). */
  preview: string;
  label?: string;
}

export interface PendingUiRequest {
  id: string;
  method: string;
  title?: string;
  message?: string;
  options?: string[];
  placeholder?: string;
  prefill?: string;
}

/** Summary of one tree, for the forest/list view. */
export interface TreeSummary {
  id: string;
  sessionPath: string;
  cwd: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  nodeCount: number;
  status: TreeStatus;
  leafId: string | null;
  /** Path to the session file this one was forked from, if any. */
  parentSession?: string;
  pendingUiRequest?: PendingUiRequest;
  /** Position in the forest plane (daemon-assigned, persisted). */
  pos?: { x: number; y: number };
  /**
   * Compact branch topology for the forest glyph: one parent index per
   * node in append order (-1 = root), capped at GLYPH_MAX_NODES.
   */
  glyph?: number[];
  /** Index into `glyph` of the active-branch tip, if within the cap. */
  glyphLeaf?: number;
  /** True when a PTY terminal (pi TUI) is attached to this tree. */
  terminalAttached?: boolean;
}

export const GLYPH_MAX_NODES = 400;

// ---- Search ----

export interface SearchMatch {
  nodeId: string;
  role?: string;
  preview: string;
}

export interface SearchResult {
  treeId: string;
  title: string;
  status: TreeStatus;
  score: number;
  matches: SearchMatch[];
}

/** Full tree detail: summary + all nodes. */
export interface TreeDetail extends TreeSummary {
  nodes: TreeNode[];
  /** Node ids on the active branch (root -> leaf). */
  activePath: string[];
}

/** Full content of a single node, for the transcript pane. */
export interface NodeDetail {
  id: string;
  parentId: string | null;
  type: string;
  role?: string;
  timestamp: string;
  text: string;
  toolName?: string;
  isError?: boolean;
  model?: string;
}

// ---- WebSocket events (daemon -> UI) ----

export type ServerEvent =
  | { event: "forest"; trees: TreeSummary[] }
  | { event: "tree_updated"; tree: TreeSummary }
  | { event: "tree_removed"; treeId: string }
  | {
      event: "status";
      treeId: string;
      status: TreeStatus;
      pendingUiRequest?: PendingUiRequest | null;
      terminalAttached?: boolean;
    }
  | { event: "stream"; treeId: string; kind: "text" | "thinking" | "tool"; delta: string }
  | { event: "runner_log"; treeId: string; line: string };

// ---- HTTP actions (UI -> daemon) ----

export interface PromptRequest {
  message: string;
  /**
   * Node to continue from. If set and not the current leaf, the daemon
   * navigates the tree (new branch from that node) before prompting.
   */
  fromNodeId?: string;
}

export interface AnswerUiRequest {
  requestId: string;
  value?: unknown;
  confirmed?: boolean;
  cancelled?: boolean;
}
