import { useEffect, useState } from "react";

/* Small fetch hook with loading + error states. A failed fetch surfaces a
   retryable error instead of hanging on a skeleton forever. Shared by the
   app shell and tab components.

   Response cache: JSON GETs are deduplicated in flight and their results
   cached by URL. The app primes the hot endpoints in parallel with the auth
   check, so tabs paint with real data on first render instead of popping in
   one by one. retry() evicts the entry, so explicit refreshes always hit
   the network. */

const inflight = new Map<string, Promise<unknown>>();
const resolved = new Map<string, unknown>();

async function fetchJson(url: string): Promise<unknown> {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  const ct = r.headers.get("content-type") ?? "";
  if (!ct.includes("json")) throw new Error("not JSON");
  return (await r.json()) as unknown;
}

function getJson<T>(url: string): Promise<T> {
  const hit = resolved.get(url);
  if (hit !== undefined) return Promise.resolve(hit as T);
  const p = inflight.get(url) as Promise<T> | undefined;
  if (p) return p;
  const np = fetchJson(url).then(
    (d) => {
      inflight.delete(url);
      resolved.set(url, d);
      return d as T;
    },
    (e) => {
      inflight.delete(url);
      throw e;
    }
  );
  inflight.set(url, np);
  return np;
}

/** Fire a GET now and cache it; safe to call twice (deduped). Returns the
 *  promise so callers can hold rendering until it settles. Rejections are
 *  swallowed here; useApi surfaces them when it consumes the entry. */
export function prime(url: string): Promise<unknown> {
  return getJson(url).catch(() => null);
}

/** Drop a cached entry so the next read refetches. */
export function evict(url: string): void {
  inflight.delete(url);
  resolved.delete(url);
}

export function useApi<T>(url: string | null): {
  data: T | null;
  error: boolean;
  loading: boolean;
  retry: () => void;
} {
  // Read a primed entry synchronously so the first paint already has data.
  const [data, setData] = useState<T | null>(() => {
    if (!url) return null;
    const hit = resolved.get(url);
    return hit !== undefined ? (hit as T) : null;
  });
  const [error, setError] = useState(false);
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    if (!url) return;
    let live = true;
    setError(false);
    getJson<T>(url).then(
      (d) => {
        if (live) setData(d);
      },
      () => {
        if (live) setError(true);
      }
    );
    return () => {
      live = false;
    };
  }, [url, nonce]);

  return {
    data,
    error,
    loading: data === null && !error,
    retry: () => {
      if (url) evict(url);
      setNonce((n) => n + 1);
    },
  };
}
