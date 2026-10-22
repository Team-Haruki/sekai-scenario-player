// Timeline clock for every setTimeout-driven wait and tween. One per player,
// shared by its stage, dialogue and effects.
//
// - `scale`: playback speed. 早送り (fast-forward) raises it so delays, fades,
//   moves and telops run shorter; 1 = normal.
// - `epoch`: bumped by cancelAll() when the player jumps. Waits and tweens
//   started in an older epoch never resolve, so stale coroutines from before
//   the jump stop where they are instead of touching the rebuilt stage.

export class Clock {
  scale = 1;
  epoch = 0;

  cancelAll() {
    this.epoch++;
  }

  sleep(ms: number): Promise<void> {
    const epoch = this.epoch;
    return new Promise((resolve) => {
      setTimeout(() => {
        if (epoch === this.epoch) resolve();
      }, ms / this.scale);
    });
  }

  // Tween of `set(v)` from `from` to `to` over `ms` (scaled), linear unless
  // `ease` is given. Once `alive()` turns false (a newer tween took over) it
  // stops and resolves at once, as a killed DOTween ends WaitForCompletion.
  tween(
    ms: number,
    from: number,
    to: number,
    set: (v: number) => void,
    ease: (t: number) => number = (t) => t,
    alive: () => boolean = () => true,
  ): Promise<void> {
    if (ms <= 0) {
      set(to);
      return Promise.resolve();
    }
    const epoch = this.epoch;
    const dur = ms / this.scale;
    return new Promise((resolve) => {
      const t0 = Date.now();
      const tick = () => {
        if (epoch !== this.epoch) return; // cancelled by a jump
        if (!alive()) return resolve();
        const k = Math.min(1, (Date.now() - t0) / dur);
        set(from + (to - from) * ease(k));
        if (k < 1) setTimeout(tick, 16);
        else resolve();
      };
      tick();
    });
  }

  // Drive `frame(t)` with clip time t (seconds) for `seconds`, setTimeout-paced.
  playClip(seconds: number, frame: (t: number) => void): Promise<void> {
    const epoch = this.epoch;
    return new Promise((resolve) => {
      const t0 = Date.now();
      const tick = () => {
        if (epoch !== this.epoch) return;
        const t = Math.min(seconds, ((Date.now() - t0) / 1000) * this.scale);
        frame(t);
        if (t < seconds) setTimeout(tick, 16);
        else resolve();
      };
      tick();
    });
  }
}
