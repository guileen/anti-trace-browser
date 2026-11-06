import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, mkdir, readFile, writeFile, rm, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { MANIFEST, SUITE_VERSION, PRODUCT_SCENARIOS, COLLECTOR_IDENTITY, evaluateAcceptance, generateInputs, generateInputVariants, generateCreationInputs, workloadFor, digest } from '../src/manifest.mjs';
import { createAuditServer } from '../src/server.mjs';
import { buildScoreboard } from '../../../browsers/engine-bench/acceptance/scoreboard.mjs';
import { deflateSync, gunzipSync } from 'node:zlib';
import { scoreSubmission, SCHEMA_VERSION } from '../src/scoring.mjs';
import { createHash } from 'node:crypto';
import { evaluateFile } from '../../../browsers/engine-bench/acceptance/evaluate.mjs';
import { inspectArchive, corruptArchive } from '../../../browsers/engine-bench/acceptance/archive-evidence.mjs';
import { drainValid, parseProcesses } from '../../../browsers/engine-bench/acceptance/process-evidence.mjs';
import { cliCollectionFailure } from '../../../browsers/engine-bench/acceptance/product-collector.mjs';
import { productObservations } from '../src/product-evidence.mjs';
import { eventsForScenario } from '../../../browsers/engine-bench/acceptance/scenario-events.mjs';

const inputs = generateInputs('independent-regression-fixture');
function coresMatrix(runtime = 'camoufox') {
  const input_digest = digest(inputs), run_id = 'collection-fixture', runtime_digest = digest(runtime);
  const environments = { A: { sha256: digest('A') }, B: { sha256: digest('B') } };
  const input_variants = generateInputVariants(inputs), workload = workloadFor('independent-regression-fixture');
  return { schema: 2, suite_version: SUITE_VERSION, inputs: structuredClone(inputs), input_generation: { version: 1, seed: 'independent-regression-fixture' }, input_digest, input_variants, input_variants_digest: digest(input_variants), workload, workload_digest: digest(workload), creation_inputs: generateCreationInputs('independent-regression-fixture'),
    race_id: 'race-fixture', run_id, runtime: { id: runtime, artifact_sha256: runtime_digest }, environments,
    collector_sha256: COLLECTOR_IDENTITY.sha256, host: { fixture: 'one host' }, started_at: new Date(Date.now() - 2000).toISOString(), finished_at: new Date(Date.now() - 1000).toISOString(),
    runs: MANIFEST.phases.flatMap(phase => MANIFEST.sites.flatMap(site => MANIFEST.lifecycles.map(lifecycle => ({ run_id: `${phase}/${site}`, collection_run_id: run_id, suite_version: SUITE_VERSION, runtime_id: runtime, runtime_digest, input_digest, environment_digest: environments[phase[0]].sha256, environment: phase[0], phase, lifecycle, site, features: { cores: { status: 'pass', observed: { cores: phase[0] === 'A' ? 4 : 8 } } } })))) };
}
const check = (result, id) => result.checks.find(row => row.id === id);

test('full lifecycle core evidence passes only its own stability/differentiation while missing features remain required', () => {
  const result = evaluateAcceptance(coresMatrix());
  assert.equal(check(result, 'stability/cores/A').status, 'pass');
  assert.equal(check(result, 'stability/cores/B').status, 'pass');
  assert.equal(check(result, 'differentiation/cores/1/http://localhost').status, 'pass');
  assert.equal(result.status, 'outstanding');
  assert.equal(check(result, 'gui_real_image_input').status, 'not_tested');
  assert.equal(check(result, 'functionality/audio/A1/initial/http://localhost').status, 'not_tested');
});

test('restart drift and equal environments fail instead of shrinking the manifest', () => {
  const raw = coresMatrix();
  raw.runs.find(r => r.phase === 'B2' && r.lifecycle === 'initial' && r.site.endsWith('localhost')).features.cores.observed.cores = 4;
  const result = evaluateAcceptance(raw);
  assert.equal(check(result, 'stability/cores/B').status, 'fail');
  assert.equal(check(result, 'differentiation/cores/2/http://localhost').status, 'fail');
  raw.runs[0].features.cores = { status: 'unsupported', detail: 'No hardwareConcurrency' };
  assert.equal(check(evaluateAcceptance(raw), 'functionality/cores/A1/initial/http://127.0.0.1').status, 'unsupported');
});

