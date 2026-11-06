(function () {
  'use strict';
  function snapshot() { return { user_agent: navigator.userAgent, platform: navigator.platform, locale: navigator.language, languages: Array.from(navigator.languages || []), timezone: Intl.DateTimeFormat().resolvedOptions().timeZone, hardware_concurrency: navigator.hardwareConcurrency, screen_width: screen.width, screen_height: screen.height }; }
  document.documentElement.setAttribute('data-first-main', JSON.stringify(snapshot()));
  window.addEventListener('message', function (event) { if (event.origin === location.origin && event.data && event.data.kind === 'first-frame') document.documentElement.setAttribute('data-first-frame', JSON.stringify(event.data.snapshot)); });
  try {
    var runID = new URLSearchParams(location.search).get('run_id') || 'product-first';
    var worker = new Worker('/acceptance-first-worker.js?context=worker&run_id=' + encodeURIComponent(runID));
    worker.onmessage = function (event) { document.documentElement.setAttribute('data-first-worker', JSON.stringify(event.data)); worker.terminate(); };
    worker.onerror = function (event) { document.documentElement.setAttribute('data-first-worker', JSON.stringify({ error: event.message || 'Worker load failed' })); worker.terminate(); };
    worker.postMessage('read-first-script');
  } catch (error) { document.documentElement.setAttribute('data-first-worker', JSON.stringify({ error: String(error) })); }
}());
