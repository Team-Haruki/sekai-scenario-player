// PjskPlayer — the embeddable player: one PIXI stage + the game's DOM chrome
// (talk window, effects, story menu, start overlay) mounted into a host
// element and scaled to fit it. Scenarios are loaded into it one at a time.

import * as PIXI from "pixi.js";

import css from "./style.css?inline";
import { buildMotionIndex } from "./scenario/assets";
import { AudioManager, type VolumeKind } from "./scenario/audio";
import { Clock } from "./scenario/clock";
import { DialogueBox } from "./scenario/dialogue";
import { Effects } from "./scenario/effects";
import { LABELS, Locale, MenuLabels, PlayerLabels } from "./scenario/labels";
import { getLive2D, setCubismCoreUrl } from "./scenario/live2d";
import { DEFAULT_MENU, type MenuItem, ScenarioMenu } from "./scenario/menu";
import { FxManager } from "./scenario/particles";
import { ScenarioPlayer } from "./scenario/player";
import { AssetResolver, ModelManifest, bindAssets, createAssetResolver } from "./scenario/resolver";
import { UiSprites } from "./scenario/sprites";
import { fetchJson } from "./scenario/net";
import { type FileCount, type FileEntries, absUrl, countFiles, provide, unprovide } from "./scenario/files";
import { fallbackOf, setFallback } from "./scenario/hosts";
import { Preload, type PreloadProgress, type PreloadResult, collectItems, scenarioText } from "./scenario/preload";
import { Stage } from "./scenario/stage";
import type { ScenarioSceneData } from "./scenario/types";

export interface PlayerOptions {
  /** Asset base URL (see docs/assets.md for the layout) or a full resolver. */
  assets: string | AssetResolver;
  /** CostumeType → model files. Default: fetched from `assets.modelManifest()`. */
  models?: ModelManifest | (() => Promise<ModelManifest>);
  /**
   * Start playing as soon as a scenario is loaded. `"auto"` (default) does so
   * when the browser allows sound without a click, otherwise it shows a start
   * button; `false` always shows the button.
   */
  autoplay?: boolean | "auto";
  /** Auto-advance lines (the menu's Auto (オート) toggle). Default true. */
  auto?: boolean;
  /** Language of the start overlay and story menu. Default "zh". */
  locale?: Locale;
  labels?: LabelOverrides;
  /**
   * The ⋯ story menu: `false` hides it, a list picks its buttons (GAME_MENU is
   * the game's own panel). Default DEFAULT_MENU: fullscreen, auto, mute, fast,
   * hide, log.
   */
  menu?: boolean | readonly MenuItem[];
  /** Start muted. Default false. */
  muted?: boolean;
  /** Listener volumes (0-1) for BGM, voices and SE; 1 each by default. */
  volumes?: Partial<Record<VolumeKind, number>>;
  /** Play the voices. Default true. */
  voice?: boolean;
  /** Script of the text being shown, for its fonts (see setTextScript). Default "ja". */
  textScript?: TextScript;
  /**
   * Talk window fonts: `name` (name plate, bold) and `body` (lines, medium)
   * URLs. Default: Source Han Sans JP Bold / Medium from `assets.font()`
   * (the files in this repo's fonts/). `false` leaves the CSS fallback stack.
   */
  fonts?: false | { name?: string; body?: string };
  /** Where to load Live2D Cubism Core from if the page hasn't loaded it. */
  cubismCoreUrl?: string;
  /** Canvas resolution. Default min(devicePixelRatio, 2). */
  resolution?: number;
  /**
   * Download every file a scenario uses before it plays (`load()` can
   * override it per scenario). The bar shows the download; files no host
   * gives are reported with a retry and a play-anyway button. Default false:
   * only the first costumes and voice are waited for, the rest streams.
   */
  preload?: boolean | PreloadOptions;
}

export interface PreloadOptions {
  /** Downloads at a time. Default 6. */
  concurrency?: number;
}

export type LabelOverrides = Partial<Omit<PlayerLabels, "menu">> & { menu?: Partial<MenuLabels> };

