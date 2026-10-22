// Dev-server plugin: serves the asset layout under /assets/ from the staged
// folder (./assets) and, when SEKAI_ASSET_ROOT is set, straight from a
// local asset-updater export tree — see server/asset-tree.ts.
//
//   SEKAI_ASSET_ROOT=/path/to/jp-assets SEKAI_MASTER_DIR=/path/to/master npm run dev

import path from "node:path";
import type { Plugin } from "vite";
import { assetHandler } from "./asset-tree.ts";

export function sekaiAssets(opts: { staged: string; mount?: string }): Plugin {
  const mount = opts.mount ?? "/assets";
  return {
    name: "sekai-assets",
    apply: "serve",
    configureServer(server) {
      const root = process.env.SEKAI_ASSET_ROOT;
      const handle = assetHandler({ root, master: process.env.SEKAI_MASTER_DIR, staged: path.resolve(opts.staged) });
      server.middlewares.use(mount, (req, res, next) => handle(req, res, next));
      if (root) server.config.logger.info(`  sekai-assets: serving ${mount}/ from ${root}`);
    },
  };
}
