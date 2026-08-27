const VERSION = 'video-pwa-v19';
const OFFLINE_DB = 'video-offline-hls';
const OFFLINE_DB_VERSION = 3;
const OFFLINE_ASSETS = 'assets';
const APP_SHELL = [
  './', './index.html', './episode-download.js', './offline-hls.js', './offline-hls-core.js', './episode-download.css',
  './assets/index-e5BS_vQK.js', './assets/index-DWyknnYL.css',
  './assets/vendor-DS5UYnvf.js', './assets/player-B6lhAZ8n.js',
  './manifest.webmanifest', './app-icon.svg', './app-icon-maskable.svg',
  './apple-touch-icon-180.png', './pwa-192x192.png', './pwa-512x512.png',
  './maskable-192x192.png', './maskable-512x512.png'
];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(VERSION).then((cache) => cache.addAll(APP_SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((key) => key !== VERSION && key !== 'video-hls-v1').map((key) => caches.delete(key)))).then(() => self.clients.claim()));
});

const isHlsAsset = (url) => /\.(m3u8|ts|m4s|aac)(?:$|[?#])/i.test(url.pathname + url.search);
const isAppAsset = (url) => url.origin === self.location.origin;
const unavailableResponse = () => new Response('Resource temporarily unavailable', {
  status: 503,
  headers: { 'Cache-Control': 'no-store' },
});

const getOfflineAsset = (episodeId, assetPath) => new Promise((resolve, reject) => {
  const request = indexedDB.open(OFFLINE_DB, OFFLINE_DB_VERSION);
  request.onupgradeneeded = () => {
    const database = request.result;
    if (!database.objectStoreNames.contains('episodes')) database.createObjectStore('episodes', { keyPath: 'id' });
    if (!database.objectStoreNames.contains(OFFLINE_ASSETS)) {
      const store = database.createObjectStore(OFFLINE_ASSETS, { keyPath: 'id' });
      store.createIndex('episodeId', 'episodeId', { unique: false });
    }
    if (!database.objectStoreNames.contains('downloads')) database.createObjectStore('downloads', { keyPath: 'id' });
  };
  request.onerror = () => reject(request.error || new Error('离线数据库不可用'));
  request.onsuccess = () => {
    const database = request.result;
    database.onversionchange = () => database.close();
    try {
      if (!database.objectStoreNames.contains(OFFLINE_ASSETS)) { database.close(); reject(new Error('离线资源表不存在')); return; }
      const assetRequest = database.transaction(OFFLINE_ASSETS, 'readonly').objectStore(OFFLINE_ASSETS).get(`${episodeId}:${assetPath}`);
      assetRequest.onsuccess = () => { const asset = assetRequest.result || null; database.close(); resolve(asset); };
      assetRequest.onerror = () => { const error = assetRequest.error || new Error('离线资源读取失败'); database.close(); reject(error); };
    } catch (error) {
      database.close();
      reject(error);
    }
  };
});

const offlineResponse = async (url) => {
  const parts = url.pathname.split('/').filter(Boolean).slice(1);
  if (parts.length < 2) return new Response('Offline asset not found', { status: 404 });
  let episodeId;
  let assetPath;
  try { episodeId = decodeURIComponent(parts.shift()); assetPath = parts.map((part) => decodeURIComponent(part)).join('/'); } catch { return new Response('Offline asset not found', { status: 404 }); }
  try {
    const asset = await getOfflineAsset(episodeId, assetPath);
    if (!asset?.body) return new Response('Offline asset not found', { status: 404 });
    return new Response(asset.body, { status: 200, headers: { 'Content-Type': asset.contentType || 'application/octet-stream', 'Content-Length': String(asset.size || asset.body.size || 0), 'Cache-Control': 'public, max-age=31536000, immutable' } });
  } catch {
    return new Response('Offline asset unavailable', { status: 503 });
  }
};

self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return;
  const url = new URL(event.request.url);
  if (isAppAsset(url) && url.pathname.startsWith('/offline-hls/')) {
    event.respondWith(offlineResponse(url));
    return;
  }
  // Do not intercept cross-origin HLS requests. The browser/player must handle
  // those directly; intercepting them makes CORS failures become Response.error().
  if (isAppAsset(url) && isHlsAsset(url)) {
    event.respondWith(caches.open('video-hls-v1').then(async (cache) => {
      const cached = await cache.match(event.request);
      if (cached) return cached;
      try {
        const response = await fetch(event.request);
        if (response.ok || response.type === 'opaque') {
          const cacheResponse = response.clone();
          event.waitUntil(cache.put(event.request, cacheResponse).catch(() => {}));
        }
        return response;
      } catch {
        // Response.error() makes the FetchEvent itself fail and produces the
        // browser warning: "promise was resolved with an error response object".
        // Return a normal HTTP error so callers can handle it and retry.
        return cached || new Response(JSON.stringify({ ok: false, code: 'UPSTREAM_UNAVAILABLE', message: '视频资源暂时无法访问', retryable: true }), {
          status: 503,
          headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
        });
      }
    }));
    return;
  }
  if (!isAppAsset(url)) return;
  event.respondWith(caches.match(event.request).then((cached) => cached || fetch(event.request).then((response) => {
    if (response.ok) {
      const cacheResponse = response.clone();
      event.waitUntil(caches.open(VERSION).then((cache) => cache.put(event.request, cacheResponse)).catch(() => {}));
    }
    return response;
  }).catch(() => event.request.mode === 'navigate'
    ? caches.match('./index.html')
    : unavailableResponse())));
});
