/**
 * HTTP + WebSocket API for the pines UI.
 *
 *   GET  /api/forest                      -> TreeSummary[]
 *   GET  /api/tree/:id                    -> TreeDetail
 *   GET  /api/tree/:id/node/:nodeId       -> NodeDetail
 *   POST /api/tree/:id/prompt             {message, fromNodeId?}
 *   POST /api/tree/:id/abort
 *   POST /api/tree/:id/answer             {requestId, value?/confirmed?/cancelled?}
 *   POST /api/tree/:id/fork               {nodeId}
 *   WS   /ws                              -> ServerEvent stream
 *
 * Also serves the built UI from packages/ui/dist when present.
 */

import http from "node:http";
import path from "node:path";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import express from "express";
import { WebSocketServer, WebSocket } from "ws";
import type { PromptRequest, AnswerUiRequest, ServerEvent } from "@pines/shared";
import { Forest } from "./forest.js";

export function createServer(forest: Forest): http.Server {
  const app = express();
  app.use(express.json({ limit: "5mb" }));

  app.get("/api/forest", (_req, res) => {
    res.json(forest.list());
  });

  app.get("/api/tree/:id", (req, res) => {
    const d = forest.detail(req.params.id);
    if (!d) return void res.status(404).json({ error: "tree not found" });
    res.json(d);
  });

  app.get("/api/tree/:id/node/:nodeId", (req, res) => {
    const n = forest.nodeDetail(req.params.id, req.params.nodeId);
    if (!n) return void res.status(404).json({ error: "node not found" });
    res.json(n);
  });

  app.post("/api/tree/:id/prompt", (req, res) => {
    const tree = forest.find(req.params.id);
    if (!tree) return void res.status(404).json({ error: "tree not found" });
    const body = req.body as PromptRequest;
    if (!body?.message?.trim()) {
      return void res.status(400).json({ error: "message required" });
    }
    forest
      .runnerFor(tree)
      .prompt(body.message, body.fromNodeId)
      .then(() => res.json({ ok: true }))
      .catch((e: Error) => res.status(500).json({ error: e.message }));
  });

  app.post("/api/tree/:id/abort", (req, res) => {
    const tree = forest.find(req.params.id);
    if (!tree) return void res.status(404).json({ error: "tree not found" });
    forest
      .runnerFor(tree)
      .abort()
      .then(() => res.json({ ok: true }))
      .catch((e: Error) => res.status(500).json({ error: e.message }));
  });

  app.post("/api/tree/:id/answer", (req, res) => {
    const tree = forest.find(req.params.id);
    if (!tree) return void res.status(404).json({ error: "tree not found" });
    try {
      forest.runnerFor(tree).answerUi(req.body as AnswerUiRequest);
      res.json({ ok: true });
    } catch (e) {
      res.status(500).json({ error: (e as Error).message });
    }
  });

  app.post("/api/tree/:id/fork", (req, res) => {
    const tree = forest.find(req.params.id);
    if (!tree) return void res.status(404).json({ error: "tree not found" });
    const nodeId = (req.body as { nodeId?: string })?.nodeId;
    if (!nodeId) return void res.status(400).json({ error: "nodeId required" });
    forest
      .runnerFor(tree)
      .fork(nodeId)
      .then((newPath) => res.json({ ok: true, sessionPath: newPath }))
      .catch((e: Error) => res.status(500).json({ error: e.message }));
  });

  // Serve the built UI when available.
  const here = path.dirname(fileURLToPath(import.meta.url));
  const uiDist = path.resolve(here, "../../ui/dist");
  if (existsSync(uiDist)) {
    app.use(express.static(uiDist));
    app.get(/^\/(?!api|ws).*/, (_req, res) => {
      res.sendFile(path.join(uiDist, "index.html"));
    });
  }

  const server = http.createServer(app);
  const wss = new WebSocketServer({ server, path: "/ws" });

  const send = (ws: WebSocket, ev: ServerEvent) => {
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(ev));
  };

  wss.on("connection", (ws) => {
    send(ws, { event: "forest", trees: forest.list() });
  });

  forest.on("broadcast", (ev: ServerEvent) => {
    for (const ws of wss.clients) send(ws, ev);
  });

  return server;
}
