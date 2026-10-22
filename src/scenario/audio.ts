// BGM / SE / voice playback (mp3, URLs from the AssetResolver).

export class AudioManager {
  private bgm?: HTMLAudioElement;
  private bgmUrl?: string;
  private voice?: HTMLAudioElement;
  private voiceDone?: () => void; // settles the current playVoice() promise

  // Web Audio graph for voice lip-sync (amplitude analysis).
  private ctx?: AudioContext;
  private analyser?: AnalyserNode;
  private voiceSrc?: MediaElementAudioSourceNode;
  private timeBuf?: Uint8Array;
  // a MediaElementSource can only be created once per element, so reuse a pool
  private srcCache = new WeakMap<HTMLAudioElement, MediaElementAudioSourceNode>();

  private ensureCtx() {
    if (!this.ctx) {
      const AC = (window as any).AudioContext || (window as any).webkitAudioContext;
      const ctx: AudioContext = new AC();
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 256;
      analyser.connect(ctx.destination);
      this.ctx = ctx;
      this.analyser = analyser;
      this.timeBuf = new Uint8Array(analyser.fftSize);
    }
    if (this.ctx.state === "suspended") this.ctx.resume();
  }

  // Current voice amplitude (RMS, ~0-1) for lip-sync; 0 if no voice playing.
  getVoiceLevel(): number {
    if (!this.analyser || !this.timeBuf || !this.voice || this.voice.paused) return 0;
    this.analyser.getByteTimeDomainData(this.timeBuf);
    let sum = 0;
    for (let i = 0; i < this.timeBuf.length; i++) {
      const d = (this.timeBuf[i] - 128) / 128;
      sum += d * d;
    }
    const rms = Math.sqrt(sum / this.timeBuf.length);
    return Math.min(0.85, rms * 2.4); // gain for a natural open (not a gape)
  }

  playBgm(url: string, volume = 1, fadeMs = 250) {
    if (this.bgm && this.bgmUrl === url) return; // same BGM already playing
    const old = this.bgm;
    this.bgmUrl = url;
    const a = new Audio(url);
    a.loop = true;
    a.volume = fadeMs > 0 ? 0 : volume;
    a.play().catch((e) => console.warn("bgm play blocked/failed", e));
    this.bgm = a;
    if (fadeMs > 0) {
      this.fadeAudio(a, volume, fadeMs); // fade in new
      if (old) this.fadeAudio(old, 0, fadeMs, () => old.pause()); // crossfade out old
    } else if (old) {
      old.pause();
    }
  }

  private fadeAudio(el: HTMLAudioElement, to: number, ms: number, done?: () => void) {
    const from = el.volume;
    const t0 = Date.now();
    const tick = () => {
      const k = Math.min(1, (Date.now() - t0) / ms);
      el.volume = Math.max(0, Math.min(1, from + (to - from) * k));
      if (k < 1) setTimeout(tick, 33);
      else done?.();
    };
    tick();
  }
  stopBgm() {
    if (this.bgm) {
      this.bgm.pause();
      this.bgm = undefined;
      this.bgmUrl = undefined;
    }
  }
  setBgmVolume(v: number) {
    if (this.bgm) this.bgm.volume = Math.max(0, Math.min(1, v));
  }

  playSe(url: string, volume = 1) {
    const a = new Audio(url);
    a.volume = volume;
    a.play().catch((e) => console.warn("se play failed", e));
  }

  // Resolves when the voice clip ends (or fails to load). Never rejects.
  // Routed through an AnalyserNode so getVoiceLevel() can drive lip-sync.
  playVoice(url: string, volume = 1): Promise<void> {
    this.stopVoice();
    return new Promise((resolve) => {
      const a = new Audio(url);
      a.crossOrigin = "anonymous";
      a.volume = volume;
      this.voice = a;
      try {
        this.ensureCtx();
        let src = this.srcCache.get(a);
        if (!src) {
          src = this.ctx!.createMediaElementSource(a);
          this.srcCache.set(a, src);
        }
        src.connect(this.analyser!);
        this.voiceSrc = src;
      } catch (e) {
        console.warn("voice analyser setup failed", e);
      }
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        resolve();
      };
      this.voiceDone = finish;
      a.addEventListener("ended", finish);
      a.addEventListener("error", () => {
        console.warn("voice load failed", url);
        finish();
      });
      a.play().catch(finish);
    });
  }
  stopVoice() {
    if (this.voiceSrc) {
      try {
        this.voiceSrc.disconnect();
      } catch {
        /* noop */
      }
      this.voiceSrc = undefined;
    }
    if (this.voice) {
      this.voice.pause();
      this.voice = undefined;
    }
    // a stopped clip never fires "ended": settle its promise here
    const done = this.voiceDone;
    this.voiceDone = undefined;
    done?.();
  }
}
