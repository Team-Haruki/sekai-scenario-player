// Standalone asset server with CORS, so a hosted copy of the preview site (or
// any app embedding the player) can play from your local asset tree.
//
//   node server/cli.ts --root /path/to/jp-assets --master /path/to/master [--staged assets] [--port 5174]
//
// Options fall back to SEKAI_ASSET_ROOT / SEKAI_MASTER_DIR / SEKAI_STAGED_DIR / PORT.
// Then point the player (or the preview site's settings) at http://localhost:5174/.

import http from "node:http";
import { parseArgs } from "node:util";
import { assetHandler } from "./asset-tree.ts";

const { values } = parseArgs({
  options: {
    root: { type: "string" },
    master: { type: "string" },
    staged: { type: "string" },
    port: { type: "string" },
    host: { type: "string" },
    origin: { type: "string" }, // Access-Control-Allow-Origin (default *)
  },
});
const root = values.root ?? process.env.SEKAI_ASSET_ROOT;
const master = values.master ?? process.env.SEKAI_MASTER_DIR;
const staged = values.staged ?? process.env.SEKAI_STAGED_DIR;
const port = Number(values.port ?? process.env.PORT ?? 5174);
const host = values.host ?? "127.0.0.1";
if (!root && !staged) {
  console.error("usage: node server/cli.ts --root <asset tree> [--master <master dir>] [--staged <dir>] [--port 5174]");
  process.exit(1);
}

const handle = assetHandler({ root, master, staged });
http
  .createServer((req, res) => {
    res.setHeader("Access-Control-Allow-Origin", values.origin ?? "*");
    res.setHeader("Access-Control-Allow-Headers", "Range");
    res.setHeader("Access-Control-Expose-Headers", "Content-Length, Content-Range, Accept-Ranges");
    // a page served over https may reach a localhost server (Chrome Private Network Access)
    res.setHeader("Access-Control-Allow-Private-Network", "true");
    if (req.method === "OPTIONS") return void res.writeHead(204).end();
    if (req.method !== "GET" && req.method !== "HEAD") return void res.writeHead(405).end();
    handle(req, res, () => res.writeHead(404).end());
  })
  .listen(port, host, () => {
    console.log(`pjsk asset server: http://${host === "0.0.0.0" ? "localhost" : host}:${port}/`);
    if (root) console.log(`  tree   ${root}`);
    if (master) console.log(`  master ${master}`);
    if (staged) console.log(`  staged ${staged}`);
  });
