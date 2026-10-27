// Service worker: guarda la app para que abra rápido y se pueda instalar.
// La voz y los mensajes siempre van por internet (no se cachean).
const CACHE = "walkie-claves-v2";
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
