import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile, writeFile, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { resolve, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir, cpus, totalmem } from 'node:os';
import { createReadStream } from 'node:fs';
import { createHash } from 'node:crypto';
import { pngPixels } from '../scripts/png.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const args = process.argv.slice(2);
const option = (name, fallback) => { const index = args.indexOf(name); return index < 0 ? fallback : args[index + 1]; };
if (args.includes('--help')) {
  console.log('node browsers/engine-bench/acceptance/camoufox-performance.mjs --url URL [--output DIR] [--runs 10] [--warmups 2]');
  process.exit(0);
}
const url = new URL(option('--url', 'http://127.0.0.1:8785/')).href;
const output = resolve(option('--output', join(root, 'browsers/engine-bench/.local/performance/camoufox-' + Date.now())));
const runs = Number(option('--runs', '10')), warmups = Number(option('--warmups', '2'));
if (!Number.isInteger(runs) || runs < 1 || runs > 100 || !Number.isInteger(warmups) || warmups < 0 || warmups > 10) throw new Error('Invalid sample counts');
await mkdir(output, { recursive: true, mode: 0o700 });
const home = await mkdtemp(join(tmpdir(), 'at-perf-'));
const env = { ...process.env, ANTI_TRACE_HOME: home };
const cli = join(root, 'cli/bin/anti-trace');
const workload = JSON.parse(await readFile(join(root, 'browsers/engine-bench/scripts/common-workload.json'), 'utf8'));
const exec = promisify(execFile);
const samples = [], failures = [];
const stats = values => { const v = values.filter(Number.isFinite).sort((a, b) => a - b); return v.length ? { n: v.length, median: v.length % 2 ? v[Math.floor(v.length / 2)] : (v[v.length / 2 - 1] + v[v.length / 2]) / 2, p95: v[Math.ceil(v.length * .95) - 1] } : { n: 0, median: null, p95: null }; };
async function call(...values) {
  return await new Promise((resolveCall, reject) => {
    const child = spawn(cli, values, { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    const timer = setTimeout(() => { child.kill('SIGTERM'); reject(new Error('CLI deadline')); }, 120000);
    child.stdout.on('data', data => { stdout += data; }); child.stderr.on('data', data => { stderr += data; });
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('close', code => { clearTimeout(timer); if (code) reject(new Error(`CLI ${values[0]}: ${stderr.slice(0, 500)}`)); else { try { resolveCall({ value: JSON.parse(stdout), bytes: Buffer.byteLength(stdout) }); } catch (error) { reject(error); } } });
  });
}
function sampler(pid) {
  const samples = [], cpu = new Map(); let stopped = false, pending = Promise.resolve(), timer;
  const collect = async () => {
    try {
      const { stdout } = await exec('ps', ['-axo', 'pid=,ppid=,rss=,time='], { timeout: 3000, maxBuffer: 8 * 1024 * 1024 });
      const rows = stdout.trim().split('\n').map(line => { const [id, parent, rss, time] = line.trim().split(/\s+/); return { id: Number(id), parent: Number(parent), rss: Number(rss), cpu: time.split(':').reduce((n, part) => n * 60 + Number(part), 0) }; });
      const owned = new Set([pid]); let changed = true;
      while (changed) { changed = false; for (const row of rows) if (owned.has(row.parent) && !owned.has(row.id)) { owned.add(row.id); changed = true; } }
      const tree = rows.filter(row => owned.has(row.id));
      for (const row of tree) cpu.set(row.id, Math.max(cpu.get(row.id) || 0, row.cpu));
      samples.push({ at: performance.now(), rss_kib: tree.reduce((n, row) => n + row.rss, 0), pids: tree.map(row => row.id) });
    } catch (error) { samples.push({ error: error.message }); }
    if (!stopped) timer = setTimeout(() => { pending = collect(); }, 100);
  };
  pending = collect();
  return async () => { stopped = true; clearTimeout(timer); await pending; return { scope: 'managed Python/driver/browser process tree after readiness; includes startup CPU already accrued, excludes pre-readiness RSS peak', sample_interval_ms: 100, peak_tree_rss_kib: Math.max(0, ...samples.map(x => x.rss_kib || 0)), sampled_cpu_seconds: [...cpu.values()].reduce((a, b) => a + b, 0), samples }; };
}
const runtimeMetadata = (await call('doctor', '--json')).value;
const runtimePath = runtimeMetadata.checks?.find(row => row.check === 'browser' && row.result === 'pass')?.detail;
if (!runtimePath) { await rm(home, { recursive: true, force: true }); throw new Error('Existing runtime unavailable; benchmark does not download browsers'); }
const runtimeHash = createHash('sha256');
for await (const chunk of createReadStream(runtimePath)) runtimeHash.update(chunk);
runtimeMetadata.artifact_sha256 = runtimeHash.digest('hex');
try {
  for (let index = 1 - warmups; index <= runs; index++) {
    const name = 'perf' + (index + warmups), row = { index, warmup: index <= 0, status: 'error', stages: {}, output_bytes: 0, cli_round_trips: 0 };
    const invoke = async (...values) => { const result = await call(...values); row.output_bytes += result.bytes; row.cli_round_trips++; return result.value; };
    let stopSampling;
    try {
      await invoke('create', name, '--json');
      let started = performance.now();
      const ready = await invoke('start', name, '--headless', '--url', url, '--json'); row.stages.startup_ms = performance.now() - started;
      if (!Number.isInteger(ready.pid)) throw new Error('READY omitted owned process identity');
      stopSampling = sampler(ready.pid);
      started = performance.now();
      row.common_workload = (await invoke('exec', name, 'eval', workload.expression, '--json')).result;
      row.stages.common_roundtrip_ms = performance.now() - started;
      if (row.common_workload.checksum !== workload.expected_checksum || row.common_workload.count !== workload.dom_nodes || row.common_workload.last !== 'item-999') throw new Error('Common workload correctness failed');
      row.pixels = [];
      for (const [i, color] of ['rgb(240,20,30)', 'rgb(10,40,230)'].entries()) {
        await invoke('exec', name, 'eval', `(() => { let el=document.getElementById('comparison-color'); if(!el){el=document.createElement('div');el.id='comparison-color';document.body.appendChild(el)}el.style.cssText='position:fixed;left:0;top:0;width:200px;height:200px;z-index:2147483647;background:${color}';return true; })()`, '--json');
        const path = join(output, `${name}-${i}.png`), begin = performance.now();
        await invoke('exec', name, 'screenshot', path, '--json');
        const bytes = await readFile(path); row.pixels.push({ ...pngPixels(bytes), screenshot_roundtrip_ms: performance.now() - begin, png_bytes: bytes.length, path });
      }
      const expected = [[240, 20, 30], [10, 40, 230]];
      row.visual_status = row.pixels.every((p, i) => p.rgb_at_20_20.every((n, j) => Math.abs(n - expected[i][j]) <= 10)) ? 'pass' : 'fail';
      row.status = row.visual_status === 'pass' ? 'completed' : 'visual_failed';
    } catch (error) { row.error = error.message; failures.push({ index, error: error.message }); }
    finally {
      if (stopSampling) row.resources = await stopSampling();
      try { await invoke('stop', name, '--json'); } catch (error) { row.cleanup_error = error.message; }
      samples.push(row);
      await writeFile(join(output, `run-${index}.json`), JSON.stringify(row, null, 2));
    }
  }
} finally {
  if (!samples.some(row => row.cleanup_error)) await rm(home, { recursive: true, force: true });
  else failures.push({ cleanup: 'Profile retained for owned-process recovery', private_home: home });
}
const measured = samples.filter(row => !row.warmup), done = measured.filter(row => row.status === 'completed');
const cpu = cpus();
const report = { schema: 1, runtime: 'Camoufox managed CLI reference', observed_at: new Date().toISOString(), url, workload: { ...workload, sha256: createHash('sha256').update(workload.expression).digest('hex') },
  runtime_metadata: runtimeMetadata,
  host: { platform: process.platform, arch: process.arch, cpu: cpu[0]?.model, cores: cpu.length, memory_bytes: totalmem() },
  method: 'Fresh synthetic profile/process per run; two discarded warmups and ten measured runs by default. Internal page DOM/JS workload matches native benchmark. CLI/driver and viewport costs are reported separately, not normalized away.',
  limitations: ['Managed tree contains Python/Playwright/Firefox; native benchmark excludes its Node driver.', 'RSS begins after readiness; startup RSS maximum is not sampled.', 'Viewport/DPR differs from CDP native controls; visual timing is separate and image dimensions retained.', 'This reference does not establish privacy or challenge clearance.'],
  summary: { attempted: measured.length, completed: done.length, startup_ms: stats(done.map(x => x.stages.startup_ms)), internal_common_ms: stats(done.map(x => x.common_workload.total_ms)), common_cli_roundtrip_ms: stats(done.map(x => x.stages.common_roundtrip_ms)), sampled_tree_rss_kib: stats(done.map(x => x.resources?.peak_tree_rss_kib)), sampled_cpu_seconds: stats(done.map(x => x.resources?.sampled_cpu_seconds)) }, samples, failures };
await writeFile(join(output, 'report.json'), JSON.stringify(report, null, 2));
console.log(JSON.stringify({ output, summary: report.summary, failures }));
if (done.length !== runs || failures.length) process.exitCode = 1;
