// BGM / SE / voice playback. Every source is a list of candidate mp3 URLs
// (the same clip can sit in several folders of the asset tree); the next one
// is tried when a URL fails to load.
//
// iOS Safari lets an <audio> element or an AudioContext make sound only once
// it was started inside a user gesture, and refuses a later play() outside
// one, element by element. So every tap and key press (the start button's
// included) calls unlock(): it starts the AudioContext and primes the few
// long-lived <audio> elements. Voices and SEs are short: they are fetched
// ahead (preload), decoded and played through the context, so a voice starts
// with its line and lip-sync reads its waveform. Until the context runs (the
// browser allowed <audio> autoplay but no gesture happened yet) they play
// from <audio> elements, the voice with a synthetic lip-sync level. BGM
// always streams from one of two primed elements (two for the crossfade).

import { withTimeout } from "./net";
import { fileFetch, fileUrl } from "./files";

const SILENT_WAV = "data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YQAAAAA=";
const FETCH_TIMEOUT = 15_000;
const CLIP_CACHE = 32; // clips kept (a few seconds of decoded mono each)
const VOICE_WAIT = 10_000; // a voice not loaded by then is skipped
const SE_LATE = 3_000; // an SE that loads later than this no longer fits its moment
const GESTURES = ["touchend", "pointerup", "click", "keydown"] as const;

/** The first candidate that answers, as a Blob (a dropped connection is retried once); null when none does. */
async function fetchFirst(urls: string[]): Promise<Blob | null> {
  for (const url of urls)
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const r = await fileFetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT) });
        if (r.ok) return await r.blob();
        if (r.status < 500) break; // not in this folder: the next candidate
      } catch {
        /* network error or timeout: once more */
      }
    }
  return null;
}

interface Clip {
  blob: Promise<Blob | null>;
  buffer?: Promise<AudioBuffer | null>;
}

// A long-lived <audio> that walks its candidates on load errors. iOS keeps an
// element unlocked once it played in a gesture, whatever it plays next.
class Track {
  readonly el = new Audio();
  private urls: string[] = [];
  private i = 0;
  private failed?: () => void;
  private primed = false;
  /** play() was asked for: unlock() retries it after a refusal. */
  wanted = false;
  onEnded?: () => void;

  constructor() {
    this.el.crossOrigin = "anonymous";
    this.el.addEventListener("error", () => {
      if (!this.urls.length) return; // stopped, or the priming clip
      if (++this.i < this.urls.length) {
        this.el.src = fileUrl(this.urls[this.i]);
        if (this.wanted) void this.play();
      } else {
        const f = this.failed;
        this.stop();
        f?.();
      }
    });
    this.el.addEventListener("ended", () => this.onEnded?.());
  }

  load(urls: string[], failed?: () => void) {
    this.urls = urls;
    this.i = 0;
    this.failed = failed;
    this.wanted = false;
    if (urls.length) this.el.src = fileUrl(urls[0]);
    else queueMicrotask(() => failed?.());
  }

  /** false when the browser refused (no gesture yet). */
  play(): Promise<boolean> {
    this.wanted = true;
    return this.el.play().then(
      () => (this.primed = true),
      () => false,
    );
  }

  stop() {
    this.urls = [];
    this.wanted = false;
    this.onEnded = undefined;
    this.el.pause();
  }

  // inside a gesture: resume a refused play(), or play silence once
  unlock() {
    if (this.wanted && this.el.paused) void this.play();
    else if (!this.primed && !this.urls.length) {
      this.el.src = SILENT_WAV;
      this.el.play().then(
        () => {
          this.primed = true;
          if (!this.urls.length) this.el.pause();
        },
        () => {},
      );
    }
  }
}

export class AudioManager {
  private muted = false;
  private ctx?: AudioContext;
  private master?: GainNode; // after the analyser, so muting keeps the lip-sync input
  private analyser?: AnalyserNode;
  private timeBuf?: Uint8Array<ArrayBuffer>;
  private clips = new Map<string, Clip>();

  private bgmTracks = [new Track(), new Track()];
  private bgm?: Track;
  private bgmUrl?: string;
  private fades = new WeakMap<HTMLAudioElement, ReturnType<typeof setTimeout>>();

  private voiceTrack = new Track(); // voices before the context runs
  private voiceNode?: AudioBufferSourceNode;
  private voiceToken = 0;
  private voiceDone?: () => void; // settles the current playVoice() promise
  private voiceBlobUrl?: string;
  // the current voice plays from voiceTrack, outside the analyser graph:
  // lip-sync follows a synthetic level instead of the waveform
  private direct = false;

  // taps only start sound once there is something to play: a running context
  // takes the iOS audio session (and stops the music of other apps)
  private armed = false;

  constructor() {
    for (const e of GESTURES) addEventListener(e, this.unlock, { capture: true, passive: true });
  }