test('different ports do not count as independent sites and old suite versions never silently pass', () => {
  const raw = coresMatrix();
  for (const r of raw.runs) r.site = r.site.endsWith('localhost') ? 'http://127.0.0.1:8766' : 'http://127.0.0.1:8765';
  assert.equal(check(evaluateAcceptance(raw), 'two_schemeful_sites').status, 'not_tested');
  raw.suite_version = '2026.11.03.1';
  const result = evaluateAcceptance(raw);
  assert.equal(check(result, 'suite_version').status, 'not_tested');
  assert.equal(check(result, 'stability/cores/A').status, 'not_tested');
});

test('audio judges actual frequency, gain and disconnected sample responses rather than submitted pass', () => {
  const raw = coresMatrix();
  const sample = (frequency, gain) => ({ sample_rate: 44100, samples: Array.from({ length: 4096 }, (_, n) => Math.sin(2 * Math.PI * frequency * n / 44100) * gain) });
  const observed = { base: sample(inputs.frequency, .2), frequency: sample(inputs.frequency * 2, .2), gain: sample(inputs.frequency, .1), disconnected: sample(inputs.frequency, 0) };
  raw.runs[0].features.audio = { status: 'pass', observed };
  const id = 'functionality/audio/A1/initial/http://127.0.0.1';
  assert.equal(check(evaluateAcceptance(raw), id).status, 'pass');
  observed.gain = sample(inputs.frequency, .2);
  assert.equal(check(evaluateAcceptance(raw), id).status, 'fail');
  observed.gain = sample(inputs.frequency, .1); observed.disconnected = sample(inputs.frequency, .2);
  assert.equal(check(evaluateAcceptance(raw), id).status, 'fail');
});

test('matching Worker identity still requires worker-global semantics', () => {
  const raw = coresMatrix();
  const identity = { user_agent: 'fixture-UA', language: 'en-US', platform: 'fixture', cores: 4 };
  const observed = { main: identity, child: { ...identity }, challenge: inputs.challenge,
    answer: inputs.challenge * 7, http: { headers: { 'user-agent': identity.user_agent } },
    realm: { document_type: 'undefined', window_type: 'undefined', worker_global: true }, asynchronous: true, isolated: true, terminated: true, scheduling: ['sync', 'microtask', 'timer'] };
  raw.runs[0].features.worker = { status: 'pass', observed };
  const id = 'functionality/worker/A1/initial/http://127.0.0.1';
  assert.equal(check(evaluateAcceptance(raw), id).status, 'pass');
  observed.realm.document_type = 'object';
  assert.equal(check(evaluateAcceptance(raw), id).status, 'fail');
  observed.realm.document_type = 'undefined'; observed.realm.worker_global = false;
  assert.equal(check(evaluateAcceptance(raw), id).status, 'fail');
});

test('independent HTTP echo retains actual contexts, redirects and protocol but redacts credentials', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'acceptance-http-'));
  const server = createAuditServer({ dataDir: dir }); server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await rm(dir, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const headers = { 'User-Agent': 'Independent-test-client', Cookie: 'private=value', Authorization: 'private-value' };
  const echo = await (await fetch(base + '/api/echo?run_id=independent&context=fetch', { headers })).json();
  assert.equal(echo.headers['user-agent'], 'Independent-test-client'); assert.equal(echo.headers.cookie, undefined); assert.equal(echo.headers.authorization, undefined);
  const response = await fetch(base + '/api/echo/redirect?run_id=independent&context=redirect', { headers });
  assert.equal(response.redirected, true);
  const events = await (await fetch(base + '/api/echo/events?run_id=independent')).json();
  assert.equal(events.source, 'server'); assert.deepEqual(events.receipts.map(r => r.context), ['fetch', 'redirect', 'redirect']);
  assert.ok(events.receipts.every(r => r.protocol === 'HTTP/1.1' && r.source === 'server' && !r.headers.cookie));
  assert.equal((await (await fetch(base + '/api/manifest')).json()).suite_version, SUITE_VERSION);
  assert.equal((await fetch(base + '/acceptance.js')).status, 200);
});

