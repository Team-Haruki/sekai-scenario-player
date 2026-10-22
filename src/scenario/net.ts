// Network helpers: nothing the player waits on may hang forever, and a single
// dropped connection shouldn't fail an episode.

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

export class HttpError extends Error {
  constructor(
    readonly url: string,
    readonly status: number,
  ) {
    super(`${url}: HTTP ${status}`);
  }
}

/**
 * GET JSON with a per-attempt timeout, retrying network errors, timeouts and
 * 5xx (with a short backoff). 4xx answers are final.
 */
export async function fetchJson<T>(url: string, { timeoutMs = 15_000, retries = 2 } = {}): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
      if (!r.ok) throw new HttpError(url, r.status);
      return (await r.json()) as T;
    } catch (e) {
      const final = e instanceof HttpError && e.status < 500;
      if (final || attempt >= retries) throw e instanceof HttpError ? e : new Error(`${url}: ${(e as Error).message}`);
      await new Promise((r) => setTimeout(r, 400 * 2 ** attempt));
    }
  }
}
