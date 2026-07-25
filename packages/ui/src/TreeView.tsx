import { useEffect, useMemo, useRef } from "react";
import type { TreeDetail, TreeNode } from "@pines/shared";
import { buildGraph, laneColor } from "./gitgraph";

const ROW = 34;
const LANE_W = 16;
const PAD_X = 14;
const PAD_Y = 8;
const CURVE = 12;

function roleOf(n: TreeNode): { key: string; label: string } {
  const r = n.role ?? n.type;
  switch (r) {
    case "user":
      return { key: "user", label: "user" };
    case "assistant":
      return { key: "assistant", label: "asst" };
    case "toolResult":
      return { key: "tool", label: "tool" };
    case "bashExecution":
      return { key: "tool", label: "bash" };
    case "branchSummary":
    case "branch_summary":
      return { key: "branch", label: "branch" };
    case "compactionSummary":
    case "compaction":
      return { key: "branch", label: "compact" };
    case "custom":
      return { key: "custom", label: n.type === "custom" ? "pines" : "custom" };
    case "model_change":
      return { key: "meta", label: "model" };
    case "thinking_level_change":
      return { key: "meta", label: "think" };
    default:
      return { key: "meta", label: r.slice(0, 7) };
  }
}

function shortTime(iso: string): string {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return "";
  return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

export function TreeView({
  tree,
  selectedId,
  onSelect,
}: {
  tree: TreeDetail;
  selectedId: string | null;
  onSelect: (id: string) => void;
}) {
  const graph = useMemo(() => buildGraph(tree.nodes), [tree.nodes]);
  const active = useMemo(() => new Set(tree.activePath), [tree.activePath]);
  const rowsRef = useRef<HTMLDivElement | null>(null);

  const gutterW = PAD_X * 2 + graph.laneCount * LANE_W;
  const height = PAD_Y * 2 + graph.rows.length * ROW;
  const laneX = (l: number) => PAD_X + l * LANE_W + LANE_W / 2;
  const rowY = (r: number) => PAD_Y + r * ROW + ROW / 2;

  // Keep the selected row in view (e.g. after keyboard nav / search jump).
  useEffect(() => {
    if (!selectedId || !rowsRef.current) return;
    const i = graph.rows.findIndex((r) => r.node.id === selectedId);
    const el = rowsRef.current.children[i] as HTMLElement | undefined;
    el?.scrollIntoView({ block: "nearest" });
  }, [selectedId, graph.rows]);

  const edgePath = (e: { fromRow: number; fromLane: number; toRow: number; toLane: number }) => {
    const fx = laneX(e.fromLane);
    const fy = rowY(e.fromRow);
    const tx = laneX(e.toLane);
    const ty = rowY(e.toRow);
    if (e.fromLane === e.toLane) return `M ${fx} ${fy} L ${tx} ${ty}`;
    // Swing into the target lane within the first row, then rail down.
    const cy = fy + ROW;
    return (
      `M ${fx} ${fy} C ${fx} ${fy + CURVE}, ${tx} ${cy - CURVE}, ${tx} ${cy}` +
      (ty > cy ? ` L ${tx} ${ty}` : "")
    );
  };

  return (
    <div className="gittree" style={{ minHeight: height }}>
      <div className="gittree-rows" ref={rowsRef}>
        {graph.rows.map((r) => {
          const isSelected = selectedId === r.node.id;
          const isLeaf = tree.leafId === r.node.id;
          const onActive = active.has(r.node.id);
          const role = roleOf(r.node);
          return (
            <div
              key={r.node.id}
              className={
                "gitrow" +
                (isSelected ? " gitrow-selected" : "") +
                (onActive ? "" : " gitrow-inactive")
              }
              style={{ height: ROW, paddingLeft: gutterW + 6 }}
              onClick={() => onSelect(r.node.id)}
              title={r.node.preview}
            >
              <span className={`rolebadge role-${role.key}`}>{role.label}</span>
              <span className="gitrow-preview">{r.node.preview || "—"}</span>
              {r.node.label && <span className="tagchip">⌂ {r.node.label}</span>}
              {isLeaf && (
                <span className={`tipchip${tree.status === "running" ? " tipchip-live" : ""}`}>
                  {tree.status === "running" ? "● running" : "tip"}
                </span>
              )}
              <span className="gitrow-time">{shortTime(r.node.timestamp)}</span>
            </div>
          );
        })}
      </div>
      <svg className="gittree-graph" width={gutterW} height={height}>
        {graph.edges.map((e, i) => {
          const child = graph.rows[e.toRow];
          const edgeActive = active.has(child.node.id) && active.has(graph.rows[e.fromRow].node.id);
          return (
            <path
              key={i}
              d={edgePath(e)}
              fill="none"
              stroke={laneColor(e.toLane)}
              strokeWidth={edgeActive ? 2 : 1.5}
              opacity={edgeActive ? 0.95 : 0.35}
            />
          );
        })}
        {graph.rows.map((r) => {
          const isSelected = selectedId === r.node.id;
          const isLeaf = tree.leafId === r.node.id;
          const onActive = active.has(r.node.id);
          const cx = laneX(r.lane);
          const cy = rowY(r.row);
          return (
            <g key={r.node.id}>
              {isLeaf && tree.status === "running" && (
                <circle cx={cx} cy={cy} r={8} fill="none" stroke={laneColor(r.lane)} strokeWidth={1.5}>
                  <animate attributeName="r" values="6;11;6" dur="1.8s" repeatCount="indefinite" />
                  <animate attributeName="opacity" values="0.8;0;0.8" dur="1.8s" repeatCount="indefinite" />
                </circle>
              )}
              <circle
                cx={cx}
                cy={cy}
                r={isLeaf ? 5 : 4}
                fill={onActive ? laneColor(r.lane) : "#0b0e14"}
                stroke={laneColor(r.lane)}
                strokeWidth={1.5}
                opacity={onActive ? 1 : 0.5}
              />
              {isSelected && (
                <circle cx={cx} cy={cy} r={8.5} fill="none" stroke="#e6edf3" strokeWidth={1.4} />
              )}
            </g>
          );
        })}
      </svg>
    </div>
  );
}
