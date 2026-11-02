const C = "od-shell-v1";
const SHELL = ["./", "index.html", "app.js", "worker.js", "manifest.json", "icon-192.png"];
self.addEventListener("install", e => { e.waitUntil(caches.open(C).then(c => c.addAll(SHELL)).then(() => self.skipWaiting())); });
self.addEventListener("activate", e => { e.waitUntil(caches.keys().then(k => Promise.all(k.filter(x => x.startsWith("od-shell-") && x !== C).map(x => caches.delete(x)))).then(() => self.clients.claim())); });
self.addEventListener("fetch", e => {
  const u = new URL(e.request.url);
  if (e.request.method !== "GET") return;
  // libreria dal CDN e file locali: rete, con copia salvata per l'uso offline. I pesi dei modelli li salva transformers.js (Cache API).
  if (u.origin === location.origin || u.hostname === "cdn.jsdelivr.net") {
    e.respondWith(fetch(e.request).then(r => { if (r.ok) { const cp = r.clone(); caches.open(C).then(c => c.put(e.request, cp)); } return r; }).catch(() => caches.match(e.request)));
  }
});
