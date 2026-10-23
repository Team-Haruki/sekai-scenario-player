// Fallback hosts. A resolver's `fallback(url)` names the same file on another
// host; every load in the player goes through sources() and walks from one to
// the other when a host fails with a network error, a timeout, a 5xx or a body
// cut short. A 4xx is an answer (the file is not there) and never moves on.
//
// - A host that failed is tried after its fallback for HOST_DOWN_MS, so an
//   outage during an episode costs one timeout, not one per file.
// - A file served from the fallback is loaded from there from then on.
// - The fallbacks of every player on a page are asked in turn (first answer
//   wins), like the handed-in files: each resolver only knows its own hosts.

import { absUrl, fileUrl, providedBlob } from "./files";

export type FallbackFn = (url: string) => string | null | undefined;

const fallbacks = new Map<object, FallbackFn>();
const down = new Map<string, number>(); // origin → until
const moved = new Map<string, string>(); // absolute URL → the URL that served it

/** How long a failed host goes behind its fallback. */
export const HOST_DOWN_MS = 60_000;
/** A probe (HEAD) that tells a missing file from a failing host after an element load failed. */
const PROBE_TIMEOUT = 5_000;

/** Register `owner`'s fallback (none: `fn` omitted). */
export function setFallback(owner: object, fn?: FallbackFn) {
  if (fn) fallbacks.set(owner, fn);
  else fallbacks.delete(owner);
}

/** The same file on the fallback host, absolute; null when no resolver names one. */
export function fallbackOf(url: string): string | null {
  const a = absUrl(url);
  for (const fn of fallbacks.values()) {
    let f: string | null | undefined;
    try {
      f = fn(a);
    } catch {
      f = null;
    }
    if (f) {
      const fa = absUrl(f);
      if (fa !== a) return fa;
    }
  }
  return null;
}

const originOf = (url: string) => {
  try {
    return new URL(url).origin;
  } catch {
    return url;
  }
};

function isDown(url: string) {
  const o = originOf(url);
  const until = down.get(o);
  if (until === undefined) return false;
  if (until > Date.now()) return true;
  down.delete(o);
  return false;
}

/** `url`'s host failed (network, timeout, 5xx, cut short): try its fallback first for a while. */
export function markDown(url: string) {
  down.set(originOf(url), Date.now() + HOST_DOWN_MS);
}

/**
 * `src` served `url`: the host works, and a file served from the fallback is
 * loaded from there from now on.
 */
export function markServed(url: string, src: string) {
  const a = absUrl(url);
  const s = absUrl(src);
  down.delete(originOf(s));
  if (s !== a) moved.set(a, s);
}

/**
 * Where to load `url` from, in order: the URL itself and its fallback, the
 * fallback first when it served this file before or the host is down. A file
 * handed in (provideFiles) has one source, itself.
 */
export function sources(url: string): string[] {
  const a = absUrl(url);
  if (/^(blob|data):/.test(a) || providedBlob(a)) return [a];
  const fb = fallbackOf(a);
  if (!fb) return [a];
  return moved.get(a) === fb || isDown(a) ? [fb, a] : [a, fb];
}

/** The source to try first (what a load that can't walk its sources should use). */
export function preferred(url: string): string {
  return sources(url)[0];
}

/** An HTTP answer that was not OK. */
export class HttpError extends Error {
  constructor(
    readonly url: string,
    readonly status: number,
  ) {
    super(`${url}: HTTP ${status}`);
  }
}

/** A body shorter than its Content-Length (the connection ended early). */
export class TruncatedError extends Error {
  constructor(
    readonly url: string,
    readonly got: number,
    readonly expected: number,
  ) {
    super(`${url}: body cut short (${got} of ${expected} bytes)`);
  }
}

/** The load was cancelled by its caller (a scenario switch, stop(), destroy()). */
export const isAbort = (e: unknown) => e instanceof DOMException && e.name === "AbortError";

/** Worth trying on the other host: anything but a 4xx answer or the caller's abort. */
export function retryable(e: unknown): boolean {
  if (isAbort(e)) return false;
  if (e instanceof HttpError) return e.status >= 500;
  return true;
}

