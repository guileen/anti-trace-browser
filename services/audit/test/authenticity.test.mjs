import test from 'node:test';
import assert from 'node:assert/strict';
import { deflateSync } from 'node:zlib';
import { AUTHENTICITY_MANIFEST, generateAuthenticityInputs, evaluateAuthenticity } from '../src/authenticity.mjs';

// Analytic unit fixtures are NOT browser/reference captures. Real-runtime provenance,
// displayed pixels and reference host coverage are exercised by the outer collector.
function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) { crc ^= byte; for (let i = 0; i < 8; i++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0); }
  return (crc ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const name = Buffer.from(type), size = Buffer.alloc(4), crc = Buffer.alloc(4); size.writeUInt32BE(data.length); crc.writeUInt32BE(crc32(Buffer.concat([name, data])));
  return Buffer.concat([size, name, data, crc]);
}
function encode(sample, gray = false) {
  const { width, height, pixels } = sample, channels = gray ? 1 : 4, header = Buffer.alloc(13), scanlines = Buffer.alloc((width * channels + 1) * height);
  header.writeUInt32BE(width, 0); header.writeUInt32BE(height, 4); header[8] = 8; header[9] = gray ? 0 : 6;
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) for (let c = 0; c < channels; c++) scanlines[y * (width * channels + 1) + 1 + x * channels + c] = pixels[(y * width + x) * 4 + c];
  sample.png = 'data:image/png;base64,' + Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), chunk('IHDR', header), chunk('IDAT', deflateSync(scanlines)), chunk('IEND', Buffer.alloc(0))]).toString('base64');
  return sample;
}
function image(width, height, expected) {
  const pixels = [];
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) pixels.push(...expected(x, y));
  return encode({ width, height, pixels });
}
function canvas(input) {
  const c = input.canvas, foreground = [24, 59, 113, 255], background = [255, 255, 255, 255];
  function geometry(angle) { return image(64, 48, (x, y) => { const dx = x + .5 - 32, dy = y + .5 - 24; return Math.abs(dx * Math.cos(angle) + dy * Math.sin(angle)) < 12 && Math.abs(-dx * Math.sin(angle) + dy * Math.cos(angle)) < 7 ? c.colors[0] : [245, 245, 245, 255]; }); }
  function text(lines, font, variant) {
    const sample = image(160, 64, (x, y) => {
      const left = 3 + variant * 3, u = (x - left) % 8, v = y % 16 - 3, inGlyphs = x >= left && x < left + 24;
      const stroke = ((u === 0 || u === 5) && v >= 1 && v <= 7) || ((v === 0 || v === 8) && u >= 1 && u <= 4) || (v === 4 && u >= 2 && u <= 5);
      return inGlyphs && stroke ? foreground : background;
    });
    sample.metrics = lines.map((line, row) => ({ text: line, font, width: 60 + row + (variant === 3 ? 0 : variant * 2) })); return sample;
  }
  function glyph(round) {
    const sample = image(48, 48, (x, y) => {
      const outer = ((x - 23) / 11) ** 2 + ((y - 27) / 14) ** 2, inner = ((x - 23) / 7) ** 2 + ((y - 27) / 10) ** 2;
      return (round ? outer <= 1 && inner >= 1 : x >= 20 && x < 24 && y >= 13 && y <= 39) ? [0, 0, 0, 255] : background;
    });
    sample.metrics = [{ text: round ? c.glyphs.round : c.glyphs.straight, font: c.glyphs.font, width: round ? 26 : 10 }]; return sample;
  }
  const value = {
    monochrome: image(32, 24, () => [c.monochrome, c.monochrome, c.monochrome, 255]), regions: image(32, 24, x => c.colors[Math.min(2, Math.floor(x / 10))]), alpha: image(32, 24, x => x < 16 ? [0, 0, 0, 0] : [...c.alpha_color.slice(0, 3), 128]),
    geometry: geometry(c.rotation), geometry_variant: geometry(c.rotation + .8), geometry_repeat: geometry(c.rotation), text: text(c.text, c.fonts[0], 0), text_variant: text(c.text_variant, c.fonts[0], 1), text_font_variant: text(c.text, c.fonts[1], 2), text_reordered: text(c.text_reordered, c.fonts[0], 3), glyph_o: glyph(true), glyph_i: glyph(false),
  };
  // A legitimate grayscale PNG encoding must also be accepted.
  encode(value.monochrome, true);
  return value;
}
function audio(input) {
  const a = input.audio, render = (frequency, gain) => ({ sample_rate: a.sample_rate, samples: Array.from({ length: a.length }, (_, i) => gain * Math.sin(2 * Math.PI * frequency * i / a.sample_rate)) });
  return { base: render(a.frequency, a.gain), frequency: render(a.frequency * 2, a.gain), gain: render(a.frequency, a.gain / 2), disconnected: render(a.frequency, 0), repeat: render(a.frequency, a.gain) };
}
function webgl(input) {
  const g = input.webgl;
  function render(color, texture) { const pixels = []; for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) { const i = (Math.floor(y / 4) * 2 + Math.floor(x / 4)) * 4; pixels.push(...color.map((n, c) => Math.round(n * texture[i + c] / 255))); } return pixels; }
  return { width: 8, height: 8, compile: true, link: true, error: 0, invalid_shader_rejected: true, base: render(g.color, g.texture), uniform_variant: render(g.variant_color, g.texture), texture_variant: render(g.color, g.variant_texture), repeat: render(g.color, g.texture), identifier: 'analytic-unit-fixture', parameters: {} };
}
function fixture(seed = 'held-out-unit-7319') {
  const input = generateAuthenticityInputs(seed), realm = () => ({ canvas: { status: 'ok', observed: canvas(input) }, audio: { status: 'ok', observed: audio(input) }, webgl: { status: 'ok', observed: webgl(input) } });
  return { schema: 1, suite_version: 'authenticity-2', input, run_id: 'unit-only', realms: { window: realm(), iframe: realm(), worker: { canvas: { status: 'unsupported', reason: 'No Worker OffscreenCanvas in this analytic fixture' }, audio: { status: 'unsupported', reason: 'Window-only' }, webgl: { status: 'unsupported', reason: 'No Worker OffscreenCanvas in this analytic fixture' } } } };
}
const check = (result, id) => result.checks.find(c => c.id === id);