  /** A scenario is loaded: from now on taps and key presses start sound (and this one, if it came from a gesture). */
  arm() {
    this.armed = true;
    if ((navigator as any).userActivation?.isActive) this.unlock();
  }

  /** Start sound from a user gesture (the start button, any tap or key). Must run synchronously in it. */
  readonly unlock = () => {
    if (!this.armed) return;
    const ctx = this.ensureCtx();
    if (ctx.state !== "running") {
      void ctx.resume().catch(() => {});
      // older iOS only starts the context when a source starts in the gesture
      const src = ctx.createBufferSource();
      src.buffer = ctx.createBuffer(1, 1, 22050);
      src.connect(ctx.destination);
      src.start(0);
    }
    for (const t of this.bgmTracks) t.unlock();
    this.voiceTrack.unlock();
  };

  private ensureCtx(): AudioContext {
    if (!this.ctx) {
      // iOS: play through the silent switch, as media elements do (Safari 16.4+)
      try {
        const session = (navigator as any).audioSession;
        if (session) session.type = "playback";
      } catch {
        /* not settable here */
      }
      const AC = window.AudioContext || (window as any).webkitAudioContext;
      const ctx: AudioContext = new AC();
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 256;
      const master = ctx.createGain();
      master.gain.value = this.muted ? 0 : 1;
      analyser.connect(master);
      master.connect(ctx.destination);
      this.ctx = ctx;
      this.analyser = analyser;
      this.master = master;
      this.timeBuf = new Uint8Array(analyser.fftSize);
    }
    return this.ctx;
  }

  /** Can clips go through the context? Tries to start a suspended one briefly. */
  private async running(): Promise<boolean> {
    const ctx = this.ensureCtx();
    if (ctx.state === "running") return true;
    await Promise.race([ctx.resume().catch(() => {}), new Promise((r) => setTimeout(r, 80))]);
    return (ctx.state as AudioContextState) === "running";
  }

  // ── clips (voices, SEs) ──────────────────────────────────────────────────
  private clip(urls: string[]): Clip | null {
    if (!urls.length) return null;
    const key = urls.join("\n");
    let c = this.clips.get(key);
    if (c) this.clips.delete(key); // re-insert: most recently used last
    else {
      const clip: Clip = { blob: fetchFirst(urls) };
      // a clip no candidate gave is forgotten, so the next request tries again
      void clip.blob.then((b) => {
        if (!b && this.clips.get(key) === clip) this.clips.delete(key);
      });
      c = clip;
    }
    this.clips.set(key, c);
    if (this.clips.size > CLIP_CACHE) this.clips.delete(this.clips.keys().next().value!);
    return c;
  }

  private decoded(c: Clip): Promise<AudioBuffer | null> {
    const ctx = this.ensureCtx();
    return (c.buffer ??= c.blob
      .then((b) => (b ? b.arrayBuffer() : null))
      .then((ab) => (ab ? ctx.decodeAudioData(ab) : null))
      .catch(() => null));
  }

  /** Fetch and decode a clip that plays soon (the next lines' voices and SEs); resolves once it is ready or failed. */
  async preload(urls: string[]): Promise<void> {
    const c = this.clip(urls);
    if (c) await this.decoded(c);
  }

  // Current voice amplitude (RMS, ~0-1) for lip-sync; 0 if no voice playing.
  getVoiceLevel(): number {
    if (this.direct) return this.voiceTrack.el.paused ? 0 : 0.28 + 0.22 * Math.abs(Math.sin(performance.now() / 95));
    if (!this.voiceNode || !this.analyser || !this.timeBuf) return 0;
    this.analyser.getByteTimeDomainData(this.timeBuf);
    let sum = 0;
    for (let i = 0; i < this.timeBuf.length; i++) {
      const d = (this.timeBuf[i] - 128) / 128;
      sum += d * d;
    }
    const rms = Math.sqrt(sum / this.timeBuf.length);
    return Math.min(0.85, rms * 2.4); // gain for a natural open (not a gape)
  }

  /** Silence BGM, SE and voice (the voice still drives lip-sync). */
  setMuted(muted: boolean) {
    this.muted = muted;
    for (const t of this.bgmTracks) t.el.muted = muted;
    this.voiceTrack.el.muted = muted;
    if (this.master) this.master.gain.value = muted ? 0 : 1;
  }

  // ── BGM ──────────────────────────────────────────────────────────────────
  playBgm(urls: string[], volume = 1, fadeMs = 250) {
    const url = urls[0];
    if (this.bgm && this.bgmUrl === url) return; // same BGM already playing
    const old = this.bgm;
    const t = this.bgmTracks.find((x) => x !== old)!;
    this.cancelFade(t.el);
    t.stop(); // still fading out from the BGM before
    this.bgmUrl = url;
    t.load(urls, () => console.warn("bgm load failed", url));
    t.el.loop = true;
    t.el.muted = this.muted;
    t.el.volume = fadeMs > 0 ? 0 : volume;
    void t.play(); // refused before a gesture: unlock() starts it
    this.bgm = t;
    if (fadeMs > 0) {
      this.fadeAudio(t.el, volume, fadeMs); // fade in new
      if (old) this.fadeAudio(old.el, 0, fadeMs, () => old.stop()); // crossfade out old
    } else old?.stop();
  }

