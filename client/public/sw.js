/* Daybook service worker: keeps the app shell on the device so the app opens
 * fast from the home screen. Deliberately small:
 *   - /api/* is never touched: budget data always comes from the network.
 *   - Navigations are network-first, falling back to the cached index.html
 *     only when offline, so a deploy is picked up on the next load.
 *   - Hashed /assets/* files are immutable, so they are served cache-first.
 * Bump VERSION to drop every old cache on the next activate. */
const VERSION = "v1";
const CACHE = `daybook-shell-${VERSION}`;

// Precache index.html plus the hashed bundles it references, so the second
// open (and an offline one) needs no network for the shell.
const assetsIn = (html) => [...new Set(html.match(/\/assets\/[^"'\s)]+/g) || [])];

async function precache() {
  const cache = await caches.open(CACHE);
  const res = await fetch("/", { cache: "no-cache" });
  if (!res.ok) throw new Error(`shell ${res.status}`);
  const html = await res.clone().text();
  await cache.put("/", res);
  await cache.addAll(["/manifest.webmanifest", ...assetsIn(html)]);
}

// After a fresh index.html arrives, drop bundles the new build no longer
// references so the cache doesn't grow with every deploy. (The client has no
// lazy chunks: everything it loads is linked from index.html.)
async function refreshShell(res) {
  const cache = await caches.open(CACHE);
  const html = await res.clone().text();
  await cache.put("/", res);
  const keep = new Set(assetsIn(html));
  for (const req of await cache.keys()) {
    const path = new URL(req.url).pathname;
    if (path.startsWith("/assets/") && !keep.has(path)) await cache.delete(req);
  }
}

self.addEventListener("install", (event) => {
  event.waitUntil(precache().then(() => self.skipWaiting()));
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k.startsWith("daybook-") && k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin || url.pathname.startsWith("/api/")) return;

  if (req.mode === "navigate") {
    event.respondWith(
      fetch(req)
        .then((res) => {
          // Only the shell itself is cached; every app route renders it.
          const html = (res.headers.get("content-type") || "").includes("text/html");
          if (res.ok && html) event.waitUntil(refreshShell(res.clone()));
          return res;
        })
        .catch(() => caches.match("/").then((hit) => hit || Response.error()))
    );
    return;
  }

  if (url.pathname.startsWith("/assets/")) {
    event.respondWith(
      caches.match(req).then(
        (hit) =>
          hit ||
          fetch(req).then((res) => {
            if (res.ok) {
              const copy = res.clone();
              caches.open(CACHE).then((cache) => cache.put(req, copy));
            }
            return res;
          })
      )
    );
  }
});
