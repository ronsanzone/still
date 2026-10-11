// Content-free hint only. Authoritative state is fetched by the application.
const database = () =>
  new Promise((resolve, reject) => {
    const request = indexedDB.open("still-push", 1);
    request.onupgradeneeded = () => request.result.createObjectStore("events");
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });

self.addEventListener("push", (event) =>
  event.waitUntil(
    (async () => {
      let data;
      try {
        data = event.data.json();
      } catch {
        return;
      }
      if (
        !data ||
        typeof data.eventId !== "string" ||
        !/^[A-Za-z0-9_-]{1,128}$/.test(data.eventId) ||
        !Number.isSafeInteger(data.conversationId) ||
        data.conversationId <= 0
      )
        return;
      const db = await database();
      const seen = await new Promise((resolve, reject) => {
        const tx = db.transaction("events", "readonly");
        const request = tx.objectStore("events").get(data.eventId);
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      if (seen) {
        db.close();
        return;
      }
      await self.registration.showNotification("Still", {
        body: "An update is ready.",
        tag: `still-${data.eventId}`,
        data: { conversationId: data.conversationId },
      });
      await new Promise((resolve, reject) => {
        const tx = db.transaction("events", "readwrite");
        tx.objectStore("events").put(true, data.eventId);
        tx.oncomplete = resolve;
        tx.onerror = () => reject(tx.error);
      });
      db.close();
    })(),
  ),
);

self.addEventListener("notificationclick", (event) =>
  event.waitUntil(
    (async () => {
      event.notification.close();
      const id = event.notification.data?.conversationId;
      if (!Number.isSafeInteger(id) || id <= 0) return;
      const url = new URL(`/?chat=${id}`, self.location.origin);
      const windows = await self.clients.matchAll({
        type: "window",
        includeUncontrolled: true,
      });
      const existing = windows.find(
        (client) => new URL(client.url).origin === url.origin,
      );
      if (existing) {
        await existing.navigate(url.href);
        await existing.focus();
      } else await self.clients.openWindow(url.href);
    })(),
  ),
);
