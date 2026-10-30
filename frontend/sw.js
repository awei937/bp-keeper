/* 血压管家 — Service Worker：静态资源离线缓存（网络优先，失败回退缓存）
   HTTP（非 localhost）环境下注册失败时由页面静默降级，不影响使用。 */
var CACHE_NAME = 'bp-shell-v1';
var ASSETS = [
  './',
  './index.html',
  './css/app.css',
  './js/icons.js',
  './js/core.js',
  './js/views.js',
  './js/app.js',
  './js/mock.js',
  './vendor/chart.umd.min.js',
  './manifest.webmanifest',
  './icons/icon.svg',
  './icons/icon-192.png',
  './icons/icon-512.png'
];

self.addEventListener('install', function (event) {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(function (cache) { return cache.addAll(ASSETS).catch(function () { /* 个别资源缺失不阻塞安装 */ }); })
      .then(function () { return self.skipWaiting(); })
  );
});

self.addEventListener('activate', function (event) {
  event.waitUntil(
    caches.keys().then(function (keys) {
      return Promise.all(keys.filter(function (k) { return k !== CACHE_NAME; })
        .map(function (k) { return caches.delete(k); }));
    }).then(function () { return self.clients.claim(); })
  );
});

self.addEventListener('fetch', function (event) {
  var request = event.request;
  if (request.method !== 'GET') return;
  var url;
  try { url = new URL(request.url); } catch (e) { return; }
  if (url.origin !== self.location.origin) return;
  // 接口请求永远走网络，不做缓存
  if (url.pathname.indexOf('/api/') === 0) return;

  event.respondWith(
    fetch(request).then(function (response) {
      if (response && response.ok) {
        var copy = response.clone();
        caches.open(CACHE_NAME).then(function (cache) {
          cache.put(request, copy).catch(function () { /* ignore */ });
        });
      }
      return response;
    }).catch(function () {
      return caches.match(request).then(function (cached) {
        if (cached) return cached;
        if (request.mode === 'navigate') {
          return caches.match('./index.html');
        }
        return new Response('离线且无缓存', { status: 503, statusText: 'offline' });
      });
    })
  );
});
