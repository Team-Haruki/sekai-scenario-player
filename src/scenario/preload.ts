// Preload: download every file a scenario can use before it plays, so the
// timeline never waits on the network and a failing host is dealt with up
// front (its fallback, see hosts.ts).
//
// Memory: the files are not kept. Each body is read to its end and dropped,
// which leaves it in the browser's HTTP cache; the player's own loads then
// read it from there. Scenarios run from a few MB (an area talk: ~7 MB in 24
// files) to 170 MB (a 27-character finale: ~500 files, 60 MB of them Live2D
// textures), far more than a phone should hold in Blobs next to the decoded
// models. Only the few JSON files that name further files (a model3, an
// effect, the background-effect list) are read into memory.

import { buildMotionIndex } from "./assets";
import { absUrl, providedBlob } from "./files";
import { HttpError, TruncatedError, isAbort, isCutShort, markDown, markServed, retryable, sources, timeout } from "./hosts";
import { fxTextureFiles } from "./particles";
import { type EpisodeAssets, type ModelManifest, candidatesKey } from "./resolver";
import { type ScenarioSceneData, SoundPlayMode, SpecialEffectType as T } from "./types";

/** How far a preload has got (the `preload` event). */
export interface PreloadProgress {
  /** files settled (loaded, missing or failed) of those found so far; `total` grows while model3s and effects name more */
  done: number;
  total: number;
  /** bytes received */
  bytes: number;
  /** files that failed on every host */
  failed: number;
}

/** A file no host gave (network, timeout, 5xx, cut short). */
export interface PreloadFailure {
  url: string;
  error: string;
}

export interface PreloadResult {
  /** files loaded (from the network, the HTTP cache or handed in) */
  loaded: number;
  bytes: number;
  /** files that exist nowhere (404 / 403 on every candidate): the player skips them as it would anyway */
  missing: string[];
  failed: PreloadFailure[];
}

interface Item {
  /** candidate URLs, tried in order until one loads */
  urls: string[];
  /** read the body as JSON and return the files it names */
  names?: (json: any, url: string) => Item[];
  /** not a file: something to wait for (a font face) */
  task?: () => Promise<unknown>;
  /** a resolver candidate list (bgm, se, voice, background): its outcome goes in `chosen` */
  list?: boolean;
}

/** Per request: until the headers arrive, and then between two chunks of the body. */
const HEADERS_TIMEOUT = 15_000;
const IDLE_TIMEOUT = 20_000;
const RETRIES = 2;
/** A task (a font face) that hasn't settled by then is left to finish on its own. */
const TASK_TIMEOUT = 20_000;

export interface PreloadSources {
  scenario: ScenarioSceneData;
  manifest: ModelManifest;
  assets: EpisodeAssets;
  /** files the player itself shows (UI sprites) */
  extra?: string[];
  /** fonts and the like: settled, never failed */
  tasks?: (() => Promise<unknown>)[];
}

