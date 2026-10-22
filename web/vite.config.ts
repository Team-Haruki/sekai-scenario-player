import { fileURLToPath, URL } from "node:url";
import tailwindcss from "@tailwindcss/vite";
import vue from "@vitejs/plugin-vue";
import { defineConfig } from "vite";
import { sekaiAssets } from "../server/vite-plugin.ts";

const r = (p: string) => fileURLToPath(new URL(p, import.meta.url));

// Preview site. In dev, /assets/ serves the staged ./assets folder and, with
// SEKAI_ASSET_ROOT / SEKAI_MASTER_DIR set, a whole local asset tree.
export default defineConfig({
  root: r("."),
  base: "./",
  plugins: [vue(), tailwindcss(), sekaiAssets({ staged: r("../assets") })],
  resolve: {
    alias: {
      "@": r("./src"),
      "pjsk-scenario-player": r("../src/index.ts"),
    },
  },
  build: {
    outDir: r("../dist/site"),
    emptyOutDir: true,
    rollupOptions: {
      output: { manualChunks: (id) => (/node_modules\/(pixi\.js|@pixi)\//.test(id) ? "pixi" : undefined) },
    },
  },
});
