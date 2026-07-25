import { useMemo } from "react";
import type { TreeDetail } from "@pines/shared";
import { layoutTree, COL, ROW } from "./layout";

const ROLE_COLOR: Record<string, string> = {
  user: "#7cc4ff",
  assistant: "#8fd694",
  toolResult: "#c9a86a",
  bashExecution: "#c9a86a",
  custom: "#a98fd6",
  branchSummary: "#d68fb8",
  compactionSummary: "#d68fb8",
};

function nodeColor(type: string, role?: string): string {
  if (role && ROLE_COLOR[role]) return ROLE_COLOR[role];
  if (type === "compaction" || type === "branch_summary") return "#d68fb8";
  return "#8b949e";
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
  const layout = useMemo(() => layoutTree(tree.nodes), [tree.nodes]);
  const active = useMemo(() => new Set(tree.activePath), [tree.activePath]);

  const placed = [...layout.values()];
  const width = Math.max(...placed.map((p) => p.x), 0) + COL + 40;
  const height = Math.max(...placed.map((p) => p.y), 0) + ROW + 20;

  return (
    <svg
      className="treeview"
      width={width}
      height={height}
      viewBox={`-20 -14 ${width} ${height}`}
    >
      {placed.map((p) => {
        const parent = p.node.parentId ? layout.get(p.node.parentId) : null;
        if (!parent) return null;
        const onActive = active.has(p.node.id) && active.has(parent.node.id);
        const mx = (parent.x + p.x) / 2;
        return (
          <path
            key={`e-${p.node.id}`}
            d={`M ${parent.x} ${parent.y} C ${mx} ${parent.y}, ${mx} ${p.y}, ${p.x} ${p.y}`}
            fill="none"
            stroke={onActive ? "#4d8f57" : "#30363d"}
            strokeWidth={onActive ? 2.5 : 1.5}
          />
        );
      })}
      {placed.map((p) => {
        const isLeaf = tree.leafId === p.node.id;
        const isSelected = selectedId === p.node.id;
        return (
          <g
            key={p.node.id}
            transform={`translate(${p.x} ${p.y})`}
            className="treenode"
            onClick={() => onSelect(p.node.id)}
          >
            <title>{`${p.node.role ?? p.node.type}: ${p.node.preview}`}</title>
            {isSelected && <circle r={11} fill="none" stroke="#e3b341" strokeWidth={2} />}
            {isLeaf && tree.status === "running" && (
              <circle r={13} fill="none" stroke="#4d8f57" strokeWidth={1.5} opacity={0.7}>
                <animate attributeName="r" values="10;15;10" dur="1.6s" repeatCount="indefinite" />
                <animate attributeName="opacity" values="0.8;0.1;0.8" dur="1.6s" repeatCount="indefinite" />
              </circle>
            )}
            <circle
              r={7}
              fill={nodeColor(p.node.type, p.node.role)}
              opacity={active.has(p.node.id) ? 1 : 0.45}
              stroke={isLeaf ? "#e6edf3" : "none"}
              strokeWidth={isLeaf ? 1.5 : 0}
            />
            {p.node.label && (
              <text x={0} y={-13} textAnchor="middle" className="nodelabel">
                {p.node.label}
              </text>
            )}
          </g>
        );
      })}
    </svg>
  );
}
