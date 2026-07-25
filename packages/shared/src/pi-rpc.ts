/**
 * Types for pi's RPC mode wire protocol (`pi --mode rpc`).
 * Reference: pi-mono packages/coding-agent/docs/rpc.md
 *
 * Framing: strict JSONL, LF-delimited, over stdin/stdout.
 */

export interface RpcRequestBase {
  id?: string;
  type: string;
}

export type RpcRequest =
  | { id?: string; type: "prompt"; message: string; images?: unknown[]; streamingBehavior?: "steer" | "followUp" }
  | { id?: string; type: "steer"; message: string }
  | { id?: string; type: "follow_up"; message: string }
  | { id?: string; type: "abort" }
  | { id?: string; type: "get_state" }
  | { id?: string; type: "get_entries"; since?: string }
  | { id?: string; type: "get_tree" }
  | { id?: string; type: "fork"; entryId: string }
  | { id?: string; type: "clone" }
  | { id?: string; type: "new_session"; parentSession?: string }
  | { id?: string; type: "switch_session"; sessionPath: string }
  | { id?: string; type: "get_last_assistant_text" }
  | { id?: string; type: "set_session_name"; name: string }
  // Note: for extension_ui_response, `id` is the ui request's id (not an rpc correlation id).
  | { id: string; type: "extension_ui_response"; value?: unknown; confirmed?: boolean; cancelled?: boolean };

export interface RpcResponse {
  id?: string;
  type: "response";
  command: string;
  success: boolean;
  data?: unknown;
  error?: string;
}

export interface RpcStateData {
  isStreaming: boolean;
  isCompacting?: boolean;
  sessionId?: string;
  sessionFile?: string;
  sessionName?: string;
  pendingMessageCount?: number;
  model?: unknown;
  thinkingLevel?: string;
}

/** Events pi emits on stdout (everything that is not type:"response"). */
export interface RpcEvent {
  type:
    | "agent_start"
    | "agent_end"
    | "agent_settled"
    | "turn_start"
    | "turn_end"
    | "message_start"
    | "message_update"
    | "message_end"
    | "tool_execution_start"
    | "tool_execution_update"
    | "tool_execution_end"
    | "extension_ui_request"
    | "extension_error"
    | string;
  [key: string]: unknown;
}

export interface ExtensionUiRequest extends RpcEvent {
  type: "extension_ui_request";
  id: string;
  method: "select" | "confirm" | "input" | "editor" | "notify" | string;
  title?: string;
  message?: string;
  options?: string[];
  placeholder?: string;
  prefill?: string;
  timeout?: number;
}
