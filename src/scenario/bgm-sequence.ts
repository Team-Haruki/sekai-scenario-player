// CRI block cues exported from ACB. Transition rules mirror
// ScenarioAudio.SetBgmBlockIndex (7.1.0, 0x42AE650): wait for an even block,
// pass through its following transition block, then enter the requested block.
import { fetchBuffer, fetchJson, HttpError } from './net';

export interface BgmBlock {
  duration: number;
  loop: boolean;
  loopCount?: number;
  transition: number;
  divisions: number;
  events: { at: number; wave: string; gain: number; group?: string }[];
}
export interface BgmSequence {
  version: 1;
  cue: string;
  waves: Record<string, { file: string; duration: number }>;
  blocks: BgmBlock[];
}
export interface BlockChange { t: number; index: number }
export interface BlockVisit { block: number; start: number; end: number }
export interface BgmNote { key: string; start: number; stop: number; wave: string; gain: number; group: string }
export interface PreparedBgm { manifest: BgmSequence; buffers: Map<string, AudioBuffer> }
const EPS = 1e-9;

export function validateSequence(m: BgmSequence) {
  if (m?.version !== 1 || !m.blocks?.length || !m.waves) throw new Error('Invalid BGM sequence');
  for (const wave of Object.values(m.waves)) {
    if (!/^[\w.-]+\.(wav|ogg|mp3)$/.test(wave.file) || !(wave.duration > 0) || !Number.isFinite(wave.duration))
      throw new Error('Invalid BGM waveform');
  }
  for (const b of m.blocks) {
    if (!(b.duration > 0) || !Number.isFinite(b.duration) || ![0, 1, 2].includes(b.transition)
      || (b.transition === 1 && (!Number.isInteger(b.divisions) || b.divisions < 2 || b.divisions === 65535))
      || (b.loopCount != null && (!Number.isInteger(b.loopCount) || b.loopCount < 0)))
      throw new Error('Invalid BGM block');
    for (const e of b.events) {
      if (!m.waves[e.wave] || !Number.isFinite(e.at) || e.at < 0 || !Number.isFinite(e.gain) || e.gain < 0
        || (e.group && !['IM_001', 'IM_002'].includes(e.group))) throw new Error('Unsupported BGM event');
    }
  }
}

export async function loadBgmSequence(urls: string[], ctx: AudioContext): Promise<PreparedBgm | undefined> {
  let manifest: BgmSequence | undefined, base = '';
  for (const url of urls) {
    try { manifest = await fetchJson<BgmSequence>(url); base = url; break; }
    catch (e) { if (!(e instanceof HttpError && e.status === 404)) throw e; }
  }
  if (!manifest) return;
  validateSequence(manifest);
  const buffers = new Map<string, AudioBuffer>();
  await Promise.all(Object.entries(manifest.waves).map(async ([id, wave]) => {
    const bytes = await fetchBuffer(new URL(wave.file, new URL(base, location.href)).href, { timeoutMs: 30_000 });
    buffers.set(id, await ctx.decodeAudioData(bytes));
  }));
  return { manifest, buffers };
}

function transitionAt(b: BgmBlock, start: number, request: number) {
  if (b.transition === 0) return start + b.duration;
  if (b.transition === 2) return request;
  const step = b.duration / b.divisions;
  return Math.min(start + b.duration, start + (Math.floor(Math.max(0, request - start) / step + EPS) + 1) * step);
}

/** Deterministic plan; the online scheduler and offline verification use the same time origin. */
export function blockVisits(m: BgmSequence, duration: number, changes: readonly BlockChange[] = [], initial = 0): BlockVisit[] {
  const blocks = m.blocks, commands = [...changes].sort((a, b) => a.t - b.t);
  if (!Number.isInteger(initial) || initial < 0 || initial >= blocks.length
    || commands.some(c => !Number.isInteger(c.index) || c.index < 0 || c.index >= blocks.length || !Number.isFinite(c.t) || c.t < 0))
    throw new Error('Invalid BGM block command');
  const visits: BlockVisit[] = [], loops = new Map<number, number>();
  let index = initial, start = 0, command = 0;
  let pending: { target: number; phase: 'even' | 'transition' | 'target' } | undefined;
  const exit = (i: number, t: number): [number, number] => {
    const b = blocks[i], count = b.loopCount ?? 65535;
    const repeats = b.loop && (count === 65535 || (loops.get(i) ?? 0) < count);
    return [t + b.duration, repeats ? i : i + 1];
  };
  let [end, next] = exit(index, start);
  for (let step = 0; step < 20_000; step++) {
    if (start >= duration || index >= blocks.length) return visits;
    while (command < commands.length && commands[command].t < Math.min(end, duration) - EPS) {
      const c = commands[command++];
      pending = { target: c.index, phase: index % 2 ? 'even' : 'transition' };
      [end, next] = exit(index, start);
      if (pending.phase === 'transition') { end = transitionAt(blocks[index], start, c.t); next = index + 1; }
    }
    const actualEnd = Math.min(end, duration);
    visits.push({ block: index, start, end: actualEnd });
    if (actualEnd >= duration) return visits;
    const old = index;
    index = next; start = end;
    if (index >= blocks.length) return visits;
    loops.set(index, index === old ? (loops.get(index) ?? 0) + 1 : 0);
    [end, next] = exit(index, start);
    if (pending?.phase === 'transition') {
      pending.phase = 'target'; end = transitionAt(blocks[index], start, start); next = pending.target;
    } else if (pending?.phase === 'target') pending = undefined;
    else if (pending?.phase === 'even' && index % 2 === 0) {
      pending.phase = 'transition'; end = transitionAt(blocks[index], start, start); next = index + 1;
    }
  }
  throw new Error('BGM sequence did not make progress');
}

