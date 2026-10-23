// Lazy Live2D runtime. The Cubism 4 plugin throws at import time unless
// Live2DCubismCore is already on window, and Cubism Core is proprietary
// (Live2D Proprietary Software License) so it can't be bundled: load it from
// `coreUrl` first (unless the host page already did), then import the plugin.

import * as PIXI from "pixi.js";
import { absUrl as abs } from "./files";
import { loadFrom } from "./hosts";
import { fetchBuffer, fetchJson } from "./net";

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
    s.onerror = () => {
      s.remove();
      reject(new Error(`could not load Cubism Core from ${src}`));
    };
    document.head.appendChild(s);
  });
}

// from the URL's host, or its fallback when the host fails or stalls
const SCRIPT_TIMEOUT = 20_000;
const loadCore = (url: string) => loadFrom(url, loadScript, { timeoutMs: SCRIPT_TIMEOUT });

// JSON fetched ahead for a model being loaded (its motions, facials and
// physics, whose URLs are known before the model3 is): the library's loader
// takes them from here instead of downloading them after the moc.
// Counted: two costumes of one character share their motion library.
const ahead = new Map<string, { p: Promise<unknown>; owners: number }>();

/** Per attempt for a moc or a texture (a few MB): the XHR / image loads they replace had no limit. */
export const BIG_FILE_TIMEOUT = 60_000;

/** Start fetching these JSON files now; the returned function forgets them (once all their owners did). */
export function fetchAhead(urls: string[]): () => void {
  const mine = [...new Set(urls.map(abs))];
  for (const u of mine) {
    const e = ahead.get(u);
    if (e) e.owners++;
    else {
      const p = fetchJson(u);
      p.catch(() => {}); // a failure is the loader's to report
      ahead.set(u, { p, owners: 1 });
    }
  }
  let released = false;
  return () => {
    if (released) return;
    released = true;
    for (const u of mine) {
      const e = ahead.get(u);
      if (e && --e.owners <= 0) ahead.delete(u);
    }
  };
}

/** A file fetchAhead() is loading, or a fresh fetch. */
export function aheadJson<T>(url: string): Promise<T> {
  return (ahead.get(abs(url))?.p as Promise<T> | undefined) ?? fetchJson<T>(url);
}

export function getLive2D(): Promise<Live2DModule> {
  return (loading ??= (async () => {
    if (!(window as any).Live2DCubismCore) await loadCore(coreUrl);
    const mod = await import("@sekai-world/pixi-live2d-display-mulmotion/cubism4");
    mod.Live2DModel.registerTicker(PIXI.Ticker);
    // in place of the XHR loader: JSON from what fetchAhead() has, then JSON
    // and the moc through net.ts (handed-in files, the load count, retries)
    mod.Live2DLoader.middlewares.unshift(async (context: any, next: () => Promise<void>) => {
      const url = abs(context.settings ? context.settings.resolveURL(context.url) : context.url);
      if (context.type === "json") {
        const p = ahead.get(url)?.p;
        context.result = await (p ? p.catch(() => fetchJson(url)) : fetchJson(url));
      } else if (context.type === "arraybuffer") context.result = await fetchBuffer(url, { timeoutMs: BIG_FILE_TIMEOUT });
      else return next();
    });
    return mod;
  })().catch((e) => {
    loading = undefined; // allow a retry (e.g. after setCubismCoreUrl)
    throw e;
  }));
}