/** Every file a scenario can load, as candidate lists; model3s and effects name more when read. */
export function collectItems({ scenario: scn, manifest, assets, extra = [], tasks = [] }: PreloadSources): Item[] {
  const items: Item[] = [];
  const single = (url: string | null | undefined, names?: Item["names"]) => {
    if (url) items.push({ urls: [url], names });
  };
  const list = (urls: string[]) => {
    if (urls.length) items.push({ urls, list: true });
  };

  // costumes: the model3 (it names the moc, the textures and the physics), the clips
  const midx = buildMotionIndex(scn);
  const costumes = new Map<string, Set<number>>();
  const addCostume = (costume: string | undefined, id: number) => {
    if (!costume) return;
    const ids = costumes.get(costume) ?? new Set<number>();
    ids.add(id);
    costumes.set(costume, ids);
  };
  for (const c of scn.AppearCharacters ?? []) addCostume(c.CostumeType, c.Character2dId);
  for (const l of scn.FirstLayout ?? []) addCostume(l.CostumeType, l.Character2dId);
  for (const l of scn.LayoutData ?? []) addCostume(l.CostumeType, l.Character2dId);
  const clips = new Set<string>();
  for (const [costume, ids] of costumes) {
    const m = manifest[costume];
    if (!m) continue;
    const physics = assets.physics(m);
    single(assets.model(m), (settings: any, url) => {
      const near = (p: string) => new URL(p, new URL(url, location.href)).href;
      const refs = settings?.FileReferences ?? {};
      const out: Item[] = [];
      if (refs.Moc) out.push({ urls: [near(refs.Moc)] });
      for (const t of refs.Textures ?? []) out.push({ urls: [near(t)] });
      const phys = physics === null ? null : (physics ?? refs.Physics);
      if (phys) out.push({ urls: [near(phys)] });
      return out;
    });
    for (const id of ids)
      for (const [kind, names] of [
        ["motion", midx.motions.get(id)],
        ["facial", midx.facials.get(id)],
      ] as const)
        for (const n of names ?? []) {
          const url = assets.motion(m, kind, n);
          if (url && !clips.has(url)) {
            clips.add(url);
            single(url);
          }
        }
  }

  // sound: the voice of every line (the player plays the first), BGM, SEs
  const { ScenarioId } = scn;
  for (const t of scn.TalkData ?? []) {
    const v = t.Voices?.[0];
    if (v?.VoiceId) list(assets.voice(ScenarioId, v.VoiceId, { character2dId: v.Character2dId }));
  }
  const bgms = new Set<string>(scn.FirstBgm ? [scn.FirstBgm] : []);
  const ses = new Set<string>();
  for (const s of scn.SoundData ?? []) {
    if (s.PlayMode === SoundPlayMode.CrossFade || s.PlayMode === SoundPlayMode.Stack) {
      if (s.Bgm) bgms.add(s.Bgm);
      if (s.Se) ses.add(s.Se);
    } else if (s.PlayMode === SoundPlayMode.SpecialSePlay && s.Se) ses.add(s.Se);
  }
  for (const b of bgms) list(assets.bgm(b));
  for (const s of ses) list(assets.se(s));

  // backgrounds, movies, full-screen text voices, effects
  const bgs = new Set<string>(scn.FirstBackground ? [scn.FirstBackground] : []);
  const fx = new Set<string>();
  let holo = false;
  for (const e of scn.SpecialEffectData ?? []) {
    switch (e.EffectType) {
      case T.ChangeBackground:
        if (e.StringVal) bgs.add(e.StringVal);
        break;
      case T.Movie:
        single(assets.movie(e.StringVal));
        break;
      case T.FullScreenText:
        if (e.StringValSub) list(assets.voice(ScenarioId, e.StringValSub));
        break;
      case T.PlayScenarioEffect:
        if (e.StringVal) fx.add(e.StringVal);
        break;
      case T.SekaiOut:
        fx.add("sekai_transition");
        break;
      case T.SekaiOut3anv:
        fx.add("sekai_transition_3anv");
        break;
      case T.AttachCharacterShader:
        if (e.StringVal === "hologram" || e.StringVal === "monitor") holo = true;
        if (e.StringVal === "hologram" && e.StringValSub) fx.add("hologram");
        break;
    }
  }
  const effect = (name: string): Item => ({
    urls: [assets.fx(`${name}/effect.json`)],
    names: (data) => (data ? fxTextureFiles(data).map((f) => ({ urls: [`${assets.fx(name)}/${f}`] })) : []),
  });
  for (const b of bgs) list(assets.background(b));
  // prefab backgrounds: the ones the effect list has
  if (bgs.size)
    single(assets.fx("bg/index.json"), (ids: unknown) =>
      Array.isArray(ids) ? [...bgs].filter((b) => ids.includes(b)).map((b) => effect(`bg/${b}`)) : [],
    );
  for (const name of fx) items.push(effect(name));
  if (holo) single(assets.ui("scenario/holo.png"));
  for (const url of extra) single(url);
  for (const task of tasks) items.push({ urls: [], task });

  // the files that name more go first, so the total settles early
  return [...items.filter((i) => i.names), ...items.filter((i) => !i.names)];
}

