// Shows the Hub's desktop notifications (src/edge/notices.ts) while no tab is looking.
// Chrome wakes this up for each push, even with every tab of the app closed.

self.addEventListener("push", (event) => {
  const message = event.data?.json();
  if (!message) return;
  event.waitUntil(
    (async () => {
      // You're looking at the board already, and the row glows live there.
      const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
      if (!message.always && windows.some((w) => w.focused && w.visibilityState === "visible")) return;
      await self.registration.showNotification(message.title, {
        body: message.body,
        tag: message.tag,
        icon: "/apple-touch-icon.png",
        data: { url: message.url },
      });
    })(),
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const url = event.notification.data?.url;
  if (url) event.waitUntil(self.clients.openWindow(url));
});
