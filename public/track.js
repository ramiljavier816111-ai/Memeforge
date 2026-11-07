/* Counts this visitor once per day (server stores a random cookie id, never an IP). */
(function () {
  try { fetch('/api/visit', { method: 'POST', keepalive: true, credentials: 'same-origin' }).catch(function () {}); } catch (e) {}
})();
