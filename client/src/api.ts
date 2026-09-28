import { useEffect, useState } from "react";

/* Small fetch hook with loading + error states. A failed fetch surfaces a
   retryable error instead of hanging on a skeleton forever. Shared by the
   app shell and tab components. */
export function useApi<T>(url: string | null): {
  data: T | null;
  error: boolean;
  loading: boolean;
  retry: () => void;
} {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState(false);
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    if (!url) return;
    let live = true;
    setError(false);
    fetch(url)
      .then(async (r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const ct = r.headers.get("content-type") ?? "";
        if (!ct.includes("json")) throw new Error("not JSON");
        return (await r.json()) as T;
      })
      .then((d) => {
        if (live) setData(d);
      })
      .catch(() => {
        if (live) setError(true);
      });
    return () => {
      live = false;
    };
  }, [url, nonce]);

  return { data, error, loading: data === null && !error, retry: () => setNonce((n) => n + 1) };
}