/** The characters of a scenario's text (talk lines, names, telops, captions, choices): for loading font slices. */
export function scenarioText(scn: ScenarioSceneData): string {
  const chars = new Set<string>();
  const add = (s?: string) => {
    for (const ch of s ?? "") chars.add(ch);
  };
  for (const t of scn.TalkData ?? []) {
    add(t.WindowDisplayName);
    add(t.Body);
  }
  for (const e of scn.SpecialEffectData ?? [])
    if (e.EffectType === T.Telop || e.EffectType === T.PlaceInfo || e.EffectType === T.FullScreenText || e.EffectType === T.SimpleSelectable)
      add(e.StringVal);
  return [...chars].join("");
}

/**
 * One scenario's preload: run() downloads everything; retry() downloads again
 * what failed. Cancelled through `signal`.
 */
export class Preload {
  /** candidate list (candidatesKey) → the candidate that loaded (tried first), or null: none exists (skipped) */
  readonly chosen = new Map<string, string | null>();
  private seen = new Set<string>();
  private failedItems: Item[] = [];
  private progress: PreloadProgress = { done: 0, total: 0, bytes: 0, failed: 0 };
  private result: PreloadResult = { loaded: 0, bytes: 0, missing: [], failed: [] };

  constructor(
    private readonly opts: {
      signal: AbortSignal;
      concurrency?: number;
      onProgress?: (p: PreloadProgress) => void;
    },
  ) {}

  run(items: Item[]): Promise<PreloadResult> {
    return this.download(items);
  }

  /** Download again the files that failed (and whatever they name). */
  retry(): Promise<PreloadResult> {
    const again = this.failedItems;
    this.failedItems = [];
    this.result.failed = [];
    this.progress.done -= again.length;
    this.progress.failed = 0;
    return this.download(again, true);
  }

  private report() {
    this.opts.onProgress?.({ ...this.progress });
  }

  private add(queue: Item[], items: Item[]) {
    for (const it of items) {
      const key = it.task ? undefined : candidatesKey(it.urls.map(absUrl));
      if (key !== undefined) {
        if (this.seen.has(key)) continue;
        this.seen.add(key);
      }
      queue.push(it);
      this.progress.total++;
    }
  }

  private async download(items: Item[], again = false): Promise<PreloadResult> {
    const { signal } = this.opts;
    const queue: Item[] = [];
    if (again) queue.push(...items);
    else this.add(queue, items);
    this.report();
    const limit = Math.max(1, this.opts.concurrency ?? 6);
    let active = 0;
    await new Promise<void>((resolve) => {
      const pump = () => {
        if (signal.aborted) return resolve();
        while (active < limit && queue.length) {
          const it = queue.shift()!;
          active++;
          void this.one(it, queue).finally(() => {
            active--;
            pump();
          });
        }
        if (!active && !queue.length) resolve();
      };
      pump();
    });
    return { ...this.result, missing: [...this.result.missing], failed: [...this.result.failed] };
  }

  private async one(it: Item, queue: Item[]) {
    const { signal } = this.opts;
    if (it.task) {
      await timeout(it.task(), TASK_TIMEOUT).catch(() => {}); // best effort: a font that stalls doesn't hold the episode
    } else {
      let failure: unknown;
      let ok = false;
      for (const url of it.urls) {
        if (signal.aborted) return;
        try {
          const json = await this.fetchFile(url, !!it.names);
          ok = true;
          if (it.list) this.chosen.set(candidatesKey(it.urls), url);
          if (it.names) {
            let more: Item[] = [];
            try {
              more = it.names(json, url);
            } catch {
              /* nothing more named */
            }
            this.add(queue, more);
          }
          break;
        } catch (e) {
          if (signal.aborted && isAbort(e)) return;
          if (retryable(e)) failure = e; // this candidate's hosts failed; the next may still load
        }
      }
      if (ok) this.result.loaded++;
      else if (failure !== undefined) {
        this.failedItems.push(it);
        this.result.failed.push({ url: it.urls[0], error: (failure as Error).message ?? String(failure) });
        this.progress.failed++;
      } else {
        this.result.missing.push(it.urls[0]);
        if (it.list) this.chosen.set(candidatesKey(it.urls), null);
      }
    }
    if (signal.aborted) return;
    this.progress.done++;
    this.report();
  }

