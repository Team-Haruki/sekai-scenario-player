// CRI block cues exported from ACB. Transition rules mirror
// ScenarioAudio.SetBgmBlockIndex (7.1.0, 0x42AE650): wait for an even block,
// pass through its following transition block, then enter the requested block.
// Block-level rules follow the CRI Atom runtime shipped with 7.1.0:
// - a requested beat transition (transition 1) out of a block with transitionMode 1
//   that crosses beat k enters a beat-synchronised destination with more than k
//   divisions at its own beat k; notes already sounding there continue mid-wave;
// - a block with `next` jumps there when it ends, instead of to the following block.
import { mp3LeadingSamples } from './mp3-timing';
import { fetchBuffer, fetchJson, HttpError } from './net';

export interface BgmBlock {
  duration: number;
  loop: boolean;
  loopCount?: number;
  transition: number;
  divisions: number;
  transitionMode?: number;
  next?: number;
  events: { at: number; wave: string; gain: number; group?: string }[];
}
/** AISAC control value the exported gains were evaluated at. */
export interface BgmAisac { control: string; value: number }
export interface BgmSequence {
  version: 1;
  cue: string;
  waves: Record<string, { file: string; duration: number }>;
  blocks: BgmBlock[];
  aisac?: BgmAisac[];
}
export interface BlockChange { t: number; index: number }
/** `offset`: position inside the block where this visit starts (beat-synchronised entry). */
export interface BlockVisit { block: number; start: number; end: number; offset?: number }
/** `offset`: position inside the waveform where the note starts. */
export interface BgmNote { key: string; start: number; stop: number; wave: string; gain: number; group: string; offset: number }
/**
 * A loaded descriptor. Its waves are fetched and decoded when the scheduler asks
 * for them and dropped again once it stops asking: a cue decoded whole takes
 * hundreds of megabytes (bgm90001 is 17 minutes of stereo audio in 185 waves).
 */
export interface PreparedBgm {
  manifest: BgmSequence;
  /** Decoded waves, ready to start. */
  buffers: Map<string, AudioBuffer>;
  /** Fetch and decode these waves. Resolves once each is decoded or has failed. */
  load(ids: Iterable<string>): Promise<void>;
  /** Drop the decoded waves that are not among `ids`. */
  keep(ids: ReadonlySet<string>): void;
  /** Drop everything; later loads do nothing. */
  release(): void;
}
const EPS = 1e-9;
const LEAD = 0.05; // scheduling lead, so setting up the first node cannot clip the intro
const LOOKAHEAD = 1.5; // notes are scheduled this far ahead: the timers of a hidden tab fire once a second
const WINDOW = 12; // waves of the blocks reached within this time are kept decoded
const TICK = 100;
const START_WAIT = 3_000; // a cue whose first waves are not decoded by then starts anyway; they join late
const WAVE_RETRY = 5_000; // a wave that failed to load is asked for again after this
const FETCH_ALL = 24; // a cue with at most this many waves is fetched (not decoded) whole once it plays
// Voice-limit groups the game's ACF caps at one voice.
const ONE_VOICE_GROUPS = ['IM_001', 'IM_002', 'IM_003', 'IM_004', 'IM_005', 'IM_006', 'IM_007', 'IM_008'];

