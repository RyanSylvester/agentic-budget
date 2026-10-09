import { useEffect, useRef, useState } from "react";

/* Small fetch hook with loading + error states. A failed fetch surfaces a
   retryable error instead of hanging on a skeleton forever. Shared by the
   app shell and tab components.

   Response cache: JSON GETs are deduplicated in flight and their results
   cached by URL. The app primes the hot endpoints in parallel with the auth
   check, so tabs paint with real data on first render instead of popping in
   one by one.

   Freshness: every write made through send() invalidates the whole cache
   and tells mounted hooks to refetch in the background, so totals on other
   tabs follow an edit. The same happens when the page comes back into view
   after a while (the agent may have recorded things meanwhile) and when the
   network returns. A hook mounting on an entry older than STALE_MS shows it
   at once and refetches behind it. */

const STALE_MS = 30_000;

const inflight = new Map<string, Promise<unknown>>();
const resolved = new Map<string, { data: unknown; at: number }>();
const listeners = new Set<() => void>();

let unauthorizedHandler: (() => void) | null = null;

/** Called whenever the server answers 401: the session has ended. */
export function onUnauthorized(handler: (() => void) | null): void {
  unauthorizedHandler = handler;
}

async function fetchJson(url: string): Promise<unknown> {
  const r = await fetch(url);
  if (r.status === 401) unauthorizedHandler?.();
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  const ct = r.headers.get("content-type") ?? "";
  if (!ct.includes("json")) throw new Error("not JSON");
  return (await r.json()) as unknown;
}

function getJson<T>(url: string): Promise<T> {
  const hit = resolved.get(url);
  if (hit !== undefined) return Promise.resolve(hit.data as T);
  const p = inflight.get(url) as Promise<T> | undefined;
  if (p) return p;
  const np = fetchJson(url).then(
    (d) => {
      inflight.delete(url);
      resolved.set(url, { data: d, at: Date.now() });
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

/** Drop every cached entry and have mounted hooks refetch. */
export function invalidate(): void {
  inflight.clear();
  resolved.clear();
  for (const l of listeners) l();
}

/** fetch() for writes: a successful non-GET invalidates the cache, and a 401
 *  reports the ended session. */
export async function send(url: string, init?: RequestInit): Promise<Response> {
  const r = await fetch(url, init);
  if (r.status === 401) unauthorizedHandler?.();
  if (r.ok && (init?.method ?? "GET").toUpperCase() !== "GET") invalidate();
  return r;
}

if (typeof window !== "undefined") {
  let hiddenAt = 0;
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") hiddenAt = Date.now();
    else if (hiddenAt && Date.now() - hiddenAt > STALE_MS) invalidate();
  });
  window.addEventListener("online", invalidate);
}

/** True while the browser reports a network connection. */
export function useOnline(): boolean {
  const [online, setOnline] = useState(() => (typeof navigator === "undefined" ? true : navigator.onLine));
  useEffect(() => {
    const up = () => setOnline(true);
    const down = () => setOnline(false);
    window.addEventListener("online", up);
    window.addEventListener("offline", down);
    return () => {
      window.removeEventListener("online", up);
      window.removeEventListener("offline", down);
    };
  }, []);
  return online;
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
    return hit !== undefined ? (hit.data as T) : null;
  });
  const [error, setError] = useState(false);
  const [nonce, setNonce] = useState(0);
  const hasData = useRef(data !== null);
  hasData.current = data !== null;

  useEffect(() => {
    const bump = () => setNonce((n) => n + 1);
    listeners.add(bump);
    return () => {
      listeners.delete(bump);
    };
  }, []);

  useEffect(() => {
    if (!url) return;
    let live = true;
    setError(false);
    const hit = resolved.get(url);
    if (hit !== undefined && Date.now() - hit.at > STALE_MS) evict(url);
    getJson<T>(url).then(
      (d) => {
        if (live) setData(d);
      },
      () => {
        // A failed background refresh keeps showing what we had.
        if (live && !hasData.current) setError(true);
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