  // One file through its hosts (sources(): the host, its fallback), like
  // net.ts: a failing host gives way to the other, a 4xx is final. The body
  // is counted and dropped, or parsed when `json`.
  private async fetchFile(url: string, json: boolean): Promise<unknown> {
    const blob = providedBlob(url);
    if (blob) {
      this.count(blob.size);
      return json ? JSON.parse(await blob.text()) : undefined;
    }
    const order = sources(url);
    for (let attempt = 0; ; attempt++) {
      const src = order[attempt % order.length];
      let got = 0;
      try {
        const value = await this.stream(src, json, (n) => {
          got += n;
          this.count(n);
        });
        markServed(url, src);
        this.result.bytes += got;
        return value;
      } catch (e) {
        this.count(-got); // what a failed attempt received doesn't count
        if (this.opts.signal.aborted && isAbort(e)) throw e;
        const again = retryable(e);
        if (again) markDown(src);
        if (!again || attempt >= RETRIES) throw e;
        if ((attempt + 1) % order.length === 0) await new Promise((r) => setTimeout(r, 400 * 2 ** Math.floor(attempt / order.length)));
      }
    }
  }

  private count(n: number) {
    this.progress.bytes += n;
  }

  // GET `src` to its end: a timeout until the headers, then between chunks
  private async stream(src: string, json: boolean, onBytes: (n: number) => void): Promise<unknown> {
    const c = new AbortController();
    const { signal } = this.opts;
    const onAbort = () => c.abort(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
    let timer: ReturnType<typeof setTimeout> | undefined;
    const arm = (ms: number) => {
      clearTimeout(timer);
      timer = setTimeout(() => c.abort(new DOMException(`${src}: timed out`, "TimeoutError")), ms);
    };
    try {
      if (signal.aborted) onAbort();
      arm(HEADERS_TIMEOUT);
      const r = await fetch(src, { signal: c.signal });
      if (!r.ok) {
        void r.body?.cancel().catch(() => {});
        throw new HttpError(src, r.status);
      }
      const chunks: Uint8Array[] = [];
      const size = await readBody(r, () => arm(IDLE_TIMEOUT), (chunk) => {
        onBytes(chunk.byteLength);
        if (json) chunks.push(chunk.slice());
      });
      const expected = isCutShort(size, r.headers.get("content-length"));
      if (expected !== null) throw new TruncatedError(src, size, expected);
      if (!json) return undefined;
      return JSON.parse(await new Blob(chunks as BlobPart[]).text()); // a cut-short body fails here too (retryable)
    } catch (e) {
      // our own abort carries the reason (a TimeoutError); fetch may report it as an AbortError
      if (c.signal.aborted && !signal.aborted) throw c.signal.reason;
      throw e;
    } finally {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
    }
  }
}

const CHUNK = 64 * 1024;
const buffers: ArrayBuffer[] = []; // read buffers between files (one per download at a time)

/**
 * Read a body to its end, handing each chunk to `onChunk` (valid only during
 * the call), and return its size. A BYOB reader fills one reused buffer, so
 * reading a 170 MB episode leaves next to no garbage; where the browser has
 * no BYOB reader for fetch bodies, the default reader's chunks are dropped
 * as they come.
 */
async function readBody(r: Response, beforeRead: () => void, onChunk: (chunk: Uint8Array) => void): Promise<number> {
  let size = 0;
  if (!r.body) {
    const b = new Uint8Array(await r.arrayBuffer());
    onChunk(b);
    return b.byteLength;
  }
  let byob: ReadableStreamBYOBReader | undefined;
  try {
    byob = r.body.getReader({ mode: "byob" });
  } catch {
    byob = undefined;
  }
  if (byob) {
    let buf = buffers.pop() ?? new ArrayBuffer(CHUNK);
    for (;;) {
      beforeRead();
      const { done, value } = await byob.read(new Uint8Array(buf, 0, CHUNK));
      if (value) buf = value.buffer; // handed back (also when done): read into it again
      if (done || !value) break;
      size += value.byteLength;
      onChunk(value);
    }
    if (buf.byteLength === CHUNK && buffers.length < 16) buffers.push(buf); // for the next file
    return size;
  }
  const reader = r.body.getReader();
  for (;;) {
    beforeRead();
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    onChunk(value);
  }
  return size;
}