export function waveformNotes(m: BgmSequence, visits: BlockVisit[]): BgmNote[] {
  const notes: BgmNote[] = [];
  for (const v of visits) m.blocks[v.block].events.forEach((e, i) => {
    const start = v.start + e.at;
    if (start < v.end - EPS) notes.push({ key: `${v.block}:${v.start}:${i}`, start,
      stop: start + m.waves[e.wave].duration, wave: e.wave, gain: e.gain, group: e.group || '' });
  });
  notes.sort((a, b) => a.start - b.start);
  const active = new Map<string, BgmNote>();
  for (const note of notes) if (note.group) {
    const old = active.get(note.group);
    if (old) old.stop = Math.min(old.stop, note.start);
    active.set(note.group, note);
  }
  return notes;
}

/** Schedule decoded waves on the audio clock, without restarting the intro at each loop. */
export class BlockBgmPlayer {
  readonly gain: GainNode;
  private origin: number;
  private initial = 0;
  private changes: BlockChange[] = [];
  private nodes = new Map<string, { src: AudioBufferSourceNode; gain: GainNode; start: number; stop: number }>();
  private timer?: ReturnType<typeof setTimeout>;
  private fadeTimer?: ReturnType<typeof setTimeout>;
  private stopped = false;
  private completed = new Set<string>();

  constructor(private ctx: AudioContext, private prepared: PreparedBgm, destination: AudioNode) {
    this.gain = ctx.createGain();
    this.gain.connect(destination);
    // Leave a short scheduling lead so first-node setup cannot clip the intro.
    this.origin = ctx.currentTime + 0.05;
  }
  start(volume: number, fadeMs: number) {
    this.gain.gain.setValueAtTime(fadeMs > 0 ? 0 : volume, this.ctx.currentTime);
    if (fadeMs > 0) {
      this.gain.gain.setValueAtTime(0, this.origin);
      this.gain.gain.linearRampToValueAtTime(volume, this.origin + fadeMs / 1000);
    }
    this.tick();
  }
  setBlock(index: number, restore = false) {
    if (!Number.isInteger(index) || !this.prepared.manifest.blocks[index]) throw new Error('Invalid BGM block index');
    if (restore) {
      this.clearNodes(); this.completed.clear(); this.initial = index; this.origin = this.ctx.currentTime + 0.05; this.changes = [];
    } else this.changes.push({ t: Math.max(0, this.ctx.currentTime - this.origin), index });
    this.tick();
  }
  private tick = () => {
    clearTimeout(this.timer);
    if (this.stopped) return;
    const now = this.ctx.currentTime, elapsed = Math.max(0, now - this.origin);
    const notes = waveformNotes(this.prepared.manifest, blockVisits(this.prepared.manifest, elapsed + 0.25, this.changes, this.initial));
    const planned = new Map(notes.map(n => [n.key, n]));
    for (const [key, node] of this.nodes) {
      const note = planned.get(key);
      if (!note || note.stop <= elapsed) {
        node.src.onended = null; node.src.stop(); node.src.disconnect(); node.gain.disconnect(); this.nodes.delete(key);
      }
    }
    for (const note of notes) {
      if (note.stop <= elapsed || this.completed.has(note.key)) continue;
      const stop = this.origin + note.stop;
      const existing = this.nodes.get(note.key);
      if (existing) { if (existing.stop !== stop) { existing.src.stop(stop); existing.stop = stop; } continue; }
      const buffer = this.prepared.buffers.get(note.wave)!;
      const offset = Math.max(0, elapsed - note.start);
      if (offset >= buffer.duration) continue;
      const src = this.ctx.createBufferSource(), gain = this.ctx.createGain();
      src.buffer = buffer; gain.gain.value = note.gain;
      src.connect(gain).connect(this.gain);
      const node = { src, gain, start: this.origin + note.start, stop };
      this.nodes.set(note.key, node);
      src.onended = () => { this.completed.add(note.key); if (this.nodes.get(note.key) === node) this.nodes.delete(note.key); src.disconnect(); gain.disconnect(); };
      src.start(Math.max(now, node.start), offset); src.stop(stop);
    }
    this.timer = setTimeout(this.tick, 50);
  };
  fadeOut(ms: number, done: () => void) {
    this.gain.gain.cancelAndHoldAtTime(this.ctx.currentTime);
    this.gain.gain.linearRampToValueAtTime(0, this.ctx.currentTime + ms / 1000);
    clearTimeout(this.fadeTimer);
    this.fadeTimer = setTimeout(() => { this.stop(); done(); }, ms);
  }
  private clearNodes() {
    for (const { src, gain } of this.nodes.values()) { src.onended = null; src.stop(); src.disconnect(); gain.disconnect(); }
    this.nodes.clear();
  }
  stop() {
    this.stopped = true; clearTimeout(this.timer); clearTimeout(this.fadeTimer);
    this.clearNodes(); this.gain.disconnect();
  }
}
