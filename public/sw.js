const CACHE_NAME = 'savetube-v1';
const STATIC_ASSETS = [
    '/',
    '/index.html',
    '/style.css',
    '/app.js',
    '/icons/icon-192.png',
    '/icons/icon-512.png',
];

// Install — cache static assets
self.addEventListener('install', (e) => {
    e.waitUntil(
        caches.open(CACHE_NAME).then((cache) => cache.addAll(STATIC_ASSETS))
    );
    self.skipWaiting();
});

// Activate — clean old caches
self.addEventListener('activate', (e) => {
    e.waitUntil(
        caches.keys().then((keys) =>
            Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
        )
    );
    self.clients.claim();
});

// Fetch — cache-first for static, network-first for API
self.addEventListener('fetch', (e) => {
    const url = new URL(e.request.url);

    // Never cache API calls
    if (url.pathname.startsWith('/api/')) return;

    e.respondWith(
        caches.match(e.request).then((cached) => {
            const fetchPromise = fetch(e.request).then((resp) => {
                if (resp.ok) {
                    const clone = resp.clone();
                    caches.open(CACHE_NAME).then((cache) => cache.put(e.request, clone));
                }
                return resp;
            }).catch(() => cached);

            return cached || fetchPromise;
        })
    );
});
