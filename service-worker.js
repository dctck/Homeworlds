const CACHE_NAME = 'hwarena-v1';

self.addEventListener('install', e => self.skipWaiting());
self.addEventListener('activate', e => e.waitUntil(
  clients.claim().then(() => console.log('[SW] Clients claimed'))
));

self.addEventListener('push', e => {
  if (!e.data) return;
  const data = e.data.json();
  const options = {
    body: data.body || 'Your turn!',
    data: { gameId: data.gameId, playerSlot: data.playerSlot }
  };
  // Notify open clients for debug
  clients.matchAll({ type: 'window', includeUncontrolled: true }).then(list => {
    list.forEach(c => c.postMessage({ type: 'PUSH_RECEIVED', body: data.body }));
  });
  e.waitUntil(self.registration.showNotification(data.title || 'Homeworlds Arena', options));
});

self.addEventListener('notificationclick', e => {
  e.notification.close();
  const data = e.notification.data || {};
  const gameId = data.gameId;
  const playerSlot = data.playerSlot || 1;
  const url = gameId ? `/game/?room=${gameId}&player=${playerSlot}` : '/lobby/';
  e.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then(list => {
      const exactMatch = list.find(c => c.url.includes(gameId));
      if (exactMatch) return exactMatch.focus();
      const anyTab = list.find(c => c.url.includes('hwarena.xyz'));
      if (anyTab) return anyTab.navigate(url).then(c => c.focus());
      return clients.openWindow(url);
    })
  );
});