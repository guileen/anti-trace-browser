import test from 'node:test';
import assert from 'node:assert/strict';
import { RULES, SCHEMA_VERSION, SUITE_VERSION, STATUSES, scoreSubmission, validateSubmission } from '../src/scoring.mjs';

const submission = (observations = []) => ({ schema_version: SCHEMA_VERSION, suite_version: SUITE_VERSION, started_at: '2026-11-03T10:00:00.000Z', finished_at: '2026-11-03T10:00:01.000Z', observations });
const row = (report, id) => report.observations.find(o => o.id === id);
const observation = (id, value, extra = {}) => ({ id, status: 'pass', value, ...extra });
const canvas = () => ({ red_pixel: [255, 0, 0, 255], painted_pixels: 531, png_signature: '89504e470d0a1a0a', pixel_hash: 'a1234567', repeat_pixel_hash: 'a1234567', variant_pixel_hash: 'b1234567', png_hash: 'c1234567', repeat_png_hash: 'c1234567' });
const audio = () => ({ hash: '12345678', repeat_hash: '12345678', variant_hash: '87654321', samples: 4096, sample_rate: 44100, rms: 0.141, variant_rms: 0.142, zero_crossings: 81, variant_zero_crossings: 163 });

test('all axes have fixed 100-point denominator and missing observations earn zero', () => {
  const result = scoreSubmission(submission());
  assert.equal(result.observations.length, RULES.length);
  assert.equal(result.coverage.statuses.not_tested, RULES.length);
  assert.equal(result.coverage.observed, 0);
  for (const axis of Object.values(result.scores)) { assert.equal(axis.possible, 100); assert.equal(axis.score, 0); assert.equal(axis.coverage, 0); }
});

test('submitted pass without evidence is not success; unsupported remains separate', () => {
  const result = scoreSubmission(submission([{ id: 'canvas_render', status: 'pass' }, { id: 'audio_render', status: 'unsupported', detail: 'No OfflineAudioContext' }]));
  assert.equal(row(result, 'canvas_render').status, 'not_tested');
  assert.equal(row(result, 'audio_render').status, 'unsupported');
  assert.equal(result.scores.functionality.score, 0);
  assert.equal(result.scores.functionality.possible, 100);
});

test('unknown IDs, duplicates, malformed envelopes and excessive evidence are rejected', () => {
  for (const observations of [[{ id: 'invented', status: 'pass' }], [{ id: 'cookie', status: 'pass' }, { id: 'cookie', status: 'fail' }], [{ id: 'cookie', status: 'magic' }], [{ id: 'cookie', status: 'pass', duration_ms: -1 }], [{ id: 'cookie', status: 'pass', duration_ms: Infinity }], [{ id: 'cookie', status: 'error', detail: 'x'.repeat(4097) }]]) assert.throws(() => validateSubmission(submission(observations)));
  assert.throws(() => validateSubmission({ ...submission(), schema_version: 9 }));
  assert.throws(() => validateSubmission({ ...submission(), suite_version: 'old' }));
  assert.throws(() => validateSubmission({ ...submission(), observations: null }));
  assert.throws(() => validateSubmission({ ...submission(), finished_at: '2025-01-01T00:00:00Z' }));
  assert.throws(() => validateSubmission(submission([observation('cookie', { huge: 'x'.repeat(65537) })])));
});

test('real result controls override submitted status in both directions', () => {
  const result = scoreSubmission(submission([
    observation('cookie', { written: 'audit-value-7319', read: 'corrupted', deleted: true }),
    observation('local_storage', { written: 'audit-value-7319', read: 'audit-value-7319', deleted: true }, { status: 'fail' }),
  ]));
  assert.equal(row(result, 'cookie').status, 'fail');
  assert.equal(row(result, 'cookie').earned, 0);
  assert.equal(row(result, 'local_storage').status, 'pass');
  assert.equal(row(result, 'local_storage').submitted_status, 'fail');
  assert.equal(result.scores.functionality.score, 10);
});

