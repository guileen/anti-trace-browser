(function (root) {
  'use strict';
  function generateAuthenticityInputs(seed) {
    if (typeof seed !== 'string' || !seed.length || seed.length > 256) throw new Error('Authenticity seed must contain 1..256 characters');
    var state = 2166136261;
    for (var i = 0; i < seed.length; i++) state = Math.imul(state ^ seed.charCodeAt(i), 16777619) >>> 0;
    function next() { state = (Math.imul(state, 1664525) + 1013904223) >>> 0; return state; }
    function color() { return [32 + next() % 160, 32 + next() % 160, 32 + next() % 160, 255]; }
    var first = color(), second = first.map(function (n, i) { return i === 3 ? 255 : 255 - n; });
    var input = {
      version: 'authenticity-inputs-2', seed: seed,
      canvas: { monochrome: 24 + next() % 208, colors: [first, second, [19, 91, 211, 255]], alpha_color: color(), rotation: .15 + (next() % 400) / 1000,
        text: ['Audit ' + next() % 10000, '你好世界', 'مرحبا بالعالم', 'Ωμέγα κόσμος'], text_variant: ['Changed ' + next() % 10000, '世界你好中文', 'العالم مرحبا بكم', 'Ελληνικά Ωμέγα'], fonts: ['sans-serif', 'monospace'], glyphs: { round: 'O', straight: 'I', font: 'sans-serif', size: 32 } },
      audio: { frequency: 280 + next() % 260, gain: .2, sample_rate: 44100, length: 2048 },
      webgl: { color: first, variant_color: second, texture: [255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 255, 255, 255, 255, 0, 255], variant_texture: [0, 255, 255, 255, 255, 0, 255, 255, 255, 255, 255, 255, 0, 0, 0, 255] }
    };
    input.canvas.text_reordered = input.canvas.text.map(function (line) { return Array.from(line).reverse().join(''); });
    return input;
  }
  if (typeof module === 'object' && module.exports) module.exports = { generateAuthenticityInputs: generateAuthenticityInputs };
  else root.AuthenticityInputs = { generateAuthenticityInputs: generateAuthenticityInputs };
}(typeof globalThis === 'object' ? globalThis : this));
