(function () {
  'use strict';
  var snapshot = function () { return { user_agent: navigator.userAgent, language: navigator.language, platform: navigator.platform, cores: navigator.hardwareConcurrency }; };
  function unavailable(message) { var error = new Error(message); error.auditStatus = 'unsupported'; throw error; }
  function bounded(promise, ms) { return new Promise(function (resolve, reject) { var timer = setTimeout(function () { reject(new Error('Probe deadline exceeded')); }, ms); Promise.resolve(promise).then(function (v) { clearTimeout(timer); resolve(v); }, function (e) { clearTimeout(timer); reject(e); }); }); }
  function canvas(input, text, variant) {
    var c = document.createElement('canvas'); c.width = text ? 192 : 64; c.height = text ? 64 : 32;
    var x = c.getContext && c.getContext('2d');
    if (!x || !x.getImageData || !c.toDataURL) unavailable('Canvas 2D draw/read/export unavailable');
    x.fillStyle = '#fff'; x.fillRect(0, 0, c.width, c.height);
    if (text) { x.font = '18px sans-serif'; x.fillStyle = '#214a83'; x.fillText(input.text + (variant ? ' changed' : ''), 2, 25); x.font = '16px serif'; x.fillText(variant ? '界 Ω ب' : '你好 Ω مرحبا', 3, 49); }
    else { x.save(); x.translate(31, 16); x.rotate(input.rotation + (variant ? .37 : 0)); x.fillStyle = '#1683c5'; x.fillRect(-17, -9, 32, 16); x.beginPath(); x.arc(12, 2, 7, 0, Math.PI * 1.7); x.fillStyle = '#ed5c23'; x.fill(); x.restore(); }
    var zeroSizeError = null, invalidContext = false;
    try { x.getImageData(0, 0, 0, 1); } catch (error) { zeroSizeError = error.name; }
    try { invalidContext = c.getContext('not-a-context') === null; } catch (_) {}
    return { width: c.width, height: c.height, pixels: Array.from(x.getImageData(0, 0, c.width, c.height).data), png: c.toDataURL('image/png'), semantics: { context_brand: typeof CanvasRenderingContext2D === 'function' && x instanceof CanvasRenderingContext2D, canvas_brand: typeof HTMLCanvasElement === 'function' && c instanceof HTMLCanvasElement, context_identity: c.getContext('2d') === x, zero_size_error: zeroSizeError, invalid_context_null: invalidContext } };
  }
  async function audio(input) {
    var Offline = window.OfflineAudioContext || window.webkitOfflineAudioContext;
    if (!Offline) unavailable('OfflineAudioContext unavailable');
    async function render(frequency, gain, connected, stopAt) {
      var c = new Offline(1, 4096, 44100), oscillator = c.createOscillator(), amplitude = c.createGain(), completed = false;
      oscillator.type = 'sine'; oscillator.frequency.value = frequency; amplitude.gain.value = gain;
      var chained = oscillator.connect(amplitude) === amplitude; if (connected) amplitude.connect(c.destination); oscillator.start(0);
      if (stopAt !== undefined) oscillator.stop(stopAt);
      c.oncomplete = function () { completed = true; };
      var synchronous = true, resolvedSynchronously = false, rendering = c.startRendering();
      rendering.then(function () { resolvedSynchronously = synchronous; }); synchronous = false;
      var buffer = await rendering; await new Promise(function (resolve) { setTimeout(resolve, 0); });
      var invalidChannel = null, duplicateStart = null;
      try { buffer.getChannelData(2); } catch (error) { invalidChannel = error.name; }
      try { oscillator.start(0); } catch (error) { duplicateStart = error.name; }
      return { samples: Array.from(buffer.getChannelData(0)), sample_rate: buffer.sampleRate, semantics: { context_brand: c instanceof Offline, oscillator_brand: typeof OscillatorNode === 'function' && oscillator instanceof OscillatorNode, gain_brand: typeof GainNode === 'function' && amplitude instanceof GainNode, buffer_brand: typeof AudioBuffer === 'function' && buffer instanceof AudioBuffer, connect_chain: chained, asynchronous: !resolvedSynchronously, completion_event: completed, closed_state: c.state === 'closed', invalid_channel_error: invalidChannel, duplicate_start_error: duplicateStart } };
    }
    return { base: await render(input.frequency, .2, true), frequency: await render(input.frequency * 2, .2, true), gain: await render(input.frequency, .1, true), disconnected: await render(input.frequency, .2, false), stopped: await render(input.frequency, .2, true, 0) };
  }
  function webgl(input) {
    var c = document.createElement('canvas'); c.width = 8; c.height = 8;
    var gl = c.getContext && c.getContext('webgl', { antialias: false, preserveDrawingBuffer: true });
    if (!gl) unavailable('WebGL unavailable');
    var shaders = [], program, buffer;
    try {
      function shader(type, source) { var s = gl.createShader(type); shaders.push(s); gl.shaderSource(s, source); gl.compileShader(s); if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s)); return s; }
      program = gl.createProgram(); gl.attachShader(program, shader(gl.VERTEX_SHADER, 'attribute vec2 position; void main(){gl_Position=vec4(position,0.,1.);}')); gl.attachShader(program, shader(gl.FRAGMENT_SHADER, 'precision mediump float; uniform vec4 color; void main(){gl_FragColor=color;}')); gl.linkProgram(program);
      if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(program));
      gl.useProgram(program); buffer = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, buffer); gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
      var attribute = gl.getAttribLocation(program, 'position'); gl.enableVertexAttribArray(attribute); gl.vertexAttribPointer(attribute, 2, gl.FLOAT, false, 0, 0); gl.viewport(0, 0, 8, 8);
      function draw(color) { gl.uniform4fv(gl.getUniformLocation(program, 'color'), new Float32Array(color.map(function (n) { return n / 255; }))); gl.drawArrays(gl.TRIANGLES, 0, 3); var pixel = new Uint8Array(4); gl.readPixels(3, 3, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, pixel); return Array.from(pixel); }
      var base = draw(input.color), variant = draw(input.color.map(function (n, i) { return i === 3 ? n : 255 - n; })), ext = gl.getExtension('WEBGL_debug_renderer_info');
      var error = gl.getError(), objects = gl.isProgram(program) && gl.isBuffer(buffer) && shaders.every(function (s) { return gl.isShader(s); });
      gl.enable(-1); var invalidEnumError = gl.getError();
      var broken = gl.createShader(gl.FRAGMENT_SHADER); shaders.push(broken); gl.shaderSource(broken, 'deliberately invalid GLSL source'); gl.compileShader(broken);
      var rejected = gl.getShaderParameter(broken, gl.COMPILE_STATUS) === false && String(gl.getShaderInfoLog(broken)).length > 0;
      return { compile: true, link: true, objects_valid: objects, error: error, invalid_enum_error: invalidEnumError, base: base, variant: variant, identifier: String(gl.getParameter(ext ? ext.UNMASKED_RENDERER_WEBGL : gl.RENDERER)), parameters: [gl.getParameter(gl.MAX_TEXTURE_SIZE), gl.getParameter(gl.MAX_VERTEX_ATTRIBS), gl.getParameter(gl.SUBPIXEL_BITS)], semantics: { context_brand: typeof WebGLRenderingContext === 'function' && gl instanceof WebGLRenderingContext, program_brand: typeof WebGLProgram === 'function' && program instanceof WebGLProgram, buffer_brand: typeof WebGLBuffer === 'function' && buffer instanceof WebGLBuffer, invalid_shader_rejected: rejected } };
    } finally { if (buffer) gl.deleteBuffer(buffer); if (program) gl.deleteProgram(program); shaders.forEach(function (s) { gl.deleteShader(s); }); var loss = gl.getExtension('WEBGL_lose_context'); if (loss) loss.loseContext(); }
  }
  function fonts(input) {
    var c = document.createElement('canvas'), x = c.getContext && c.getContext('2d');
    if (!x || !x.measureText) unavailable('Text metrics unavailable');
    return { measurements: ['monospace', 'serif', 'sans-serif', 'Arial', 'Times New Roman', 'Menlo'].map(function (font) { x.font = '19px ' + font; return { font: font, width: x.measureText(input.text + ' 你好 Ω مرحبا').width }; }) };
  }
  async function worker(input, runID) {
    if (typeof Worker !== 'function') unavailable('Worker unavailable');
    var w = new Worker('/acceptance-worker.js?run_id=' + encodeURIComponent(runID) + '&context=worker');
    var isolated = new Worker('/acceptance-worker.js?run_id=' + encodeURIComponent(runID) + '&context=worker');
    var synchronous = true, afterTermination = 0;
    try {
      var first = new Promise(function (resolve, reject) {
        w.onerror = function (e) { reject(new Error(e.message || 'Worker error')); };
        w.onmessage = function (e) { resolve({ main: snapshot(), child: e.data.environment, realm: e.data.realm, challenge: e.data.challenge, answer: e.data.answer, http: e.data.http, asynchronous: !synchronous, scheduling: e.data.scheduling, global_before: e.data.global_before }); };
        w.postMessage({ challenge: input.challenge, run_id: runID, marker: 'first:' + input.challenge });
      });
      var second = new Promise(function (resolve, reject) {
        isolated.onerror = function (e) { reject(new Error(e.message || 'Isolated Worker error')); };
        isolated.onmessage = function (e) { resolve(e.data.global_before); };
        isolated.postMessage({ challenge: input.challenge + 1, run_id: runID, marker: 'second:' + input.challenge });
      });
      synchronous = false;
      var results = await bounded(Promise.all([first, second]), 4000);
      results[0].isolated = results[0].global_before === null && results[1] === null && typeof window.__acceptance_worker_marker === 'undefined';
      w.onmessage = function () { afterTermination++; };
      w.postMessage({ challenge: input.challenge, run_id: runID, delayed: true });
      w.terminate();
      await new Promise(function (resolve) { setTimeout(resolve, 150); });
      results[0].terminated = afterTermination === 0;
      return results[0];
    } finally { w.terminate(); isolated.terminate(); }
  }
  async function iframe(input) {
    var frame = document.createElement('iframe'); frame.hidden = true; frame.src = '/acceptance-frame.html';
    var listener;
    try { return await bounded(new Promise(function (resolve, reject) {
      listener = function (event) { if (event.source !== frame.contentWindow || event.origin !== location.origin || event.data.challenge !== input.challenge) return; resolve({ main: snapshot(), child: event.data.environment, challenge: event.data.challenge, answer: event.data.answer }); };
      window.addEventListener('message', listener); frame.onload = function () { frame.contentWindow.postMessage({ challenge: input.challenge }, location.origin); }; frame.onerror = function () { reject(new Error('iframe load error')); }; document.body.appendChild(frame);
    }), 4000); } finally { window.removeEventListener('message', listener); frame.remove(); }
  }
  function idb(mode, marker) {
    if (!window.indexedDB) unavailable('IndexedDB unavailable');
    return new Promise(function (resolve, reject) {
      var request = indexedDB.open('runtime_acceptance_v2', 1), db;
      request.onupgradeneeded = function () { request.result.createObjectStore('fixtures'); };
      request.onerror = function () { reject(request.error); };
      request.onsuccess = function () {
        db = request.result; var tx = db.transaction('fixtures', mode === 'write' ? 'readwrite' : 'readonly'), store = tx.objectStore('fixtures'), result, prior;
        var get = store.get('marker'); get.onsuccess = function () { prior = get.result; if (mode === 'write' && prior === undefined) store.put(marker, 'marker'); result = prior === undefined && mode === 'write' ? marker : prior; };
        tx.oncomplete = function () { db.close(); resolve(result === undefined ? null : result); }; tx.onerror = function () { db.close(); reject(tx.error); };
      };
    });
  }
  async function persistence(options) {
    var marker = options.environment + ':' + location.protocol + '//' + location.hostname + ':' + options.input.challenge;
    var key = 'runtime_acceptance_v2', cookie = function () { var row = document.cookie.split(';').map(function (s) { return s.trim(); }).find(function (s) { return s.indexOf(key + '=') === 0; }); return row ? decodeURIComponent(row.slice(key.length + 1)) : null; };
    var local = localStorage.getItem(key), prior = cookie(), isolation = localStorage.getItem(key + ':isolation');
    if (options.storage_mode === 'write' && isolation === null) { isolation = local === null && prior === null ? 'yes' : 'no'; localStorage.setItem(key + ':isolation', isolation); }
    if (options.storage_mode === 'write' && local === null) localStorage.setItem(key, marker);
    if (options.storage_mode === 'write' && prior === null) document.cookie = key + '=' + encodeURIComponent(marker) + '; Path=/; Max-Age=31536000; SameSite=Lax';
    return { cookie: cookie(), local_storage: localStorage.getItem(key), indexed_db: await idb(options.storage_mode, marker), prior_absent: isolation === 'yes' };
  }
  async function headers(runID) {
    await fetch('/api/echo?context=fetch&run_id=' + encodeURIComponent(runID), { cache: 'no-store' });
    await fetch('/api/echo/redirect?context=redirect&run_id=' + encodeURIComponent(runID), { cache: 'no-store' });
    await bounded(new Promise(function (resolve, reject) { var image = new Image(); image.onload = resolve; image.onerror = function () { reject(new Error('Subresource echo failed')); }; image.src = '/api/echo/pixel?context=subresource&run_id=' + encodeURIComponent(runID); }), 4000);
    return { user_agent: navigator.userAgent, language: navigator.language, receipts: [], source: 'browser; runner must attach independent server receipts' };
  }
  window.AcceptanceProbes = { collect: async function (options) {
    var input = options.input, features = {};
    var probes = {
      canvas_text: function () { return { base: canvas(input, true, false), variant: canvas(input, true, true) }; },
      canvas_geometry: function () { return { base: canvas(input, false, false), variant: canvas(input, false, true) }; },
      audio: function () { return audio(input); }, webgl: function () { return webgl(input); }, fonts: function () { return fonts(input); },
      screen: function () { return { width: screen.width, height: screen.height, dpr: devicePixelRatio, inner_width: innerWidth, inner_height: innerHeight }; },
      cores: function () { return { cores: navigator.hardwareConcurrency }; },
      worker: function () { return worker(input, options.run_id); }, iframe: function () { return iframe(input); },
      headers: function () { return headers(options.run_id); }, persistence: function () { return persistence(options); },
    };
    for (var id of Object.keys(probes)) { try { features[id] = { status: 'pass', observed: await bounded(Promise.resolve().then(probes[id]), 8000) }; } catch (e) { features[id] = { status: e.auditStatus === 'unsupported' ? 'unsupported' : 'error', detail: String(e.name + ': ' + e.message) }; } }
    return features;
  } };
}());
