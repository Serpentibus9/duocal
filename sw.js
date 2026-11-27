// sw.js — lets DuoCal open instantly and offline once installed.
// Only DuoCal's own files are cached. Google traffic (your calendar data and
// sign-in) is NEVER cached or touched here.
// Updates: the network is tried first, so a new version shows up on the next open.
const CACHE = 'duocal-v7';
const FILES = ['./', 'index.html', 'styles.css', 'icon.svg', 'icon-512.png', 'apple-touch-icon.png', 'manifest.webmanifest',
  'js/config.js', 'js/validate.js', 'js/recur.js', 'js/ics.js', 'js/export.js', 'js/importers.js', 'js/gauth.js', 'js/gstore.js', 'js/app.js', 'vendor/exceljs.min.js'];

self.addEventListener('install', e => { e.waitUntil(caches.open(CACHE).then(c => c.addAll(FILES)).then(() => self.skipWaiting())); });
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== self.location.origin) return; // Google & everything else: straight to the network
  if (url.search || url.hash) return;
  e.respondWith(
    fetch(e.request).then(res => {
      if (res.ok && res.type === 'basic') { const copy = res.clone(); caches.open(CACHE).then(c => c.put(e.request, copy)); }
      return res;
    }).catch(() => caches.match(e.request).then(r => r || caches.match('index.html')))
  );
});
