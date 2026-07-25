import { useEffect, useRef } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";

/**
 * xterm.js view attached to a daemon-side PTY running the pi TUI.
 * Closing this pane only detaches the socket — the PTY (and pi) keep
 * running in the daemon; reattaching replays the scrollback buffer.
 */
export function TerminalPane({
  treeId,
  onExit,
}: {
  treeId: string;
  onExit: () => void;
}) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const onExitRef = useRef(onExit);
  onExitRef.current = onExit;

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const term = new Terminal({
      fontFamily: 'ui-monospace, "SF Mono", "Cascadia Code", Menlo, monospace',
      fontSize: 12.5,
      cursorBlink: true,
      allowProposedApi: true,
      theme: {
        background: "#0b0e14",
        foreground: "#dce3ea",
        cursor: "#3fb950",
        selectionBackground: "rgba(88, 166, 255, 0.3)",
        black: "#161d27",
        red: "#f85149",
        green: "#3fb950",
        yellow: "#d29922",
        blue: "#58a6ff",
        magenta: "#a371f7",
        cyan: "#39c5cf",
        white: "#dce3ea",
        brightBlack: "#7d8896",
      },
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(host);
    fit.fit();
    term.focus();

    const proto = location.protocol === "https:" ? "wss" : "ws";
    const ws = new WebSocket(`${proto}://${location.host}/ws/term/${encodeURIComponent(treeId)}`);
    let closedByServer = false;

    ws.onopen = () => {
      ws.send(JSON.stringify({ type: "resize", cols: term.cols, rows: term.rows }));
    };
    ws.onmessage = (m) => {
      try {
        const msg = JSON.parse(m.data as string) as { type: string; data?: string; code?: number };
        if (msg.type === "output" && msg.data) term.write(msg.data);
        else if (msg.type === "exit") {
          closedByServer = true;
          term.write(`\r\n\x1b[90m[process exited (${msg.code})]\x1b[0m\r\n`);
          onExitRef.current();
        }
      } catch {}
    };
    ws.onclose = () => {
      if (!closedByServer) term.write("\r\n\x1b[90m[detached]\x1b[0m\r\n");
    };

    const dataSub = term.onData((data) => {
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: "input", data }));
    });
    const resizeSub = term.onResize(({ cols, rows }) => {
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: "resize", cols, rows }));
    });
    const ro = new ResizeObserver(() => fit.fit());
    ro.observe(host);

    return () => {
      ro.disconnect();
      dataSub.dispose();
      resizeSub.dispose();
      ws.close();
      term.dispose();
    };
  }, [treeId]);

  return <div className="termpane" ref={hostRef} />;
}