test('frozen seeded inputs are deterministic, held-out and versioned', () => {
  assert.deepEqual(generateAuthenticityInputs('new-seed'), generateAuthenticityInputs('new-seed'));
  assert.notDeepEqual(generateAuthenticityInputs('new-seed'), generateAuthenticityInputs('another-seed'));
  assert.throws(() => generateAuthenticityInputs(''));
  assert.throws(() => generateAuthenticityInputs('x'.repeat(257)));
  assert.equal(Object.isFrozen(AUTHENTICITY_MANIFEST.thresholds), true);
  assert.equal(AUTHENTICITY_MANIFEST.reference.sample_count, 0);
  assert.equal(AUTHENTICITY_MANIFEST.reference.status, 'not_measured');
});

test('valid monochrome and full analytic meaning pass without entropy requirements', () => {
  const result = evaluateAuthenticity(fixture());
  assert.equal(result.overall, 'pass', JSON.stringify(result.checks.filter(c => c.required && c.status !== 'pass')));
  assert.equal(check(result, 'window/canvas/monochrome').status, 'pass');
  assert.equal(result.statistics['window/canvas'].monochrome.unique_rgba, 1);
  assert.equal(result.coverage.unsupported.find(c => c.id === 'worker/canvas').required, false);
  assert.equal(check(result, 'worker/audio').status, 'unsupported');
  assert.equal(result.coverage.reference.sample_count, 0);
});

test('constant and unchanged Canvas outputs fail input-conditioned semantics', () => {
  const raw = fixture(), canvas = raw.realms.window.canvas.observed;
  canvas.regions = image(32, 24, () => [80, 80, 80, 255]);
  canvas.geometry_variant = structuredClone(canvas.geometry);
  canvas.text_variant = structuredClone(canvas.text);
  const result = evaluateAuthenticity(raw);
  assert.equal(result.overall, 'fail');
  for (const id of ['window/canvas/spatial_regions', 'window/canvas/geometry_response', 'window/canvas/text_response']) assert.equal(check(result, id).status, 'fail');
  assert.equal(check(result, 'window/canvas/export_readback').status, 'pass');
});