/**
 * Bytes received and Content-Length disagree beyond what compression explains
 * (gzip and brotli add at most a few dozen bytes plus 0.1 %; Content-Encoding
 * isn't readable cross-origin, so a decoded body may also be longer).
 */
export function isCutShort(got: number, contentLength: string | null): number | null {
  const expected = contentLength == null ? Number.NaN : Number(contentLength);
  if (!Number.isFinite(expected) || expected <= 0) return null;
  return got < expected - 64 - expected / 1000 ? expected : null;
}

const probes = new Map<string, Promise<unknown>>(); // origin → a probe in flight

/**
 * After an element (an image, audio, video, a script) failed to load `src`:
 * is that the host failing (try the fallback) rather than the file missing?
 * Elements don't expose the status, so ask the host with a HEAD request: a
 * network error, a timeout or a 5xx marks the host down; a 2xx (the host
 * answers, the element still broke: cut short) moves this file on alone; a
 * 4xx is the file missing. While the host is down no probe is needed, and a
 * probe already running for the host is waited for first.
 */
export async function hostFailed(src: string, signal?: AbortSignal): Promise<boolean> {
  if (src.startsWith("blob:") || src.startsWith("data:")) return false;
  if (isDown(src)) return true;
  const origin = originOf(src);
  const running = probes.get(origin);
  if (running) {
    await running;
    if (isDown(src)) return true;
  }
  const p = probe(src, signal);
  const settled = p.then(
    () => {},
    () => {},
  );
  probes.set(origin, settled);
  void settled.then(() => probes.get(origin) === settled && probes.delete(origin));
  const verdict = await p;
  if (verdict === "down") markDown(src);
  return verdict !== "missing";
}

async function probe(src: string, signal?: AbortSignal): Promise<"down" | "broken" | "missing"> {
  try {
    const r = await fetch(src, { method: "HEAD", signal: anySignal(signal, PROBE_TIMEOUT) });
    return r.status >= 500 ? "down" : r.ok ? "broken" : "missing";
  } catch {
    return signal?.aborted ? "missing" : "down"; // the caller's abort: nothing more to try
  }
}

/** `signal` (the caller's) and a timeout of `ms`, as one signal; the timeout aborts with a TimeoutError. */
export function anySignal(signal: AbortSignal | undefined, ms: number): AbortSignal {
  const c = new AbortController();
  const t = setTimeout(() => c.abort(new DOMException("timed out", "TimeoutError")), ms);
  const onAbort = () => c.abort(signal!.reason);
  if (signal?.aborted) onAbort();
  else signal?.addEventListener("abort", onAbort, { once: true });
  c.signal.addEventListener(
    "abort",
    () => {
      clearTimeout(t);
      signal?.removeEventListener("abort", onAbort);
    },
    { once: true },
  );
  return c.signal;
}

/** A promise that rejects with a TimeoutError after `ms` unless `p` settles first. */
export function timeout<T>(p: Promise<T>, ms: number): Promise<T> {
  if (!(ms > 0) || !Number.isFinite(ms)) return p;
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new DOMException("timed out", "TimeoutError")), ms);
    p.then(
      (v) => (clearTimeout(t), resolve(v)),
      (e) => (clearTimeout(t), reject(e)),
    );
  });
}

/**
 * Load `url` with an element-style loader (`load(src)` rejects when the
 * element fails), walking to the fallback host when the host failed: a
 * timeout, or a probe that finds the host failing rather than the file
 * missing. Handed-in files are loaded from their object URL. Rejects with
 * the last failure.
 */
export async function loadFrom<T>(
  url: string,
  load: (src: string) => Promise<T>,
  opts: { timeoutMs?: number; signal?: AbortSignal } = {},
): Promise<T> {
  const order = sources(url);
  let last: unknown;
  for (let i = 0; i < order.length; i++) {
    const src = order[i];
    try {
      const v = await timeout(load(fileUrl(src)), opts.timeoutMs ?? 0);
      markServed(url, src);
      return v;
    } catch (e) {
      last = e;
      if (opts.signal?.aborted) throw e;
      if (i === order.length - 1) break;
      const timedOut = e instanceof DOMException && e.name === "TimeoutError";
      if (timedOut) markDown(src); // a host that stalls is failing
      else if (!(await hostFailed(src, opts.signal))) break; // missing: the fallback won't have it either
    }
  }
  throw last;
}
