(function () {
  'use strict';
  var busy = false;
  function utf8Bytes(text) {
    var count = 0;
    for (var i = 0; i < text.length; i++) {
      var c = text.charCodeAt(i);
      if (c < 128) count++;
      else if (c < 2048) count += 2;
      else if (c >= 55296 && c <= 56319 && i + 1 < text.length && text.charCodeAt(i + 1) >= 56320 && text.charCodeAt(i + 1) <= 57343) { count += 4; i++; }
      else count += 3;
    }
    return count;
  }
  function absent(status, reason) { return { canvas: { status: status, reason: reason }, audio: { status: 'unsupported', reason: 'Window-only Audio outside intended Worker coverage' }, webgl: { status: status, reason: reason } }; }
  async function worker(input, runID) {
    if (typeof Worker !== 'function') return absent('unsupported', 'Worker unavailable');
    var w;
    try {
      w = new Worker('/authenticity-worker.js?run_id=' + encodeURIComponent(runID) + '&context=worker');
      return await AuthenticityCore.bounded(new Promise(function (resolve, reject) {
        w.onerror = function (event) { reject(new Error(event.message || 'Authenticity Worker failed')); };
        w.onmessage = function (event) { if (event.data && event.data.run_id === runID) resolve(event.data.realms); };
        w.postMessage({ input: input, run_id: runID });
      }), 30000);
    } catch (error) { return absent('error', String(error.message).slice(0, 500)); }
    finally { if (w) w.terminate(); }
  }
  async function iframe(input, runID) {
    var frame = document.createElement('iframe'), listener;
    frame.hidden = true; frame.src = '/authenticity-frame.html'; frame.title = 'Authenticity same-origin realm';
    try {
      return await AuthenticityCore.bounded(new Promise(function (resolve, reject) {
        listener = function (event) { if (event.source === frame.contentWindow && event.origin === location.origin && event.data && event.data.run_id === runID) resolve(event.data.realms); };
        window.addEventListener('message', listener);
        frame.onerror = function () { reject(new Error('Authenticity iframe load failed')); };
        frame.onload = function () { frame.contentWindow.postMessage({ input: input, run_id: runID }, location.origin); };
        document.body.appendChild(frame);
      }), 30000);
    } catch (error) { var result = absent('error', String(error.message).slice(0, 500)); result.audio = { status: 'error', reason: String(error.message).slice(0, 500) }; return result; }
    finally { window.removeEventListener('message', listener); frame.remove(); }
  }
  document.addEventListener('authenticity-collect', async function () {
    if (busy) return;
    busy = true;
    var output = document.getElementById('authenticity-output'), request = {}, result, serialized;
    output.setAttribute('data-status', 'running'); output.setAttribute('data-request-id', '');
    try {
      var text = document.documentElement.getAttribute('data-authenticity-request') || '{}';
      if (text.length > 16384) throw new Error('Authenticity request exceeds bound');
      request = JSON.parse(text);
      output.setAttribute('data-request-id', String(request.request_id || ''));
      var options = request.options || {}, input = AuthenticityInputs.generateAuthenticityInputs(options.seed), runID = String(options.run_id || request.request_id || '').slice(0, 100);
      if (options.input && JSON.stringify(options.input) !== JSON.stringify(input)) throw new Error('Input does not match frozen seeded generator');
      var receipt = AuthenticityCore.bounded(Promise.resolve().then(function () { return fetch('/api/echo?context=fetch&run_id=' + encodeURIComponent(runID), { cache: 'no-store' }); }).then(function (response) { if (!response.ok) throw new Error('Authenticity request echo failed: ' + response.status); return response.json(); }), 8000).then(function (value) { return { status: 'ok', observed: value }; }, function (error) { return { status: 'error', reason: String(error.message).slice(0, 500) }; });
      var realms = await AuthenticityCore.bounded(Promise.all([AuthenticityCore.collect(input, false), iframe(input, runID), worker(input, runID), receipt]), 45000);
      result = { schema: 1, suite_version: 'authenticity-2', input: input, run_id: runID, realms: { window: realms[0], iframe: realms[1], worker: realms[2] }, request_echo: realms[3] };
      serialized = JSON.stringify(result);
      if (utf8Bytes(serialized) > 6 * 1024 * 1024) throw new Error('Authenticity raw output exceeds 6 MiB bound');
    } catch (error) { serialized = JSON.stringify({ error: String(error.name + ': ' + error.message).slice(0, 1000) }); }
    output.textContent = serialized; output.setAttribute('data-status', 'complete'); busy = false;
  });
}());
