// Lazy Live2D runtime. The Cubism 4 plugin throws at import time unless
// Live2DCubismCore is already on window, and Cubism Core is proprietary
// (Live2D Proprietary Software License) so it can't be bundled: load it from
// `coreUrl` first (unless the host page already did), then import the plugin.

import * as PIXI from "pixi.js";
import { fetchJson } from "./net";

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

// JSON fetched ahead for a model being loaded (its motions, facials and
// physics, whose URLs are known before the model3 is): the library's loader
// takes them from here instead of downloading them after the moc.
const ahead = new Map<string, Promise<unknown>>();
const abs = (url: string) => new URL(url, location.href).href; // the key, however the URL was written

/** Start fetching these JSON files now; the returned function forgets them. */
export function fetchAhead(urls: string[]): () => void {
  const mine = [...new Set(urls.map(abs))].filter((u) => !ahead.has(u));
  for (const u of mine) {
    const p = fetchJson(u);
    p.catch(() => {}); // a failure is the loader's to report
    ahead.set(u, p);
  }
  return () => {
    for (const u of mine) ahead.delete(u);
  };
}

/** A file fetchAhead() is loading, or a fresh fetch. */
export function aheadJson<T>(url: string): Promise<T> {
  return (ahead.get(abs(url)) as Promise<T> | undefined) ?? fetchJson<T>(url);
}

export function getLive2D(): Promise<Live2DModule> {
  return (loading ??= (async () => {
    if (!(window as any).Live2DCubismCore) await loadScript(coreUrl);
    const mod = await import("@sekai-world/pixi-live2d-display-mulmotion/cubism4");
    mod.Live2DModel.registerTicker(PIXI.Ticker);
    // before the XHR loader: serve what fetchAhead() has (and fall back to it on a failure)
    mod.Live2DLoader.middlewares.unshift((context: any, next: () => Promise<void>) => {
      const p = context.type === "json" && ahead.get(abs(context.settings ? context.settings.resolveURL(context.url) : context.url));
      if (!p) return next();
      return p.then(
        (data) => void (context.result = data),
        () => next(),
      );
    });
    return mod;
  })().catch((e) => {
    loading = undefined; // allow a retry (e.g. after setCubismCoreUrl)
    throw e;
  }));
}
