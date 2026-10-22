// pjsk-scenario-player — public API.

export { DEFAULT_FONTS, PjskPlayer } from "./PjskPlayer";
export type { PlayerEvents, PlayerModes, PlayerOptions, TextScript } from "./PjskPlayer";
export { DEFAULT_MENU, GAME_MENU } from "./scenario/menu";
export type { MenuItem } from "./scenario/menu";
export { createAssetResolver } from "./scenario/resolver";
export type { AssetResolver, AssetUrls, LoadContext, ModelManifest, ModelManifestEntry } from "./scenario/resolver";
export { scriptLines } from "./scenario/script";
export type { ScriptLine } from "./scenario/script";
export { LABELS } from "./scenario/labels";
export type { Locale, MenuLabels, PlayerLabels } from "./scenario/labels";
export { DEFAULT_CUBISM_CORE_URL } from "./scenario/live2d";
export * from "./scenario/types";

import { PjskPlayer, type PlayerOptions } from "./PjskPlayer";

/** Mount a player into `container` (an element or a selector). */
export function createPlayer(container: HTMLElement | string, options: PlayerOptions): PjskPlayer {
  const el = typeof container === "string" ? document.querySelector<HTMLElement>(container) : container;
  if (!el) throw new Error(`createPlayer: no element ${container}`);
  return new PjskPlayer(el, options);
}
