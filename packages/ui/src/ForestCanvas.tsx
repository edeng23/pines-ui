import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { TreeSummary, TreeStatus } from "@pines/shared";
import { layoutGlyph, GlyphPoint } from "./glyph";

const GLYPH_SIZE = 60; // world units, glyph content height
const RING_R = 46;
const HIT_RADIUS = 52;
const GRID = 90;
const STATUS_COLOR: Record<TreeStatus, string> = {
  running: "#3fb950",
  waiting: "#d29922",
  idle: "#58a6ff",
  error: "#f85149",
  dormant: "#6e7681",
};
const STATUS_LABEL: Record<TreeStatus, string> = {
  running: "running",
  waiting: "needs input",
  idle: "idle",
  error: "error",
  dormant: "dormant",
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
  const onOpenRef = useRef(onOpen);
  onOpenRef.current = onOpen;

  const glyphs = useMemo(() => {
    const m = new Map<string, GlyphPoint[]>();
    for (const t of trees) if (t.glyph) m.set(t.sessionPath, layoutGlyph(t.glyph));
    return m;
  }, [trees]);
  const glyphsRef = useRef(glyphs);
  glyphsRef.current = glyphs;

  const fitView = useCallback(() => {
    const canvas = canvasRef.current;
    const list = treesRef.current;
    if (!canvas || list.length === 0) return;
    const xs = list.map((t) => t.pos?.x ?? 0);
    const ys = list.map((t) => t.pos?.y ?? 0);
    const minX = Math.min(...xs) - 170;
    const maxX = Math.max(...xs) + 170;
    const minY = Math.min(...ys) - 170;
    const maxY = Math.max(...ys) + 170;
    const w = canvas.clientWidth || 800;
    const h = canvas.clientHeight || 600;
    const scale = Math.min(w / (maxX - minX), h / (maxY - minY), 1.4);
    camRef.current = { x: (minX + maxX) / 2, y: (minY + maxY) / 2, scale };
  }, []);

  const zoomBy = useCallback((factor: number) => {
    const cam = camRef.current;
    cam.scale = Math.min(4, Math.max(0.08, cam.scale * factor));
  }, []);

  // Fit the camera to the forest once trees first arrive.
  useEffect(() => {
    if (fittedRef.current || trees.length === 0) return;
    fitView();
    fittedRef.current = true;
  }, [trees, fitView]);

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

      // dot grid, drawn in world space so it pans and zooms with the forest
      {
        let step = GRID;
        while (step * cam.scale < 26) step *= 2;
        while (step * cam.scale > 110) step /= 2;
        const alpha = Math.min(0.1, 0.045 + cam.scale * 0.02);
        ctx.fillStyle = `rgba(126, 140, 160, ${alpha})`;
        const x0 = Math.floor((cam.x - w / 2 / cam.scale) / step) * step;
        const y0 = Math.floor((cam.y - h / 2 / cam.scale) / step) * step;
        for (let gx = x0; toSX(gx) < w + step; gx += step) {
          for (let gy = y0; toSY(gy) < h + step; gy += step) {
            ctx.fillRect(toSX(gx) - 0.5, toSY(gy) - 0.5, 1.5, 1.5);
          }
        }
      }

      // lineage edges (fork parentSession links), dotted
      ctx.save();
      ctx.setLineDash([3, 6]);
      ctx.strokeStyle = "rgba(126, 140, 160, 0.4)";
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
        if (cx < -120 || cx > w + 120 || cy < -120 || cy > h + 120) continue;
        const ringR = RING_R * s;
        ctx.save();
        ctx.globalAlpha = dimmed ? 0.13 : 1;

        // coin: filled disc so the glyph sits on a card-like surface
        ctx.beginPath();
        ctx.arc(cx, cy, ringR, 0, Math.PI * 2);
        ctx.fillStyle = hoverRef.current === t.id ? "#161d27" : "#11161e";
        ctx.fill();

        // status ring (running pulses + glows)
        if (t.status === "running") {
          ctx.shadowColor = STATUS_COLOR.running;
          ctx.shadowBlur = 10 * s * (0.7 + 0.3 * Math.sin(now * 3.2));
        }
        ctx.beginPath();
        ctx.arc(cx, cy, ringR, 0, Math.PI * 2);
        ctx.strokeStyle = STATUS_COLOR[t.status];
        ctx.lineWidth = Math.max(1, 1.4 * s);
        if (t.status === "running") {
          ctx.globalAlpha *= 0.65 + 0.35 * Math.sin(now * 3.2);
        } else if (t.status === "dormant") {
          ctx.globalAlpha *= 0.45;
        }
        ctx.stroke();
        ctx.shadowBlur = 0;
        ctx.globalAlpha = dimmed ? 0.13 : 1;
        if (hoverRef.current === t.id) {
          ctx.beginPath();
          ctx.arc(cx, cy, ringR + 3.5 * s, 0, Math.PI * 2);
          ctx.strokeStyle = "rgba(230, 237, 243, 0.55)";
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
          ctx.strokeStyle = dimmed ? "#2e5238" : "#3d7a4b";
          ctx.lineWidth = Math.max(0.8, 1.2 * s);
          ctx.lineCap = "round";
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
            ctx.lineTo(px(root), py(root) + 7 * s);
            ctx.strokeStyle = "#8a6d4a";
            ctx.stroke();
          }
          // active tip
          const leaf = t.glyphLeaf != null ? pts[t.glyphLeaf] : undefined;
          if (leaf) {
            if (t.status === "running") {
              ctx.shadowColor = "#56d364";
              ctx.shadowBlur = 8 * s;
            }
            ctx.beginPath();
            ctx.arc(px(leaf), py(leaf), Math.max(1.6, 2.3 * s), 0, Math.PI * 2);
            ctx.fillStyle = t.status === "running" ? "#56d364" : STATUS_COLOR[t.status];
            ctx.fill();
            ctx.shadowBlur = 0;
          }
        }

        // waiting marker
        if (t.status === "waiting") {
          const br = Math.max(7, 8.5 * s);
          const bx = cx + ringR * 0.72;
          const by = cy - ringR * 0.72;
          ctx.beginPath();
          ctx.arc(bx, by, br, 0, Math.PI * 2);
          ctx.fillStyle = STATUS_COLOR.waiting;
          ctx.fill();
          ctx.fillStyle = "#0b0e14";
          ctx.font = `700 ${br * 1.3}px ui-sans-serif`;
          ctx.textAlign = "center";
          ctx.textBaseline = "middle";
          ctx.fillText("?", bx, by + 0.5);
          ctx.textBaseline = "alphabetic";
        }

        // title
        if (s > 0.32) {
          ctx.fillStyle = dimmed ? "rgba(125, 136, 150, 0.4)" : "#9aa4b2";
          ctx.font = `500 ${Math.max(9.5, 11.5 * Math.min(s, 1.05))}px ui-sans-serif`;
          ctx.textAlign = "center";
          const title = t.title.length > 24 ? t.title.slice(0, 23) + "…" : t.title;
          ctx.fillText(title, cx, cy + ringR + 16 * Math.min(s, 1.2));
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
      canvas.style.cursor = "grabbing";
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
      canvas.style.cursor = "grab";
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

  const counts = useMemo(() => {
    const c = new Map<TreeStatus, number>();
    for (const t of trees) c.set(t.status, (c.get(t.status) ?? 0) + 1);
    return c;
  }, [trees]);

  return (
    <div className="forestcanvas-wrap">
      <canvas ref={canvasRef} className="forestcanvas" />
      {hover && (
        <div className="hovercard" style={{ left: hover.sx + 14, top: hover.sy + 14 }}>
          <div className="hovercard-title">
            <span className={`dot dot-${hover.tree.status}`} /> {hover.tree.title}
          </div>
          <div className="hovercard-meta">
            {hover.tree.nodeCount} nodes · {STATUS_LABEL[hover.tree.status]}
            {hover.tree.parentSession ? " · ⑂ fork" : ""}
          </div>
          <div className="hovercard-cwd">{hover.tree.cwd}</div>
        </div>
      )}
      <div className="canvas-legend">
        {(Object.keys(STATUS_COLOR) as TreeStatus[]).map((s) =>
          counts.get(s) ? (
            <span key={s} className="legend-item">
              <span className={`dot dot-${s}`} /> {STATUS_LABEL[s]}
              <span className="legend-count">{counts.get(s)}</span>
            </span>
          ) : null,
        )}
      </div>
      <div className="canvas-controls">
        <button title="zoom in" onClick={() => zoomBy(1.3)}>
          +
        </button>
        <button title="zoom out" onClick={() => zoomBy(1 / 1.3)}>
          −
        </button>
        <button title="fit forest" onClick={fitView}>
          ⌖
        </button>
      </div>
      {trees.length === 0 && (
        <div className="empty forestcanvas-empty">
          No trees yet. Start a pi session and it will appear here.
        </div>
      )}
    </div>
  );
}
