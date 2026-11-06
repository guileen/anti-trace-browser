(function (root) {
  'use strict';
  function unsupported(message) { var e = new Error(message); e.authenticityStatus = 'unsupported'; throw e; }
  function bounded(promise, ms) { return new Promise(function (resolve, reject) { var timer = setTimeout(function () { reject(new Error('Authenticity feature deadline exceeded')); }, ms); Promise.resolve(promise).then(function (value) { clearTimeout(timer); resolve(value); }, function (error) { clearTimeout(timer); reject(error); }); }); }
  function canvasElement(width, height, worker) {
    var c;
    if (worker) { if (typeof OffscreenCanvas !== 'function') unsupported('Worker OffscreenCanvas unavailable'); c = new OffscreenCanvas(width, height); }
    else { c = document.createElement('canvas'); c.width = width; c.height = height; }
    return c;
  }
  function css(color, alpha) { return 'rgba(' + color[0] + ',' + color[1] + ',' + color[2] + ',' + (alpha === undefined ? 1 : alpha) + ')'; }
  async function sample(c, x, metrics) {
    var pixels = Array.from(x.getImageData(0, 0, c.width, c.height).data), png;
    if (typeof c.toDataURL === 'function') png = c.toDataURL('image/png');
    else if (typeof c.convertToBlob === 'function') {
      var blob = await c.convertToBlob({ type: 'image/png' }), bytes = new Uint8Array(await blob.arrayBuffer()), binary = '';
      if (bytes.length > 196608) throw new Error('Canvas PNG exceeds fixture bound');
      for (var i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
      png = 'data:image/png;base64,' + btoa(binary);
    } else unsupported('Canvas PNG export unavailable');
    if (typeof png !== 'string' || png.length > 262144) throw new Error('Canvas PNG exceeds fixture bound');
    var result = { width: c.width, height: c.height, pixels: pixels, png: png };
    if (metrics) result.metrics = metrics;
    if (c.id === 'authenticity-regions') {
      var box = c.getBoundingClientRect();
      result.display = { element_id: c.id, css_box: { x: box.left, y: box.top, width: box.width, height: box.height }, pixel_scale: 4 };
    }
    return result;
  }
  async function canvas(input, worker) {
    async function paint(kind, variant) {
      var text = kind === 'text', geometry = kind === 'geometry', glyph = kind === 'glyph', width = text ? 160 : geometry ? 64 : glyph ? 48 : 32, height = text ? 64 : geometry || glyph ? 48 : 24;
      var c = canvasElement(width, height, worker), x = c.getContext && c.getContext('2d');
      if (!x || typeof x.getImageData !== 'function') unsupported('Canvas 2D readback unavailable');
      var metrics;
      if (kind === 'monochrome') { x.fillStyle = css([input.monochrome, input.monochrome, input.monochrome]); x.fillRect(0, 0, width, height); }
      if (kind === 'regions') { for (var band = 0; band < 3; band++) { x.fillStyle = css(input.colors[band]); x.fillRect(band * 10, 0, band === 2 ? 12 : 10, height); } }
      if (kind === 'alpha') { x.fillStyle = css(input.alpha_color, .5); x.fillRect(16, 0, 16, height); }
      if (geometry) {
        x.fillStyle = '#f5f5f5'; x.fillRect(0, 0, width, height);
        x.save(); x.translate(32, 24); x.rotate(input.rotation + (variant ? .8 : 0)); x.fillStyle = css(input.colors[0]); x.fillRect(-12, -7, 24, 14); x.restore();
      }
      if (text) {
        var lines = variant === 1 ? input.text_variant : variant === 3 ? input.text_reordered : input.text, font = input.fonts[variant === 2 ? 1 : 0];
        x.fillStyle = '#ffffff'; x.fillRect(0, 0, width, height); x.fillStyle = '#183b71'; x.font = '12px ' + font; x.textBaseline = 'alphabetic';
        metrics = lines.map(function (line, row) { var m = x.measureText(line); x.fillText(line, 2, row * 16 + 12); return { text: line, font: font, width: m.width }; });
      }
      if (glyph) {
        var letter = variant ? input.glyphs.straight : input.glyphs.round;
        x.fillStyle = '#ffffff'; x.fillRect(0, 0, width, height); x.fillStyle = '#000000'; x.font = input.glyphs.size + 'px ' + input.glyphs.font; x.textBaseline = 'alphabetic';
        var measurement = x.measureText(letter); x.fillText(letter, 8, 40);
        metrics = [{ text: letter, font: input.glyphs.font, width: measurement.width }];
      }
      if (!worker && kind === 'regions' && root.parent === root) {
        var prior = document.getElementById('authenticity-regions'); if (prior) prior.remove();
        c.id = 'authenticity-regions'; c.style.cssText = 'position:absolute;left:16px;top:16px;width:128px;height:96px;padding:0;border:0;image-rendering:pixelated;';
        document.body.appendChild(c);
      }
      return sample(c, x, metrics);
    }
    return { monochrome: await paint('monochrome'), regions: await paint('regions'), alpha: await paint('alpha'), geometry: await paint('geometry'), geometry_variant: await paint('geometry', 1), geometry_repeat: await paint('geometry'), text: await paint('text'), text_variant: await paint('text', 1), text_font_variant: await paint('text', 2), text_reordered: await paint('text', 3), glyph_o: await paint('glyph'), glyph_i: await paint('glyph', 1) };
  }
  async function audio(input) {
    var Offline = root.OfflineAudioContext || root.webkitOfflineAudioContext;
    if (!Offline) unsupported('OfflineAudioContext unavailable');
    async function render(frequency, gain, connected) {
      var c = new Offline(1, input.length, input.sample_rate), oscillator = c.createOscillator(), amplitude = c.createGain();
      oscillator.type = 'sine'; oscillator.frequency.value = frequency; amplitude.gain.value = gain;
      oscillator.connect(amplitude); amplitude.connect(c.destination); if (!connected) amplitude.disconnect(); oscillator.start(0);
      var buffer = await c.startRendering();
      return { sample_rate: buffer.sampleRate, samples: Array.from(buffer.getChannelData(0)) };
    }
    return { base: await render(input.frequency, input.gain, true), frequency: await render(input.frequency * 2, input.gain, true), gain: await render(input.frequency, input.gain / 2, true), disconnected: await render(input.frequency, input.gain, false), repeat: await render(input.frequency, input.gain, true) };
  }
  function webgl(input, worker) {
    var c = canvasElement(8, 8, worker), gl = c.getContext && c.getContext('webgl', { antialias: false, preserveDrawingBuffer: true });
    if (!gl) unsupported('WebGL unavailable');
    var shaders = [], program, buffer, texture;
    try {
      function shader(type, source) { var s = gl.createShader(type); shaders.push(s); gl.shaderSource(s, source); gl.compileShader(s); if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s) || 'Shader compile failed'); return s; }
      program = gl.createProgram();
      gl.attachShader(program, shader(gl.VERTEX_SHADER, 'attribute vec2 position; varying vec2 uv; void main(){uv=position*0.5+0.5; gl_Position=vec4(position,0.0,1.0);}'));
      gl.attachShader(program, shader(gl.FRAGMENT_SHADER, 'precision mediump float; varying vec2 uv; uniform sampler2D image; uniform vec4 tint; void main(){gl_FragColor=texture2D(image,uv)*tint;}'));
      gl.linkProgram(program); if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(program) || 'Shader link failed'); gl.useProgram(program);
      buffer = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, buffer); gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
      var position = gl.getAttribLocation(program, 'position'); gl.enableVertexAttribArray(position); gl.vertexAttribPointer(position, 2, gl.FLOAT, false, 0, 0);
      texture = gl.createTexture(); gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, texture); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE); gl.uniform1i(gl.getUniformLocation(program, 'image'), 0); gl.viewport(0, 0, 8, 8); gl.disable(gl.DITHER);
      function draw(color, texels) {
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 2, 2, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array(texels)); gl.uniform4fv(gl.getUniformLocation(program, 'tint'), new Float32Array(color.map(function (n) { return n / 255; })));
        gl.drawArrays(gl.TRIANGLES, 0, 3); var pixels = new Uint8Array(8 * 8 * 4); gl.readPixels(0, 0, 8, 8, gl.RGBA, gl.UNSIGNED_BYTE, pixels); return Array.from(pixels);
      }
      var base = draw(input.color, input.texture), uniformVariant = draw(input.variant_color, input.texture), textureVariant = draw(input.color, input.variant_texture), repeat = draw(input.color, input.texture);
      var ext = gl.getExtension('WEBGL_debug_renderer_info'), error = gl.getError();
      var broken = gl.createShader(gl.FRAGMENT_SHADER); shaders.push(broken); gl.shaderSource(broken, 'invalid shader source'); gl.compileShader(broken);
      return { width: 8, height: 8, compile: true, link: true, error: error, base: base, uniform_variant: uniformVariant, texture_variant: textureVariant, repeat: repeat, invalid_shader_rejected: gl.getShaderParameter(broken, gl.COMPILE_STATUS) === false, identifier: String(gl.getParameter(ext ? ext.UNMASKED_RENDERER_WEBGL : gl.RENDERER)), parameters: { max_texture_size: gl.getParameter(gl.MAX_TEXTURE_SIZE), max_vertex_attribs: gl.getParameter(gl.MAX_VERTEX_ATTRIBS) } };
    } finally {
      if (texture) gl.deleteTexture(texture); if (buffer) gl.deleteBuffer(buffer); if (program) gl.deleteProgram(program); shaders.forEach(function (s) { gl.deleteShader(s); });
      var loss = gl.getExtension('WEBGL_lose_context'); if (loss) loss.loseContext();
    }
  }
  root.AuthenticityCore = { bounded: bounded, collect: async function (input, worker) {
    var result = {}, probes = { canvas: function () { return canvas(input.canvas, worker); }, audio: function () { if (worker) unsupported('Window-only OfflineAudioContext: outside intended Worker coverage'); return audio(input.audio); }, webgl: function () { return webgl(input.webgl, worker); } };
    var n = root.navigator || {}, data = n.userAgentData;
    result.environment = { user_agent: n.userAgent, platform: n.platform, language: n.language, languages: n.languages ? Array.from(n.languages) : null, cores: n.hardwareConcurrency, user_agent_data: data ? { brands: data.brands ? Array.from(data.brands) : null, mobile: data.mobile, platform: data.platform } : null };
    if (!worker) { var s = root.screen || {}; result.environment.screen = { width: s.width, height: s.height, avail_width: s.availWidth, avail_height: s.availHeight, color_depth: s.colorDepth, pixel_depth: s.pixelDepth }; result.environment.dpr = root.devicePixelRatio; }
    for (var name of Object.keys(probes)) {
      try { result[name] = { status: 'ok', observed: await bounded(Promise.resolve().then(probes[name]), 8000) }; }
      catch (error) { result[name] = { status: error.authenticityStatus === 'unsupported' ? 'unsupported' : 'error', reason: String(error.name + ': ' + error.message).slice(0, 500) }; }
    }
    return result;
  } };
}(typeof globalThis === 'object' ? globalThis : this));
