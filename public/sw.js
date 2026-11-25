// Service worker. Notifications are deliberately generic so a glance at the lock screen reveals nothing.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));

self.addEventListener('push', (event) => {
  let data = {};
  try { data = event.data ? event.data.json() : {}; } catch (e) {}
  const urgent = data.type === 'call';
  event.waitUntil(
    self.registration.showNotification('Web Browser', {
      body: 'New notification',
      icon: '/icon-192.png',
      badge: '/favicon.png',
      tag: urgent ? 'r-urgent' : 'r-normal',
      renotify: true,
      requireInteraction: urgent,
      vibrate: urgent ? [400, 200, 400, 200, 400] : [150],
      data: { url: '/' },
    })
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