test('canvas validates actual controls and separates PNG byte variation from scope protection', () => {
  const bytesChanged = { ...canvas(), repeat_png_hash: 'd1234567' };
  const result = scoreSubmission(submission([observation('canvas_render', bytesChanged), observation('canvas_privacy', bytesChanged)]));
  assert.equal(row(result, 'canvas_render').status, 'pass');
  assert.equal(row(result, 'canvas_privacy').status, 'not_tested');
  assert.equal(row(result, 'canvas_privacy').earned, 0);
  assert.match(row(result, 'canvas_privacy').reason, /PNG/);
  const corrupted = scoreSubmission(submission([observation('canvas_render', { ...canvas(), red_pixel: [0, 0, 0, 0] })]));
  assert.equal(row(corrupted, 'canvas_render').status, 'fail');
});

test('same-input noise by itself earns no cross-site protection score', () => {
  const result = scoreSubmission(submission([
    observation('canvas_privacy', { ...canvas(), repeat_pixel_hash: '11223344' }),
    observation('audio_privacy', { ...audio(), repeat_hash: '11223344' }),
    observation('cross_site', { isolated: true, channel_verified: true }),
    observation('public_network', { protected: true }),
  ]));
  assert.equal(result.scores.privacy.score, 0);
  for (const id of ['canvas_privacy', 'audio_privacy', 'cross_site', 'public_network']) assert.equal(row(result, id).status, 'not_tested');
});

test('WebGL extension absence only scores with functioning real red pixel readback', () => {
  const bad = scoreSubmission(submission([observation('webgl_privacy', { pixel: [0, 0, 0, 0], error: 0, debug_extension: false })]));
  assert.equal(bad.scores.privacy.score, 0);
  const good = scoreSubmission(submission([observation('webgl_privacy', { pixel: [255, 0, 0, 255], error: 0, debug_extension: false })]));
  assert.equal(good.scores.privacy.score, 10);
  assert.equal(good.scores.privacy.possible, 100);
});

test('audio frequency corruption and silent rendering are caught', () => {
  const good = scoreSubmission(submission([observation('audio_render', audio())]));
  assert.equal(row(good, 'audio_render').status, 'pass');
  for (const changed of [{ rms: 0 }, { variant_zero_crossings: 81 }, { variant_hash: '12345678' }, { samples: 0 }]) {
    const bad = scoreSubmission(submission([observation('audio_render', { ...audio(), ...changed })]));
    assert.equal(row(bad, 'audio_render').earned, 0);
  }
});

test('no media devices and absent webdriver cannot become protection success', () => {
  const result = scoreSubmission(submission([
    observation('media_privacy', { devices: [], camera_permission: 'denied', microphone_permission: 'denied' }),
    observation('webdriver', {}),
  ]));
  assert.equal(result.scores.privacy.score, 0);
  assert.equal(row(result, 'webdriver').earned, 0);
});

test('font baseline observation stays unmeasured for protection without a reference population', () => {
  for (const width of [100, 140]) {
    const result = scoreSubmission(submission([observation('font_privacy', { baseline: 100, measurements: [{ font: 'Test font', width }] })]));
    assert.equal(row(result, 'font_privacy').status, 'not_tested');
    assert.equal(row(result, 'font_privacy').earned, 0);
  }
});

test('performance requires correct workloads, positive elapsed time and fixed budgets', () => {
  const cpu = { iterations: 8000000, checksum: 383992440 };
  const dom = { nodes: 600, checksum: 179700, last_text: 'row-599', layout_height: 1200 };
  const result = scoreSubmission(submission([observation('cpu_workload', cpu, { duration_ms: 60 }), observation('dom_workload', dom, { duration_ms: 50 })]));
  assert.equal(result.scores.performance.score, 50);
  assert.equal(result.scores.performance.possible, 100);
  assert.equal(row(result, 'cpu_workload').earned, 25);
  for (const [value, duration_ms] of [[{ ...cpu, checksum: 0 }, 1], [cpu, 0]]) {
    const bad = scoreSubmission(submission([observation('cpu_workload', value, { duration_ms })]));
    assert.equal(bad.scores.performance.score, 0);
  }
});

test('statuses and coverage remain complete and bounded for corrupted fields', () => {
  const result = scoreSubmission(submission([observation('dom_events', { events: 5 }), observation('language_http', { language: 10, languages: [null] }), observation('iframe_coherence', { channel_verified: true, answer: 14638 })]));
  assert.equal(Object.values(result.coverage.statuses).reduce((a, b) => a + b, 0), RULES.length);
  assert.equal(result.coverage.observed, 3);
  for (const o of result.observations) { assert.ok(STATUSES.includes(o.status)); assert.ok(o.earned >= 0 && o.earned <= o.possible); }
});
