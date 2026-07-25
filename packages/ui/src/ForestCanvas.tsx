import { useEffect, useMemo, useRef, useState } from "react";
import type { TreeSummary, TreeStatus } from "@pines/shared";
import { layoutGlyph, GlyphPoint } from "./glyph";

const GLYPH_SIZE = 64; // world units, glyph content height
const HIT_RADIUS = 52;
const STATUS_COLOR: Record<TreeStatus, string> = {
  running: "#4d8f57",
  waiting: "#e3b341",
  idle: "#58a6ff",
  error: "#f85149",
  dormant: "#6b5a44",
};

interface Camera {
  x: number;
  y: number;
  scale: number;
}

export function ForestCanvas({
  trees,
  spotlight,
  onOpen,
}: {
  trees: TreeSummary[];
  /** When set (search active), trees outside this set are dimmed. */
  spotlight: Set<string> | null;
  onOpen: (id: string) => void;
}) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const camRef = useRef<Camera>({ x: 0, y: 0, scale: 1 });
  const fittedRef = useRef(false);
  const [hover, setHover] = useState<{ tree: TreeSummary; sx: number; sy: number } | null>(null);
  const hoverRef = useRef<string | null>(null);
  const treesRef = useRef(trees);
  treesRef.current = trees;
  const spotlightRef = useRef(spotlight);
  spotlightRef.current = spotlight;

  const glyphs = useMemo(() => {
    const m = new Map<string, GlyphPoint[]>();
    for (const t of trees) if (t.glyph) m.set(t.sessionPath, layoutGlyph(t.glyph));
    return m;
  }, [trees]);
  const glyphsRef = useRef(glyphs);
  glyphsRef.current = glyphs;

  // Fit the camera to the forest once trees first arrive.
  useEffect(() => {
    if (fittedRef.current || trees.length === 0) return;
    const canvas = canvasRef.current;
    if (!canvas) return;
    const xs = trees.map((t) => t.pos?.x ?? 0);
    const ys = trees.map((t) => t.pos?.y ?? 0);
    const minX = Math.min(...xs) - 160;
    const maxX = Math.max(...xs) + 160;
    const minY = Math.min(...ys) - 160;
    const maxY = Math.max(...ys) + 160;
    const w = canvas.clientWidth || 800;
    const h = canvas.clientHeight || 600;
    const scale = Math.min(w / (maxX - minX), h / (maxY - minY), 1.4);
    camRef.current = { x: (minX + maxX) / 2, y: (minY + maxY) / 2, scale };
    fittedRef.current = true;
  }, [trees]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d")!;
    let raf = 0;

    const draw = () => {
      const cam = camRef.current;
      const dpr = window.devicePixelRatio || 1;
      const w = canvas.clientWidth;
      const h = canvas.clientHeight;
      if (canvas.width !== w * dpr || canvas.height !== h * dpr) {
        canvas.width = w * dpr;
        canvas.height = h * dpr;
      }
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, w, h);
      const toSX = (wx: number) => (wx - cam.x) * cam.scale + w / 2;
      const toSY = (wy: number) => (wy - cam.y) * cam.scale + h / 2;
      const now = performance.now() / 1000;
      const list = treesRef.current;
      const spot = spotlightRef.current;
      const posByPath = new Map(list.map((t) => [t.sessionPath, t.pos]));

      // lineage edges (fork parentSession links), dotted
      ctx.save();
      ctx.setLineDash([4, 5]);
      ctx.strokeStyle = "rgba(139,148,158,0.35)";
      ctx.lineWidth = 1;
      for (const t of list) {
        if (!t.parentSession || !t.pos) continue;
        const pp = posByPath.get(t.parentSession);
        if (!pp) continue;
        ctx.beginPath();
        ctx.moveTo(toSX(pp.x), toSY(pp.y));
        ctx.lineTo(toSX(t.pos.x), toSY(t.pos.y));
        ctx.stroke();
      }
      ctx.restore();

      for (const t of list) {
        if (!t.pos) continue;
        const dimmed = spot !== null && !spot.has(t.id);
        const cx = toSX(t.pos.x);
        const cy = toSY(t.pos.y);
        const s = cam.scale;
        if (cx < -100 || cx > w + 100 || cy < -100 || cy > h + 100) continue;
        ctx.save();
        ctx.globalAlpha = dimmed ? 0.14 : 1;

        // status ring
        const ringR = 46 * s;
        ctx.beginPath();
        ctx.arc(cx, cy, ringR, 0, Math.PI * 2);
        ctx.strokeStyle = STATUS_COLOR[t.status];
        ctx.lineWidth = Math.max(1.2, 1.8 * s);
        if (t.status === "running") {
          ctx.globalAlpha *= 0.55 + 0.45 * Math.sin(now * 4);
        } else if (t.status === "dormant") {
          ctx.globalAlpha *= 0.5;
        }
        ctx.stroke();
        ctx.globalAlpha = dimmed ? 0.14 : 1;
        if (hoverRef.current === t.id) {
          ctx.beginPath();
          ctx.arc(cx, cy, ringR + 3 * s, 0, Math.PI * 2);
          ctx.strokeStyle = "#e6edf3";
          ctx.lineWidth = 1;
          ctx.stroke();
        }

        // glyph silhouette, grown upward from the ring's lower third
        const pts = glyphsRef.current.get(t.sessionPath);
        if (pts && pts.length > 0) {
          const gh = GLYPH_SIZE * s;
          const gw = GLYPH_SIZE * 0.9 * s;
          const baseY = cy + gh * 0.45;
          const px = (p: GlyphPoint) => cx + p.x * gw;
          const py = (p: GlyphPoint) => baseY + p.y * gh;
          ctx.strokeStyle = dimmed ? "#3d6647" : "#4d8f57";
          ctx.lineWidth = Math.max(0.8, 1.3 * s);
          ctx.beginPath();
          for (const p of pts) {
            if (p.parent < 0) continue;
            const q = pts[p.parent];
            ctx.moveTo(px(q), py(q));
            ctx.lineTo(px(p), py(p));
          }
          ctx.stroke();
          // trunk root tick
          const root = pts.find((p) => p.parent < 0);
          if (root) {
            ctx.beginPath();
            ctx.moveTo(px(root), py(root));
            ctx.lineTo(px(root), py(root) + 6 * s);
            ctx.strokeStyle = "#8a6d4a";
            ctx.stroke();
          }
          // active tip
          const leaf = t.glyphLeaf != null ? pts[t.glyphLeaf] : undefined;
          if (leaf) {
            ctx.beginPath();
            ctx.arc(px(leaf), py(leaf), Math.max(1.5, 2.4 * s), 0, Math.PI * 2);
            ctx.fillStyle = t.status === "running" ? "#8fd694" : STATUS_COLOR[t.status];
            ctx.fill();
          }
        }

        // waiting marker
        if (t.status === "waiting") {
          ctx.fillStyle = "#e3b341";
          ctx.font = `${Math.max(10, 13 * s)}px ui-sans-serif`;
          ctx.textAlign = "center";
          ctx.fillText("?", cx + ringR * 0.75, cy - ringR * 0.75);
        }

        // title
        if (s > 0.35) {
          ctx.fillStyle = dimmed ? "rgba(139,148,158,0.4)" : "#8b949e";
          ctx.font = `${Math.max(9, 11 * Math.min(s, 1.1))}px ui-sans-serif`;
          ctx.textAlign = "center";
          const title = t.title.length > 22 ? t.title.slice(0, 21) + "…" : t.title;
          ctx.fillText(title, cx, cy + ringR + 14 * Math.min(s, 1.2));
        }
        ctx.restore();
      }
      raf = requestAnimationFrame(draw);
    };
    raf = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(raf);
  }, []);

  // interactions
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    let dragging = false;
    let moved = false;
    let last = { x: 0, y: 0 };

    const toWorld = (sx: number, sy: number) => {
      const cam = camRef.current;
      const r = canvas.getBoundingClientRect();
      return {
        x: (sx - r.left - r.width / 2) / cam.scale + cam.x,
        y: (sy - r.top - r.height / 2) / cam.scale + cam.y,
      };
    };
    const treeAt = (sx: number, sy: number): TreeSummary | null => {
      const wpt = toWorld(sx, sy);
      let best: TreeSummary | null = null;
      let bestD = HIT_RADIUS;
      for (const t of treesRef.current) {
        if (!t.pos) continue;
        const d = Math.hypot(t.pos.x - wpt.x, t.pos.y - wpt.y);
        if (d < bestD) {
          bestD = d;
          best = t;
        }
      }
      return best;
    };

    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const cam = camRef.current;
      const factor = Math.exp(-e.deltaY * 0.0012);
      const next = Math.min(4, Math.max(0.08, cam.scale * factor));
      const before = toWorld(e.clientX, e.clientY);
      cam.scale = next;
      const after = toWorld(e.clientX, e.clientY);
      cam.x += before.x - after.x;
      cam.y += before.y - after.y;
    };
    const onDown = (e: MouseEvent) => {
      dragging = true;
      moved = false;
      last = { x: e.clientX, y: e.clientY };
    };
    const onMove = (e: MouseEvent) => {
      if (dragging) {
        const dx = e.clientX - last.x;
        const dy = e.clientY - last.y;
        if (Math.abs(dx) + Math.abs(dy) > 2) moved = true;
        const cam = camRef.current;
        cam.x -= dx / cam.scale;
        cam.y -= dy / cam.scale;
        last = { x: e.clientX, y: e.clientY };
        return;
      }
      const t = treeAt(e.clientX, e.clientY);
      hoverRef.current = t?.id ?? null;
      canvas.style.cursor = t ? "pointer" : "grab";
      if (t) {
        const r = canvas.getBoundingClientRect();
        setHover({ tree: t, sx: e.clientX - r.left, sy: e.clientY - r.top });
      } else {
        setHover(null);
      }
    };
    const onUp = (e: MouseEvent) => {
      const wasDrag = dragging && moved;
      dragging = false;
      if (wasDrag) return;
      const t = treeAt(e.clientX, e.clientY);
      if (t) onOpenRef.current(t.id);
    };
    const onLeave = () => {
      dragging = false;
      hoverRef.current = null;
      setHover(null);
    };

    canvas.addEventListener("wheel", onWheel, { passive: false });
    canvas.addEventListener("mousedown", onDown);
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    canvas.addEventListener("mouseleave", onLeave);
    return () => {
      canvas.removeEventListener("wheel", onWheel);
      canvas.removeEventListener("mousedown", onDown);
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      canvas.removeEventListener("mouseleave", onLeave);
    };
  }, []);
  const onOpenRef = useRef(onOpen);
  onOpenRef.current = onOpen;

  return (
    <div className="forestcanvas-wrap">
      <canvas ref={canvasRef} className="forestcanvas" />
      {hover && (
        <div className="hovercard" style={{ left: hover.sx + 14, top: hover.sy + 14 }}>
          <div className="hovercard-title">
            <span className={`dot dot-${hover.tree.status}`} /> {hover.tree.title}
          </div>
          <div className="hovercard-meta">
            {hover.tree.nodeCount} nodes · {hover.tree.status}
            {hover.tree.parentSession ? " · ⑂ fork" : ""}
          </div>
          <div className="hovercard-cwd">{hover.tree.cwd}</div>
        </div>
      )}
      {trees.length === 0 && (
        <div className="empty forestcanvas-empty">
          No trees yet. Start a pi session and it will appear here.
        </div>
      )}
    </div>
  );
}