export interface PlayerEvents {
  /** A scenario was fetched and its stage built (models still loading). */
  load: { scenario: ScenarioSceneData };
  /**
   * A costume finished loading (or failed / timed out). Playback starts once
   * the `required` ones (on stage for the first lines) are in; the others keep
   * loading while it plays. `failed` lists the costumes that won't show.
   */
  loading: LoadingProgress;
  /** The first costumes are loaded; playback starts now. */
  play: { scenario: ScenarioSceneData };
  /** Snippet `index` of `total` started (also fired after a jump). */
  progress: { index: number; total: number };
  /** The scenario played to its end. */
  end: { scenario: ScenarioSceneData };
  error: { error: Error };
  /** A mode changed (from the menu, a tap or the API). */
  mode: PlayerModes;
  /** The menu's Log (ログ) button was pressed. */
  log: Record<string, never>;
  /** A preload (see `preload`) moved on: files done of those found so far, bytes received. */
  preload: PreloadProgress;
  /** A preload run finished: what loaded, what exists nowhere, what failed on every host. */
  preloaded: PreloadResult;
}
type Listener<K extends keyof PlayerEvents> = (e: PlayerEvents[K]) => void;

/** How far a scenario's loading has got (the `loading` event). */
export interface LoadingProgress {
  /** costumes settled (loaded, failed or timed out) of all the scenario's costumes */
  loaded: number;
  total: number;
  /** of those, the ones playback waits for (on stage for the first lines) */
  required: number;
  requiredLoaded: number;
  /** costumes that won't show */
  failed: string[];
  /**
   * Every file this load has asked for so far (the scenario, models, motions,
   * textures, the first voice …): `started` grows as loading finds more,
   * `bytes` counts what arrived, `provided` the files handed in (provideFiles).
   */
  files: FileCount;
}

/** The loading bar while the host drives it (setProgress): `loaded` of `total`, in files or bytes. */
export interface HostProgress {
  loaded: number;
  total: number;
  /** shown before the numbers, e.g. "Downloading" */
  label?: string;
  /** the numbers are bytes: shown in MB */
  bytes?: boolean;
}

export interface PlayerModes {
  auto: boolean;
  fast: boolean;
  uiHidden: boolean;
  muted: boolean;
  voice: boolean;
  fullscreen: boolean;
}

/** Which family set the talk window uses: Japanese / Latin, Chinese or Korean text. */
export type TextScript = "ja" | "latin" | "zh" | "ko";

interface Session {
  scenario: ScenarioSceneData;
  player: ScenarioPlayer;
  stage: Stage;
  fx: FxManager;
  started: boolean;
}

// the game sets these in FOT-RodinNTLG Pro EB / DB (commercial); Source Han
// Sans (SIL OFL, shipped in fonts/) stands in
export const DEFAULT_FONTS = { name: "SourceHanSansJP-Bold.otf", body: "SourceHanSansJP-Medium.otf" };

const STAGE_W = 1280;
const STAGE_H = 720;
// background images the stylesheet reads from CSS variables (--pjsk-img-*)
const CSS_IMAGES = [
  "menu/btn",
  "menu/close",
  "menu/menu_circle",
  "menu/menu_dots",
  "scenario/btn_round_h80_wh",
  "scenario/tex_transition_left",
  "scenario/tex_transition_top",
];

// Can this page play sound without a click yet? (a silent clip either plays or
// is rejected by the browser's autoplay policy)
const SILENT_WAV = "data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YQAAAAA=";
const canAutoplay = () =>
  new Audio(SILENT_WAV).play().then(
    () => true,
    () => false,
  );

function injectStyle(id: string, text: string) {
  if (document.getElementById(id)) return;
  const el = document.createElement("style");
  el.id = id;
  el.textContent = text;
  document.head.appendChild(el);
}

export class PjskPlayer {
  readonly root: HTMLElement;
  readonly assets: AssetResolver;
  private stageEl: HTMLElement;
  private overlay: HTMLElement;
  private loadingEl: HTMLElement;
  private progressEl: HTMLElement;
  private progressText: HTMLElement;
  private statusEl: HTMLElement;
  private startBtn: HTMLButtonElement;
  private app: PIXI.Application;
  private clock = new Clock();
  private audio = new AudioManager();
  private dialogue: DialogueBox;
  private effects: Effects;
  private menu?: ScenarioMenu;
  private session?: Session;
  private manifest?: Promise<ModelManifest>;
  private labels: PlayerLabels;
  private listeners = new Map<keyof PlayerEvents, Set<Listener<any>>>();
  private modes: PlayerModes;
  private logOn = false;
  private resize: ResizeObserver;
  private loadSeq = 0;
  private destroyed = false;
  // the current load's progress: costumes (from the player) and files (counted)
  private progress?: { costumes?: Omit<LoadingProgress, "files">; files: FileCount; stop: () => void; frame?: number };
  private hostProgress: HostProgress | null = null;
  private loadFiles?: object; // owns what load({ files }) handed in, until the next load
  private sprites: UiSprites;
  private actionsEl: HTMLElement;
  private preloading?: { abort: AbortController; progress?: PreloadProgress };
  private choice?: (c: "retry" | "continue" | "cancel") => void; // the retry / play-anyway buttons

