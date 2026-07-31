// 来場者アプリ visit.html の Service Worker
// VERSION を上げるとキャッシュを作り直す(バスト)。
const VERSION = "v4";
const CORE_CACHE = `pmv-core-${VERSION}`;
const POSTER_CACHE = `pmv-posters-${VERSION}`;

// プリキャッシュ(SW の置き場所=サイトルート基準)
const CORE = [
  "./visit.html",
  "./manifest.webmanifest",
  "./assets/visit/graphic.js",
  "./assets/visit/qr.js",
  "./assets/leaflet.svg",
  "./assets/visit/title-ja.svg",
  "./assets/visit/title-en.svg",
  "./data/works.json",
  "./data/sections.json",
];

self.addEventListener("install", (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CORE_CACHE);
    // 1つ失敗しても install 全体を落とさない
    await Promise.all(CORE.map((url) =>
      cache.add(new Request(url, { cache: "reload" })).catch((e) => console.warn("[sw] precache", url, e))
    ));
    await self.skipWaiting();
  })());
});

self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys
      .filter((k) => k.startsWith("pmv-") && k !== CORE_CACHE && k !== POSTER_CACHE)
      .map((k) => caches.delete(k)));
    await self.clients.claim();
  })());
});

self.addEventListener("message", (event) => {
  if (event.data && event.data.type === "SKIP_WAITING") self.skipWaiting();
});

const isPoster = (url) => url.pathname.includes("/assets/posters/");
const isApi = (url) => url.pathname.includes("/api/");

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;

  let url;
  try { url = new URL(req.url); } catch (e) { return; }
  if (url.origin !== self.location.origin) return;   // Google Fonts 等はそのまま
  if (isApi(url)) return;                            // ジョブ送信・取得は常にネットワーク

  // ポスター画像: cache-first のランタイムキャッシュ
  if (isPoster(url)) {
    event.respondWith((async () => {
      const cache = await caches.open(POSTER_CACHE);
      const hit = await cache.match(req);
      if (hit) return hit;
      try {
        const res = await fetch(req);
        if (res && res.ok) cache.put(req, res.clone());
        return res;
      } catch (e) {
        return hit || Response.error();
      }
    })());
    return;
  }

  // ナビゲーション: ネットワーク優先 → 失敗したらキャッシュした visit.html
  if (req.mode === "navigate") {
    event.respondWith((async () => {
      try {
        return await fetch(req);
      } catch (e) {
        const cache = await caches.open(CORE_CACHE);
        return (await cache.match(req)) || (await cache.match("./visit.html")) || Response.error();
      }
    })());
    return;
  }

  // その他の同一オリジン資産: cache-first + バックグラウンド更新
  event.respondWith((async () => {
    const cache = await caches.open(CORE_CACHE);
    const hit = await cache.match(req);
    const net = fetch(req).then((res) => {
      if (res && res.ok) cache.put(req, res.clone());
      return res;
    }).catch(() => null);
    return hit || (await net) || Response.error();
  })());
});