test('historical revalidation preserves bytes, names current suite and reports missing raw evidence', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'acceptance-history-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const source = join(dir, 'old'); await import('node:fs/promises').then(fs => fs.mkdir(source));
  const history = '{"suite_version":"2026.11.03.1","scores":{"functionality":100},"observations":[{"id":"canvas_render","status":"pass","value":{"pixel_hash":"12345678"}}]}\n';
  await writeFile(join(source, 'old.json'), history);
  const output = join(dir, 'revalidated');
  const run = spawnSync(process.execPath, ['../../browsers/engine-bench/acceptance/revalidate.mjs', source, output], { cwd: new URL('..', import.meta.url), encoding: 'utf8' });
  assert.equal(run.status, 0, run.stderr);
  assert.equal(await readFile(join(source, 'old.json'), 'utf8'), history);
  const report = JSON.parse(await readFile(join(output, `old.${SUITE_VERSION}.verdict.json`), 'utf8'));
  assert.equal(report.source_suite_version, '2026.11.03.1'); assert.equal(report.status, 'outstanding');
  assert.ok(report.gaps.some(g => g.id.includes('canvas_text')));
  assert.equal((await readdir(source)).length, 1);
});

test('all 22 product scenarios remain mandatory independent gates even with producer approvals', () => {
  const raw = coresMatrix();
  raw.product_evidence = PRODUCT_SCENARIOS.map(s => ({ case_id: s.id, status: 'pass', approved: true }));
  raw.external_required = true;
  const result = evaluateAcceptance(raw);
  assert.equal(PRODUCT_SCENARIOS.length, 22);
  assert.deepEqual(result.checks.filter(c => c.id.startsWith('product/')).map(c => c.id), ['E1','E2','E3','I1','I2','I3','C1','C2','C3','L1','L2','G1','G2','A1','A2','N1','N2','T1','T2','K1','K2','K3'].map(id => `product/${id}`));
  assert.ok(result.checks.filter(c => c.id.startsWith('product/')).every(c => c.required && c.status === 'not_tested'));
  assert.equal(result.overall, 'NOT_PASS');
  assert.equal(result.product_coverage.passed, 0);
});

test('missing malformed duplicate failed stale and mixed observations preserve the full denominator', () => {
  const baseline = evaluateAcceptance(coresMatrix()).coverage.required;
  for (const mutate of [
    raw => { raw.runs = []; },
    raw => { raw.runs = null; },
    raw => { raw.runs.push(structuredClone(raw.runs[0])); },
    raw => { raw.runs[0].collection_error = 'Collector crashed after producing some valid values'; },
    raw => { raw.runs[0].runtime_id = 'lightpanda'; },
    raw => { raw.runs[0].runtime_digest = digest('other executable'); },
    raw => { raw.runs[0].input_digest = digest('other workload'); },
    raw => { raw.runs[0].environment_digest = digest('other configuration'); },
    raw => { raw.runs[0].collection_run_id = 'another collection'; },
    raw => { raw.runs[0].suite_version = '2026.11.04.3'; },
    raw => { raw.finished_at = '2020-01-01T00:00:00Z'; raw.started_at = raw.finished_at; },
    raw => { raw.inputs.frequency++; },
    raw => { raw.input_generation.seed = 'different independent inputs'; },
    raw => { raw.collection_error = 'failure after all page values'; },
  ]) {
    const raw = coresMatrix(); mutate(raw);
    const result = evaluateAcceptance(raw);
    assert.equal(result.coverage.required, baseline);
    assert.equal(result.overall, 'NOT_PASS');
    assert.notEqual(check(result, 'functionality/cores/A1/initial/http://127.0.0.1').status, 'pass');
  }
});

test('all non-pass producer states block functional and stability gates even with valid values', () => {
  for (const status of ['fail', 'unsupported', 'error', 'not_tested', 'review_required', 'made_up_pass']) {
    const raw = coresMatrix(); raw.runs[0].features.cores.status = status;
    const result = evaluateAcceptance(raw);
    assert.equal(check(result, 'functionality/cores/A1/initial/http://127.0.0.1').status, status === 'made_up_pass' ? 'error' : status);
    assert.equal(check(result, 'stability/cores/A').status, 'not_tested');
  }
});

