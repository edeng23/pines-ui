import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  TreeSummary,
  TreeDetail,
  NodeDetail,
  ServerEvent,
  TreeStatus,
  PendingUiRequest,
  SearchResult,
} from "@pines/shared";
import { api, openEvents } from "./api";
import { TreeView } from "./TreeView";
import { ForestCanvas } from "./ForestCanvas";
import { SearchBar } from "./SearchBar";

const STATUS_LABEL: Record<TreeStatus, string> = {
  running: "running",
  waiting: "needs input",
  idle: "idle",
  error: "error",
  dormant: "dormant",
};

function StatusDot({ status }: { status: TreeStatus }) {
  return <span className={`dot dot-${status}`} title={STATUS_LABEL[status]} />;
}

export default function App() {
  const [trees, setTrees] = useState<TreeSummary[]>([]);
  const [openId, setOpenId] = useState<string | null>(null);
  const [detail, setDetail] = useState<TreeDetail | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [selectedNode, setSelectedNode] = useState<NodeDetail | null>(null);
  const [streamBuf, setStreamBuf] = useState<Record<string, string>>({});
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [spotlight, setSpotlight] = useState<Set<string> | null>(null);
  const openIdRef = useRef(openId);
  openIdRef.current = openId;
  const lastLeafRef = useRef<string | null>(null);
  const jumpNodeRef = useRef<string | null>(null);

  const refreshDetail = useCallback((treeId: string) => {
    api
      .tree(treeId)
      .then((d) => {
        if (openIdRef.current === treeId) {
          const prevLeaf = lastLeafRef.current;
          lastLeafRef.current = d.leafId;
          setDetail(d);
          const jump = jumpNodeRef.current;
          jumpNodeRef.current = null;
          // A search jump wins; otherwise keep the user's selection but
          // follow the leaf as it grows.
          setSelectedId((cur) => {
            if (jump && d.nodes.some((n) => n.id === jump)) return jump;
            return !cur || !d.nodes.some((n) => n.id === cur) || cur === prevLeaf ? d.leafId : cur;
          });
        }
      })
      .catch((e: Error) => setErrorMsg(e.message));
  }, []);

  // Event stream
  useEffect(() => {
    return openEvents((ev: ServerEvent) => {
      switch (ev.event) {
        case "forest":
          setTrees(ev.trees);
          break;
        case "tree_updated":
          setTrees((ts) => {
            const rest = ts.filter((t) => t.id !== ev.tree.id && t.sessionPath !== ev.tree.sessionPath);
            return [ev.tree, ...rest].sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
          });
          if (openIdRef.current === ev.tree.id) refreshDetail(ev.tree.id);
          break;
        case "tree_removed":
          setTrees((ts) => ts.filter((t) => t.id !== ev.treeId && t.sessionPath !== ev.treeId));
          break;
        case "status":
          // The live stream row is only shown while running; drop the buffer
          // once the turn ends (the entries have landed in the tree by then).
          if (ev.status !== "running") {
            setStreamBuf((b) => ({ ...b, [ev.treeId]: "" }));
          }
          setTrees((ts) =>
            ts.map((t) =>
              t.id === ev.treeId
                ? { ...t, status: ev.status, pendingUiRequest: ev.pendingUiRequest ?? undefined }
                : t,
            ),
          );
          if (openIdRef.current === ev.treeId) {
            setDetail((d) =>
              d ? { ...d, status: ev.status, pendingUiRequest: ev.pendingUiRequest ?? undefined } : d,
            );
          }
          break;
        case "stream":
          if (ev.kind === "text") {
            setStreamBuf((b) => ({ ...b, [ev.treeId]: (b[ev.treeId] ?? "") + ev.delta }));
          }
          break;
      }
    });
  }, [refreshDetail]);

  // Open/close a tree
  useEffect(() => {
    if (!openId) {
      setDetail(null);
      setSelectedId(null);
      return;
    }
    refreshDetail(openId);
  }, [openId, refreshDetail]);

  // Selected node transcript
  useEffect(() => {
    if (!openId || !selectedId) {
      setSelectedNode(null);
      return;
    }
    api
      .node(openId, selectedId)
      .then(setSelectedNode)
      .catch(() => setSelectedNode(null));
  }, [openId, selectedId, detail]);

  // Esc goes back to the forest; the agent keeps running. When typing,
  // Esc just leaves the field.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      const el = document.activeElement as HTMLElement | null;
      const tag = (el?.tagName ?? "").toLowerCase();
      if (tag === "input" || tag === "textarea") {
        el?.blur();
        return;
      }
      setOpenId(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const openTree = trees.find((t) => t.id === openId);

  const openAt = useCallback((treeId: string, nodeId?: string) => {
    jumpNodeRef.current = nodeId ?? null;
    setOpenId((cur) => {
      if (cur === treeId) refreshDetail(treeId);
      return treeId;
    });
  }, [refreshDetail]);

  return (
    <div className="app">
      <header>
        <span className="logo" onClick={() => setOpenId(null)}>
          🌲 pines
        </span>
        {openTree && (
          <span className="crumb">
            / {openTree.title} <StatusDot status={openTree.status} />
          </span>
        )}
        <SearchBar
          onResults={(rs: SearchResult[] | null) =>
            setSpotlight(rs ? new Set(rs.map((r) => r.treeId)) : null)
          }
          onPick={openAt}
        />
        {errorMsg && (
          <span className="error" onClick={() => setErrorMsg(null)}>
            {errorMsg} ✕
          </span>
        )}
      </header>
      {!openId ? (
        <ForestCanvas trees={trees} spotlight={spotlight} onOpen={setOpenId} />
      ) : detail ? (
        <TreePage
          detail={detail}
          selectedId={selectedId}
          selectedNode={selectedNode}
          stream={streamBuf[openId] ?? ""}
          onSelect={setSelectedId}
          onError={setErrorMsg}
        />
      ) : (
        <div className="empty">loading…</div>
      )}
    </div>
  );
}

function TreePage({
  detail,
  selectedId,
  selectedNode,
  stream,
  onSelect,
  onError,
}: {
  detail: TreeDetail;
  selectedId: string | null;
  selectedNode: NodeDetail | null;
  stream: string;
  onSelect: (id: string) => void;
  onError: (msg: string) => void;
}) {
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);

  const branching = !!selectedId && selectedId !== detail.leafId;

  // Arrow-key navigation over the tree: ← parent, → child (preferring the
  // active path), ↑/↓ siblings. Ignored while typing.
  useEffect(() => {
    const byId = new Map(detail.nodes.map((n) => [n.id, n]));
    const childrenOf = (id: string) => detail.nodes.filter((n) => n.parentId === id);
    const active = new Set(detail.activePath);
    const onKey = (e: KeyboardEvent) => {
      const tag = (document.activeElement?.tagName ?? "").toLowerCase();
      if (tag === "input" || tag === "textarea") return;
      if (!selectedId || !byId.has(selectedId)) return;
      const cur = byId.get(selectedId)!;
      if (e.key === "ArrowLeft" && cur.parentId && byId.has(cur.parentId)) {
        e.preventDefault();
        onSelect(cur.parentId);
      } else if (e.key === "ArrowRight") {
        const kids = childrenOf(cur.id);
        if (kids.length > 0) {
          e.preventDefault();
          onSelect(kids.find((k) => active.has(k.id))?.id ?? kids[0].id);
        }
      } else if (e.key === "ArrowUp" || e.key === "ArrowDown") {
        if (!cur.parentId) return;
        const siblings = childrenOf(cur.parentId);
        const i = siblings.findIndex((s) => s.id === cur.id);
        const next = siblings[i + (e.key === "ArrowDown" ? 1 : -1)];
        if (next) {
          e.preventDefault();
          onSelect(next.id);
        }
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [detail.nodes, detail.activePath, selectedId, onSelect]);

  const pathToSelected = useMemo(() => {
    if (!selectedId) return [];
    const byId = new Map(detail.nodes.map((n) => [n.id, n]));
    const path = [];
    let cur = byId.get(selectedId);
    while (cur) {
      path.push(cur);
      cur = cur.parentId ? byId.get(cur.parentId) : undefined;
    }
    return path.reverse();
  }, [detail.nodes, selectedId]);

  const send = async () => {
    if (!message.trim() || busy) return;
    setBusy(true);
    try {
      await api.prompt(detail.id, {
        message,
        fromNodeId: branching ? selectedId! : undefined,
      });
      setMessage("");
    } catch (e) {
      onError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const fork = async () => {
    if (!selectedId) return;
    try {
      await api.fork(detail.id, selectedId);
    } catch (e) {
      onError((e as Error).message);
    }
  };

  const answer = async (a: { value?: unknown; confirmed?: boolean; cancelled?: boolean }) => {
    const req = detail.pendingUiRequest;
    if (!req) return;
    try {
      await api.answer(detail.id, { requestId: req.id, ...a });
    } catch (e) {
      onError((e as Error).message);
    }
  };

  return (
    <div className="treepage">
      <div className="treepane">
        <TreeView tree={detail} selectedId={selectedId} onSelect={onSelect} />
      </div>
      <div className="sidepane">
        <div className="transcript">
          {pathToSelected.map((n) => (
            <div key={n.id} className={`msg msg-${n.role ?? n.type}`}>
              <div className="msg-role">{n.role ?? n.type}</div>
              <div className="msg-text">
                {selectedNode && n.id === selectedNode.id ? selectedNode.text : n.preview}
              </div>
            </div>
          ))}
          {stream && detail.status === "running" && (
            <div className="msg msg-assistant msg-live">
              <div className="msg-role">assistant · streaming</div>
              <div className="msg-text">{stream}▌</div>
            </div>
          )}
        </div>
        {detail.status === "waiting" && detail.pendingUiRequest && (
          <UiRequestForm req={detail.pendingUiRequest} onAnswer={answer} />
        )}
        <div className="composer">
          {branching && (
            <div className="branchnote">
              ⑂ branching from <code>{selectedId}</code> — a new branch will grow from this node
              <button className="linkbtn" onClick={fork} title="Start a new tree (session file) from this node">
                fork to new tree instead
              </button>
            </div>
          )}
          <textarea
            value={message}
            placeholder={branching ? "Prompt for the new branch…" : "Prompt…"}
            onChange={(e) => setMessage(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) void send();
            }}
          />
          <div className="composer-actions">
            {detail.status === "running" ? (
              <button
                className="btn-danger"
                onClick={() => api.abort(detail.id).catch((e: Error) => onError(e.message))}
              >
                ■ abort
              </button>
            ) : (
              <button
                className="btn-primary"
                onClick={() => void send()}
                disabled={!message.trim() || busy}
              >
                {branching ? "⑂ branch & send" : "send"} ⌘↵
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function UiRequestForm({
  req,
  onAnswer,
}: {
  req: PendingUiRequest;
  onAnswer: (a: { value?: unknown; confirmed?: boolean; cancelled?: boolean }) => void;
}) {
  const [text, setText] = useState(req.prefill ?? "");
  return (
    <div className="uirequest">
      <div className="uirequest-title">🌲 {req.title ?? "pi needs input"}</div>
      {req.message && <div className="uirequest-msg">{req.message}</div>}
      {req.method === "select" &&
        (req.options ?? []).map((o) => (
          <button key={o} onClick={() => onAnswer({ value: o })}>
            {o}
          </button>
        ))}
      {req.method === "confirm" && (
        <>
          <button onClick={() => onAnswer({ confirmed: true })}>yes</button>
          <button onClick={() => onAnswer({ confirmed: false })}>no</button>
        </>
      )}
      {(req.method === "input" || req.method === "editor") && (
        <>
          <textarea
            value={text}
            placeholder={req.placeholder}
            onChange={(e) => setText(e.target.value)}
          />
          <button onClick={() => onAnswer({ value: text })}>submit</button>
        </>
      )}
      <button className="linkbtn" onClick={() => onAnswer({ cancelled: true })}>
        cancel
      </button>
    </div>
  );
}
