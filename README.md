# 🌲 pines

**Tree-first orchestration for [pi](https://github.com/badlogic/pi-mono) coding agents** (pi + trees).

The conversation tree is the primary navigation surface, not a sidebar. Each pi session is a tree; branch from any node with the context reached at that point; navigate away and the agent **keeps running in the background**, showing its live status in the forest.

See [DESIGN.md](./DESIGN.md) for the research-backed architecture (how superset does backgrounding, what pi gives us natively, semantic forest layout, grafting).

## Status — M2 "Forest"

- ✅ `pinesd` daemon: watches `~/.pi/agent/sessions`, parses pi's v3 tree JSONL incrementally, spawns one `pi --mode rpc` child per active tree
- ✅ Live status per tree, derived from pi's RPC events: `running` · `waiting (needs input)` · `idle` · `error` · `dormant`
- ✅ Tree view: SVG DAG of every node, active path highlighted, click any node to inspect the transcript up to that point
- ✅ **Continue from any node** — grows a new branch in place (pi-native tree, single session file)
- ✅ **Fork to a new tree** from any node (pi `fork`, lineage tracked via `parentSession`)
- ✅ Answer pi's interactive dialogs (select/confirm/input) from the UI while headless
- ✅ **Embedded terminal** (superset-style): open the real pi TUI for any tree in an xterm.js pane backed by a daemon-side PTY; detaching leaves pi running (⌨ marker in the forest) and reattaching replays scrollback — the git graph keeps updating live beside it
- ✅ Streaming assistant output over WebSocket; `Esc` returns to the forest without pausing anything
- ✅ **Forest canvas**: each tree drawn as its actual branch silhouette with a color-coded status ring (running trees pulse, waiting trees get a `?`); wheel zoom + drag pan; hover cards; dotted lineage edges between forks and their parents
- ✅ Stable positions: phyllotaxis-spiral placement persisted to `~/.pines/positions.json`; forks land next to their parent tree (M3 upgrades placement to embedding-kNN)
- ✅ **Search** (`/`): token search across all node text in all trees, spotlight-dims the forest, jump straight to the matching node in its tree
- ✅ Keyboard nav in a tree: `←` parent · `→` child (prefers the active path) · `↑`/`↓` siblings · `Esc` back to forest
- 🔜 M3 semantic layout (embeddings + kNN placement + semantic search) · M4 grafts (see DESIGN.md §7)

## Quickstart

```bash
npm install
npm run build

# with real pi (npm i -g @earendil-works/pi-coding-agent, configured with API keys):
node packages/daemon/dist/index.js

# open http://localhost:7314
```

Environment:

| var | default | |
|---|---|---|
| `PINES_PORT` | `7314` | HTTP/WS port |
| `PINES_SESSION_DIR` | `~/.pi/agent/sessions` | pi's session storage |
| `PINES_PI_BIN` | `pi` | pi binary to spawn |
| `PINES_TERM_CMD` | `<pi> --session {session}` | command for embedded terminals |

### Try it without API keys

A mock pi (same RPC wire protocol, same session file format) is included:

```bash
PINES_SESSION_DIR=/tmp/pines-demo PINES_PI_BIN=$PWD/packages/daemon/mock/mock-pi.cjs \
  node packages/daemon/dist/index.js
```

Prompts containing `ask me` make the mock raise an interactive question (→ `waiting` status); `fail` makes it error.

### Troubleshooting

**`posix_spawnp failed` / agents stuck on `error`** — pinesd can't find the
`pi` executable. This usually means pi lives in a PATH set up by your shell
profile (nvm, volta, homebrew) that the daemon didn't inherit. Fix with:

```bash
PINES_PI_BIN="$(which pi)" node packages/daemon/dist/index.js
```

pinesd warns at startup when the configured binary can't be resolved.
Embedded terminals additionally fall back to running the command through
your login shell (`$SHELL -lc`), so they pick up your profile's PATH even
when the daemon didn't.

### Development

```bash
npm run dev             # daemon via tsx
npm run dev -w @pines/ui  # vite dev server on :5173, proxies to :7314
npm test                # parser + runner tests (uses mock-pi)
```

## Layout

```
packages/shared   pi session/RPC protocol types + pines API types
packages/daemon   pinesd: indexer, pi RPC runner, HTTP/WS server, mock-pi
packages/ui       React UI: forest list, SVG tree view, transcript, composer
```
