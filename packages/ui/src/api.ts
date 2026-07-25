import type {
  TreeSummary,
  TreeDetail,
  NodeDetail,
  ServerEvent,
  PromptRequest,
  AnswerUiRequest,
  SearchResult,
} from "@pines/shared";

async function jsonOrThrow<T>(res: Response): Promise<T> {
  if (!res.ok) {
    let msg = res.statusText;
    try {
      msg = ((await res.json()) as { error?: string }).error ?? msg;
    } catch {}
    throw new Error(msg);
  }
  return res.json() as Promise<T>;
}

export const api = {
  forest: () => fetch("/api/forest").then((r) => jsonOrThrow<TreeSummary[]>(r)),
  search: (q: string) =>
    fetch(`/api/search?q=${encodeURIComponent(q)}`).then((r) => jsonOrThrow<SearchResult[]>(r)),
  tree: (id: string) =>
    fetch(`/api/tree/${encodeURIComponent(id)}`).then((r) => jsonOrThrow<TreeDetail>(r)),
  node: (treeId: string, nodeId: string) =>
    fetch(`/api/tree/${encodeURIComponent(treeId)}/node/${encodeURIComponent(nodeId)}`).then(
      (r) => jsonOrThrow<NodeDetail>(r),
    ),
  prompt: (treeId: string, body: PromptRequest) =>
    fetch(`/api/tree/${encodeURIComponent(treeId)}/prompt`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }).then((r) => jsonOrThrow<{ ok: boolean }>(r)),
  abort: (treeId: string) =>
    fetch(`/api/tree/${encodeURIComponent(treeId)}/abort`, { method: "POST" }).then((r) =>
      jsonOrThrow<{ ok: boolean }>(r),
    ),
  answer: (treeId: string, body: AnswerUiRequest) =>
    fetch(`/api/tree/${encodeURIComponent(treeId)}/answer`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }).then((r) => jsonOrThrow<{ ok: boolean }>(r)),
  openTerminal: (treeId: string) =>
    fetch(`/api/tree/${encodeURIComponent(treeId)}/terminal`, { method: "POST" }).then((r) =>
      jsonOrThrow<{ ok: boolean; ws: string }>(r),
    ),
  closeTerminal: (treeId: string) =>
    fetch(`/api/tree/${encodeURIComponent(treeId)}/terminal`, { method: "DELETE" }).then((r) =>
      jsonOrThrow<{ ok: boolean }>(r),
    ),
  fork: (treeId: string, nodeId: string) =>
    fetch(`/api/tree/${encodeURIComponent(treeId)}/fork`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ nodeId }),
    }).then((r) => jsonOrThrow<{ ok: boolean; sessionPath: string | null }>(r)),
};

/** Open the event stream; reconnects with backoff. Returns a cleanup fn. */
export function openEvents(onEvent: (ev: ServerEvent) => void): () => void {
  let ws: WebSocket | null = null;
  let closed = false;
  let retry = 500;

  const connect = () => {
    if (closed) return;
    const proto = location.protocol === "https:" ? "wss" : "ws";
    ws = new WebSocket(`${proto}://${location.host}/ws`);
    ws.onmessage = (m) => {
      try {
        onEvent(JSON.parse(m.data as string) as ServerEvent);
      } catch {}
    };
    ws.onopen = () => {
      retry = 500;
    };
    ws.onclose = () => {
      if (!closed) setTimeout(connect, (retry = Math.min(retry * 2, 10_000)));
    };
  };
  connect();
  return () => {
    closed = true;
    ws?.close();
  };
}
