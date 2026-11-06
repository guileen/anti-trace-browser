(function () {
  'use strict';
  var sequence = 0;
  function unsupported(message) { var e = new Error(message); e.auditStatus = 'unsupported'; throw e; }
  function snapshot() {
    return { user_agent: navigator.userAgent, language: navigator.language, languages: navigator.languages ? Array.from(navigator.languages) : null, platform: navigator.platform, hardware_concurrency: navigator.hardwareConcurrency, device_memory: navigator.deviceMemory, webdriver: navigator.webdriver };
  }
  function hashBytes(bytes) {
    var h = 2166136261;
    for (var i = 0; i < bytes.length; i++) h = Math.imul(h ^ bytes[i], 16777619) >>> 0;
    return ('00000000' + h.toString(16)).slice(-8);
  }
  function bytesFromBase64(text) {
    var binary = atob(text), bytes = new Uint8Array(binary.length);
    for (var i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes;
  }
  function unique() { return 'anti_trace_audit_' + Date.now() + '_' + (++sequence); }
  function canvasProbe() {
    var canvas = document.createElement('canvas');
    if (typeof canvas.getContext !== 'function' || typeof canvas.toDataURL !== 'function') unsupported('Canvas 绘制 / 导出接口不可用');
    var ctx = canvas.getContext('2d');
    if (!ctx || typeof ctx.getImageData !== 'function') unsupported('Canvas 2D 或像素读回不可用');
    canvas.width = 240; canvas.height = 80;
    function paint(text) {
      ctx.clearRect(0, 0, 240, 80);
      ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, 240, 80);
      ctx.fillStyle = '#ff0000'; ctx.fillRect(0, 0, 16, 16);
      ctx.font = '19px sans-serif'; ctx.fillStyle = '#153c86'; ctx.fillText(text, 28, 38);
      ctx.strokeStyle = '#13a77e'; ctx.lineWidth = 2; ctx.beginPath(); ctx.arc(176, 46, 19, 0, 5); ctx.stroke();
      var image = ctx.getImageData(0, 0, 240, 80).data;
      var png = bytesFromBase64(canvas.toDataURL('image/png').split(',')[1] || '');
      var painted = 0;
      for (var i = 0; i < image.length; i += 4) {
        if (((i / 4) % 240) >= 20 && (image[i] < 250 || image[i + 1] < 250 || image[i + 2] < 250)) painted++;
      }
      return { pixel_hash: hashBytes(image), png_hash: hashBytes(png), red: Array.from(ctx.getImageData(4, 4, 1, 1).data), painted: painted, png_signature: Array.from(png.slice(0, 8)).map(function (b) { return ('0' + b.toString(16)).slice(-2); }).join(''), png_bytes: png.length };
    }
    var first = paint('Audit 7319'), repeat = paint('Audit 7319'), variant = paint('Audit 9821');
    return { hash_algorithm: 'fnv1a32 (non-cryptographic, actual bytes)', pixel_hash: first.pixel_hash, repeat_pixel_hash: repeat.pixel_hash, variant_pixel_hash: variant.pixel_hash, png_hash: first.png_hash, repeat_png_hash: repeat.png_hash, variant_png_hash: variant.png_hash, red_pixel: first.red, painted_pixels: first.painted, png_signature: first.png_signature, png_bytes: first.png_bytes, width: 240, height: 80 };
  }
  function webglProbe() {
    var canvas = document.createElement('canvas');
    if (typeof canvas.getContext !== 'function') unsupported('Canvas 上下文接口不可用');
    canvas.width = 8; canvas.height = 8;
    var gl = canvas.getContext('webgl', { antialias: false, preserveDrawingBuffer: true });
    if (!gl) unsupported('WebGL 上下文不可用；不代表隐私保护');
    try {
      gl.clearColor(1, 0, 0, 1); gl.clear(gl.COLOR_BUFFER_BIT);
      var pixel = new Uint8Array(4); gl.readPixels(2, 2, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, pixel);
      var error = gl.getError(), debug = gl.getExtension('WEBGL_debug_renderer_info');
      return { pixel: Array.from(pixel), error: error, debug_extension: !!debug, renderer: gl.getParameter(gl.RENDERER), vendor: gl.getParameter(gl.VENDOR), unmasked_renderer: debug ? gl.getParameter(debug.UNMASKED_RENDERER_WEBGL) : null, unmasked_vendor: debug ? gl.getParameter(debug.UNMASKED_VENDOR_WEBGL) : null, max_texture_size: gl.getParameter(gl.MAX_TEXTURE_SIZE), subpixel_bits: gl.getParameter(gl.SUBPIXEL_BITS), extensions: gl.getSupportedExtensions() || [] };
    } finally { var loss = gl.getExtension('WEBGL_lose_context'); if (loss) loss.loseContext(); }
  }
  async function audioProbe() {
    var Offline = window.OfflineAudioContext || window.webkitOfflineAudioContext;
    if (!Offline) unsupported('离线音频接口不可用；不代表隐私保护');
    async function render(frequency) {
      var context = new Offline(1, 4096, 44100), oscillator = context.createOscillator(), gain = context.createGain();
      oscillator.type = 'sine'; oscillator.frequency.value = frequency; gain.gain.value = 0.2;
      oscillator.connect(gain); gain.connect(context.destination); oscillator.start(0);
      var buffer = await context.startRendering(), samples = buffer.getChannelData(0), sum = 0, crossings = 0;
      for (var i = 0; i < samples.length; i++) { sum += samples[i] * samples[i]; if (i && ((samples[i] >= 0) !== (samples[i - 1] >= 0))) crossings++; }
      return { hash: hashBytes(new Uint8Array(samples.buffer, samples.byteOffset, samples.byteLength)), rms: Math.sqrt(sum / samples.length), crossings: crossings, samples: samples.length, sample_rate: buffer.sampleRate };
    }
    var a = await render(440), b = await render(440), c = await render(880);
    return { hash_algorithm: 'fnv1a32 (non-cryptographic, Float32 sample bytes)', hash: a.hash, repeat_hash: b.hash, variant_hash: c.hash, rms: a.rms, variant_rms: c.rms, zero_crossings: a.crossings, variant_zero_crossings: c.crossings, samples: a.samples, sample_rate: a.sample_rate };
  }
  async function navigatorProbe() {
    var response = await fetch('/api/context', { cache: 'no-store' });
    if (!response.ok) throw new Error('HTTP 声明控制通道失败：' + response.status);
    var value = snapshot(); value.http = await response.json();
    value.plugins = navigator.plugins ? Array.from(navigator.plugins).map(function (p) { return p.name; }) : null;
    value.mime_types = navigator.mimeTypes ? Array.from(navigator.mimeTypes).map(function (m) { return m.type; }) : null;
    return value;
  }
  function geometryProbe() {
    var s = window.screen || {};
    return { screen_width: s.width, screen_height: s.height, avail_width: s.availWidth, avail_height: s.availHeight, color_depth: s.colorDepth, pixel_depth: s.pixelDepth, inner_width: window.innerWidth, inner_height: window.innerHeight, outer_width: window.outerWidth, outer_height: window.outerHeight, dpr: window.devicePixelRatio, client_width: document.documentElement.clientWidth, timezone: typeof Intl !== 'undefined' ? Intl.DateTimeFormat().resolvedOptions().timeZone : null };
  }
  function cookieProbe() {
    var key = unique(), marker = 'audit-value-7319', read;
    try {
      document.cookie = key + '=' + marker + '; Path=/; SameSite=Strict';
      read = document.cookie.split(';').map(function (x) { return x.trim(); }).find(function (x) { return x.indexOf(key + '=') === 0; });
    } finally { document.cookie = key + '=; Max-Age=0; Path=/; SameSite=Strict'; }
    return { written: marker, read: read ? read.slice(key.length + 1) : null, deleted: !document.cookie.split(';').some(function (x) { return x.trim().indexOf(key + '=') === 0; }) };
  }
  function localStorageProbe() {
    if (!window.localStorage) unsupported('LocalStorage 不可用');
    var key = unique(), marker = 'audit-value-7319', read;
    try { localStorage.setItem(key, marker); read = localStorage.getItem(key); }
    finally { localStorage.removeItem(key); }
    return { written: marker, read: read, deleted: localStorage.getItem(key) === null };
  }
  function idbProbe() {
    if (!window.indexedDB) unsupported('IndexedDB 不可用');
    return new Promise(function (resolve, reject) {
      var name = unique(), db, settled = false, timer;
      function finish(error, value) {
        if (settled) return; settled = true; clearTimeout(timer);
        if (db) db.close();
        var deletion;
        try { deletion = indexedDB.deleteDatabase(name); } catch (e) { reject(error || e); return; }
        if (error) { reject(error); return; }
        deletion.onsuccess = function () { resolve(value); };
        deletion.onerror = function () { reject(deletion.error || new Error('数据库清理失败')); };
        deletion.onblocked = function () { reject(new Error('数据库清理受阻')); };
      }
      timer = setTimeout(function () { finish(new Error('IndexedDB 事务超时')); }, 1450);
      var opening = indexedDB.open(name, 1);
      opening.onupgradeneeded = function () { opening.result.createObjectStore('evidence'); };
      opening.onerror = function () { finish(opening.error || new Error('数据库打开失败')); };
      opening.onblocked = function () { finish(new Error('数据库打开受阻')); };
      opening.onsuccess = function () {
        db = opening.result;
        if (settled) { db.close(); indexedDB.deleteDatabase(name); return; }
        var write = db.transaction('evidence', 'readwrite');
        write.objectStore('evidence').put({ marker: 'audit-value-7319', number: 7319 }, 'control');
        write.onerror = function () { finish(write.error || new Error('写事务失败')); };
        write.oncomplete = function () {
          var tx = db.transaction('evidence', 'readonly'), get = tx.objectStore('evidence').get('control'), read;
          get.onsuccess = function () { read = get.result; };
          tx.onerror = function () { finish(tx.error || new Error('读事务失败')); };
          tx.oncomplete = function () {
            var del = db.transaction('evidence', 'readwrite'); del.objectStore('evidence').delete('control');
            del.onerror = function () { finish(del.error || new Error('删除事务失败')); };
            del.oncomplete = function () {
              var check = db.transaction('evidence', 'readonly'), request = check.objectStore('evidence').get('control'), absent = false;
              request.onsuccess = function () { absent = request.result === undefined; };
              check.onerror = function () { finish(check.error || new Error('删除验证失败')); };
              check.oncomplete = function () { finish(null, { read: read, deleted: absent }); };
            };
          };
        };
      };
    });
  }
  function domProbe() {
    var parent = document.createElement('div'), child = document.createElement('button'), events = [];
    parent.id = unique(); child.setAttribute('data-audit', '7319'); child.textContent = 'audit:7319'; parent.appendChild(child); document.body.appendChild(parent);
    var detail;
    try {
      child.addEventListener('audit-control', function (event) { events.push('child'); detail = event.detail; });
      parent.addEventListener('audit-control', function () { events.push('parent'); });
      child.dispatchEvent(new CustomEvent('audit-control', { bubbles: true, detail: 7319 }));
      return { selected: parent.querySelector('[data-audit="7319"]') === child, text: child.textContent, attribute: child.getAttribute('data-audit'), events: events, event_detail: detail };
    } finally { parent.remove(); }
  }
  function layoutProbe() {
    var parent = document.createElement('div'), child = document.createElement('div');
    parent.style.cssText = 'position:fixed;left:0;top:0;width:240px;height:80px;padding:0;border:0;box-sizing:content-box;visibility:hidden;';
    child.style.cssText = 'position:absolute;left:12px;top:9px;width:48px;height:18px;padding:0;border:0;box-sizing:content-box;';
    parent.appendChild(child); document.body.appendChild(parent);
    try { var a = parent.getBoundingClientRect(), b = child.getBoundingClientRect(); return { width: a.width, height: a.height, child_width: b.width, offset_x: b.left - a.left, offset_y: b.top - a.top }; }
    finally { parent.remove(); }
  }
  function workerProbe() {
    if (typeof Worker !== 'function') unsupported('Worker 不可用');
    return new Promise(function (resolve, reject) {
      var worker = new Worker('/worker.js'), timer;
      function finish(error, value) { clearTimeout(timer); worker.terminate(); error ? reject(error) : resolve(value); }
      timer = setTimeout(function () { finish(new Error('Worker 挑战通道超时')); }, 1450);
      worker.onerror = function (event) { finish(new Error(event.message || 'Worker 执行失败')); };
      worker.onmessage = function (event) {
        if (!event.data || event.data.challenge !== 'audit-challenge-7319') return;
        finish(null, { challenge: event.data.challenge, answer: event.data.answer, channel_verified: event.data.answer === 14638, main: snapshot(), child: event.data.environment });
      };
      worker.postMessage({ challenge: 'audit-challenge-7319', input: 7319 });
    });
  }
  function iframeProbe() {
    return new Promise(function (resolve, reject) {
      var frame = document.createElement('iframe'), timer;
      frame.hidden = true; frame.title = '同源一致性探针'; frame.src = '/frame.html';
      function finish(error, value) { clearTimeout(timer); window.removeEventListener('message', receive); frame.remove(); error ? reject(error) : resolve(value); }
      function receive(event) {
        if (event.source !== frame.contentWindow || event.origin !== location.origin || !event.data || event.data.challenge !== 'audit-challenge-7319') return;
        finish(null, { challenge: event.data.challenge, answer: event.data.answer, channel_verified: event.data.answer === 14638, main: snapshot(), child: event.data.environment });
      }
      window.addEventListener('message', receive);
      frame.onload = function () { frame.contentWindow.postMessage({ challenge: 'audit-challenge-7319', input: 7319 }, location.origin); };
      frame.onerror = function () { finish(new Error('iframe 加载失败')); };
      timer = setTimeout(function () { finish(new Error('iframe 挑战通道超时')); }, 1450);
      document.body.appendChild(frame);
    });
  }
  async function mediaProbe() {
    if (!navigator.mediaDevices || typeof navigator.mediaDevices.enumerateDevices !== 'function') unsupported('媒体枚举接口不可用；未申请权限');
    async function permission(name) {
      if (!navigator.permissions || typeof navigator.permissions.query !== 'function') return 'unsupported';
      try { return (await navigator.permissions.query({ name: name })).state; } catch (_) { return 'unsupported'; }
    }
    var camera = await permission('camera'), microphone = await permission('microphone'), devices = await navigator.mediaDevices.enumerateDevices();
    return { camera_permission: camera, microphone_permission: microphone, permission_requested: false, devices: Array.from(devices).slice(0, 128).map(function (device) { return { kind: device.kind, label: device.label, device_id: device.deviceId, group_id: device.groupId }; }) };
  }
  function fontsProbe() {
    var canvas = document.createElement('canvas');
    if (typeof canvas.getContext !== 'function') unsupported('字体真实测量依赖的 Canvas 不可用');
    var ctx = canvas.getContext('2d');
    if (!ctx || typeof ctx.measureText !== 'function') unsupported('字体度量不可用');
    var text = 'mmmmmmWWWWWW0123456789', candidates = ['Arial', 'Times New Roman', 'Courier New', 'Helvetica Neue', 'Menlo', 'Georgia', 'Microsoft YaHei', 'Noto Sans CJK SC'];
    ctx.font = '32px monospace'; var baseline = ctx.measureText(text).width;
    return { baseline: baseline, sample: text, measurements: candidates.map(function (font) { ctx.font = '32px "' + font + '", monospace'; return { font: font, width: ctx.measureText(text).width }; }) };
  }
  function cpuProbe() {
    var start = performance.now(), checksum = 0, n = 1000000;
    for (var round = 0; round < 8; round++) for (var i = 0; i < n; i++) checksum += i % 97;
    return { value: { iterations: n * 8, checksum: checksum }, duration_ms: performance.now() - start };
  }
  function domWorkloadProbe() {
    var start = performance.now(), container = document.createElement('div'), checksum = 0;
    container.style.cssText = 'position:absolute;left:-10000px;top:0;width:240px;visibility:hidden;';
    try {
      for (var i = 0; i < 600; i++) { var node = document.createElement('div'); node.className = 'audit-row'; node.setAttribute('data-index', String(i)); node.style.height = '2px'; node.textContent = 'row-' + i; container.appendChild(node); }
      document.body.appendChild(container);
      var nodes = container.querySelectorAll('.audit-row');
      for (var j = 0; j < nodes.length; j++) checksum += Number(nodes[j].getAttribute('data-index'));
      var height = container.getBoundingClientRect().height;
      return { value: { nodes: nodes.length, checksum: checksum, last_text: nodes.length ? nodes[nodes.length - 1].textContent : null, layout_height: height }, duration_ms: performance.now() - start };
    } finally { container.remove(); }
  }
  var probes = { canvas: canvasProbe, webgl: webglProbe, audio: audioProbe, navigator: navigatorProbe, geometry: geometryProbe, cookie: cookieProbe, local_storage: localStorageProbe, indexed_db: idbProbe, dom: domProbe, layout: layoutProbe, worker: workerProbe, iframe: iframeProbe, media: mediaProbe, fonts: fontsProbe, cpu: cpuProbe, dom_workload: domWorkloadProbe };
  window.AuditProbes = { collect: function (name) { if (!probes[name]) throw new Error('未知探针：' + name); return probes[name](); }, snapshot: snapshot };
}());