function productFixture(raw, caseID = 'I2') {
  const events = [
    { name: 'invalid_config', source: 'process', args: ['create', 'invalidFixture'], exit_code: 1, stdout: JSON.stringify({ error: { code: 'invalid_config' } }), stderr: '' },
    { name: 'identity_collision', source: 'process', args: ['create', 'collisionFixture'], exit_code: 1, stdout: JSON.stringify({ error: { code: 'identity_collision' } }), stderr: '' },
  ];
  raw.commands = events.map((event, sequence) => {
    Object.assign(event, { sequence, started_at: raw.started_at, finished_at: raw.finished_at });
    return { sequence, args: event.args, exit_code: event.exit_code, started_at: event.started_at, finished_at: event.finished_at,
      stdout_sha256: createHash('sha256').update(event.stdout).digest('hex'), stderr_sha256: createHash('sha256').update(event.stderr).digest('hex') };
  });
  const content = { events };
  return { schema: 1, suite_version: SUITE_VERSION, case_id: caseID, source: 'process', run_id: raw.run_id,
    race_id: raw.race_id, runtime_id: raw.runtime.id, runtime_digest: raw.runtime.artifact_sha256,
    input_digest: raw.input_digest, environment_digests: raw.environments, collector_sha256: raw.collector_sha256,
    observed_at: raw.finished_at, artifacts: [{ id: 'process-observations', content, sha256: digest(content) }] };
}

test('harness product evaluator derives assertions from raw outcomes, not approvals or claimed passes', () => {
  const raw = coresMatrix(), record = productFixture(raw);
  const result = evaluateAcceptance(raw, { productEvidence: [record] }), gate = check(result, 'product/I2');
  assert.equal(gate.obligations.find(row => row.id === 'invalid_config').status, 'pass');
  assert.equal(gate.obligations.find(row => row.id === 'identity_collision').status, 'pass');
  assert.equal(gate.status, 'not_tested');
  assert.equal(result.overall, 'NOT_PASS');
  const claimed = productFixture(raw, 'A1');
  claimed.assertions = PRODUCT_SCENARIOS.find(s => s.id === 'A1').obligations.map(id => ({ id, status: 'pass', approved: true }));
  assert.equal(check(evaluateAcceptance(raw, { productEvidence: [claimed] }), 'product/A1').status, 'not_tested');
  record.artifacts[0].content.events[0].exit_code = 0;
  raw.commands[0].exit_code = 0;
  record.artifacts[0].sha256 = digest(record.artifacts[0].content);
  const failed = check(evaluateAcceptance(raw, { productEvidence: [record] }), 'product/I2');
  assert.equal(failed.obligations.find(row => row.id === 'invalid_config').status, 'fail');
});

test('stale mixed-runtime input collector and corrupted product artifacts cannot pass', () => {
  const raw = coresMatrix();
  for (const mutate of [
    p => { p.runtime_id = 'lightpanda'; },
    p => { p.runtime_digest = digest('other binary'); },
    p => { p.input_digest = digest('other inputs'); },
    p => { p.suite_version = '2026.11.04.3'; },
    p => { p.run_id = 'other collection'; },
    p => { p.collector_sha256 = digest('other collector'); },
    p => { p.environment_digests = { A: { sha256: digest('different profile') } }; },
    p => { p.observed_at = '2020-01-01T00:00:00Z'; },
    p => { p.artifacts[0].content = 'corrupted'; },
  ]) {
    const record = productFixture(raw); mutate(record);
    assert.ok(check(evaluateAcceptance(raw, { productEvidence: [record] }), 'product/I2').obligations.every(row => row.status !== 'pass'));
  }
});

test('scoreboard always contains all three runtimes and rejects mixed race/workload/runtime evidence', () => {
  const reports = ['camoufox', 'obscura', 'lightpanda'].map(runtime => ({ runtime, raw: coresMatrix(runtime) }));
  const score = buildScoreboard(reports);
  assert.equal(score.runtimes.length, 3); assert.equal(score.winner, null);
  assert.ok(score.runtimes.every(r => r.overall === 'NOT_PASS' && r.product_coverage.required === 22 && r.errors.length === 0));
  assert.equal(buildScoreboard(reports.slice(0, 1)).runtimes.length, 3);
  reports[1].raw.input_digest = digest('different workload');
  reports[2].raw.runtime.id = 'camoufox';
  const mixed = buildScoreboard(reports);
  assert.ok(mixed.runtimes[1].errors.some(s => s.includes('input_digest')));
  assert.ok(mixed.runtimes[2].errors.some(s => s.includes('runtime identity')));
  assert.equal(mixed.overall, 'NOT_PASS');
});

