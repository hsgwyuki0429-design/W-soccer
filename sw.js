// sw.js — ホーム画面から起動したときにオフラインでも動くようにするだけのもの。
// ビルドしないので、バージョンを上げればそのまま入れ替わる。

const VERSION = 'pairkick-v1';
const SHELL = [
  './',
  './index.html',
  './style.css',
  './favicon.svg',
  './manifest.webmanifest',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/icon-maskable-512.png',
  './src/main.js',
  './src/config.js',
  './src/game.js',
  './src/bot.js',
  './src/input.js',
  './src/render.js',
  './src/effects.js',
  './src/audio.js',
  './src/ui.js',
  './src/net.js',
];

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(VERSION)
      // 1つでも失敗すると全部落ちるので、個別に入れる
      .then((c) => Promise.all(SHELL.map((u) => c.add(u).catch(() => {}))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  // WebSocket や API は触らない
  if (url.pathname.endsWith('/ws')) return;

  // HTML と JS は「まずネット、駄目ならキャッシュ」。
  // 更新をすぐ拾いたい一方、オフラインでも起動させたいため。
  const fresh = req.mode === 'navigate' || url.pathname.endsWith('.js') || url.pathname.endsWith('.html');
  if (fresh) {
    e.respondWith(
      fetch(req)
        .then((res) => {
          const copy = res.clone();
          caches.open(VERSION).then((c) => c.put(req, copy)).catch(() => {});
          return res;
        })
        .catch(() => caches.match(req).then((r) => r || caches.match('./index.html')))
    );
    return;
  }
  e.respondWith(caches.match(req).then((r) => r || fetch(req)));
});
