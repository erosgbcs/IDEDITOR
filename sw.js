/* IDEDITOR offline application shell and opportunistic CDN cache. */
'use strict';
const SHELL_CACHE = 'ideditor-shell-v3';
const CDN_CACHE = 'ideditor-cdn-v1';
const SHELL_ASSETS = ['./','./index.html','./style.css','./script.js','./ai-agents.js','./editor-core.js','./project-storage.js','./manifest.json','./icon.svg'];
const CDN_HOSTS = new Set(['cdn.jsdelivr.net','cdnjs.cloudflare.com','www.gstatic.com']);
self.addEventListener('install', event => {
  event.waitUntil(caches.open(SHELL_CACHE).then(cache => cache.addAll(SHELL_ASSETS)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', event => {
  event.waitUntil(caches.keys().then(keys => Promise.all(
    keys.filter(key => key.startsWith('ideditor-shell-') && key !== SHELL_CACHE).map(key => caches.delete(key))
  )).then(() => self.clients.claim()));
});
self.addEventListener('fetch', event => {
  const request = event.request;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin === self.location.origin) {
    if (request.mode === 'navigate') {
      event.respondWith(fetch(request).then(response => {
        caches.open(SHELL_CACHE).then(cache => cache.put('./index.html', response.clone()));
        return response;
      }).catch(async () => (await caches.match('./index.html')) || Response.error()));
      return;
    }
    event.respondWith(caches.match(request).then(cached => cached || fetch(request).then(response => {
      if (response.ok) caches.open(SHELL_CACHE).then(cache => cache.put(request, response.clone()));
      return response;
    })));
    return;
  }
  if (CDN_HOSTS.has(url.hostname) && (['script', 'style', 'worker'].includes(request.destination))) {
    event.respondWith(caches.open(CDN_CACHE).then(async cache => {
      const cached = await cache.match(request);
      if (cached) return cached;
      try {
        const response = await fetch(request);
        if (response.ok || response.type === 'opaque') {
          try { await cache.put(request, response.clone()); } catch (cacheError) {}
        }
        return response;
      } catch (error) {
        return cached || Response.error();
      }
    }));
  }
});
