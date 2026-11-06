(function () {
  'use strict';
  window.addEventListener('message', async function (event) {
    if (event.source !== parent || event.origin !== location.origin || !event.data || !event.data.input) return;
    var result = await AuthenticityCore.collect(event.data.input, false);
    parent.postMessage({ run_id: event.data.run_id, realms: result }, location.origin);
  });
}());