export function validateSequence(m: BgmSequence) {
  if (m?.version !== 1 || !m.blocks?.length || !m.waves) throw new Error('Invalid BGM sequence');
  for (const wave of Object.values(m.waves)) {
    if (!/^[\w.-]+\.(wav|ogg|mp3)$/.test(wave.file) || !(wave.duration > 0) || !Number.isFinite(wave.duration))
      throw new Error('Invalid BGM waveform');
  }
  for (const b of m.blocks) {
    if (!(b.duration > 0) || !Number.isFinite(b.duration) || ![0, 1, 2].includes(b.transition)
      || (b.transition === 1 && (!Number.isInteger(b.divisions) || b.divisions < 2 || b.divisions === 65535))
      || (b.loopCount != null && (!Number.isInteger(b.loopCount) || b.loopCount < 0))
      || (b.transitionMode != null && ![0, 1].includes(b.transitionMode))
      || (b.next != null && (!Number.isInteger(b.next) || b.next < 0 || b.next >= m.blocks.length)))
      throw new Error('Invalid BGM block');
    for (const e of b.events) {
      if (!m.waves[e.wave] || !Number.isFinite(e.at) || e.at < 0 || !Number.isFinite(e.gain) || e.gain < 0
        || (e.group && !ONE_VOICE_GROUPS.includes(e.group))) throw new Error('Unsupported BGM event');
    }
  }
  if (m.aisac != null && (!Array.isArray(m.aisac)
    || m.aisac.some(a => typeof a?.control !== 'string' || !Number.isFinite(a.value))))
    throw new Error('Invalid BGM AISAC');
}

/** One wave as the descriptor times it: an MP3's encoder delay and padding are cut off. */
async function decodeWave(ctx: AudioContext, bytes: ArrayBuffer, wave: { file: string; duration: number }): Promise<AudioBuffer> {
  // decodeAudioData detaches its input: the bytes are kept for the MP3 header and a later decode
  const decoded = await ctx.decodeAudioData(bytes.slice(0));
  if (!wave.file.endsWith('.mp3')) return decoded;
  const offset = mp3LeadingSamples(bytes, decoded.length, decoded.sampleRate);
  const length = Math.min(decoded.length - offset, Math.round(wave.duration * decoded.sampleRate));
  if (length <= 0) throw new Error('Invalid decoded BGM waveform');
  if (!offset && length === decoded.length) return decoded;
  const trimmed = ctx.createBuffer(decoded.numberOfChannels, length, decoded.sampleRate);
  for (let ch = 0; ch < decoded.numberOfChannels; ch++)
    trimmed.copyToChannel(decoded.getChannelData(ch).subarray(offset, offset + length), ch);
  return trimmed;
}

/** The waves of a descriptor at `base` (its URL), loaded on request. */
export function prepareBgm(manifest: BgmSequence, base: string, ctx: AudioContext): PreparedBgm {
  const buffers = new Map<string, AudioBuffer>();
  const encoded = new Map<string, Promise<ArrayBuffer>>(); // kept: a wave dropped from `buffers` is decoded again
  const decoding = new Map<string, Promise<void>>();
  const retryAt = new Map<string, number>();
  let wanted: ReadonlySet<string> | undefined, released = false, fetchedAll = false;
  const bytes = (id: string) => {
    let p = encoded.get(id);
    if (!p) {
      p = fetchBuffer(new URL(manifest.waves[id].file, new URL(base, location.href)).href, { timeoutMs: 30_000 });
      encoded.set(id, p);
    }
    return p;
  };
  const decode = (id: string) => {
    let p = decoding.get(id);
    if (!p) {
      p = bytes(id).then(async (b) => {
        if (released) return;
        const buffer = await decodeWave(ctx, b, manifest.waves[id]);
        if (!released && (!wanted || wanted.has(id))) buffers.set(id, buffer);
      }).catch((e) => {
        if (released) return;
        encoded.delete(id);
        retryAt.set(id, Date.now() + WAVE_RETRY);
        console.warn('bgm wave load failed', manifest.waves[id].file, e);
      }).finally(() => decoding.delete(id));
      decoding.set(id, p);
    }
    return p;
  };
  return {
    manifest, buffers,
    async load(ids) {
      if (released) return;
      const now = Date.now();
      await Promise.all([...ids].filter(id => manifest.waves[id] && !buffers.has(id) && !((retryAt.get(id) ?? 0) > now)).map(decode));
    },
    keep(ids) {
      wanted = ids;
      for (const id of buffers.keys()) if (!ids.has(id)) buffers.delete(id);
      if (fetchedAll || released || Object.keys(manifest.waves).length > FETCH_ALL) return;
      // a small cue is fetched whole, so a block the scenario asks for has its waves at hand
      fetchedAll = true;
      for (const id of Object.keys(manifest.waves)) {
        const p = bytes(id);
        p.catch(() => { if (encoded.get(id) === p) encoded.delete(id); });
      }
    },
    release() { released = true; buffers.clear(); encoded.clear(); },
  };
}

