#!/usr/bin/env node
/**
 * pinesd — the pines daemon.
 *
 * Watches the pi session directory, exposes the forest over HTTP/WS, and
 * runs `pi --mode rpc` children for trees you interact with.
 *
 * Env:
 *   PINES_PORT         listen port (default 7314)
 *   PINES_SESSION_DIR  pi session dir (default ~/.pi/agent/sessions)
 *   PINES_PI_BIN       pi binary (default "pi"; point at mock-pi for dev)
 */

import { SessionIndexer } from "./indexer.js";
import { Forest } from "./forest.js";
import { createServer } from "./server.js";
import { defaultPiBin, defaultSessionDir } from "./runner.js";
import { PositionStore, defaultDataDir } from "./positions.js";
import { resolveExecutable } from "./exec.js";

const port = Number(process.env.PINES_PORT ?? 7314);
const sessionDir = defaultSessionDir();
const piBin = defaultPiBin();
const dataDir = defaultDataDir();

const indexer = new SessionIndexer(sessionDir);
const positions = new PositionStore(dataDir);
const forest = new Forest(indexer, { piBin }, positions, {
  piBin,
  termCmd: process.env.PINES_TERM_CMD,
});

await indexer.start();
const server = createServer(forest);
server.listen(port, () => {
  console.log(`pinesd listening on http://localhost:${port}`);
  console.log(`  session dir: ${sessionDir}`);
  console.log(`  data dir:    ${dataDir}`);
  console.log(`  pi binary:   ${piBin}${resolveExecutable(piBin) ? "" : "  ⚠ NOT FOUND"}`);
  console.log(`  trees:       ${indexer.trees.size}`);
  if (!resolveExecutable(piBin)) {
    console.warn(
      `⚠ "${piBin}" is not on pinesd's PATH. Agents won't start until you install pi\n` +
        `  or set PINES_PI_BIN to its full path (run: which pi).`,
    );
  }
});

async function shutdown(): Promise<void> {
  console.log("pinesd shutting down…");
  await forest.shutdown();
  await positions.save();
  server.close();
  process.exit(0);
}
process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());
