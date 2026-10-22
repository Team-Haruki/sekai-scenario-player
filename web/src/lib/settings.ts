import { useStorage } from "@vueuse/core";
import type { Locale } from "pjsk-scenario-player";

export interface Settings {
  /** asset base URL ("" = none configured) */
  assets: string;
  locale: Locale;
  autoplay: boolean;
}

// In dev the Vite server mounts the local assets at /assets/; a deployed copy
// starts without a source until the visitor points it at one.
const DEFAULT_ASSETS = import.meta.env.DEV ? "/assets/" : "";

export const settings = useStorage<Settings>(
  "pjsk:settings",
  { assets: DEFAULT_ASSETS, locale: "zh", autoplay: true },
  localStorage,
  { mergeDefaults: true },
);

// ?assets=<url> overrides (and remembers) the source, so a link can carry it
const fromUrl = new URLSearchParams(location.search).get("assets");
if (fromUrl != null) settings.value.assets = fromUrl;

export const LOCAL_SERVER = "http://localhost:5174/";

export function normalizeBase(url: string) {
  const u = url.trim();
  return !u || u.endsWith("/") ? u : u + "/";
}
