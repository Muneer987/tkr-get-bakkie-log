// Keeps the app's own files working with no signal. Bump VERSION when the app files change.
// Firebase traffic (other websites) is never touched here; Firebase keeps its own offline copy.
const VERSION = "v7";
const FILES = ["./", "index.html", "style.css", "manifest.webmanifest",
  "icons/icon-192.png", "icons/icon-512.png", "icons/maskable-192.png", "icons/maskable-512.png", "icons/logo-96.png",
  "lib/xlsx.full.min.js", "lib/jszip.min.js", "lib/firebase.js",
  "get/", "get/index.html", "get/style.css", "get/app.js",
  "tasks/", "tasks/index.html", "tasks/tasks.css", "tasks/app.js"];

self.addEventListener("install", e => { e.waitUntil(caches.open(VERSION).then(c => c.addAll(FILES))); self.skipWaiting(); });
self.addEventListener("activate", e => {
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== VERSION).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
// Network first so updates arrive when there is signal; cached copy when there is not.
self.addEventListener("fetch", e => {
  if (e.request.method !== "GET" || new URL(e.request.url).origin !== self.location.origin) return;
  e.respondWith(fetch(e.request, { cache: "no-cache" }).then(r => { const copy = r.clone(); caches.open(VERSION).then(c => c.put(e.request, copy)); return r; })
    .catch(() => caches.match(e.request, { ignoreSearch: true }).then(r => r || caches.match("index.html"))));
});
