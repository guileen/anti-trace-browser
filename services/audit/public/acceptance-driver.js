(function () {
  'use strict';
  var busy = false;
  document.addEventListener('acceptance-collect', async function () {
    if (busy) return;
    var output = document.getElementById('acceptance-output'), request;
    try {
      request = JSON.parse(document.documentElement.getAttribute('data-acceptance-request'));
      if (!request || typeof request.request_id !== 'string' || !request.options) throw new Error('Invalid explicit harness request');
      busy = true; output.setAttribute('data-request-id', request.request_id); output.setAttribute('data-status', 'running');
      // Native sample arrays are copied in the page realm, not through Firefox automation Xrays.
      output.textContent = JSON.stringify({ features: await window.AcceptanceProbes.collect(request.options) });
    } catch (error) { output.textContent = JSON.stringify({ error: String(error.message || error) }); }
    finally { busy = false; output.setAttribute('data-status', 'complete'); }
  });
}());
