// Service worker. Notifications look like an ordinary news alert (the server sends a real headline), so a glance at
// the screen reveals nothing about a chat.
// v2: never caches the app. On activate it wipes every cache left behind by older versions of this site
// (e.g. the old "e-browser-v1" shell) so every device always runs the latest deploy.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) =>
  e.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  )
);

// Browsers only offer "Install app" when the worker has a fetch handler. This one never caches:
// page loads go straight to the network, so every device always gets the latest deploy.
self.addEventListener('fetch', (event) => {
  if (event.request.mode === 'navigate') event.respondWith(fetch(event.request));
});

self.addEventListener('push', (event) => {
  let data = {};
  try { data = event.data ? event.data.json() : {}; } catch (e) {}
  const urgent = data.type === 'call';
  event.waitUntil(
    Promise.all([
      self.registration.showNotification(data.title || 'Top stories', {
        body: data.body || 'Tap to read the latest headlines',
        icon: '/icon-192.png',
        badge: '/favicon.png',
        tag: urgent ? 'news-urgent' : 'news',
        renotify: true,
        requireInteraction: urgent,
        vibrate: urgent ? [400, 200, 400, 200, 400] : [150],
        data: { url: '/' },
      }),
      // Tell any open page "the push arrived on this device" (used by Settings -> Send test notification).
      self.clients
        .matchAll({ type: 'window', includeUncontrolled: true })
        .then((list) => list.forEach((c) => c.postMessage({ type: 'push-received', kind: data.type || 'message' }))),
    ])
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((list) => {
      for (const c of list) { if ('focus' in c) return c.focus(); }
      return self.clients.openWindow('/');
    })
  );
});
