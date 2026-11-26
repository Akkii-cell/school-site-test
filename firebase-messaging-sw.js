// 閉じていても届く通知を表示する
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', e => e.waitUntil(self.clients.claim()));
self.addEventListener('push', e => {
  let d = {};
  try { d = e.data.json().data || {}; } catch (_) {}
  e.waitUntil(self.registration.showNotification(d.title || '共有サイト', {
    body: d.body || '新しいお知らせがあります', icon: 'icon-192.png', data: { postId: d.postId || '' }
  }));
});
self.addEventListener('notificationclick', e => {
  e.notification.close();
  const id = e.notification.data && e.notification.data.postId;
  e.waitUntil((async () => {
    const list = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const open = list.find(c => c.url.startsWith(self.registration.scope));
    if (open) { await open.focus(); if (id) open.postMessage({ postId: id }); return; }
    await self.clients.openWindow(self.registration.scope + (id ? '#post=' + encodeURIComponent(id) : ''));
  })());
});
