/**
 * Types for pi's on-disk session format (v3).
 * Reference: pi-mono packages/coding-agent/docs/session-format.md
 *
 * Session files are JSONL. The first line is a SessionHeader; every
 * subsequent line is a SessionEntry with `id`/`parentId` forming a tree.
 * The active branch ("leaf") is the chain from the most recently appended
 * entry back to the root.
 */

export interface SessionHeader {
  type: "session";
  version: number;
  id: string;
  timestamp: string;
  cwd: string;
  /** Present on forked sessions: path to the original session file. */
  parentSession?: string;
}

export interface SessionEntryBase {
  type: string;
  /** 8-char hex id. */
  id: string;
  /** null for the first entry after the header. */
  parentId: string | null;
  timestamp: string;
}

export interface TextContent {
  type: "text";
  text: string;
}
export interface ImageContent {
  type: "image";
  data: string;
  mimeType: string;
}
export interface ThinkingContent {
  type: "thinking";
  thinking: string;
}
export interface ToolCallContent {
  type: "toolCall";
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}
export type ContentBlock =
  | TextContent
  | ImageContent
  | ThinkingContent
  | ToolCallContent;

export type AgentMessageRole =
  | "user"
  | "assistant"
  | "toolResult"
  | "bashExecution"
  | "custom"
  | "branchSummary"
  | "compactionSummary";

export interface AgentMessage {
  role: AgentMessageRole;
  content?: string | ContentBlock[];
  // assistant
  model?: string;
  provider?: string;
  stopReason?: string;
  errorMessage?: string;
  usage?: Record<string, unknown>;
  // toolResult
  toolCallId?: string;
  toolName?: string;
  isError?: boolean;
  // bashExecution
  command?: string;
  output?: string;
  exitCode?: number;
  // custom
  customType?: string;
  display?: boolean;
  // branchSummary / compactionSummary
  summary?: string;
  fromId?: string;
  tokensBefore?: number;
  timestamp?: number;
}

export interface MessageEntry extends SessionEntryBase {
  type: "message";
  message: AgentMessage;
}
export interface ModelChangeEntry extends SessionEntryBase {
  type: "model_change";
  provider: string;
  modelId: string;
}
export interface ThinkingLevelChangeEntry extends SessionEntryBase {
  type: "thinking_level_change";
  thinkingLevel: string;
}
export interface CompactionEntry extends SessionEntryBase {
  type: "compaction";
  summary: string;
  tokensBefore?: number;
  firstKeptEntryId?: string;
  retainedTail?: unknown[];
}
export interface BranchSummaryEntry extends SessionEntryBase {
  type: "branch_summary";
  fromId: string;
  summary: string;
}
export interface CustomEntry extends SessionEntryBase {
  type: "custom";
  customType: string;
  data: unknown;
}
export interface CustomMessageEntry extends SessionEntryBase {
  type: "custom_message";
  customType: string;
  content: string | ContentBlock[];
  display?: boolean;
}
export interface LabelEntry extends SessionEntryBase {
  type: "label";
  targetId: string;
  label: string | null;
}
export interface SessionInfoEntry extends SessionEntryBase {
  type: "session_info";
  name: string;
}

export type SessionEntry =
  | MessageEntry
  | ModelChangeEntry
  | ThinkingLevelChangeEntry
  | CompactionEntry
  | BranchSummaryEntry
  | CustomEntry
  | CustomMessageEntry
  | LabelEntry
  | SessionInfoEntry;

/** Extract plain text from a string-or-blocks content field. */
export function contentText(content: string | ContentBlock[] | undefined): string {
  if (content == null) return "";
  if (typeof content === "string") return content;
  return content
    .map((b) => {
      if (b.type === "text") return b.text;
      if (b.type === "thinking") return b.thinking;
      if (b.type === "toolCall") return `[tool: ${b.name}]`;
      return "[image]";
    })
    .join("\n")
    .trim();
}