test('histogram-preserving spatial shuffle fails even with matching export/readback', () => {
  const raw = fixture(), regions = raw.realms.window.canvas.observed.regions, before = new Map();
  function histogram(pixels) { const counts = new Map(); for (let i = 0; i < pixels.length; i += 4) { const color = pixels.slice(i, i + 4).join(','); counts.set(color, (counts.get(color) || 0) + 1); } return [...counts.entries()].sort(); }
  before.set('histogram', histogram(regions.pixels));
  const shuffled = [];
  for (let y = 0; y < regions.height; y++) for (let x = 0; x < regions.width; x++) { const source = (y * regions.width + (x + 13) % regions.width) * 4; shuffled.push(...regions.pixels.slice(source, source + 4)); }
  regions.pixels = shuffled; encode(regions);
  assert.deepEqual(histogram(regions.pixels), before.get('histogram'));
  const result = evaluateAuthenticity(raw);
  assert.equal(check(result, 'window/canvas/export_readback').status, 'pass');
  assert.equal(check(result, 'window/canvas/spatial_regions').status, 'fail');
});

test('PNG mismatch and false grayscale exports fail independently of statistics', () => {
  const raw = fixture(), samples = raw.realms.window.canvas.observed;
  samples.monochrome.pixels[0] ^= 1;
  assert.equal(check(evaluateAuthenticity(raw), 'window/canvas/export_readback').status, 'fail');
  const fresh = fixture(); encode(fresh.realms.window.canvas.observed.regions, true);
  assert.equal(check(evaluateAuthenticity(fresh), 'window/canvas/export_readback').status, 'fail');
});

test('ignored frequency, gain and disconnected graph controls are rejected separately', () => {
  for (const [variant, id] of [['frequency', 'frequency'], ['gain', 'gain_response'], ['disconnected', 'disconnect']]) {
    const raw = fixture(), audio = raw.realms.iframe.audio.observed; audio[variant] = structuredClone(audio.base);
    const result = evaluateAuthenticity(raw);
    assert.equal(result.overall, 'fail'); assert.equal(check(result, `iframe/audio/${id}`).status, 'fail');
  }
});

test('a same-energy square wave cannot substitute for actual sine graph computation', () => {
  const raw = fixture(), a = raw.input.audio, value = raw.realms.window.audio.observed;
  value.base.samples = value.base.samples.map((_, i) => Math.sin(2 * Math.PI * a.frequency * i / a.sample_rate) >= 0 ? a.gain / Math.sqrt(2) : -a.gain / Math.sqrt(2));
  assert.equal(check(evaluateAuthenticity(raw), 'window/audio/base').status, 'fail');
});

test('shader uniform and texture input-insensitive output cannot pass', () => {
  const raw = fixture(), gl = raw.realms.window.webgl.observed;
  gl.uniform_variant = structuredClone(gl.base); gl.texture_variant = structuredClone(gl.base);
  const result = evaluateAuthenticity(raw);
  assert.equal(check(result, 'window/webgl/base').status, 'pass');
  assert.equal(check(result, 'window/webgl/uniform_variant').status, 'fail');
  assert.equal(check(result, 'window/webgl/texture_variant').status, 'fail');
});

test('supported Worker paths are judged and unsupported/missing required realms never pass', () => {
  const raw = fixture(); raw.realms.worker = structuredClone(raw.realms.window);
  assert.equal(check(evaluateAuthenticity(raw), 'worker/canvas/monochrome').status, 'pass');
  raw.realms.worker.webgl.observed.texture_variant = raw.realms.worker.webgl.observed.base;
  assert.equal(evaluateAuthenticity(raw).overall, 'fail');
  const absent = fixture(); absent.realms.iframe.audio = { status: 'unsupported', reason: 'Unavailable' };
  assert.equal(evaluateAuthenticity(absent).overall, 'not_tested');
  delete absent.realms.iframe;
  assert.equal(check(evaluateAuthenticity(absent), 'iframe/canvas').status, 'not_tested');
});