test('actual three-runtime command retains real CLI spawn failures and all mandatory cells', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'acceptance-race-failure-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const output = join(dir, 'new-race');
  const run = spawnSync(process.execPath, ['../../browsers/engine-bench/acceptance/race.mjs', '--output', output, '--cli', join(dir, 'nonexistent-real-cli'), '--input-seed', 'controlled-failure'], { cwd: new URL('..', import.meta.url), encoding: 'utf8', timeout: 60000, maxBuffer: 8 * 1024 * 1024 });
  assert.equal(run.status, 1, run.stderr);
  const scoreboard = JSON.parse(await readFile(join(output, 'scoreboard.json'), 'utf8'));
  assert.equal(scoreboard.overall, 'NOT_PASS');
  assert.equal(scoreboard.runtimes.length, 3);
  for (const runtime of ['camoufox', 'obscura', 'lightpanda']) {
    const raw = JSON.parse(await readFile(join(output, runtime, 'raw.json'), 'utf8'));
    assert.equal(raw.runtime.id, runtime); assert.ok(raw.collection_error);
    assert.equal(raw.runs.length, 32); assert.ok(raw.runs.every(row => row.collection_error));
    t.after(() => rm(raw.profile_home, { recursive: true, force: true }));
    const verdict = JSON.parse(await readFile(join(output, runtime, 'verdict.json'), 'utf8'));
    assert.equal(verdict.product_coverage.required, 22);
    assert.equal(verdict.coverage.required, evaluateAcceptance(coresMatrix()).coverage.required);
    assert.ok(raw.commands.some(c => c.args[0] === 'create'));
    assert.ok(raw.commands.some(c => c.args[0] === 'start'));
    assert.ok(raw.commands.some(c => c.args[0] === 'stop'));
  }
});

function encodedRaster(width, height, color) {
  const pixels = Array.from({ length: width * height * 4 }, (_, i) => color[i % 4]);
  const crc32 = bytes => { let crc = 0xffffffff; for (const byte of bytes) { crc ^= byte; for (let i = 0; i < 8; i++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0); } return (crc ^ 0xffffffff) >>> 0; };
  const chunk = (name, data) => { const type = Buffer.from(name), size = Buffer.alloc(4), crc = Buffer.alloc(4); size.writeUInt32BE(data.length); crc.writeUInt32BE(crc32(Buffer.concat([type, data]))); return Buffer.concat([size, type, data, crc]); };
  const header = Buffer.alloc(13); header.writeUInt32BE(width); header.writeUInt32BE(height, 4); header[8] = 8; header[9] = 6;
  const scanlines = Buffer.alloc(height * (width * 4 + 1));
  for (let y = 0; y < height; y++) Buffer.from(pixels.slice(y * width * 4, (y + 1) * width * 4)).copy(scanlines, y * (width * 4 + 1) + 1);
  const png = Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), chunk('IHDR', header), chunk('IDAT', deflateSync(scanlines)), chunk('IEND', Buffer.alloc(0))]);
  return { width, height, pixels, png: 'data:image/png;base64,' + png.toString('base64') };
}

test('text and geometry independently require genuine PNG decoding matching observed RGBA', () => {
  for (const [feature, width, height] of [['canvas_text', 192, 64], ['canvas_geometry', 64, 32]]) {
    const raw = coresMatrix(), observed = { base: encodedRaster(width, height, [10, 20, 30, 255]), variant: encodedRaster(width, height, [30, 20, 10, 255]) };
    raw.runs[0].features[feature] = { status: 'pass', observed };
    const id = `functionality/${feature}/A1/initial/http://127.0.0.1`;
    assert.equal(check(evaluateAcceptance(raw), id).status, 'pass');
    observed.base.pixels[0]++;
    assert.equal(check(evaluateAcceptance(raw), id).status, 'fail');
    observed.base.pixels[0]--;
    observed.base.png = 'data:image/png;base64,iVBORw0KGgo=';
    assert.equal(check(evaluateAcceptance(raw), id).status, 'fail');
  }
});

