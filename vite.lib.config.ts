import { defineConfig } from "vite";

// Library build: dist/lib/pjsk-scenario-player.js (ESM). pixi.js stays a peer
// so the host app shares one copy; the Live2D plugin is bundled (and split
// into its own chunk, loaded once Cubism Core is on the page).
export default defineConfig({
  build: {
    outDir: "dist/lib",
    emptyOutDir: true,
    sourcemap: true,
    lib: { entry: "src/index.ts", formats: ["es"], fileName: () => "pjsk-scenario-player.js" },
    rollupOptions: { external: ["pixi.js", /^@pixi\//] },
  },
});
