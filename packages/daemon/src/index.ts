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

const port = Number(process.env.PINES_PORT ?? 7314);
const sessionDir = defaultSessionDir();
const piBin = defaultPiBin();

const indexer = new SessionIndexer(sessionDir);
const forest = new Forest(indexer, { piBin });

await indexer.start();
const server = createServer(forest);
server.listen(port, () => {
  console.log(`pinesd listening on http://localhost:${port}`);
  console.log(`  session dir: ${sessionDir}`);
  console.log(`  pi binary:   ${piBin}`);
  console.log(`  trees:       ${indexer.trees.size}`);
});

async function shutdown(): Promise<void> {
  console.log("pinesd shutting down…");
  await forest.shutdown();
  server.close();
  process.exit(0);
}
process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());