test('shader output and Worker scheduling isolation termination controls cannot substitute for one another', () => {
  const raw = coresMatrix();
  const observed = { compile: true, link: true, objects_valid: true, invalid_enum_error: 1280, error: 0, base: [...inputs.color], variant: inputs.color.map((n, i) => i === 3 ? n : 255 - n), identifier: 'actual test observation', parameters: [4096, 16, 8] };
  raw.runs[0].features.webgl = { status: 'pass', observed };
  const id = 'functionality/webgl/A1/initial/http://127.0.0.1';
  assert.equal(check(evaluateAcceptance(raw), id).status, 'pass');
  observed.variant = [...observed.base];
  assert.equal(check(evaluateAcceptance(raw), id).status, 'fail');
  const identity = { user_agent: 'fixture', language: 'en', platform: 'fixture', cores: 4 };
  const worker = { main: identity, child: identity, challenge: inputs.challenge, answer: inputs.challenge * 7, http: { headers: { 'user-agent': 'fixture' } }, realm: { document_type: 'undefined', window_type: 'undefined', worker_global: true }, asynchronous: true, isolated: true, terminated: true, scheduling: ['sync', 'microtask', 'timer'] };
  raw.runs[0].features.worker = { status: 'pass', observed: worker };
  const workerID = 'functionality/worker/A1/initial/http://127.0.0.1';
  assert.equal(check(evaluateAcceptance(raw), workerID).status, 'pass');
  for (const field of ['asynchronous', 'isolated', 'terminated']) { worker[field] = false; assert.equal(check(evaluateAcceptance(raw), workerID).status, 'fail'); worker[field] = true; }
  worker.scheduling = ['sync', 'timer', 'microtask'];
  assert.equal(check(evaluateAcceptance(raw), workerID).status, 'fail');
});

test('single-page report exposes all product gates as outstanding, never product acceptance', () => {
  const report = scoreSubmission({ schema_version: SCHEMA_VERSION, suite_version: SUITE_VERSION, started_at: new Date(Date.now() - 1000).toISOString(), finished_at: new Date().toISOString(), observations: [] });
  assert.equal(report.acceptance.overall, 'NOT_PASS');
  assert.equal(report.acceptance.product_scenarios.length, 22);
  assert.ok(report.acceptance.product_scenarios.every(row => row.required && row.status === 'not_tested' && row.obligations.length > 0));
});

test('process output edits cannot promote a gate even when artifact JSON is rehashed', () => {
  const raw = coresMatrix(), record = productFixture(raw);
  record.artifacts[0].content.events[0].stdout += ' ';
  record.artifacts[0].sha256 = digest(record.artifacts[0].content);
  assert.equal(check(evaluateAcceptance(raw, { productEvidence: [record] }), 'product/I2').status, 'error');
});

