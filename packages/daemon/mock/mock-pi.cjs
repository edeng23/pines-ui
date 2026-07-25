#!/usr/bin/env node
/**
 * mock-pi: a minimal stand-in for `pi --mode rpc` used for pines
 * development and tests (no API keys needed).
 *
 * Speaks the same LF-delimited JSONL protocol on stdin/stdout, appends
 * v3 entries to the session file like the real pi, and emits the same
 * lifecycle events (agent_start, message_update deltas, agent_settled…).
 *
 * Behaviors for exercising the UI:
 *   - prompt containing "ask me"  -> emits an extension_ui_request (select)
 *   - prompt containing "fail"    -> streams an error delta
 *   - otherwise                   -> streams a canned reply word by word
 *
 * Usage: mock-pi.cjs --mode rpc --session <path> [--delay <ms-per-word>]
 */

const fs = require("node:fs");
const crypto = require("node:crypto");
const readline = require("node:readline");

function arg(name, dflt) {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : dflt;
}

const sessionPath = arg("--session");
const wordDelay = Number(arg("--delay", process.env.MOCK_PI_DELAY || "80"));
if (!sessionPath) {
  process.stderr.write("mock-pi: --session <path> required\n");
  process.exit(2);
}

const out = (obj) => process.stdout.write(JSON.stringify(obj) + "\n");

// ---- session file handling ----
let leafId = null;
const ids = new Set();

function loadSession() {
  if (!fs.existsSync(sessionPath)) {
    const header = {
      type: "session",
      version: 3,
      id: crypto.randomUUID(),
      timestamp: new Date().toISOString(),
      cwd: process.cwd(),
    };
    fs.writeFileSync(sessionPath, JSON.stringify(header) + "\n");
    return;
  }
  const lines = fs.readFileSync(sessionPath, "utf8").split("\n");
  for (const line of lines) {
    if (!line.trim()) continue;
    try {
      const e = JSON.parse(line);
      if (e.type === "session") continue;
      if (e.id) {
        ids.add(e.id);
        leafId = e.id;
      }
    } catch {}
  }
}

function newId() {
  for (;;) {
    const id = crypto.randomBytes(4).toString("hex");
    if (!ids.has(id)) {
      ids.add(id);
      return id;
    }
  }
}

function appendEntry(entry) {
  fs.appendFileSync(sessionPath, JSON.stringify(entry) + "\n");
  leafId = entry.id;
  return entry;
}

function appendMessage(message) {
  return appendEntry({
    type: "message",
    id: newId(),
    parentId: leafId,
    timestamp: new Date().toISOString(),
    message,
  });
}

loadSession();

// ---- agent simulation ----
let streaming = false;
let abortRequested = false;
let pendingUi = null;

const CANNED =
  "Understood. I inspected the repository, made a plan, and applied the change you asked for. " +
  "The tests pass locally and the diff is small and focused.";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function runTurn(promptText) {
  streaming = true;
  abortRequested = false;
  appendMessage({ role: "user", content: promptText, timestamp: Date.now() });
  out({ type: "agent_start" });
  out({ type: "turn_start" });

  if (promptText.includes("ask me")) {
    pendingUi = {
      type: "extension_ui_request",
      id: crypto.randomUUID(),
      method: "select",
      title: "mock-pi needs a decision",
      options: ["Option A", "Option B"],
    };
    out(pendingUi);
    return; // stay "streaming" until answered
  }

  const failing = promptText.includes("fail");
  const words = CANNED.split(" ");
  let text = "";
  for (const w of words) {
    if (abortRequested) break;
    text += (text ? " " : "") + w;
    out({
      type: "message_update",
      assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: (text === w ? "" : " ") + w },
    });
    await sleep(wordDelay);
  }
  if (failing && !abortRequested) {
    out({ type: "message_update", assistantMessageEvent: { type: "error", error: "mock failure" } });
  }
  finishTurn(text, failing ? "error" : abortRequested ? "aborted" : "stop");
}

function finishTurn(text, stopReason) {
  const msg = {
    role: "assistant",
    content: [{ type: "text", text }],
    provider: "mock",
    model: "mock-1",
    stopReason,
    timestamp: Date.now(),
  };
  appendMessage(msg);
  out({ type: "turn_end", message: msg, toolResults: [] });
  out({ type: "agent_end", messages: [msg], willRetry: false });
  streaming = false;
  out({ type: "agent_settled" });
}

// ---- rpc loop ----
const rl = readline.createInterface({ input: process.stdin, terminal: false });
rl.on("close", () => process.exit(0));
rl.on("line", (line) => {
  if (!line.trim()) return;
  let req;
  try {
    req = JSON.parse(line);
  } catch {
    return;
  }
  const respond = (extra) =>
    out({ id: req.id, type: "response", command: req.type, success: true, ...extra });

  switch (req.type) {
    case "prompt":
      respond();
      runTurn(String(req.message ?? ""));
      break;
    case "abort":
      abortRequested = true;
      if (pendingUi) {
        pendingUi = null;
        finishTurn("(aborted)", "aborted");
      }
      respond();
      break;
    case "get_state":
      respond({
        data: {
          isStreaming: streaming,
          sessionFile: sessionPath,
          sessionId: "mock",
          model: { provider: "mock", id: "mock-1" },
        },
      });
      break;
    case "extension_ui_response":
      if (pendingUi && req.id === pendingUi.id) {
        const choice = req.cancelled ? "(cancelled)" : String(req.value ?? "");
        pendingUi = null;
        (async () => {
          out({
            type: "message_update",
            assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: `You chose: ${choice}.` },
          });
          await sleep(wordDelay);
          finishTurn(`You chose: ${choice}.`, "stop");
        })();
      }
      // pi responds to the ui request event implicitly; no rpc response line
      break;
    case "fork": {
      const entryId = req.entryId;
      const lines = fs.readFileSync(sessionPath, "utf8").split("\n").filter(Boolean);
      const entries = lines.map((l) => JSON.parse(l));
      const byId = new Map(entries.filter((e) => e.id).map((e) => [e.id, e]));
      if (!byId.has(entryId)) {
        out({ id: req.id, type: "response", command: "fork", success: false, error: "entry not found" });
        break;
      }
      const path_ = [];
      let cur = byId.get(entryId);
      while (cur) {
        path_.unshift(cur);
        cur = cur.parentId ? byId.get(cur.parentId) : null;
      }
      const newPath = sessionPath.replace(/\.jsonl$/, `-fork-${Date.now()}.jsonl`);
      const header = {
        type: "session",
        version: 3,
        id: crypto.randomUUID(),
        timestamp: new Date().toISOString(),
        cwd: process.cwd(),
        parentSession: sessionPath,
      };
      fs.writeFileSync(
        newPath,
        [header, ...path_].map((e) => JSON.stringify(e)).join("\n") + "\n",
      );
      respond({ data: { sessionPath: newPath } });
      break;
    }
    default:
      respond();
  }
});
