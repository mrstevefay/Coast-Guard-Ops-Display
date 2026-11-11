/* Crew app service worker add-on: show a pushed alert, and open the app when it is tapped. */
self.addEventListener('push', (event) => {
  let d = {};
  try {
    d = event.data ? event.data.json() : {};
  } catch {
    d = { body: event.data ? event.data.text() : '' };
  }
  event.waitUntil(
    self.registration.showNotification(d.title || 'Howth Coast Guard', {
      body: d.body || '',
      tag: d.tag || 'cg',
      renotify: true,
      requireInteraction: Boolean(d.urgent),
      icon: '/m/icons/icon-192.png',
      badge: '/m/icons/icon-192.png',
      vibrate: d.urgent ? [400, 150, 400, 150, 400, 150, 800] : [200],
      data: { url: d.url || '/m/' },
    }),
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const target = new URL((event.notification.data && event.notification.data.url) || '/m/', self.location.origin);
  event.waitUntil(
    (async () => {
      const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      // an open copy of the same app: bring it forward and tell it where to go
      const open = windows.find((c) => new URL(c.url).pathname === target.pathname);
      if (open) {
        open.postMessage({ type: 'push-open', hash: target.hash });
        return open.focus();
      }
      return self.clients.openWindow(target.href);
    })(),
  );
});
