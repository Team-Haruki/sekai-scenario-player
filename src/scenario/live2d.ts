// Lazy Live2D runtime. The Cubism 4 plugin throws at import time unless
// Live2DCubismCore is already on window, and Cubism Core is proprietary
// (Live2D Proprietary Software License) so it can't be bundled: load it from
// `coreUrl` first (unless the host page already did), then import the plugin.

import * as PIXI from "pixi.js";

export const DEFAULT_CUBISM_CORE_URL = "https://cubism.live2d.com/sdk-web/cubismcore/live2dcubismcore.min.js";

type Live2DModule = typeof import("@sekai-world/pixi-live2d-display-mulmotion/cubism4");

let coreUrl = DEFAULT_CUBISM_CORE_URL;
let loading: Promise<Live2DModule> | undefined;

export function setCubismCoreUrl(url: string) {
  coreUrl = url;
}

function loadScript(src: string) {
  return new Promise<void>((resolve, reject) => {
    const s = document.createElement("script");
    s.src = src;
    s.onload = () => resolve();
    s.onerror = () => reject(new Error(`could not load Cubism Core from ${src}`));
    document.head.appendChild(s);
  });
}

export function getLive2D(): Promise<Live2DModule> {
  return (loading ??= (async () => {
    if (!(window as any).Live2DCubismCore) await loadScript(coreUrl);
    const mod = await import("@sekai-world/pixi-live2d-display-mulmotion/cubism4");
    mod.Live2DModel.registerTicker(PIXI.Ticker);
    return mod;
  })().catch((e) => {
    loading = undefined; // allow a retry (e.g. after setCubismCoreUrl)
    throw e;
  }));
}
