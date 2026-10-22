// Where every file the player loads comes from. The default resolver maps
// everything under one base URL (the layout documented in docs/assets.md and
// served by tools/asset-server); any entry can be overridden.

import type { ScenarioSceneData } from "./types";

/**
 * One costume's model files. The default resolver reads the four documented
 * fields; a host with its own `model` / `motion` / `physics` rules can put
 * whatever its rules need in the entry.
 */
export interface ModelManifestEntry {
  modelDir?: string; // e.g. "models/v1/main/10_an/10an_normal" (relative to the asset base)
  modelFile?: string; // e.g. "10an_normal_3.0_t05.model3"
  motionDir?: string; // e.g. "v1/main/10_an"
  motionBase?: string; // e.g. "10an_motion_base"
  [key: string]: unknown;
}
// CostumeType → model files
export type ModelManifest = Record<string, ModelManifestEntry>;

/**
 * Candidate URLs, tried in order until one loads. A single string is one
 * candidate; `null` or `[]` means the asset doesn't exist and is skipped.
 */
export type AssetUrls = string | readonly string[] | null;

/** The episode being loaded: handed to every per-episode resolver call. */
export interface LoadContext {
  scenario: ScenarioSceneData;
  /** Whatever the host passed as `load(…, { context })`. */
  data?: unknown;
}

export interface AssetResolver {
  /** Scenario JSON, used by `player.load("<ScenarioId>")`. */
  scenario(id: string): string;
  /** CostumeType → model manifest (used when no `models` option is given). */
  modelManifest(): string;
  /** The costume's .model3 settings file; textures/physics resolve relative to it. */
  model(entry: ModelManifestEntry, ctx: LoadContext): string;
  /**
   * The physics file to use instead of the model3's own reference, relative to
   * the model3 or absolute; `null` drops physics. Omit to keep the reference.
   */
  physics?(entry: ModelManifestEntry, ctx: LoadContext): string | null | undefined;
  /** A motion3 clip of the costume (`kind` = body motion or facial); `null` = the costume has none. */
  motion(entry: ModelManifestEntry, kind: "motion" | "facial", name: string, ctx: LoadContext): string | null;
  bgm(id: string, ctx: LoadContext): AssetUrls;
  se(id: string, ctx: LoadContext): AssetUrls;
  voice(scenarioId: string, voiceId: string, ctx: LoadContext): AssetUrls;
  background(id: string, ctx: LoadContext): AssetUrls;
  movie(name: string, ctx: LoadContext): string | null;
  /** Particle effects converted by tools/fx_convert.py: `<name>/effect.json`, `bg/index.json`, textures. */
  fx(path: string): string;
  /** Game UI sprites (menu, dialogue marks, talk-log icons …). */
  ui(path: string): string;
  /** Font files (DEFAULT_FONTS: SourceHanSansJP-Bold.otf / -Medium.otf). */
  font(file: string): string;
}

const enc = encodeURIComponent;

export function createAssetResolver(base: string, overrides: Partial<AssetResolver> = {}): AssetResolver {
  const b = base.endsWith("/") ? base : base + "/";
  return {
    scenario: (id) => `${b}scenario/${enc(id)}.json`,
    modelManifest: () => `${b}model_manifest.json`,
    model: (m) => `${b}${m.modelDir}/${m.modelFile}`,
    motion: (m, kind, name) => `${b}motions/${m.motionDir}/${m.motionBase}/${kind}/${name}.motion3.json`,
    bgm: (id) => `${b}sound/bgm/${enc(id)}.mp3`,
    se: (id) => `${b}sound/se/${enc(id)}.mp3`,
    voice: (scenarioId, voiceId) => `${b}sound/voice/${enc(scenarioId)}/${enc(voiceId)}.mp3`,
    background: (id) => `${b}background/${enc(id)}.png`,
    movie: (name) => `${b}movie/${enc(name)}.mp4`,
    fx: (p) => `${b}fx/${p}`,
    ui: (p) => `${b}ui/${p}`,
    font: (f) => `${b}fonts/${f}`,
    ...overrides,
  };
}

const list = (u: AssetUrls): string[] => (u == null ? [] : typeof u === "string" ? [u] : [...u]);

/** The resolver as the engine uses it within one episode: context bound, candidates as arrays. */
export interface EpisodeAssets {
  model(entry: ModelManifestEntry): string;
  physics(entry: ModelManifestEntry): string | null | undefined;
  motion(entry: ModelManifestEntry, kind: "motion" | "facial", name: string): string | null;
  bgm(id: string): string[];
  se(id: string): string[];
  voice(scenarioId: string, voiceId: string): string[];
  background(id: string): string[];
  movie(name: string): string | null;
  fx(path: string): string;
  ui(path: string): string;
}

export function bindAssets(r: AssetResolver, ctx: LoadContext): EpisodeAssets {
  return {
    model: (m) => r.model(m, ctx),
    physics: (m) => r.physics?.(m, ctx),
    motion: (m, kind, name) => r.motion(m, kind, name, ctx),
    bgm: (id) => list(r.bgm(id, ctx)),
    se: (id) => list(r.se(id, ctx)),
    voice: (s, v) => list(r.voice(s, v, ctx)),
    background: (id) => list(r.background(id, ctx)),
    movie: (name) => r.movie(name, ctx),
    fx: (p) => r.fx(p),
    ui: (p) => r.ui(p),
  };
}
