// Minimal service worker — exists so the browser considers the app a real
// PWA (some engines still gate `file_handlers` + Install on having a SW).
// We do NOT cache anything: this avoids surprising users with stale code.
// All fetches pass straight through to the network; if offline, the browser
// shows its usual "offline" page.
self.addEventListener('install', () => {
  self.skipWaiting();
});
self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});
self.addEventListener('fetch', () => { /* network passthrough */ });
