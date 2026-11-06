import { createHash } from 'node:crypto';
import inputs from '../public/authenticity-inputs.cjs';
import { decodePNG } from '../../../browsers/engine-bench/scripts/png.mjs';

export const generateAuthenticityInputs = inputs.generateAuthenticityInputs;
const freeze = value => { if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); } return value; };
export const AUTHENTICITY_MANIFEST = freeze({
  schema: 1, suite_version: 'authenticity-2', input_version: 'authenticity-inputs-2',
  conditions: { canvas_color_space: 'default sRGB, 8-bit readback', canvas_sizes: { monochrome: [32, 24], regions: [32, 24], alpha: [32, 24], geometry: [64, 48], geometry_variant: [64, 48], geometry_repeat: [64, 48], text: [160, 64], text_variant: [160, 64], text_font_variant: [160, 64], text_reordered: [160, 64], glyph_o: [48, 48], glyph_i: [48, 48] }, glyphs: { font_size: 32, topology: 'O has an enclosed light counter; I has none; multiscript rows have nonrectangular stroke masks' }, export_roundtrip: 'Opaque RGB and all alpha bytes exact. At alpha128, RGB may differ by <=1: 8-bit premultiplication/unpremultiplication rounds channels at a step of 255/128, giving a half-step bound ceil(255/(2*128))=1. Transparent RGB must remain zero. No RGB tolerance elsewhere.', audio: { channels: 1, length: 2048, sample_rate: 44100, oscillator: 'sine', graph: 'oscillator -> gain -> destination; disconnect gain for silence' }, webgl: { width: 8, height: 8, texture: '2x2 RGBA, NEAREST, CLAMP_TO_EDGE', shader: 'texture2D(image,uv)*tint', dither: false, antialias: false } },
  thresholds: { pixel_channel_error: 2, partial_alpha_128_roundtrip_rgb_error: 1, geometry_edge_exclusion_px: 1.5, geometry_interior_match: .98, geometry_exterior_match: .98, text_min_ink_per_script: 4, text_distinct_occupied_rows: 3, text_distinct_occupied_columns: 3, text_changed_pixels_per_script: 2, glyph_counter_min_area: 24, audio_amplitude_relative_error: .02, audio_sine_residual_relative: .03, audio_gain_sample_error: .00002, audio_silence_peak: .0000001 },
  scope: { window: { canvas: 'required', audio: 'required', webgl: 'required' }, iframe: { canvas: 'required', audio: 'required', webgl: 'required' }, worker: { canvas: 'supported paths only; unsupported remains unsupported', audio: 'outside intended coverage: Window-only OfflineAudioContext', webgl: 'supported paths only; unsupported remains unsupported' } },
  applicability: { font_response: 'The frozen v2 sans-serif/monospace intervention assumes the configured font inventory contains distinct usable proportional and monospace faces. The collector must retain font inventory and effective selection/intervention evidence. An explicit single-family inventory may legitimately resolve both aliases to one face; v2 cannot establish a font differentiator for that configuration. This limitation does not waive or reinterpret a failed v2 font_response check, and statistics/alias declarations alone do not prove distinct effective faces. A future suite may select two independently evidenced, actually configured distinct families before freezing its inputs; existing v2 observations and rules must remain unchanged.' },
  bounds: { raw_json_bytes: 6 * 1024 * 1024, png_data_url_chars: 262144, feature_ms: 8000, child_ms: 30000, collection_ms: 45000, seed_chars: 256 },
  reference: { status: 'not_measured', sample_count: 0, hosts: [], engines: [], empirical_bounds: [], analytic_bounds: 'Frozen from commanded colors, geometry, sine graph and texture math; not claimed to be Chrome-derived. Parent must attach actual reference captures and host coverage separately.' },
  semantics: 'No entropy, unique-color-count, hash proximity, renderer family, or Chrome byte-equivalence gate. Statistics are diagnostics only. Unsupported is never a passed check. Displayed pixels and process/restart/configuration provenance require independent collector evidence.',
});
const T = AUTHENTICITY_MANIFEST.thresholds;
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const finiteArray = (a, length) => Array.isArray(a) && a.length === length && a.every(Number.isFinite);
const bytes = (a, length) => finiteArray(a, length) && a.every(n => Number.isInteger(n) && n >= 0 && n <= 255);
const hash = a => createHash('sha256').update(a).digest('hex');
const near = (a, b, tolerance = T.pixel_channel_error) => a.every((n, i) => Math.abs(n - b[i]) <= tolerance);
const pixel = (sample, x, y) => sample.pixels.slice((y * sample.width + x) * 4, (y * sample.width + x) * 4 + 4);
const rms = samples => Math.sqrt(samples.reduce((sum, n) => sum + n * n, 0) / samples.length);
function exportedSample(sample, width, height) {
  if (sample?.width !== width || sample.height !== height || !bytes(sample.pixels, width * height * 4)) return false;
  if (typeof sample.png !== 'string' || !sample.png.startsWith('data:image/png;base64,') || sample.png.length > AUTHENTICITY_MANIFEST.bounds.png_data_url_chars) return false;
  const png = Buffer.from(sample.png.slice(22), 'base64');
  // Reject a mismatched/decompression-bomb header before the shared decoder allocates.
  if (png.length < 33 || png.toString('ascii', 12, 16) !== 'IHDR' || png.readUInt32BE(16) !== width || png.readUInt32BE(20) !== height) return false;
  const decoded = decodePNG(png);
  if (decoded.width !== width || decoded.height !== height) return false;
  const gray = [0, 4].includes(decoded.color_type), hasAlpha = [4, 6].includes(decoded.color_type);
  for (let i = 0, j = 0; i < sample.pixels.length; i += 4, j += decoded.channels) {
    const alpha = hasAlpha ? decoded.pixels[j + decoded.channels - 1] : 255;
    if (sample.pixels[i + 3] !== alpha) return false;
    const tolerance = alpha === 128 ? T.partial_alpha_128_roundtrip_rgb_error : 0;
    for (let c = 0; c < 3; c++) {
      const exported = decoded.pixels[j + (gray ? 0 : c)], readback = sample.pixels[i + c];
      if ((alpha === 0 && (exported !== 0 || readback !== 0)) || Math.abs(exported - readback) > tolerance) return false;
    }
  }
  return true;
}
function imageStatistics(sample) {
  const p = sample.pixels, colors = new Map(), alpha = {}, spatial = Array.from({ length: 16 }, () => ({ count: 0, sum: [0, 0, 0, 0] }));
  let edgeEnergy = 0;
  for (let y = 0; y < sample.height; y++) for (let x = 0; x < sample.width; x++) {
    const i = (y * sample.width + x) * 4, key = p.slice(i, i + 4).join(','); colors.set(key, (colors.get(key) || 0) + 1); alpha[p[i + 3]] = (alpha[p[i + 3]] || 0) + 1;
    const cell = spatial[Math.min(3, Math.floor(y * 4 / sample.height)) * 4 + Math.min(3, Math.floor(x * 4 / sample.width))]; cell.count++;
    for (let c = 0; c < 4; c++) { cell.sum[c] += p[i + c]; if (x) edgeEnergy += Math.abs(p[i + c] - p[i + c - 4]); if (y) edgeEnergy += Math.abs(p[i + c] - p[i + c - sample.width * 4]); }
  }
  return { pixels_sha256: hash(Buffer.from(p)), png_sha256: typeof sample.png === 'string' ? hash(Buffer.from(sample.png.slice(22), 'base64')) : null, unique_rgba: colors.size, color_histogram_top16: [...colors].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, 16).map(([rgba, count]) => ({ rgba: rgba.split(',').map(Number), count })), alpha_histogram: alpha, spatial_4x4_rgba_means: spatial.map(c => c.sum.map(v => v / c.count)), edge_energy: edgeEnergy };
}
function allPixels(sample, expected) {
  for (let y = 0; y < sample.height; y++) for (let x = 0; x < sample.width; x++) if (!near(pixel(sample, x, y), expected(x, y))) return false;
  return true;
}
function geometryMeaning(sample, angle, color) {
  let inside = 0, insideOK = 0, outside = 0, outsideOK = 0;
  for (let y = 0; y < 48; y++) for (let x = 0; x < 64; x++) {
    const dx = x + .5 - 32, dy = y + .5 - 24, u = Math.cos(angle) * dx + Math.sin(angle) * dy, v = -Math.sin(angle) * dx + Math.cos(angle) * dy;
    const a = 12 - Math.abs(u), b = 7 - Math.abs(v), p = pixel(sample, x, y), margin = T.geometry_edge_exclusion_px;
    if (a > margin && b > margin) { inside++; if (near(p, color)) insideOK++; }
    else if (a < -margin || b < -margin) { outside++; if (near(p, [245, 245, 245, 255])) outsideOK++; }
  }
  return { ok: inside > 0 && outside > 0 && insideOK / inside >= T.geometry_interior_match && outsideOK / outside >= T.geometry_exterior_match, interior_match: insideOK / inside, exterior_match: outsideOK / outside };
}
function inkStructure(sample, y0, height) {
  const rows = new Set(), columns = new Set(), mask = new Uint8Array(sample.width * height);
  let ink = 0, minX = sample.width, maxX = -1, minY = height, maxY = -1;
  for (let y = 0; y < height; y++) {
    const occupied = [];
    for (let x = 0; x < sample.width; x++) {
      const p = pixel(sample, x, y + y0);
      if (Math.min(p[0], p[1], p[2]) < 128) { mask[y * sample.width + x] = 1; occupied.push(x); ink++; minX = Math.min(minX, x); maxX = Math.max(maxX, x); minY = Math.min(minY, y); maxY = Math.max(maxY, y); }
    }
    if (occupied.length) rows.add(occupied.join(','));
  }
  for (let x = 0; x < sample.width; x++) { const occupied = []; for (let y = 0; y < height; y++) if (mask[y * sample.width + x]) occupied.push(y); if (occupied.length) columns.add(occupied.join(',')); }
  return { ink, distinct_rows: rows.size, distinct_columns: columns.size, interior_background: ink ? (maxX - minX + 1) * (maxY - minY + 1) - ink : 0, width: ink ? maxX - minX + 1 : 0, height: ink ? maxY - minY + 1 : 0 };
}
function enclosedLightAreas(sample) {
  const width = sample.width, height = sample.height, bright = new Uint8Array(width * height), visited = new Uint8Array(width * height), enclosed = [];
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) { const p = pixel(sample, x, y); bright[y * width + x] = p[3] === 255 && p[0] >= 245 && p[1] >= 245 && p[2] >= 245 ? 1 : 0; }
  for (let start = 0; start < bright.length; start++) {
    if (!bright[start] || visited[start]) continue;
    const queue = [start]; visited[start] = 1; let border = false;
    for (let cursor = 0; cursor < queue.length; cursor++) {
      const index = queue[cursor], x = index % width, y = Math.floor(index / width); if (!x || x === width - 1 || !y || y === height - 1) border = true;
      for (const next of [x ? index - 1 : -1, x < width - 1 ? index + 1 : -1, y ? index - width : -1, y < height - 1 ? index + width : -1]) if (next >= 0 && bright[next] && !visited[next]) { visited[next] = 1; queue.push(next); }
    }
    if (!border) enclosed.push(queue.length);
  }
  return enclosed.filter(area => area >= T.glyph_counter_min_area);
}
function glyphMeaning(sample, text, font, round) {
  const m = sample.metrics?.[0], structure = inkStructure(sample, 0, sample.height), holes = enclosedLightAreas(sample);
  const opaque = sample.pixels.every((n, i) => i % 4 !== 3 || n === 255);
  return opaque && sample.metrics?.length === 1 && m?.text === text && m.font === font && Number.isFinite(m.width) && m.width > 2 && m.width <= 40 && structure.height >= 16 && structure.width >= 2 && (round ? structure.width >= 10 && holes.length > 0 && structure.distinct_rows >= 3 && structure.distinct_columns >= 3 : holes.length === 0);
}
function textMeaning(sample, lines, font) {
  if (!Array.isArray(sample.metrics) || sample.metrics.length !== 4) return false;
  return lines.every((line, row) => {
    const metric = sample.metrics[row];
    if (metric?.text !== line || metric.font !== font || !Number.isFinite(metric.width) || metric.width <= 2 || metric.width > 158) return false;
    let ink = 0;
    for (let y = row * 16; y < row * 16 + 16; y++) for (let x = 0; x < 160; x++) {
      const p = pixel(sample, x, y); if (p[3] !== 255) return false;
      if (p[0] < 245 || p[1] < 245 || p[2] < 245) { ink++; if (x > Math.ceil(metric.width) + 6) return false; }
    }
    const structure = inkStructure(sample, row * 16, 16);
    return ink >= T.text_min_ink_per_script && ink < 16 * Math.min(160, Math.ceil(metric.width) + 8) * .8 && structure.interior_background > 0 && structure.distinct_rows >= T.text_distinct_occupied_rows && structure.distinct_columns >= T.text_distinct_occupied_columns;
  });
}
function changedInRow(a, b, row) { let n = 0; for (let i = row * 16 * 160 * 4; i < (row + 1) * 16 * 160 * 4; i += 4) if (!eq(a.pixels.slice(i, i + 4), b.pixels.slice(i, i + 4))) n++; return n; }
function sineStatistics(samples, rate, frequency) {
  let ss = 0, cc = 0, sc = 0, ys = 0, yc = 0, crossings = 0;
  for (let i = 0; i < samples.length; i++) {
    const phase = 2 * Math.PI * frequency * i / rate, s = Math.sin(phase), c = Math.cos(phase); ss += s * s; cc += c * c; sc += s * c; ys += samples[i] * s; yc += samples[i] * c;
    if (i && (samples[i] >= 0) !== (samples[i - 1] >= 0)) crossings++;
  }
  const det = ss * cc - sc * sc, a = (ys * cc - yc * sc) / det, b = (yc * ss - ys * sc) / det;
  let residual = 0;
  for (let i = 0; i < samples.length; i++) { const phase = 2 * Math.PI * frequency * i / rate; residual += (samples[i] - a * Math.sin(phase) - b * Math.cos(phase)) ** 2; }
  const sampleBytes = Buffer.alloc(samples.length * 8);
  let peak = 0;
  samples.forEach((n, i) => { sampleBytes.writeDoubleLE(n, i * 8); peak = Math.max(peak, Math.abs(n)); });
  return { samples_sha256: hash(sampleBytes), sample_hash_encoding: 'IEEE754 Float64 little-endian', rms: rms(samples), peak, zero_crossings: crossings, estimated_hz: crossings * rate / (2 * samples.length), fitted_amplitude: Math.hypot(a, b), sine_residual_rms: Math.sqrt(residual / samples.length) };
}
function glExpected(pixels, color, texture) {
  if (!bytes(pixels, 8 * 8 * 4)) return false;
  for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) {
    const texel = (Math.floor(y / 4) * 2 + Math.floor(x / 4)) * 4, i = (y * 8 + x) * 4;
    if (!near(pixels.slice(i, i + 4), color.map((n, c) => Math.round(n * texture[texel + c] / 255)))) return false;
  }
  return true;
}
export function evaluateAuthenticity(raw) {
  const checks = [], statistics = {}, add = (id, ok, reason, observed) => checks.push({ id, status: ok ? 'pass' : 'fail', required: true, reason, ...(observed === undefined ? {} : { observed }) });
  let safe = false, canonical;
  try { safe = !!raw && Buffer.byteLength(JSON.stringify(raw)) <= AUTHENTICITY_MANIFEST.bounds.raw_json_bytes; canonical = generateAuthenticityInputs(raw?.input?.seed); } catch { /* Invalid/cyclic/oversized input cannot supply evidence. */ }
  const inputOK = safe && raw.schema === 1 && raw.suite_version === AUTHENTICITY_MANIFEST.suite_version && eq(raw.input, canonical);
  add('controlled_inputs', inputOK, 'Raw observation version and seed-generated held-out inputs must match the frozen generator; historical evidence is not upgraded.');
  for (const realm of ['window', 'iframe', 'worker']) for (const feature of ['canvas', 'audio', 'webgl']) {
    const id = `${realm}/${feature}`, row = safe ? raw.realms?.[realm]?.[feature] : null, optional = realm === 'worker';
    if (optional && feature === 'audio') { checks.push({ id, status: 'unsupported', required: false, reason: AUTHENTICITY_MANIFEST.scope.worker.audio }); continue; }
    if (!inputOK || row?.status !== 'ok' || !row.observed) {
      const status = !inputOK ? 'not_tested' : ['unsupported', 'error'].includes(row?.status) ? row.status : 'not_tested';
      checks.push({ id, status, required: !(optional && status === 'unsupported'), reason: String(row?.reason || 'Missing raw feature evidence').slice(0, 500) }); continue;
    }
    const v = row.observed;
    try {
      if (feature === 'canvas') {
        const valid = Object.entries(AUTHENTICITY_MANIFEST.conditions.canvas_sizes).every(([name, [w, h]]) => exportedSample(v[name], w, h));
        add(`${id}/export_readback`, valid, 'Every bounded PNG is independently decoded: alpha exact, opaque RGB exact, transparent RGB zero, only alpha128 RGB admits the analytic <=1 quantization bound.');
        if (!valid) continue;
        statistics[id] = Object.fromEntries(Object.keys(AUTHENTICITY_MANIFEST.conditions.canvas_sizes).map(name => [name, imageStatistics(v[name])]));
        const c = canonical.canvas;
        add(`${id}/monochrome`, allPixels(v.monochrome, () => [c.monochrome, c.monochrome, c.monochrome, 255]), 'A valid commanded monochrome image is accepted without an entropy/color-count minimum.');
        add(`${id}/spatial_regions`, allPixels(v.regions, x => c.colors[Math.min(2, Math.floor(x / 10))]), 'Each commanded color must occupy its commanded spatial region, not merely the same histogram.');
        add(`${id}/alpha`, allPixels(v.alpha, x => x < 16 ? [0, 0, 0, 0] : [...c.alpha_color.slice(0, 3), 128]), 'Transparent background and half-alpha color must survive readback/export.');
        for (const [name, angle] of [['geometry', c.rotation], ['geometry_variant', c.rotation + .8]]) { const meaning = geometryMeaning(v[name], angle, c.colors[0]); add(`${id}/${name}`, meaning.ok, 'Inverse-transformed rectangle interiors and exteriors are checked away from antialiasing boundaries.', meaning); }
        add(`${id}/geometry_response`, !eq(v.geometry.pixels, v.geometry_variant.pixels), 'Changed rotation must change the actual spatial image.');
        add(`${id}/repeat`, eq(v.geometry.pixels, v.geometry_repeat.pixels), 'Identical fixed-input geometry has identical repeated RGBA, not just nearby hashes.');
        add(`${id}/multiscript_text`, textMeaning(v.text, c.text, c.fonts[0]) && textMeaning(v.text_variant, c.text_variant, c.fonts[0]) && textMeaning(v.text_font_variant, c.text, c.fonts[1]) && textMeaning(v.text_reordered, c.text_reordered, c.fonts[0]), 'Every Latin/CJK/Arabic/Greek row requires bounded measured ink with distinct nonrectangular row/column stroke masks; input-dependent filled rectangles are rejected.');
        add(`${id}/glyph_topology`, glyphMeaning(v.glyph_o, c.glyphs.round, c.glyphs.font, true) && glyphMeaning(v.glyph_i, c.glyphs.straight, c.glyphs.font, false), 'At 32px O must contain an enclosed light counter while I must not; no Chrome pixel target or font-dependent O/I width inequality.');
        add(`${id}/text_reordering`, [0, 1, 2, 3].every(row => c.text[row].length === c.text_reordered[row].length && changedInRow(v.text, v.text_reordered, row) >= T.text_changed_pixels_per_script) && Math.abs(v.text.metrics[1].width - v.text_reordered.metrics[1].width) <= 1, 'Same-length reordered characters must change spatial glyph arrangement in every script; the CJK permutation retains the same total advance within one pixel.');
        add(`${id}/text_response`, [0, 1, 2, 3].every(row => changedInRow(v.text, v.text_variant, row) >= T.text_changed_pixels_per_script), 'Each script must respond to changed text, not only a changed hash/metadata label.');
        add(`${id}/font_response`, !eq(v.text.pixels, v.text_font_variant.pixels) && v.text.metrics.some((m, i) => Math.abs(m.width - v.text_font_variant.metrics[i].width) > .01), 'Commanded sans-serif versus monospace must affect at least one real text metric and raster.');
      } else if (feature === 'audio') {
        const c = canonical.audio, names = ['base', 'frequency', 'gain', 'disconnected', 'repeat'];
        const valid = names.every(name => v[name]?.sample_rate === c.sample_rate && finiteArray(v[name].samples, c.length));
        add(`${id}/raw_samples`, valid, 'All graph variants preserve bounded finite samples at the commanded rate.'); if (!valid) continue;
        const stats = Object.fromEntries(names.map(name => [name, sineStatistics(v[name].samples, c.sample_rate, c.frequency * (name === 'frequency' ? 2 : 1))])); statistics[id] = stats;
        for (const name of ['base', 'frequency', 'gain']) {
          const s = stats[name], amplitude = c.gain * (name === 'gain' ? .5 : 1), frequency = c.frequency * (name === 'frequency' ? 2 : 1);
          add(`${id}/${name}`, Math.abs(s.fitted_amplitude / amplitude - 1) <= T.audio_amplitude_relative_error && s.sine_residual_rms <= amplitude * T.audio_sine_residual_relative && Math.abs(s.estimated_hz - frequency) <= c.sample_rate / c.length, 'Frequency-specific sine fit, nonzero commanded amplitude and bounded residual reject input-insensitive/synthetic graph responses.', s);
        }
        add(`${id}/gain_response`, v.base.samples.every((n, i) => Math.abs(v.gain.samples[i] - n * .5) <= T.audio_gain_sample_error), 'Half gain must halve the actual waveform.');
        add(`${id}/disconnect`, stats.disconnected.peak <= T.audio_silence_peak, 'Disconnecting the gain node must remove the signal, not merely change a reported hash.');
        add(`${id}/repeat`, eq(v.base.samples, v.repeat.samples), 'Identical offline graph inputs produce identical repeated samples.');
      } else {
        const c = canonical.webgl;
        add(`${id}/shader`, v.compile === true && v.link === true && v.invalid_shader_rejected === true && v.error === 0 && v.width === 8 && v.height === 8, 'Real vertex/fragment compilation, link, invalid shader rejection and error-free draw/readback are required.');
        for (const [name, color, texture] of [['base', c.color, c.texture], ['uniform_variant', c.variant_color, c.texture], ['texture_variant', c.color, c.variant_texture]]) add(`${id}/${name}`, glExpected(v[name], color, texture), 'Each of four nearest-filtered texture regions must equal shader texture*uniform math, including changed inputs.');
        add(`${id}/repeat`, bytes(v.base, 256) && eq(v.base, v.repeat), 'Restoring identical shader inputs must restore identical full RGBA readback.');
        statistics[id] = { identifier: v.identifier, parameters: v.parameters, readbacks: Object.fromEntries(['base', 'uniform_variant', 'texture_variant', 'repeat'].filter(name => bytes(v[name], 256)).map(name => [name, imageStatistics({ width: 8, height: 8, pixels: v[name] })])) };
      }
    } catch (error) { checks.push({ id, status: 'error', required: true, reason: String(error.message).slice(0, 500) }); }
  }
  const coverage = { reference: AUTHENTICITY_MANIFEST.reference, required: checks.filter(c => c.required).length, passed: checks.filter(c => c.status === 'pass').length, unsupported: checks.filter(c => c.status === 'unsupported').map(c => ({ id: c.id, required: c.required, reason: c.reason })), missing: checks.filter(c => c.status === 'not_tested').map(c => c.id), scope: AUTHENTICITY_MANIFEST.scope };
  const overall = checks.some(c => ['fail', 'error'].includes(c.status)) ? 'fail' : checks.some(c => c.required && c.status !== 'pass') ? 'not_tested' : 'pass';
  return { checks, overall, coverage, statistics };
}
