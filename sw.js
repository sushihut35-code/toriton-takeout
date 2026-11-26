// 鳥とん受注ボード 用サービスワーカー
// Web Push通知(無料)を受け取って、ロック画面に届ける裏方
const BOARD_URL = 'https://sushihut35-code.github.io/toriton-takeout/board.html';

self.addEventListener('install', () => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

// プッシュ着信 → 通知を表示(同じtagでも再度音と振動を鳴らす)
self.addEventListener('push', (event) => {
  let d = {};
  try {
    d = event.data ? event.data.json() : {};
  } catch (e) {
    d = {};
  }
  event.waitUntil(
    self.registration.showNotification(d.title || '🍗 鳥とん', {
      body: d.body || '',
      tag: d.tag || 'toriton',
      renotify: true,
      vibrate: [300, 150, 300, 150, 300],
      icon: '/toriton-takeout/icons/icon-192.png',
      badge: '/toriton-takeout/icons/icon-192.png',
      data: { url: d.url || BOARD_URL },
    })
  );
});

// 通知タップ → 受注ボードを開く
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url =
    (event.notification.data && event.notification.data.url) || BOARD_URL;
  event.waitUntil(self.clients.openWindow(url));
});
