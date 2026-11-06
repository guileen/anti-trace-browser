import { readFile, writeFile, mkdir, rm } from 'node:fs/promises';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import os from 'node:os';
import { createAuditServer } from '../../../services/audit/src/server.mjs';
import { harness, save, summary, digest, sha256, sampleTree } from './runtime-harness.mjs';
import { pngPixels } from '../scripts/png.mjs';
import { COLLECTOR_IDENTITY } from '../../../services/audit/src/manifest.mjs';
const root = resolve(fileURLToPath(new URL('../../..', import.meta.url))), args = process.argv.slice(2);
const option = (key, fallback) => { const i = args.indexOf(key); if (i < 0) return fallback; if (!args[i + 1] || args[i + 1].startsWith('--')) throw new Error(`${key} requires a value`); return args[i + 1]; };
if (args.includes('--help')) { console.log('node browsers/engine-bench/acceptance/task-performance.mjs --runtime lightpanda|obscura|camoufox [--output NEW-DIR]\nTwo discarded warmups + ten measured runs. Same real CLI/Python script, fixed viewport/DPR/core declaration, DOM/JS and visual costs separate. No privacy or challenge claim.'); process.exit(0); }
const runtime = option('--runtime', 'lightpanda');
if (!['lightpanda', 'obscura', 'camoufox'].includes(runtime)) throw new Error('Unknown runtime');
const output = resolve(option('--output', join(root, 'browsers/engine-bench/.local/performance', `${runtime}-authentic-${Date.now()}`)));
await mkdir(dirname(output), { recursive: true, mode: 0o700 });
await mkdir(output, { recursive: false, mode: 0o700 });
const kit = await harness(root, output), workload = JSON.parse(await readFile(join(root, 'browsers/engine-bench/scripts/common-workload.json'), 'utf8'));
const script = join(root, 'browsers/engine-bench/acceptance/performance-flow.py');
const report = { schema: 1, runtime, run_id: randomUUID(), started_at: new Date().toISOString(), samples: [], errors: [], profile_home: kit.home, workload: { ...workload, sha256: digest(workload), script_sha256: sha256(await readFile(script)), viewport: [1280, 800], dpr: 1, cores: 8, warmups: 2, measured: 10 }, host: { platform: os.platform(), release: os.release(), arch: os.arch(), cpu: os.cpus()[0]?.model, cores: os.cpus().length }, budgets: { task_seconds: 60, post_ready_native_tree_rss_mib: 1024 }, method: 'Sequential same-host measurements. One new profile/process per iteration, restart same profile for warm-start timing. Two discarded warmups and ten measured tasks; first startup is process/profile-cold, OS caches are retained. Complete task uses one authenticated Python script connection. Task CPU/process-tree RSS sampled after READY; raw observations retain coarse timer and sampling limits. Startup CPU/RSS peak excluded.' };
if (!COLLECTOR_IDENTITY.available) throw new Error(COLLECTOR_IDENTITY.error);
report.sources = [];
for (const path of [...new Set(['browsers/engine-bench/acceptance/task-performance.mjs', 'browsers/engine-bench/acceptance/performance-flow.py', 'browsers/engine-bench/acceptance/runtime-harness.mjs', 'browsers/engine-bench/scripts/common-workload.json', 'browsers/engine-bench/scripts/png.mjs', 'services/audit/src/server.mjs', ...COLLECTOR_IDENTITY.sources.map(source => source.path)])].sort()) {
  const bytes = await readFile(join(root, path)), snapshot = join('sources', path);
  await mkdir(dirname(join(output, snapshot)), { recursive: true, mode: 0o700 });
  await writeFile(join(output, snapshot), bytes, { flag: 'wx', mode: 0o600 });
  report.sources.push({ path, snapshot, sha256: sha256(bytes) });
}
const requests = [], server = createAuditServer({ dataDir: join(output, 'server') });
server.prependListener('request', (req, res) => {
  const row = { url: req.url, started_at: new Date().toISOString(), bytes: 0 }; requests.push(row);
  for (const method of ['write', 'end']) {
    const original = res[method];
    res[method] = function (chunk, encoding, callback) {
      if (typeof chunk === 'string') row.bytes += Buffer.byteLength(chunk, typeof encoding === 'string' ? encoding : undefined);
      else if (ArrayBuffer.isView(chunk)) row.bytes += chunk.byteLength;
      return original.apply(this, arguments);
    };
  }
  res.once('finish', () => Object.assign(row, { status: res.statusCode, finished_at: new Date().toISOString() }));
});
try {
  server.listen(0, '127.0.0.1'); await once(server, 'listening'); const port = server.address().port;
  for (let index = 0; index < 12; index++) {
    const name = `perf${index}`, row = { index, warmup: index < 2, status: 'error' }, sequence = kit.commands.length;
    let stopSampling, created = false;
    try {
      // Preserve equal real content dimensions: Camoufox reserves its window
      // padding; Obscura uses configured avail_height (screen minus 24px).
      const overrides = { screen_width: runtime === 'camoufox' ? 1392 : 1280, screen_height: runtime === 'camoufox' ? 922 : runtime === 'obscura' ? 824 : 800, device_scale_factor: 1, timezone: 'UTC', locale: 'en-US', languages: ['en-US', 'en'] };
      if (runtime === 'camoufox') overrides.default_sans = 'Arial';
      await kit.call('create', name, '--runtime', runtime, '--seed', digest('authentic-performance-fixed-profile'), '--cores', '8', '--fonts', 'subset:24', '--allow-private-network', '--overrides', JSON.stringify(overrides), '--json');
      created = true;
      const configuration = await kit.config(name); report.configuration ||= configuration;
      const binary = configuration.runtime.binary || configuration.runtime.executable;
      report.runtime_identity ||= { ...configuration.runtime, executable: binary, artifact_sha256: sha256(await readFile(binary)), assets: configuration.assets };
      let begin = performance.now(); await kit.call('start', name, '--headless', '--url', 'about:blank', '--json'); row.cold_startup_ms = performance.now() - begin;
      await kit.call('stop', name, '--json');
      begin = performance.now(); const ready = await kit.call('start', name, '--headless', '--url', 'about:blank', '--json'); row.warm_startup_ms = performance.now() - begin;
      if (!Number.isInteger(ready.pid)) throw new Error('READY omitted manager PID');
      stopSampling = sampleTree(ready.pid);
      const offset = requests.length, sample = 'sample-' + index;
      begin = performance.now();
      const task = await kit.call('run', name, script, '--args', JSON.stringify({ url: `http://127.0.0.1:${port}/acceptance-product.html?context=navigation&run_id=${sample}`, expression: workload.expression, output, sample }), '--timeout', '60', '--max-output-bytes', '1048576', '--json');
      row.task_wall_ms = performance.now() - begin; row.result = task.result;
      if (task.status !== 'ok' || !row.result) throw new Error('Python task did not return a completed result');
      row.action_ipc_round_trips = Array.isArray(task.completed) ? task.completed.length : null;
      row.action_trace = task.completed?.map(operation => ({ sequence: operation.sequence, operation: operation.operation }));
      row.resources = await stopSampling(); stopSampling = null;
      row.requests = requests.slice(offset); row.resource_requests = row.requests.length; row.resource_bytes = row.requests.reduce((sum, request) => sum + (request.bytes || 0), 0);
      const common = row.result.common;
      if (common?.checksum !== workload.expected_checksum || common?.count !== workload.dom_nodes || common?.last !== 'item-999') throw new Error('Common DOM/JS correctness failed');
      row.images = [];
      for (const image of row.result.images ?? []) row.images.push({ path: image.path, png_bytes: image.bytes, ...pngPixels(await readFile(image.path)) });
      const expected = [[240, 20, 30], [10, 40, 230]];
      const visualOK = row.images.length === 2 && row.images.every((image, i) => image.width === 1280 && image.height === 800 && image.rgb_at_20_20.every((n, j) => Math.abs(n - expected[i][j]) <= 2));
      if (!visualOK || JSON.stringify(row.result.visual?.viewport) !== '[1280,800]' || row.result.visual?.dpr !== 1 || !row.result.visual?.canvas_pixel?.slice(0, 3).every((n, i) => Math.abs(n - [20, 98, 189][i]) <= 2)) throw new Error('Real visual output or viewport/DPR differs from fixed workload');
      row.budget_pass = row.task_wall_ms <= 60000 && row.resources.valid_samples >= 2 && row.resources.observation_errors === 0 && Number.isFinite(row.resources.peak_tree_rss_kib) && row.resources.peak_tree_rss_kib > 0 && row.resources.peak_tree_rss_kib <= report.budgets.post_ready_native_tree_rss_mib * 1024;
      row.status = row.budget_pass ? 'completed' : 'budget_exceeded';
    } catch (error) { row.error = error.message; report.errors.push({ index, error: error.message }); }
    finally {
      if (stopSampling) row.resources = await stopSampling();
      if (created) try { await kit.call('stop', name, '--json'); } catch (error) { row.cleanup_error = error.message; report.errors.push({ index, cleanup_error: error.message }); }
      row.cli_round_trips = kit.commands.length - sequence;
      row.output_bytes = kit.commands.slice(sequence).reduce((sum, cmd) => sum + (cmd.stdout_bytes || 0), 0);
      row.script_ipc = 'one authenticated connection; operation trace in command receipt';
      report.samples.push(row); await save(join(output, `sample-${index}.json`), row);
      // A completed sample keeps evidence but releases the synthetic profile before the next run.
      if (created && !row.cleanup_error) try { await kit.call('rm', name, '--json'); } catch (error) { row.cleanup_error = error.message; report.errors.push({ index, cleanup_error: error.message }); }
    }
  }
} catch (error) { report.errors.push({ error: error.message }); }
finally {
  server.closeAllConnections(); if (server.listening) await new Promise(resolve => server.close(resolve));
  for (const source of report.sources) if (sha256(await readFile(join(root, source.path))) !== source.sha256) report.errors.push({ source: source.path, error: 'Source changed during measurement' });
  if (!report.errors.length) { await rm(kit.home, { recursive: true }); report.profile_cleanup = 'removed owned synthetic profile home after all stop/rm commands'; }
  report.finished_at = new Date().toISOString(); report.commands = kit.commands;
  const measured = report.samples.filter(row => !row.warmup), completed = measured.filter(row => ['completed', 'budget_exceeded'].includes(row.status));
  report.summary = { attempted: measured.length, completed: completed.length, within_budget: completed.filter(row => row.budget_pass).length, cold_startup_ms: summary(completed.map(row => row.cold_startup_ms)), warm_startup_ms: summary(completed.map(row => row.warm_startup_ms)), task_wall_ms: summary(completed.map(row => row.task_wall_ms)), internal_dom_js_ms: summary(completed.map(row => row.result.common.total_ms)), visual_roundtrip_ms: summary(completed.map(row => row.result.stages.visual_roundtrip_ms)), tree_rss_kib: summary(completed.map(row => row.resources.peak_tree_rss_kib)), task_cpu_seconds: summary(completed.map(row => row.resources.cpu_seconds_delta)), resource_requests: summary(completed.map(row => row.resource_requests)), resource_bytes: summary(completed.map(row => row.resource_bytes)), output_bytes: summary(completed.map(row => row.output_bytes)), cli_round_trips: summary(completed.map(row => row.cli_round_trips)), action_ipc_round_trips: summary(completed.map(row => row.action_ipc_round_trips)) };
  report.overall = completed.length === 10 && completed.every(row => row.budget_pass) && report.errors.length === 0 ? 'PASS' : 'NOT_PASS';
  await save(join(output, 'report.json'), report);
  console.log(JSON.stringify({ output, runtime, overall: report.overall, summary: report.summary, errors: report.errors }));
  process.exitCode = report.overall === 'PASS' ? 0 : 1;
}
