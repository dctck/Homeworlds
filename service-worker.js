const CACHE_NAME = 'hwarena-v1';

self.addEventListener('install', e => self.skipWaiting());
self.addEventListener('activate', e => e.waitUntil(clients.claim()));

self.addEventListener('push', e => {
  if (!e.data) return;
  const data = e.data.json();
  // data shape: { title, body, gameId }
  const options = {
    body: data.body || 'Your turn!',
    icon: '/assets/appIcons/icon-192.png',
    badge: '/assets/appIcons/badge-72.png',
    tag: data.gameId || 'hwarena',   // collapses duplicate notifications per game
    renotify: true,
    data: { gameId: data.gameId }
  };
  e.waitUntil(self.registration.showNotification(data.title || 'Homeworlds Arena', options));
});

self.addEventListener('notificationclick', e => {
  e.notification.close();
  const gameId = e.notification.data && e.notification.data.gameId;
  const playerSlot = e.notification.data && e.notification.data.playerSlot;
  const url = gameId ? `/game/?room=${gameId}&player=${playerSlot||1}` : '/lobby/';
  e.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then(list => {
      for (const client of list) {
        if (client.url.includes(gameId) && 'focus' in client) return client.focus();
      }
      return clients.openWindow(url);
    })
  );
});