// Service worker minimale: mette in cache solo la shell statica. Le chiamate /api non sono mai in cache.
const CACHE = "ats-shell-v14";
const SHELL = ["./", "style.css", "core.js", "library.js", "new.js", "live.js", "ai.js", "editor.js", "notebook.js", "notes.js", "ink.js", "misc.js", "icon.svg", "manifest.json"];
self.addEventListener("install", e => e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting())));
self.addEventListener("activate", e => e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim())));
self.addEventListener("fetch", e => {
  const u = new URL(e.request.url);
  if (u.pathname.startsWith("/api/") || e.request.method !== "GET") return;
  e.respondWith(fetch(e.request).then(r => { const c = r.clone(); caches.open(CACHE).then(x => x.put(e.request, c)); return r; }).catch(() => caches.match(e.request)));
});

// Clic su una notifica: porta in primo piano l'app (o la apre) sulla pagina giusta.
self.addEventListener("notificationclick", e => {
  e.notification.close();
  const url = (e.notification.data && e.notification.data.url) || "#/";
  e.waitUntil(self.clients.matchAll({ type: "window", includeUncontrolled: true }).then(cs => {
    for (const c of cs) { if ("focus" in c) { c.navigate ? c.navigate(self.registration.scope + url) : null; return c.focus(); } }
    return self.clients.openWindow(self.registration.scope + url);
  }));
});
