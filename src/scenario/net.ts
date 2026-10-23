// Network helpers: nothing the player waits on may hang forever, and a single
// dropped connection or a failing host shouldn't fail an episode.

import { fileFetch } from "./files";
import { HttpError, TruncatedError, anySignal, isAbort, isCutShort, markDown, markServed, retryable, sources } from "./hosts";

export { HttpError } from "./hosts";

/** `p`, or `fallback` once `ms` pass first (`p` keeps running). */
export function withTimeout<T>(p: Promise<T>, ms: number, fallback: T): Promise<T> {
  return new Promise((resolve) => {
    const t = setTimeout(() => resolve(fallback), ms);
    p.then(
      (v) => (clearTimeout(t), resolve(v)),
      () => (clearTimeout(t), resolve(fallback)),
    );
  });
}

export interface FetchOptions {
  /** per attempt, headers and body together (default 15 s) */
  timeoutMs?: number;
  /** attempts after the first (default 2) */
  retries?: number;
  signal?: AbortSignal;
}

/**
 * GET JSON with a per-attempt timeout. Network errors, timeouts, 5xx and
 * bodies cut short are retried: on the fallback host when the resolver names
 * one, then on the first host again after a short backoff. 4xx answers are
 * final. A handed-in file (files.ts) answers without a request.
 */
export function fetchJson<T>(url: string, opts?: FetchOptions): Promise<T> {
  return fetchWith(url, (r) => r.json() as Promise<T>, opts);
}

/** fetchJson() for binary files (a moc). */
export function fetchBuffer(url: string, opts?: FetchOptions): Promise<ArrayBuffer> {
  return fetchWith(url, (r) => r.arrayBuffer(), opts);
}

/** fetchJson() for a file an element shows (a texture) or a clip to decode. */
export function fetchBlob(url: string, opts?: FetchOptions): Promise<Blob> {
  return fetchWith(url, (r) => r.blob(), opts);
}

async function fetchWith<T>(url: string, read: (r: Response) => Promise<T>, { timeoutMs = 15_000, retries = 2, signal }: FetchOptions = {}): Promise<T> {
  const order = sources(url); // decided once: a host marked down meanwhile is this load's own doing
  for (let attempt = 0; ; attempt++) {
    const src = order[attempt % order.length];
    try {
      const r = await fileFetch(src, { signal: anySignal(signal, timeoutMs) });
      if (!r.ok) throw new HttpError(src, r.status);
      const body = await r.blob();
      const expected = isCutShort(body.size, r.headers.get("content-length"));
      if (expected !== null) throw new TruncatedError(src, body.size, expected);
      const value = await read(new Response(body, { status: r.status, headers: r.headers }));
      markServed(url, src);
      return value;
    } catch (e) {
      if (signal?.aborted && isAbort(e)) throw e;
      const again = retryable(e);
      // a body that isn't what we asked for (an HTML page instead of JSON) came from a host that answers
      if (again && !(e instanceof SyntaxError)) markDown(src);
      if (!again || attempt >= retries) throw e instanceof HttpError || e instanceof TruncatedError ? e : new Error(`${src}: ${(e as Error).message}`);
      // the other host at once; the same host again after a short backoff
      if ((attempt + 1) % order.length === 0) await new Promise((r) => setTimeout(r, 400 * 2 ** Math.floor(attempt / order.length)));
    }
  }
}