/** The first descriptor among `urls` that exists; undefined when none does (the cue is a flat track). */
export async function loadBgmSequence(urls: string[], ctx: AudioContext): Promise<PreparedBgm | undefined> {
  for (const url of urls) {
    let manifest: BgmSequence;
    try { manifest = await fetchJson<BgmSequence>(url); }
    catch (e) { if (e instanceof HttpError && e.status === 404) continue; throw e; }
    validateSequence(manifest);
    return prepareBgm(manifest, url, ctx);
  }
}

/** When a requested change leaves a block entered at `offset`, and the beat it leaves on (0 off-beat). */
function transitionAt(b: BgmBlock, start: number, request: number, offset = 0): [number, number] {
  const end = start + b.duration - offset;
  if (b.transition === 0) return [end, 0];
  if (b.transition === 2) return [request, 0];
  const step = b.duration / b.divisions;
  const beat = Math.floor((offset + Math.max(0, request - start)) / step + EPS) + 1;
  return [Math.min(end, start + beat * step - offset), beat];
}

/** Where the destination of a requested transition starts. */
function entryOffset(from: BgmBlock, beat: number, to: BgmBlock | undefined) {
  return beat > 0 && from.transitionMode === 1 && to?.transition === 1 && to.divisions > beat
    ? beat * (to.duration / to.divisions) : 0;
}

/** Deterministic plan; the online scheduler and offline verification use the same time origin. */
export function blockVisits(m: BgmSequence, duration: number, changes: readonly BlockChange[] = [], initial = 0): BlockVisit[] {
  const blocks = m.blocks, commands = [...changes].sort((a, b) => a.t - b.t);
  if (!Number.isInteger(initial) || initial < 0 || initial >= blocks.length
    || commands.some(c => !Number.isInteger(c.index) || c.index < 0 || c.index >= blocks.length || !Number.isFinite(c.t) || c.t < 0))
    throw new Error('Invalid BGM block command');
  const visits: BlockVisit[] = [], loops = new Map<number, number>();
  let index = initial, start = 0, offset = 0, beat = 0, command = 0;
  let pending: { target: number; phase: 'even' | 'transition' | 'target' } | undefined;
  const exit = (i: number, t: number, from: number): [number, number] => {
    const b = blocks[i], count = b.loopCount ?? 65535;
    const repeats = b.loop && (count === 65535 || (loops.get(i) ?? 0) < count);
    return [t + b.duration - from, repeats ? i : b.next ?? i + 1];
  };
  let [end, next] = exit(index, start, offset);
  // The plan is rebuilt from time 0 on every tick, so only guard against visits that
  // stop advancing time; a long session legitimately has many visits.
  for (let stalled = 0; stalled < 1_000;) {
    if (start >= duration || index >= blocks.length) return visits;
    while (command < commands.length && commands[command].t < Math.min(end, duration) - EPS) {
      const c = commands[command++];
      pending = { target: c.index, phase: index % 2 ? 'even' : 'transition' };
      [end, next] = exit(index, start, offset); beat = 0;
      if (pending.phase === 'transition') { [end, beat] = transitionAt(blocks[index], start, c.t, offset); next = index + 1; }
    }
    const actualEnd = Math.min(end, duration);
    stalled = actualEnd - start > EPS ? 0 : stalled + 1;
    visits.push(offset > EPS ? { block: index, start, end: actualEnd, offset } : { block: index, start, end: actualEnd });
    if (actualEnd >= duration) return visits;
    const old = index;
    offset = entryOffset(blocks[old], beat, blocks[next]);
    index = next; start = end; beat = 0;
    if (index >= blocks.length) return visits;
    loops.set(index, index === old ? (loops.get(index) ?? 0) + 1 : 0);
    [end, next] = exit(index, start, offset);
    if (pending?.phase === 'transition') {
      pending.phase = 'target'; [end, beat] = transitionAt(blocks[index], start, start, offset); next = pending.target;
    } else if (pending?.phase === 'target') pending = undefined;
    else if (pending?.phase === 'even' && index % 2 === 0) {
      pending.phase = 'transition'; [end, beat] = transitionAt(blocks[index], start, start, offset); next = index + 1;
    }
  }
  throw new Error('BGM sequence did not make progress');
}

