// Where every file the player loads comes from. The default resolver maps
// everything under one base URL (the layout documented in docs/assets.md and
// served by tools/asset-server); any entry can be overridden.

export interface ModelManifestEntry {
  modelDir: string; // e.g. "models/v1/main/10_an/10an_normal" (relative to the asset base)
  modelFile: string; // e.g. "10an_normal_3.0_t05.model3"
  motionDir: string; // e.g. "v1/main/10_an"
  motionBase: string; // e.g. "10an_motion_base"
  charFolder?: string;
}
// CostumeType → model files
export type ModelManifest = Record<string, ModelManifestEntry>;

export interface AssetResolver {
  /** Scenario JSON, used by `player.load("<ScenarioId>")`. */
  scenario(id: string): string;
  /** CostumeType → model manifest (used when no `models` option is given). */
  modelManifest(): string;
  /** The costume's .model3 settings file; textures/physics resolve relative to it. */
  model(entry: ModelManifestEntry): string;
  /** A motion3 clip from the costume's motion library (`kind` = body motion or facial). */
  motion(entry: ModelManifestEntry, kind: "motion" | "facial", name: string): string;
  bgm(id: string): string;
  se(id: string): string;
  voice(scenarioId: string, voiceId: string): string;
  background(id: string): string;
  movie(name: string): string;
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