test('missing or corrupted referenced raw files block only their independent product scenario', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'acceptance-artifact-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const raw = coresMatrix(), record = productFixture(raw), path = join(dir, 'raw-receipt.bin'), bytes = Buffer.from('actual retained artifact');
  raw.artifact_root = dir;
  await writeFile(path, bytes);
  record.artifacts[0].content.events.push({ name: 'raw_artifact_fixture', source: 'file', content: { raw_artifact: { path, byte_length: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') } } });
  record.artifacts[0].sha256 = digest(record.artifacts[0].content);
  const result = () => evaluateAcceptance(raw, { productEvidence: [record] });
  assert.equal(check(result(), 'product/I2').obligations.find(row => row.id === 'invalid_config').status, 'pass');
  await writeFile(path, Buffer.alloc(bytes.length, 120));
  assert.equal(check(result(), 'product/I2').status, 'error');
  await rm(path);
  assert.equal(check(result(), 'product/I2').status, 'error');
  assert.equal(check(result(), 'product/A1').status, 'not_tested');
});

test('malformed revalidation and standalone evaluation keep every mandatory denominator and preserve originals', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'acceptance-malformed-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const source = join(dir, 'old'); await mkdir(source);
  const path = join(source, 'broken.json'), bytes = '{\"truncated\":';
  await writeFile(path, bytes);
  const verdict = await evaluateFile(path, join(dir, 'new-verdict.json'));
  assert.equal(verdict.coverage.required, 459); assert.equal(verdict.overall, 'NOT_PASS');
  assert.equal(check(verdict, 'collector_integrity').status, 'error');
  const run = spawnSync(process.execPath, ['../../browsers/engine-bench/acceptance/revalidate.mjs', source, join(dir, 'history')], { cwd: new URL('..', import.meta.url), encoding: 'utf8' });
  assert.equal(run.status, 0, run.stderr);
  const historical = JSON.parse(await readFile(join(dir, 'history', `broken.${SUITE_VERSION}.verdict.json`), 'utf8'));
  assert.equal(historical.coverage.required, 459);
  assert.equal(historical.product_coverage.required, 22);
  assert.equal(historical.overall, 'NOT_PASS');
  assert.equal(await readFile(path, 'utf8'), bytes);
});

test('archive evidence reads real gzip/tar bytes and mutation preserves gzip while changing one retained byte', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'acceptance-tar-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await mkdir(join(dir, 'profile'));
  await writeFile(join(dir, 'profile', 'config.json'), JSON.stringify({ fixture: 'archive-reader-only', network: { proxy_ref: 'private-reference' } }));
  await writeFile(join(dir, 'profile', 'data.bin'), 'x'.repeat(65530) + 'fixture-user:fixture-password');
  const path = join(dir, 'actual.tar.gz'), child = spawnSync('tar', ['-czf', path, '-C', dir, 'profile'], { encoding: 'utf8' });
  assert.equal(child.status, 0, child.stderr);
  const inspected = await inspectArchive(path);
  assert.equal(inspected.config.fixture, 'archive-reader-only');
  assert.equal(inspected.credential_counts.username, 1);
  assert.equal(inspected.credential_counts.password, 1);
  assert.ok(inspected.files.some(row => row.name.endsWith('/data.bin')));
  const before = await readFile(path), changed = join(dir, 'changed.tar.gz');
  await corruptArchive(path, changed, inspected.config_offset);
  const originalTar = gunzipSync(before), changedTar = gunzipSync(await readFile(changed));
  assert.equal(originalTar.length, changedTar.length);
  assert.equal(originalTar.reduce((count, byte, index) => count + (byte !== changedTar[index] ? 1 : 0), 0), 1);
  assert.deepEqual(await readFile(path), before);
});

test('malformed command ledgers cannot throw away the required verdict denominator', () => {
  for (const commands of [null, {}, [null]]) {
    const raw = coresMatrix(), record = productFixture(raw);
    raw.commands = commands;
    const result = evaluateAcceptance(raw, { productEvidence: [record] });
    assert.equal(result.coverage.required, 459);
    assert.equal(check(result, 'product/I2').status, 'error');
    assert.equal(result.overall, 'NOT_PASS');
  }
});

test('owner-only crash drain rejects orphan lifetime, early lease release, identity mixing and masked forced cleanup', () => {
  const row = '123 122 122 S Wed Nov  4 12:00:00 2026 /owned-fixture/native';
  const probe = state => ({ exit_code: 0, stdout: JSON.stringify({ state, device: 1, inode: 7 }), stderr: '' });
  const fixture = () => ({ children_before: [row], samples: [{ before: [row], lease: probe('busy'), after: [row] }, { before: [], lease: probe('acquired'), after: [] }], remaining_before_cleanup: [], cleanup: [], data_snapshots: [[{ path: 'storage', size: 8, mtime_ms: 1 }], [{ path: 'storage', size: 8, mtime_ms: 1 }]], lease_after: probe('acquired') });
  assert.equal(drainValid(fixture()), true);
  for (const mutate of [
    value => { value.samples[0].lease = probe('acquired'); },
    value => { value.remaining_before_cleanup = [row]; },
    value => { value.cleanup = [{ pid: 123, signal: 'SIGKILL' }]; },
    value => { value.samples[0].after = [row.replace('123 122', '124 122')]; },
    value => { value.data_snapshots[1][0].mtime_ms = 2; },
    value => { value.lease_after = probe('busy'); },
    value => { value.children_before = []; },
  ]) { const value = fixture(); mutate(value); assert.equal(drainValid(value), false); }
});

test('valid expected exit-1 receipts stay semantic outcomes while real collection failures remain errors', () => {
  const receipt = { exit_code: 1, error: null, stdout: JSON.stringify({ status: 'error', code: 'invalid_config' }) };
  assert.equal(cliCollectionFailure(receipt, 'CLI create exited 1'), null);
  assert.ok(cliCollectionFailure({ ...receipt, error: 'deadline exceeded' }, 'deadline exceeded'));
  assert.ok(cliCollectionFailure({ ...receipt, exit_code: null, error: 'spawn ENOENT' }, 'spawn ENOENT'));
  assert.ok(cliCollectionFailure({ ...receipt, stdout: 'truncated output' }, 'CLI create exited 1'));
});

test('resume requires the genuinely different selected page to survive a rejected pending old-page write', () => {
  const fixture = () => [
    ...Object.entries({
      agent_resume: { status: 'ok' }, agent_resumed_state: { state: { owner: 'agent' } },
      script_control_boundary: { status: 'ok', result: { value: 'boundary-5' } }, agent_resumed_value: { result: 'boundary-5' },
      script_control_boundary_selected: { status: 'partial', error: { code: 'stale_reference' } },
      viewer_selection_resume: { status: 'ok' },
      viewer_selection_before_resume: { state: { page_id: 'different-page' } },
      viewer_selection_after_resume: { state: { page_id: 'different-page' } },
      viewer_selection_after_reclaim: { state: { page_id: 'different-page' } },
      viewer_selection_original_value: { result: 'old-target-marker' },
    }).map(([name, reply]) => ({ name, exit_code: name === 'script_control_boundary_selected' ? 1 : 0, stdout: JSON.stringify(reply), stderr: '', error: null, collection_failure: null })),
    { name: 'viewer_selection_expected', content: { original_page_id: 'original-page', selected_page_id: 'different-page' } },
  ];
  const evaluate = events => productObservations('G1', events, { run_id: 'marker' }, []).explicit_resume.status;
  assert.equal(evaluate(fixture()), 'pass');
  const switchedBack = fixture(); switchedBack.find(event => event.name === 'viewer_selection_after_resume').stdout = JSON.stringify({ state: { page_id: 'original-page' } });
  assert.equal(evaluate(switchedBack), 'fail');
  const acceptedOldWrite = fixture(); acceptedOldWrite.find(event => event.name === 'script_control_boundary_selected').stdout = JSON.stringify({ status: 'ok', result: {} });
  assert.equal(evaluate(acceptedOldWrite), 'fail');
});

test('process birthtime parsing uses the explicit UTC ps format rather than the host locale or timezone', () => {
  const rows = parseProcesses('40090 1 40090 S Wed Nov  4 16:54:11 2026 /owned/python -m anti_trace.engine --profile acceptA');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].born, 1793811251);
  assert.equal(rows[0].pid, 40090);
});

