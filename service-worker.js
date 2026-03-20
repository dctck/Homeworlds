self.addEventListener('notificationclick', e => {
  e.notification.close();
  const data = e.notification.data || {};
  const gameId = data.gameId;
  const playerSlot = data.playerSlot || 1;
  const url = gameId ? `/game/?room=${gameId}&player=${playerSlot}` : '/lobby/';

  e.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then(list => {
      // Prefer a tab already on this game
      const exactMatch = list.find(c => c.url.includes(gameId));
      if (exactMatch) return exactMatch.focus();
      // Otherwise navigate any open hwarena tab
      const anyTab = list.find(c => c.url.includes('hwarena.xyz'));
      if (anyTab) return anyTab.navigate(url).then(c => c.focus());
      // No open tab — open new window
      return clients.openWindow(url);
    })
  );
});