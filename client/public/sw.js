/**
 * PenPal service worker.
 *
 * Scope of the one promise it keeps: after your first visit, the shell (the
 * app's own HTML, JS, CSS and fonts) opens without a network. So does your
 * half-finished draft, because that is React state, not a request.
 *
 * Scope of what it refuses to touch:
 *
 *   - `/api/**` and `/uploads/**` are never intercepted and never cached. A
 *     letter body is ciphertext your key decrypts in the moment; a photo is
 *     somebody's plaintext. Storing either in a cache the next person on this
 *     device could read (devtools, a shared computer) would trade real privacy
 *     for convenience the product does not need.
 *   - Navigation requests are network-first. Deployments reach a reader the
 *     moment they have connectivity again, and the cached shell is only for
 *     the train, not the desk.
 *
 * Versioned cache names, cleaned on activate. Bump the name when the root
 * document's asset filenames change in a way you need to force offline.
 */
const CACHE = 'penpal-shell-v3';
const PRECACHE = ['/', '/site.webmanifest'];

/**
 * The route chunks are lazy, so the list of emitted assets has to come from the
 * build. A missing manifest is an older deploy or a hand-built dist; install
 * still runs and precaches what it has, which is most of the way to offline
 * but not all of it — the screen stays honest about that by failing into the
 * browser's own error page rather than a half-working shell.
 */
async function precacheList() {
  try {
    const res = await fetch('/sw-manifest.json');
    if (!res.ok) return PRECACHE;
    return [...PRECACHE, ...(await res.json())];
  } catch {
    return PRECACHE;
  }
}

self.addEventListener('install', (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(CACHE);
      await Promise.all((await precacheList()).map((path) => cache.add(path).catch(() => undefined)));
      await self.skipWaiting();
    })(),
  );
});

self.addEventListener('activate', (event) => {
  const names = [CACHE];
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => !names.includes(k)).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  // The data. Never cached, never intercepted: a failing letter fetch must
  // read as a failing letter fetch, and a photo server is nobody's cache.
  if (
    url.pathname.startsWith('/api/') ||
    url.pathname.startsWith('/uploads/') ||
    url.pathname === '/healthz'
  ) {
    return;
  }

  // A navigation. Network first so a deployment is adopted the same day it
  // ships; the cached root is the offline answer, not the preferred one.
  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request)
        .then((response) => {
          const copy = response.clone();
          caches.open(CACHE).then((cache) => cache.put('/', copy));
          return response;
        })
        .catch(() => caches.match('/', { ignoreVary: true }).then((page) => page ?? Response.error())),
    );
    return;
  }

  // Everything else that is immutable by construction: hashed bundles under
  // /assets/ and fingerprints in the font filenames. Cache first, because a
  // name collision here means the content changed, which the name promises
  // it will not.
  const cached =
    url.pathname.startsWith('/assets/') ||
    url.pathname.startsWith('/fonts/') ||
    url.pathname === '/favicon.ico' ||
    url.pathname.startsWith('/icon-') ||
    url.pathname.startsWith('/apple-touch-icon') ||
    url.pathname.startsWith('/favicon-');
  if (cached) {
    event.respondWith(
      // ignoreVary: the server marks every asset `Vary: Origin`, and a match
      // against it is a coin flip for a script request that looks different
      // from the install-time one. Everything this worker is ever asked for is
      // same-origin, by the origin check above, so the header carries nothing.
      caches.match(request, { ignoreVary: true }).then(
        (hit) =>
          hit ??
          fetch(request).then((response) => {
            const copy =
              response && response.status === 200 && response.type === 'basic' ? response.clone() : null;
            if (copy) caches.open(CACHE).then((cache) => cache.put(request, copy));
            return response;
          }),
      ),
    );
  }
});