test('historical, altered input, oversized, nonfinite and malformed evidence never passes', () => {
  const raw = fixture(); raw.suite_version = 'suite-4'; assert.equal(evaluateAuthenticity(raw).overall, 'fail');
  const altered = fixture(); altered.input.canvas.rotation += .1; assert.equal(check(evaluateAuthenticity(altered), 'controlled_inputs').status, 'fail');
  const oversized = fixture(); oversized.padding = 'x'.repeat(AUTHENTICITY_MANIFEST.bounds.raw_json_bytes); assert.equal(evaluateAuthenticity(oversized).overall, 'fail');
  const nan = fixture(); nan.realms.window.audio.observed.base.samples[0] = NaN; assert.equal(check(evaluateAuthenticity(nan), 'window/audio/raw_samples').status, 'fail');
  const malformed = fixture(); malformed.realms.window.canvas.observed.alpha.png = 'data:image/png;base64,AAAA'; assert.equal(check(evaluateAuthenticity(malformed), 'window/canvas/export_readback').status, 'fail');
  assert.equal(evaluateAuthenticity(null).overall, 'fail');
});

test('input-dependent filled rectangles with plausible metrics are not multiscript glyphs', () => {
  const raw = fixture(), value = raw.realms.window.canvas.observed;
  for (const [variant, name] of ['text', 'text_variant', 'text_font_variant', 'text_reordered'].entries()) {
    const metrics = value[name].metrics;
    value[name] = image(160, 64, (x, y) => {
      const row = Math.floor(y / 16), left = 3 + variant * 3;
      return x >= left && x < left + 12 + row && y % 16 >= 3 && y % 16 < 10 ? [24, 59, 113, 255] : [255, 255, 255, 255];
    });
    value[name].metrics = metrics;
  }
  const result = evaluateAuthenticity(raw);
  assert.equal(check(result, 'window/canvas/export_readback').status, 'pass');
  assert.equal(check(result, 'window/canvas/text_response').status, 'pass');
  assert.equal(check(result, 'window/canvas/glyph_topology').status, 'pass');
  assert.equal(check(result, 'window/canvas/multiscript_text').status, 'fail');
});

test('O and I topology cannot be replaced by rectangles or swapped', () => {
  const raw = fixture(), value = raw.realms.window.canvas.observed, metrics = value.glyph_o.metrics;
  value.glyph_o = image(48, 48, (x, y) => x >= 12 && x <= 32 && y >= 13 && y <= 39 ? [0, 0, 0, 255] : [255, 255, 255, 255]);
  value.glyph_o.metrics = metrics;
  assert.equal(check(evaluateAuthenticity(raw), 'window/canvas/glyph_topology').status, 'fail');
  const swapped = fixture(), glyphs = swapped.realms.window.canvas.observed;
  const pixels = glyphs.glyph_o.pixels; glyphs.glyph_o.pixels = glyphs.glyph_i.pixels; glyphs.glyph_i.pixels = pixels;
  encode(glyphs.glyph_o); encode(glyphs.glyph_i);
  assert.equal(check(evaluateAuthenticity(swapped), 'window/canvas/glyph_topology').status, 'fail');
});

test('same-length multiscript reordering must alter actual spatial output', () => {
  const raw = fixture(), value = raw.realms.window.canvas.observed;
  value.text_reordered.pixels = [...value.text.pixels]; encode(value.text_reordered);
  assert.equal(check(evaluateAuthenticity(raw), 'window/canvas/text_reordering').status, 'fail');
  assert.ok(raw.input.canvas.text.every((line, i) => line.length === raw.input.canvas.text_reordered[i].length));
});

test('half-alpha roundtrip admits one quantization unit but not three, alpha drift, or opaque drift', () => {
  for (const [delta, alphaDelta, expected] of [[1, 0, 'pass'], [3, 0, 'fail'], [0, 1, 'fail']]) {
    const raw = fixture(), sample = raw.realms.window.canvas.observed.alpha, readback = [...sample.pixels];
    for (let i = 0; i < sample.pixels.length; i += 4) if (sample.pixels[i + 3] === 128) { sample.pixels[i + 2] -= delta; sample.pixels[i + 3] += alphaDelta; }
    encode(sample); sample.pixels = readback;
    assert.equal(check(evaluateAuthenticity(raw), 'window/canvas/export_readback').status, expected);
  }
  const opaque = fixture(); opaque.realms.window.canvas.observed.regions.pixels[0]++;
  assert.equal(check(evaluateAuthenticity(opaque), 'window/canvas/export_readback').status, 'fail');
});

test('v1 evidence is not silently judged as the strengthened v2 suite', () => {
  const raw = fixture(); raw.suite_version = 'authenticity-1'; raw.input.version = 'authenticity-inputs-1';
  assert.equal(check(evaluateAuthenticity(raw), 'controlled_inputs').status, 'fail');
});
