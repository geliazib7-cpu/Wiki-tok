// Service worker: guarda la app para que abra rápido y se pueda instalar.
// La voz y los mensajes siempre van por internet (no se cachean).
const CACHE = "walkie-claves-v3";
const FILES = [
  "./",
  "./index.html",
  "./style.css",
  "./claves.js",
  "./app.js",
  "./peerjs.min.js",
  "./manifest.json",
  "./icon-192.png",
  "./icon-512.png",
];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(FILES)));
  self.skipWaiting();
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
  );
  self.clients.claim();
});

self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin !== location.origin) return; // servidor de conexión de PeerJS, etc.
  // Primero red (para recibir actualizaciones), si no hay red usa lo guardado
  e.respondWith(
    fetch(req)
      .then((res) => {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(req, copy));
        return res;
      })
      .catch(() => caches.match(req).then((r) => r || caches.match("./index.html")))
  );
});