  constructor(
    container: HTMLElement,
    private options: PlayerOptions,
  ) {
    this.assets = typeof options.assets === "string" ? createAssetResolver(options.assets) : options.assets;
    if (options.cubismCoreUrl) setCubismCoreUrl(options.cubismCoreUrl);
    const base = LABELS[options.locale ?? "zh"];
    this.labels = mergeLabels(base, options.labels);
    // every load asks the resolver for the fallback host's copy when a host fails
    const fallback = this.assets.fallback;
    setFallback(this, fallback && ((url: string) => fallback.call(this.assets, url)));
    this.modes = {
      auto: options.auto ?? true,
      fast: false,
      uiHidden: false,
      muted: options.muted ?? false,
      voice: options.voice ?? true,
      fullscreen: false,
    };
    this.audio.setMuted(this.modes.muted);
    for (const [kind, v] of Object.entries(options.volumes ?? {}) as [VolumeKind, number][]) this.audio.setVolume(kind, v);

    injectStyle("pjsk-player-style", css);
    if (options.fonts !== false) {
      const name = options.fonts?.name ?? this.assets.font(DEFAULT_FONTS.name);
      const body = options.fonts?.body ?? this.assets.font(DEFAULT_FONTS.body);
      // the fallback host's copy as a second source (the browser moves on when the first fails)
      const src = (url: string) => [url, fallbackOf(url)].flatMap((u) => (u ? [`url("${u}")`] : [])).join(", ");
      const face = (family: string, url: string) => `@font-face { font-family: "${family}"; src: ${src(url)}; font-display: swap; }`;
      injectStyle(`pjsk-font-${name}|${body}`, face("PJSK Sans Bold", name) + "\n" + face("PJSK Sans Medium", body));
    }

    this.root = document.createElement("div");
    this.root.className = "pjsk-player";
    this.root.dataset.script = options.textScript ?? "ja";
    const sprites = (this.sprites = new UiSprites(this.assets.ui));
    for (const p of CSS_IMAGES)
      sprites.bind(`${p}.png`, (url) => this.root.style.setProperty(`--pjsk-img-${p.replace(/[/_]/g, "-")}`, `url("${url}")`));
    this.stageEl = document.createElement("div");
    this.stageEl.className = "pjsk-stage";
    const canvas = document.createElement("canvas");
    canvas.className = "pjsk-canvas";
    this.stageEl.appendChild(canvas);
    this.root.appendChild(this.stageEl);
    container.appendChild(this.root);

    this.app = new PIXI.Application({
      view: canvas,
      width: STAGE_W,
      height: STAGE_H,
      resolution: options.resolution ?? Math.min(window.devicePixelRatio || 1, 2),
      autoDensity: true,
      backgroundColor: 0x000000,
      antialias: true,
      autoStart: true,
    });

    this.dialogue = new DialogueBox(this.stageEl, this.clock, sprites);
    this.effects = new Effects(this.stageEl, this.clock);
    if (options.menu !== false)
      this.menu = new ScenarioMenu(
        this.stageEl,
        {
          auto: () => this.setAuto(!this.modes.auto),
          fast: () => this.setFast(!this.modes.fast),
          mute: () => this.setMuted(!this.modes.muted),
          fullscreen: () => void this.toggleFullscreen(),
          hide: () => this.setUiHidden(true),
          log: () => this.emit("log", {}),
        },
        sprites,
        this.labels.menu,
        Array.isArray(options.menu) ? options.menu : DEFAULT_MENU,
      );

    this.overlay = document.createElement("div");
    this.overlay.className = "pjsk-overlay";
    this.overlay.hidden = true;
    this.overlay.innerHTML = `<div class="pjsk-loading"></div>
      <div class="pjsk-progress" hidden><i></i></div><div class="pjsk-progress-text"></div>
      <div class="pjsk-status"></div><button class="pjsk-start" hidden></button>
      <div class="pjsk-actions" hidden><button class="pjsk-retry"></button><button class="pjsk-continue"></button></div>`;
    this.loadingEl = this.overlay.querySelector(".pjsk-loading")!;
    this.progressEl = this.overlay.querySelector(".pjsk-progress")!;
    this.progressText = this.overlay.querySelector(".pjsk-progress-text")!;
    this.statusEl = this.overlay.querySelector(".pjsk-status")!;
    this.startBtn = this.overlay.querySelector(".pjsk-start")!;
    this.actionsEl = this.overlay.querySelector(".pjsk-actions")!;
    this.syncLabels();
    for (const [sel, c] of [
      [".pjsk-retry", "retry"],
      [".pjsk-continue", "continue"],
    ] as const)
      this.actionsEl.querySelector(sel)!.addEventListener("click", (e) => {
        e.stopPropagation();
        this.choose(c);
      });
    this.startBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      void this.play();
    });
    this.stageEl.appendChild(this.overlay);

    // taps: bring hidden UI back (非表示), otherwise advance / finish typing
    this.stageEl.addEventListener("click", () => {
      if (this.modes.uiHidden) this.setUiHidden(false);
      else this.session?.player.onClick();
    });

    document.addEventListener("fullscreenchange", this.onFullscreenChange);
    addEventListener("keydown", this.onKey);
    this.resize = new ResizeObserver(() => this.fit());
    this.resize.observe(this.root);
    this.fit();
    this.syncModes();
  }

  // ── events ───────────────────────────────────────────────────────────────
  on<K extends keyof PlayerEvents>(type: K, fn: Listener<K>): () => void {
    let set = this.listeners.get(type);
    if (!set) this.listeners.set(type, (set = new Set()));
    set.add(fn);
    return () => this.off(type, fn);
  }
  off<K extends keyof PlayerEvents>(type: K, fn: Listener<K>) {
    this.listeners.get(type)?.delete(fn);
  }
  private emit<K extends keyof PlayerEvents>(type: K, e: PlayerEvents[K]) {
    for (const fn of this.listeners.get(type) ?? []) {
      try {
        fn(e);
      } catch (err) {
        console.error(err);
      }
    }
  }

  // ── state ────────────────────────────────────────────────────────────────
  get scenario(): ScenarioSceneData | undefined {
    return this.session?.scenario;
  }
  get auto() {
    return this.modes.auto;
  }
  get fast() {
    return this.modes.fast;
  }
  get uiHidden() {
    return this.modes.uiHidden;
  }
  setAuto(on: boolean) {
    this.modes.auto = on;
    if (this.session) this.session.player.auto = on;
    this.syncModes();
  }
  /** 早送り: text at once, no voice, every wait/fade runs faster. */
  setFast(on: boolean) {
    this.modes.fast = on;
    this.session?.player.setFast(on);
    this.syncModes();
  }
  /** 非表示: hide the talk window and menu; the next tap on the stage shows them again. */
  setUiHidden(on: boolean) {
    this.modes.uiHidden = on;
    this.syncModes();
  }
  /** Light up the menu's Log button (the host owns the log it opens). */
  setLogActive(on: boolean) {
    this.logOn = on;
    this.syncModes();
  }
  get muted() {
    return this.modes.muted;
  }
  /** Silence BGM, SE and voices (lip-sync keeps following the voice). */
  setMuted(on: boolean) {
    this.modes.muted = on;
    this.audio.setMuted(on);
    this.syncModes();
  }
  /** Listener volume (0-1) for BGM, voices or SE, on top of the scenario's own levels; applies at once. */
  setVolume(kind: VolumeKind, value: number) {
    this.audio.setVolume(kind, value);
  }
  getVolume(kind: VolumeKind) {
    return this.audio.getVolume(kind);
  }
  get voice() {
    return this.modes.voice;
  }
  /** Play the voices; off, lines advance on the no-voice timing. Takes effect from the next line. */
  setVoice(on: boolean) {
    this.modes.voice = on;
    if (this.session) this.session.player.voiceEnabled = on;
    if (!on) this.audio.stopVoice();
    this.syncModes();
  }

  get fullscreen() {
    return this.modes.fullscreen;
  }
  /**
   * Fullscreen on the player (locked to landscape where the browser allows).
   * Where pages can't go fullscreen (iPhone Safari) the player covers the
   * viewport instead, turned sideways while the phone is held upright.
   */
  async setFullscreen(on: boolean) {
    this.fsWanted = on;
    if (!on) {
      this.leavePseudoFullscreen();
      if (document.fullscreenElement === this.root) await document.exitFullscreen().catch(() => {});
    } else if (!this.modes.fullscreen) {
      if (document.fullscreenEnabled && this.root.requestFullscreen) {
        try {
          await this.root.requestFullscreen({ navigationUI: "hide" });
          // left again while the request was pending: undo it
          if (!this.fsWanted) await document.exitFullscreen().catch(() => {});
          else await (screen.orientation as { lock?: (o: string) => Promise<void> } | undefined)?.lock?.("landscape").catch(() => {});
        } catch {
          if (this.fsWanted && !this.destroyed) this.enterPseudoFullscreen();
        }
      } else this.enterPseudoFullscreen();
    }
    this.onFullscreenChange();
  }
  toggleFullscreen() {
    return this.setFullscreen(!this.fsWanted);
  }
  private enterPseudoFullscreen() {
    this.root.classList.add("pjsk-pseudo-fs");
    document.documentElement.classList.add("pjsk-fs-lock");
  }
  private leavePseudoFullscreen() {
    this.root.classList.remove("pjsk-pseudo-fs");
    document.documentElement.classList.remove("pjsk-fs-lock");
  }
  private fsWanted = false;
  // the overlay fallback has no browser UI to leave it: Escape does
  private readonly onKey = (e: KeyboardEvent) => {
    if (e.key === "Escape" && this.root.classList.contains("pjsk-pseudo-fs")) void this.setFullscreen(false);
  };
  private readonly onFullscreenChange = () => {
    const on = document.fullscreenElement === this.root || this.root.classList.contains("pjsk-pseudo-fs");
    if (!on) this.fsWanted = false; // left with the browser's own controls
    if (on === this.modes.fullscreen) return;
    this.modes.fullscreen = on;
    this.syncModes();
  };

  /**
   * The script of the text being shown: Chinese and Korean lines switch to the
   * --pjsk-font-zh-* / --pjsk-font-ko-* families (bold names, medium lines).
   */
  setTextScript(script: TextScript) {
    this.root.dataset.script = script;
  }

  /** Change the start overlay and menu text. */
  setLabels(labels: LabelOverrides) {
    this.labels = mergeLabels(this.labels, labels);
    this.syncLabels();
    this.menu?.setLabels(this.labels.menu);
  }
  private syncLabels() {
    this.loadingEl.textContent = this.labels.loading;
    this.startBtn.textContent = this.labels.start;
    this.actionsEl.querySelector(".pjsk-retry")!.textContent = this.labels.retry;
    this.actionsEl.querySelector(".pjsk-continue")!.textContent = this.labels.continue;
  }

  /**
   * Files the host already has (downloaded itself, from a cache, an archive
   * …), keyed by the URL the resolver gives for each; relative keys resolve
   * against the page. The player reads these instead of downloading them,
   * and a model's moc, textures and physics are looked up by their URLs
   * relative to its model3. They stay until clearFiles() or destroy().
   * (Fonts and UI sprites are read when the player is created.)
   */
  provideFiles(files: FileEntries) {
    provide(this, files);
  }
  /** Forget files handed in with provideFiles(): these URLs, or all of them. */
  clearFiles(urls?: Iterable<string>) {
    unprovide(this, urls && [...urls].map(absUrl));
  }

  /** Show the loading spinner over the stage (e.g. while the host prepares a scenario). */
  showLoading() {
    this.overlay.hidden = false;
    this.loadingEl.hidden = false;
    this.statusEl.textContent = "";
    this.startBtn.hidden = true;
    this.actionsEl.hidden = true;
    this.statusEl.classList.remove("pjsk-warn");
    this.showProgress();
  }

  /**
   * Drive the loading bar yourself, e.g. while you download a scenario's
   * files to hand them in (provideFiles): call showLoading() first. `null`
   * gives the bar back to the player, as load() does.
   */
  setProgress(p: HostProgress | null) {
    this.hostProgress = p;
    this.showProgress();
  }

  // The host's numbers while it drives the bar; otherwise costumes loaded of
  // those playback waits for, the files and the MB so far.
  private showProgress() {
    const mb = (b: number) => (b / 1048576).toFixed(1);
    let ratio = 0;
    const parts: string[] = [];
    const hp = this.hostProgress;
    const pre = this.preloading?.progress;
    if (hp) {
      ratio = hp.total > 0 ? hp.loaded / hp.total : 0;
      if (hp.label) parts.push(hp.label);
      if (hp.total > 0) parts.push(hp.bytes ? `${mb(hp.loaded)} / ${mb(hp.total)} MB` : `${hp.loaded} / ${hp.total}`);
    } else if (pre) {
      parts.push(`${this.labels.preloading} ${pre.done} / ${pre.total}`);
      if (pre.bytes) parts.push(`${mb(pre.bytes)} MB`);
      ratio = pre.total > 0 ? pre.done / pre.total : 0;
    } else if (this.progress) {
      const { costumes: c, files: f } = this.progress;
      if (c?.required) parts.push(`${this.labels.models} ${c.requiredLoaded} / ${c.required}`);
      if (f.started) parts.push(`${this.labels.files} ${f.done} / ${f.started}`);
      if (f.bytes) parts.push(`${mb(f.bytes)} MB`);
      ratio = c?.required ? c.requiredLoaded / c.required : f.started ? f.done / f.started : 0;
    }
    const on = parts.length > 0 && !this.loadingEl.hidden;
    this.progressEl.hidden = !on;
    this.progressText.textContent = on ? parts.join(" · ") : "";
    (this.progressEl.firstElementChild as HTMLElement).style.width = `${Math.min(1, ratio) * 100}%`;
  }

  // Count this load's files; the bar and the `loading` event follow, once a frame.
  private startCounting() {
    this.stopCounting();
    const counting = countFiles(() => {
      if (this.progress !== state || state.frame !== undefined) return;
      state.frame = requestAnimationFrame(() => {
        state.frame = undefined;
        this.reportProgress();
      });
    });
    const state: NonNullable<PjskPlayer["progress"]> = { files: counting.count, stop: counting.stop };
    this.progress = state;
  }
  private stopCounting() {
    const p = this.progress;
    if (!p) return;
    p.stop();
    if (p.frame !== undefined) cancelAnimationFrame(p.frame);
    this.progress = undefined;
  }
  private reportProgress() {
    const p = this.progress;
    if (!p) return;
    this.showProgress();
    const c = p.costumes ?? { loaded: 0, total: 0, required: 0, requiredLoaded: 0, failed: [] };
    this.emit("loading", { ...c, files: { ...p.files } });
  }
  /** Show a message over the stage instead of the scenario (an error, a prompt). */
  showMessage(text: string) {
    this.overlay.hidden = false;
    this.loadingEl.hidden = true;
    this.showProgress();
    this.startBtn.hidden = true;
    this.actionsEl.hidden = true;
    this.statusEl.classList.remove("pjsk-warn");
    this.statusEl.textContent = text;
  }
  hideOverlay() {
    this.overlay.hidden = true;
  }

  private syncModes() {
    this.dialogue.setAuto(this.modes.fast ? "skip" : this.modes.auto ? "auto" : "off");
    this.menu?.setState({
      auto: this.modes.auto,
      fast: this.modes.fast,
      log: this.logOn,
      mute: this.modes.muted,
      fullscreen: this.modes.fullscreen,
    });
    this.stageEl.classList.toggle("ui-hidden", this.modes.uiHidden);
    this.emit("mode", { ...this.modes });
  }

  // ── playback ─────────────────────────────────────────────────────────────
  /**
   * Load a scenario (an object, or a ScenarioId fetched via `assets.scenario`,
   * or a URL) in place of the current one. Resolves once it is playing or
   * waiting for the start button.
   */
  async load(
    scenario: ScenarioSceneData | string | URL,
    opts: {
      autoplay?: boolean | "auto";
      /** Handed to every per-episode resolver call as `ctx.data` (episode kind, bundle, an asset index …). */
      context?: unknown;
      /** Files for this scenario the host already has, as for provideFiles(); dropped at the next load. */
      files?: FileEntries;
      /** Download every file before playing (the `preload` option, for this scenario). */
      preload?: boolean;
    } = {},
  ): Promise<void> {
    const seq = ++this.loadSeq;
    this.teardown();
    if (opts.files) provide((this.loadFiles = {}), opts.files);
    this.menu?.close();
    this.setUiHidden(false);
    this.hostProgress = null;
    this.startCounting();
    this.showLoading();
    this.audio.arm();
    void getLive2D().catch(() => {}); // the Live2D runtime loads alongside the scenario (a failure surfaces on the first model)

    let scn: ScenarioSceneData;
    let manifest: ModelManifest;
    try {
      const fetched =
        typeof scenario === "object" && !(scenario instanceof URL)
          ? scenario
          : fetchJson<ScenarioSceneData>(
              scenario instanceof URL || /^(https?:|blob:|data:|\/|\.)/.test(scenario)
                ? String(scenario)
                : this.assets.scenario(scenario),
            );
      [scn, manifest] = await Promise.all([fetched, this.getManifest()]);
    } catch (e) {
      if (seq === this.loadSeq) this.fail(e as Error);
      return;
    }
    if (seq !== this.loadSeq || this.destroyed) return; // another load() came in meanwhile

    const preloadOpt = opts.preload ?? !!this.options.preload;
    const abort = new AbortController();
    const pre = preloadOpt
      ? new Preload({
          signal: abort.signal,
          concurrency: typeof this.options.preload === "object" ? this.options.preload.concurrency : undefined,
          onProgress: (p) => {
            if (this.preloading?.abort !== abort) return;
            this.preloading.progress = p;
            this.showProgress();
            this.emit("preload", p);
          },
        })
      : undefined;
    // a preload finds which of an asset's candidates loads: that one is tried first
    const assets = bindAssets(this.assets, { scenario: scn, data: opts.context }, pre?.chosen);
    const stage = new Stage(this.app, manifest, buildMotionIndex(scn), assets, this.clock);
    const player = new ScenarioPlayer(scn, stage, this.dialogue, this.audio, this.effects, assets, this.clock);
    const fx = new FxManager(
      this.app.ticker,
      { bottom: stage.fxBottom, back: stage.fxBack, front: stage.fxLayer, top: stage.fxTop },
      this.assets.fx,
    );
    // scenario/effect/<name> particles; Stop becomes ForceStop while fast-forwarding
    player.onScenarioEffect = (name, play) => (play ? void fx.play(name) : fx.stop(name, player.isFast));
    const holo = (id: number) => void fx.play("hologram", () => stage.charFoot(id), `hologram@${id}`);
    player.onCharacterEffect = (id, bundle) => (bundle ? holo(id) : fx.detach((k) => k === `hologram@${id}`));
    // SekaiOut: the transition prefab (EffectLayer, under the white cover)
    player.onSekaiTransition = (anniv) =>
      void fx.play(anniv ? "sekai_transition_3anv" : "sekai_transition").then((i) => setTimeout(() => i?.stop(), 5000)); // DestroyAtTime 5s
    stage.onBackground = (id) => fx.background(id, stage.bgFxLayer);
    player.onEffectsRestore = (names, holos) => {
      fx.restore(names);
      for (const id of holos) holo(id);
    };
    player.auto = this.modes.auto;
    player.voiceEnabled = this.modes.voice;
    player.setFast(this.modes.fast);
    player.onProgress = (index, total) => this.emit("progress", { index, total });
    player.onLoadProgress = (p) => {
      if (this.session?.player !== player || !this.progress) return;
      this.progress.costumes = p;
      this.reportProgress();
    };
    player.onReady = () => {
      if (this.session?.player !== player) return;
      this.reportProgress();
      this.stopCounting();
      this.overlay.hidden = true;
      this.emit("play", { scenario: scn });
    };
    const session: Session = { scenario: scn, player, stage, fx, started: false };
    this.session = session;
    this.emit("load", { scenario: scn });

    if (pre) {
      player.waitForAll = true; // the files are here: every costume is ready before the first line
      this.preloading = { abort };
      const items = collectItems({ scenario: scn, manifest, assets, extra: this.sprites.urls(), tasks: this.fontLoads(scn) });
      if (!(await this.runPreload(session, pre, items))) return;
    }

    const autoplay = opts.autoplay ?? this.options.autoplay ?? "auto";
    if (autoplay === true || (autoplay === "auto" && (await canAutoplay()))) {
      if (this.session === session) void this.play();
      return;
    }
    if (this.session !== session) return;
    // no autoplay permission: load the models now, start on the click
    void player.preload();
    this.loadingEl.hidden = true;
    this.statusEl.textContent = "";
    this.startBtn.hidden = false;
  }

  /** Start the loaded scenario (call from a user gesture if autoplay was blocked). */
  async play(): Promise<void> {
    const s = this.session;
    if (!s || s.started) return;
    s.started = true;
    this.startBtn.hidden = true;
    this.showLoading();
    let stopped = false;
    try {
      await s.player.run(); // preloads, fires onReady (hides the overlay), then plays
      stopped = this.session !== s;
    } catch (e) {
      if (this.session === s) this.fail(e as Error);
      return;
    }
    if (!stopped && !this.destroyed) this.emit("end", { scenario: s.scenario });
  }

  /** Restart the timeline at snippet `index` with the stage rebuilt as of that point. */
  jumpTo(index: number) {
    return this.session?.player.jumpTo(index);
  }
  /** Same as a tap on the stage: finish typing, or advance a line waiting for input. */
  advance() {
    this.session?.player.onClick();
  }
  /** Stop and unload the current scenario. */
  stop() {
    this.loadSeq++;
    this.teardown();
    this.overlay.hidden = true;
  }

  destroy() {
    if (this.destroyed) return;
    this.destroyed = true;
    this.stop();
    this.resize.disconnect();
    document.removeEventListener("fullscreenchange", this.onFullscreenChange);
    removeEventListener("keydown", this.onKey);
    this.fsWanted = false; // a request still pending must not fall back to the overlay
    this.leavePseudoFullscreen();
    if (document.fullscreenElement === this.root) void document.exitFullscreen().catch(() => {});
    this.listeners.clear();
    unprovide(this);
    setFallback(this);
    this.audio.destroy();
    this.app.destroy(false, { children: true });
    this.root.remove();
  }

  // ── internals ────────────────────────────────────────────────────────────
  // Download everything; when files failed on every host, ask: retry them or
  // play anyway. false: the scenario was replaced or stopped meanwhile.
  private async runPreload(session: Session, pre: Preload, items: ReturnType<typeof collectItems>): Promise<boolean> {
    const live = () => this.session === session && !this.destroyed;
    let result = await pre.run(items);
    for (;;) {
      if (!live()) return false;
      this.emit("preloaded", result);
      if (!result.failed.length) break;
      console.warn("preload: no host gave these files", result.failed);
      const c = await new Promise<"retry" | "continue" | "cancel">((resolve) => {
        this.choice = resolve;
        this.showMessage(this.labels.preloadFailed.replace("{n}", String(result.failed.length)));
        this.statusEl.classList.add("pjsk-warn");
        this.actionsEl.hidden = false;
      });
      if (c === "cancel" || !live()) return false;
      this.showLoading();
      if (c === "continue") break;
      result = await pre.retry();
    }
    this.preloading = undefined;
    this.showProgress();
    return true;
  }

  private choose(c: "retry" | "continue" | "cancel") {
    const f = this.choice;
    this.choice = undefined;
    this.actionsEl.hidden = true;
    f?.(c);
  }

  // The talk window's faces, loaded for this scenario's characters (a host's
  // unicode-range slices load only for the text shown).
  private fontLoads(scn: ScenarioSceneData): (() => Promise<unknown>)[] {
    const fonts = document.fonts as FontFaceSet | undefined;
    const text = scenarioText(scn);
    if (!fonts?.load || !text) return [];
    const script = this.root.dataset.script;
    const cjk = script === "zh" || script === "ko";
    const style = getComputedStyle(this.root);
    const faces: [string, string, string][] = cjk
      ? [
          [`--pjsk-font-${script}-name`, "700", text],
          [`--pjsk-font-${script}-body`, "500", text],
          ["--pjsk-font-name", "400", "AUTO"], // the AUTO badge is always set in the name face
        ]
      : [
          ["--pjsk-font-name", "400", text + "AUTO"],
          ["--pjsk-font-body", "400", text],
        ];
    return faces.flatMap(([v, weight, sample]) => {
      const family = style.getPropertyValue(v).trim();
      return family ? [() => fonts.load(`${weight} 24px ${family}`, sample)] : [];
    });
  }

  private getManifest() {
    const m = this.options.models;
    this.manifest ??= (typeof m === "function" ? m() : m ? Promise.resolve(m) : fetchJson<ModelManifest>(this.assets.modelManifest())).catch(
      (e) => {
        this.manifest = undefined; // retry on the next load
        throw e;
      },
    );
    return this.manifest;
  }

  private teardown() {
    this.preloading?.abort.abort();
    this.preloading = undefined;
    this.choose("cancel");
    this.stopCounting();
    if (this.loadFiles) unprovide(this.loadFiles);
    this.loadFiles = undefined;
    const s = this.session;
    if (!s) return;
    this.session = undefined;
    s.player.stop();
    s.fx.destroy();
    s.stage.destroy();
    this.app.stage.removeChildren();
  }

  private fail(e: Error) {
    this.stopCounting();
    console.error(e);
    this.showMessage("❌ " + e.message);
    this.emit("error", { error: e });
  }

  // scale the fixed 1280x720 stage into the root, letterboxed
  private fit() {
    const w = this.root.clientWidth;
    const h = this.root.clientHeight || (w * STAGE_H) / STAGE_W;
    const k = Math.min(w / STAGE_W, h / STAGE_H) || 1;
    this.stageEl.style.transform = `translate(${(w - STAGE_W * k) / 2}px, ${(h - STAGE_H * k) / 2}px) scale(${k})`;
    // keep the spinner / start button / status readable on a small stage
    this.overlay.style.zoom = String(k < 0.6 ? Math.min(2.6, 0.6 / k) : 1);
  }
}

function mergeLabels(base: PlayerLabels, o: LabelOverrides | undefined): PlayerLabels {
  const { menu, ...rest } = o ?? {};
  const defined = Object.fromEntries(Object.entries(rest).filter(([, v]) => v !== undefined));
  return { ...base, ...defined, menu: { ...base.menu, ...menu } };
}
