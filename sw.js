// sw.js — Service Worker para sa San Antonio Water Supply Collector App
// I-cache ang lahat ng files → gumana kahit walang internet pagkatapos ng unang load

const CACHE_NAME = 'saws-collector-v1';

// Lahat ng files na kailangan ng app para gumana offline
const FILES_TO_CACHE = [
  './',
  './account.html',
  './account.css',
  './shared.js',
  './collector.js'
];

// ── INSTALL: i-cache ang lahat ng files ──
self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache => {
      return cache.addAll(FILES_TO_CACHE);
    })
  );
  // Agad na mag-activate, hindi na mag-aantay sa lumang SW
  self.skipWaiting();
});

// ── ACTIVATE: burahin ang lumang cache ──
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(
        keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k))
      )
    )
  );
  self.clients.claim();
});

// ── FETCH: Cache-first para sa app files; Network-first para sa API calls ──
self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);

  // API calls (Google Script) → palaging network, huwag i-cache
  if (url.hostname.includes('script.google.com') ||
      url.hostname.includes('googleapis.com')) {
    event.respondWith(fetch(event.request).catch(() =>
      new Response(JSON.stringify({ error: 'offline' }), {
        headers: { 'Content-Type': 'application/json' }
      })
    ));
    return;
  }

  // App files → Cache-first: kung nasa cache, gamitin agad
  // Kung hindi, kumuha sa network at i-cache
  event.respondWith(
    caches.match(event.request).then(cached => {
      if (cached) return cached;
      return fetch(event.request).then(response => {
        // I-cache lang ang successful responses
        if (!response || response.status !== 200 || response.type !== 'basic') {
          return response;
        }
        const toCache = response.clone();
        caches.open(CACHE_NAME).then(cache => cache.put(event.request, toCache));
        return response;
      });
    })
  );
});
