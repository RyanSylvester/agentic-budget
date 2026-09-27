import React from "react";

/* Test double for the app's fetch-based data layer. Components fetch relative
   URLs ("/api/pots?month=2026-09") inside useEffect, so the stub installs
   synchronously during the decorator's render, before any child effects run.
   Unmocked routes answer 404, which surfaces the component's own error state
   instead of hanging on a skeleton. */

export interface MockApiConfig {
  /** Exact "GET <url>" matches, e.g. { "/api/pots?month=2026-09": { pots: [] } }.
      Values may be JSON, a (url) => JSON fn, or a fn returning a Promise
      (return a never-resolving promise to hold the loading state). */
  get?: Record<string, unknown | ((url: string) => unknown | Promise<unknown>)>;
  /** Exact "POST <url>" matches; values may be JSON or a (body) => JSON fn */
  post?: Record<string, unknown | ((body: unknown) => unknown)>;
  /** GET urls that should fail with a 500 */
  failGet?: string[];
  /** POST urls that should fail with a 500 */
  failPost?: string[];
}

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json" },
  });

export function createFetchStub(config: MockApiConfig): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === "string" ? input : input.toString();
    const method = (init?.method ?? "GET").toUpperCase();
    if (method === "GET") {
      if (config.failGet?.includes(url)) return new Response("mock failure", { status: 500 });
      const hit = config.get?.[url];
      if (hit !== undefined) {
        const data = typeof hit === "function" ? await (hit as (u: string) => unknown)(url) : hit;
        return json(data);
      }
    } else if (method === "POST") {
      if (config.failPost?.includes(url)) return new Response("mock failure", { status: 500 });
      const handler = config.post?.[url];
      if (handler !== undefined) {
        let body: unknown;
        try {
          body = init?.body ? JSON.parse(init.body as string) : undefined;
        } catch {
          body = undefined;
        }
        return json(typeof handler === "function" ? (handler as (b: unknown) => unknown)(body) : handler);
      }
    }
    return new Response("not mocked", { status: 404 });
  }) as typeof fetch;
}

/** Decorator wrapper: installs the stub before children render, restores after. */
export function MockApi({
  config,
  children,
}: {
  config?: MockApiConfig;
  children: React.ReactNode;
}) {
  const ref = React.useRef<{ prev: typeof fetch } | null>(null);
  if (!ref.current) {
    const prev = window.fetch;
    ref.current = { prev };
    window.fetch = createFetchStub(config ?? {});
  }
  React.useEffect(() => {
    return () => {
      if (ref.current) {
        window.fetch = ref.current.prev;
        ref.current = null;
      }
    };
  }, []);
  return <>{children}</>;
}