export function waveformNotes(m: BgmSequence, visits: BlockVisit[]): BgmNote[] {
  const notes: BgmNote[] = [];
  for (const v of visits) {
    // Entered mid-block (beat-synchronised entry): the block's own timeline before the
    // entry point still decides which notes are sounding there, including voice-group
    // replacements, and those notes continue from the entry point.
    const from = v.offset ?? 0;
    const local = m.blocks[v.block].events.map((e, i) => ({ e, i, stop: e.at + m.waves[e.wave].duration }));
    if (from > EPS) {
      const last = new Map<string, (typeof local)[number]>();
      for (const n of [...local].sort((a, b) => a.e.at - b.e.at)) {
        if (!n.e.group || n.e.at >= from - EPS) continue;
        const old = last.get(n.e.group);
        if (old) old.stop = Math.min(old.stop, n.e.at);
        last.set(n.e.group, n);
      }
    }
    for (const { e, i, stop } of local) {
      if (stop <= from + EPS) continue;
      const start = v.start + Math.max(e.at, from) - from;
      if (start < v.end - EPS) notes.push({ key: `${v.block}:${v.start}:${i}`, start, stop: v.start + stop - from,
        wave: e.wave, gain: e.gain, group: e.group || '', offset: Math.max(0, from - e.at) });
    }
  }
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
  private origin = 0;
  private initial = 0;
  private requested = 0;
  private changes: BlockChange[] = [];
  private nodes = new Map<string, { src: AudioBufferSourceNode; gain: GainNode; start: number; stop: number }>();
  private timer?: ReturnType<typeof setTimeout>;
  private startTimer?: ReturnType<typeof setTimeout>;
  private fadeTimer?: ReturnType<typeof setTimeout>;
  private started = false;
  private stopped = false;
  private fading = false;
  private completed = new Set<string>();

  /** AISAC controls the exported gains assume; empty when the cue has none. */
  get aisac(): readonly BgmAisac[] { return this.prepared.manifest.aisac ?? []; }
  /** The block asked for last (the one it started in until a change). */
  get block() { return this.requested; }

  constructor(private ctx: AudioContext, readonly prepared: PreparedBgm, destination: AudioNode) {
    this.gain = ctx.createGain();
    this.gain.connect(destination);
  }

  /** Start in `block` once its first waves are decoded (or START_WAIT passed); resolves when it started or was stopped. */
  start(volume: number, fadeMs: number, block = 0): Promise<void> {
    this.check(block);
    this.initial = this.requested = block;
    const g = this.gain.gain;
    g.setValueAtTime(fadeMs > 0 ? 0 : volume, this.ctx.currentTime);
    return new Promise((resolve) => {
      const begin = () => {
        clearTimeout(this.startTimer);
        if (!this.stopped && !this.started) {
          this.started = true;
          this.origin = this.ctx.currentTime + LEAD;
          if (fadeMs > 0 && !this.fading) {
            g.setValueAtTime(0, this.origin);
            g.linearRampToValueAtTime(volume, this.origin + fadeMs / 1000);
          }
          this.tick();
        }
        resolve();
      };
      this.startTimer = setTimeout(begin, START_WAIT);
      // wait for the waves of the first notes only; the rest of the window loads meanwhile
      const { notes, wanted } = this.plan(0);
      void this.prepared.load(new Set(notes.filter(n => n.start < LOOKAHEAD).map(n => n.wave))).then(begin, begin);
      void this.prepared.load(wanted);
    });
  }

  private check(index: number) {
    if (!Number.isInteger(index) || !this.prepared.manifest.blocks[index]) throw new Error('Invalid BGM block index');
  }

  /** A scenario block change; `restore` restarts in that block instead (after a jump). */
  setBlock(index: number, restore = false) {
    this.check(index);
    this.requested = index;
    if (!this.started) {
      // before the first note: a change counts from time 0
      if (restore) { this.initial = index; this.changes = []; } else this.changes.push({ t: 0, index });
      return;
    }
    if (restore) {
      this.clearNodes(); this.completed.clear(); this.initial = index; this.origin = this.ctx.currentTime + LEAD; this.changes = [];
    } else this.changes.push({ t: Math.max(0, this.ctx.currentTime - this.origin), index });
    this.tick();
  }

  /**
   * The notes up to WINDOW after `elapsed`, and the waves of those that have not ended:
   * a note can sound on after its block, so the waves are not those of the blocks.
   */
  private plan(elapsed: number) {
    const m = this.prepared.manifest;
    const notes = waveformNotes(m, blockVisits(m, elapsed + WINDOW, this.changes, this.initial));
    const wanted = new Set<string>();
    for (const n of notes) if (n.stop > elapsed) wanted.add(n.wave);
    return { notes, wanted };
  }

  private tick = () => {
    clearTimeout(this.timer);
    if (this.stopped) return;
    const now = this.ctx.currentTime, elapsed = Math.max(0, now - this.origin);
    const { notes, wanted } = this.plan(elapsed);
    this.prepared.keep(wanted);
    void this.prepared.load(wanted);
    const planned = new Map(notes.map(n => [n.key, n]));
    for (const [key, node] of this.nodes) {
      const note = planned.get(key);
      if (!note || note.stop <= elapsed) {
        node.src.onended = null; node.src.stop(); node.src.disconnect(); node.gain.disconnect(); this.nodes.delete(key);
      }
    }
    for (const note of notes) {
      if (note.start > elapsed + LOOKAHEAD) break; // sorted by start
      if (note.stop <= elapsed || this.completed.has(note.key)) continue;
      const stop = this.origin + note.stop;
      const existing = this.nodes.get(note.key);
      if (existing) { if (existing.stop !== stop) { existing.src.stop(stop); existing.stop = stop; } continue; }
      // a wave still loading joins inside its waveform once it is decoded
      const buffer = this.prepared.buffers.get(note.wave);
      if (!buffer) continue;
      const offset = note.offset + Math.max(0, elapsed - note.start);
      if (offset >= buffer.duration) continue;
      const src = this.ctx.createBufferSource(), gain = this.ctx.createGain();
      src.buffer = buffer; gain.gain.value = note.gain;
      src.connect(gain).connect(this.gain);
      const node = { src, gain, start: this.origin + note.start, stop };
      this.nodes.set(note.key, node);
      src.onended = () => { this.completed.add(note.key); if (this.nodes.get(note.key) === node) this.nodes.delete(note.key); src.disconnect(); gain.disconnect(); };
      src.start(Math.max(now, node.start), offset); src.stop(stop);
    }
    this.timer = setTimeout(this.tick, TICK);
  };

  fadeOut(ms: number, done: () => void) {
    this.fading = true;
    const g = this.gain.gain, now = this.ctx.currentTime;
    if (g.cancelAndHoldAtTime) g.cancelAndHoldAtTime(now);
    else {
      // Firefox has no cancelAndHoldAtTime
      const held = g.value;
      g.cancelScheduledValues(now);
      g.setValueAtTime(held, now);
    }
    g.linearRampToValueAtTime(0, now + ms / 1000);
    clearTimeout(this.fadeTimer);
    this.fadeTimer = setTimeout(() => { this.stop(); done(); }, ms);
  }
  private clearNodes() {
    for (const { src, gain } of this.nodes.values()) { src.onended = null; src.stop(); src.disconnect(); gain.disconnect(); }
    this.nodes.clear();
  }
  stop() {
    this.stopped = true; clearTimeout(this.timer); clearTimeout(this.startTimer); clearTimeout(this.fadeTimer);
    this.clearNodes(); this.gain.disconnect();
  }
}