test('an actual active-export error receipt remains required consumable L2 evidence after scenario slicing', () => {
  const raw = coresMatrix(), record = productFixture(raw, 'L2');
  const event = { name: 'busy_export', source: 'process', sequence: 2, args: ['export', 'acceptA', 'owned-fixture.tar.gz', '--json'], exit_code: 1, stdout: JSON.stringify({ status: 'error', code: 'busy', message: 'busy: stop acceptA before export' }), stderr: '', started_at: raw.started_at, finished_at: raw.finished_at };
  raw.commands.push({ sequence: event.sequence, args: event.args, exit_code: 1, started_at: event.started_at, finished_at: event.finished_at, stdout_sha256: createHash('sha256').update(event.stdout).digest('hex'), stderr_sha256: createHash('sha256').update(event.stderr).digest('hex') });
  record.artifacts[0].content.events.push(event);
  record.artifacts[0].content.events = eventsForScenario('L2', record.artifacts[0].content.events);
  record.artifacts[0].sha256 = digest(record.artifacts[0].content);
  const result = evaluateAcceptance(raw, { productEvidence: [record] });
  assert.equal(check(result, 'product/L2').obligations.find(row => row.id === 'busy_export').status, 'pass');
  assert.equal(result.coverage.required, 459);
  assert.equal(result.overall, 'NOT_PASS');
});
