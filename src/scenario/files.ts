// Files a host hands in (PjskPlayer.provideFiles / load({ files })) and the
// count of what the player downloads. Every loader asks here first: fetches
// get a Response over the Blob, element loads (images, audio, video, fonts)
// its object URL. Keyed by absolute URL, however the URL was written.

const files = new Map<string, { blob: Blob; url?: string; owners: Set<object> }>();

/** `url` made absolute against the page (unchanged when it can't be parsed). */
export function absUrl(url: string): string {
  try {
    return new URL(url, location.href).href;
  } catch {
    return url;
  }
}

export type FileEntries = Map<string, Blob> | Record<string, Blob> | Iterable<readonly [string, Blob]>;

function entries(f: FileEntries): Iterable<readonly [string, Blob]> {
  return Symbol.iterator in Object(f) ? (f as Iterable<readonly [string, Blob]>) : Object.entries(f);
}

/** Register `f` for `owner`; returns the keys, for unprovide(). */
export function provide(owner: object, f: FileEntries): string[] {
  const keys: string[] = [];
  for (const [url, blob] of entries(f)) {
    const key = absUrl(url);
    const e = files.get(key);
    if (e && e.blob === blob) e.owners.add(owner);
    else {
      if (e?.url) URL.revokeObjectURL(e.url);
      files.set(key, { blob, owners: new Set([owner]) });
    }
    keys.push(key);
  }
  return keys;
}

/** Drop `owner`'s hold on `keys` (all of its files when omitted); a file no one holds is forgotten. */
export function unprovide(owner: object, keys?: Iterable<string>) {
  for (const key of keys ?? [...files.keys()]) {
    const e = files.get(key);
    if (!e?.owners.delete(owner) || e.owners.size) continue;
    if (e.url) URL.revokeObjectURL(e.url);
    files.delete(key);
  }
}

/** The handed-in Blob for `url`, if any. */
export function providedBlob(url: string): Blob | undefined {
  return files.get(absUrl(url))?.blob;
}

/** `url` for an element to load: the handed-in file's object URL, or `url` itself. */
export function fileUrl(url: string): string {
  const e = files.get(absUrl(url));
  if (!e) return url;
  if (e.url === undefined) {
    e.url = URL.createObjectURL(e.blob);
    counter.count(e.blob.size, true);
  }
  return e.url;
}

// ── load counter ──────────────────────────────────────────────────────────
// A player counts the files it loads while a scenario loads: listeners see
// each file as it starts and as it finishes (bytes: its size, or 0 when the
// size isn't known, e.g. an image an element loads).
export interface FileCount {
  started: number;
  done: number;
  bytes: number;
  /** of `done`, the files that were handed in */
  provided: number;
}
type CountListener = (c: { start?: true; bytes?: number; provided?: boolean }) => void;
const listeners = new Set<CountListener>();
const counter = {
  start: () => listeners.forEach((l) => l({ start: true })),
  done: (bytes: number, provided = false) => listeners.forEach((l) => l({ bytes, provided })),
  count(bytes: number, provided = false) {
    this.start();
    this.done(bytes, provided);
  },
};

/** Count every file loaded from now on; returns the running count and a stop function. */
export function countFiles(onChange: (c: FileCount) => void): { count: FileCount; stop: () => void } {
  const count: FileCount = { started: 0, done: 0, bytes: 0, provided: 0 };
  const l: CountListener = (e) => {
    if (e.start) count.started++;
    else {
      count.done++;
      count.bytes += e.bytes ?? 0;
      if (e.provided) count.provided++;
    }
    onChange(count);
  };
  listeners.add(l);
  return { count, stop: () => listeners.delete(l) };
}

/**
 * fetch(), served from a handed-in file when there is one, and counted. The
 * body is read here so its size is known: callers get a Response over the
 * bytes.
 */
export async function fileFetch(url: string, init?: RequestInit): Promise<Response> {
  const blob = providedBlob(url);
  if (blob) {
    counter.count(blob.size, true);
    return new Response(blob, { status: 200, headers: blob.type ? { "content-type": blob.type } : {} });
  }
  counter.start();
  let size = 0;
  try {
    const r = await fetch(url, init);
    if (!r.ok) return r;
    const body = await r.blob();
    size = body.size;
    return new Response(body, { status: r.status, statusText: r.statusText, headers: r.headers });
  } finally {
    counter.done(size);
  }
}

/** Count a file an element loads (an image, a video) from `p` starting to its end. */
export function countLoad<T>(p: Promise<T>): Promise<T> {
  counter.start();
  return p.finally(() => counter.done(0));
}