  private cancelFade(el: HTMLAudioElement) {
    clearTimeout(this.fades.get(el));
    this.fades.delete(el);
  }

  private fadeAudio(el: HTMLAudioElement, to: number, ms: number, done?: () => void) {
    this.cancelFade(el);
    const from = el.volume;
    const t0 = Date.now();
    const tick = () => {
      const k = Math.min(1, (Date.now() - t0) / ms);
      el.volume = Math.max(0, Math.min(1, from + (to - from) * k));
      if (k < 1) this.fades.set(el, setTimeout(tick, 33));
      else {
        this.fades.delete(el);
        done?.();
      }
    };
    tick();
  }
  stopBgm() {
    if (this.bgm) {
      this.cancelFade(this.bgm.el);
      this.bgm.stop();
      this.bgm = undefined;
      this.bgmUrl = undefined;
    }
  }
  setBgmVolume(v: number) {
    if (this.bgm) this.bgm.el.volume = Math.max(0, Math.min(1, v));
  }

  // ── SE ───────────────────────────────────────────────────────────────────
  playSe(urls: string[], volume = 1) {
    const c = this.clip(urls);
    if (!c) return;
    const ctx = this.ctx;
    if (ctx?.state === "running") {
      const t0 = performance.now();
      void this.decoded(c).then((buf) => {
        if (!buf) return console.warn("se load failed", urls[0]);
        if (ctx.state !== "running" || performance.now() - t0 > SE_LATE) return;
        const src = ctx.createBufferSource();
        src.buffer = buf;
        const g = ctx.createGain();
        g.gain.value = volume;
        src.connect(g).connect(this.master!);
        src.start();
      });
      return;
    }
    // before the context runs: a one-off element (what an autoplaying browser allows)
    const a = new Track();
    a.load(urls, () => console.warn("se load failed", urls[0]));
    a.el.muted = this.muted;
    a.el.volume = volume;
    void a.play();
  }

  // ── voice ────────────────────────────────────────────────────────────────
  // Resolves when the voice clip ends (or fails to load). Never rejects.
  playVoice(urls: string[], volume = 1): Promise<void> {
    this.stopVoice();
    const token = this.voiceToken;
    return new Promise((resolve) => {
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        resolve();
      };
      this.voiceDone = finish;
      const c = this.clip(urls);
      if (!c) return finish();
      const live = () => token === this.voiceToken && !done; // not stopped meanwhile
      const failed = () => {
        console.warn("voice load failed", urls[0]);
        finish();
      };
      void (async () => {
        if (await this.running()) {
          const buf = await withTimeout(this.decoded(c), VOICE_WAIT, null);
          if (!live()) return;
          if (!buf) return failed();
          const ctx = this.ctx!;
          const src = ctx.createBufferSource();
          src.buffer = buf;
          const g = ctx.createGain();
          g.gain.value = volume;
          src.connect(g).connect(this.analyser!);
          src.onended = () => {
            if (this.voiceNode === src) this.voiceNode = undefined;
            finish();
          };
          this.voiceNode = src;
          src.start();
          return;
        }
        const blob = await withTimeout(c.blob, VOICE_WAIT, null);
        if (!live()) return;
        if (!blob) return failed();
        const t = this.voiceTrack;
        this.voiceBlobUrl = URL.createObjectURL(blob);
        t.load([this.voiceBlobUrl], failed);
        t.el.muted = this.muted;
        t.el.volume = volume;
        t.onEnded = finish;
        this.direct = true;
        if (!(await t.play()) && live()) {
          t.stop(); // refused (no gesture yet): a later tap must not replay this line
          finish();
        }
      })();
    });
  }

  stopVoice() {
    this.voiceToken++;
    if (this.voiceNode) {
      const n = this.voiceNode;
      this.voiceNode = undefined;
      try {
        n.stop();
        n.disconnect();
      } catch {
        /* never started */
      }
    }
    this.voiceTrack.stop();
    if (this.voiceBlobUrl) URL.revokeObjectURL(this.voiceBlobUrl);
    this.voiceBlobUrl = undefined;
    this.direct = false;
    // a stopped clip never fires "ended": settle its promise here
    const done = this.voiceDone;
    this.voiceDone = undefined;
    done?.();
  }

  destroy() {
    for (const e of GESTURES) removeEventListener(e, this.unlock, { capture: true });
    this.stopVoice();
    this.stopBgm();
    for (const t of this.bgmTracks) t.stop();
    this.clips.clear();
    void this.ctx?.close().catch(() => {});
  }
}
