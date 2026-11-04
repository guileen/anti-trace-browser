import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:net';
import { inflateSync } from 'node:zlib';
import { randomUUID } from 'node:crypto';
import { releases, runtimeRoot, sha256 } from './setup-runtimes.mjs';
import { runtimeFacts } from './runtime-facts.mjs';

const exec = promisify(execFile);
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const options = { url: 'http://127.0.0.1:8765', runs: 3, output: '.local/reports/benchmarks/comparison.json', engines: ['lightpanda', 'obscura'], interval: 200, engine_args: {} };
for (let i = 2; i < process.argv.length; i++) {
  const flag = process.argv[i];
  if (flag === '--help') { console.log('node scripts/compare.mjs [--url URL] [--runs 3] [--output .local/reports/benchmarks/comparison.json] [--engines lightpanda,obscura] [--sample-interval 200] [--engine-args JSON-object-of-engine-to-extra-argument-array]\\nArchived comparators: moli, moli-installed. Request them explicitly to reproduce the initial selection.'); process.exit(0); }
  const value = process.argv[++i];
  if (!value) throw new Error(`Missing value: ${flag}`);
  if (flag === '--url') options.url = new URL(value).href;
  else if (flag === '--runs') options.runs = Number(value);
  else if (flag === '--output') options.output = value;
  else if (flag === '--engines') options.engines = value.split(',');
  else if (flag === '--sample-interval') options.interval = Number(value);
  else if (flag === '--engine-args') options.engine_args = JSON.parse(value);
  else throw new Error(`Unknown option ${flag}`);
}
if (!Number.isInteger(options.runs) || options.runs < 1 || options.runs > 100) throw new Error('--runs must be 1..100');
if (!Number.isFinite(options.interval) || options.interval < 100) throw new Error('--sample-interval must be >=100ms');
const allowed = ['lightpanda', 'obscura', 'moli-installed', 'moli'];
if (options.engines.some(e => !allowed.includes(e))) throw new Error(`--engines must be from ${allowed}`);
if (!options.engine_args || typeof options.engine_args !== 'object' || Array.isArray(options.engine_args) || Object.entries(options.engine_args).some(([engine, args]) => !allowed.includes(engine) || !Array.isArray(args) || args.some(a => typeof a !== 'string'))) throw new Error('--engine-args must map supported engine IDs to string arrays');
const outputPath = resolve(root, options.output);
const artifactRoot = join(dirname(outputPath), `comparison-${new Date().toISOString().replaceAll(':', '-')}-${randomUUID().slice(0, 8)}`);
const artifactId = artifactRoot.split('/').at(-1);
const screenshotRoot = join(root, '.local', 'screenshots', artifactId);
const logRoot = join(root, '.local', 'logs', artifactId);
await mkdir(artifactRoot, { recursive: true });
const delay = ms => new Promise(r => setTimeout(r, ms));
const errorText = error => error?.stack || String(error);
const now = () => performance.now();
async function save(path, value) { await writeFile(path, JSON.stringify(value, null, 2)); }
async function freePort() {
  const server = createServer();
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}

// Native WebSocket + finite per-command deadlines: no Puppeteer initialization
// commands can hang a partial CDP implementation before its useful methods run.
class CDP {
  constructor(socket, records) {
    this.socket = socket; this.records = records; this.nextId = 1; this.pending = new Map(); this.events = [];
    socket.addEventListener('message', event => {
      let message;
      try { message = JSON.parse(String(event.data)); } catch { return; }
      if (!message.id) { if (this.events.length < 1000) this.events.push(message); return; }
      const entry = this.pending.get(message.id);
      if (!entry) return;
      this.pending.delete(message.id); clearTimeout(entry.timer);
      entry.record.duration_ms = now() - entry.started;
      entry.record.response = message;
      entry.record.status = message.error ? 'error' : 'pass';
      if (message.error) entry.reject(new Error(`${entry.record.method}: ${JSON.stringify(message.error)}`));
      else entry.resolve(message.result || {});
    });
    socket.addEventListener('close', () => this.rejectPending('WebSocket closed'));
    socket.addEventListener('error', () => this.rejectPending('WebSocket error'));
  }
  rejectPending(reason) {
    for (const entry of this.pending.values()) { clearTimeout(entry.timer); entry.record.status = 'error'; entry.record.error = reason; entry.record.duration_ms = now() - entry.started; entry.reject(new Error(reason)); }
    this.pending.clear();
  }
  static async open(url, records, timeout = 1500) {
    const socket = new WebSocket(url);
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => { socket.close(); reject(new Error(`CDP connect timeout: ${url}`)); }, timeout);
      socket.addEventListener('open', () => { clearTimeout(timer); resolve(); }, { once: true });
      socket.addEventListener('error', () => { clearTimeout(timer); reject(new Error(`CDP connect error: ${url}`)); }, { once: true });
    });
    return new CDP(socket, records);
  }
  send(method, params = {}, sessionId, timeout = 10_000) {
    const id = this.nextId++;
    const record = { id, method, params, sessionId, status: 'pending' };
    this.records.push(record);
    return new Promise((resolve, reject) => {
      const started = now();
      const timer = setTimeout(() => { this.pending.delete(id); record.status = 'timeout'; record.duration_ms = now() - started; reject(new Error(`${method} timed out after ${timeout}ms`)); }, timeout);
      this.pending.set(id, { resolve, reject, timer, record, started });
      try { this.socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) })); }
      catch (error) { clearTimeout(timer); this.pending.delete(id); record.status = 'error'; record.error = errorText(error); reject(error); }
    });
  }
  close() { this.rejectPending('Runner disconnected'); this.socket.close(); }
}

function cpuSeconds(text) {
  const parts = text.split(':').map(Number);
  return parts.reduce((value, part) => value * 60 + part, 0);
}
function sampler(pid, started, phase, mode) {
  const samples = []; const cpuMax = new Map(); const errors = []; let stopped = false; let timer; let inFlight;
  const sample = async () => {
    try {
      const { stdout } = await exec('ps', ['-axo', 'pid=,ppid=,rss=,%cpu=,time='], { timeout: 2500, maxBuffer: 8 * 1024 * 1024 });
      const rows = stdout.trim().split('\n').map(line => {
        const [id, ppid, rss, cpu, time] = line.trim().split(/\s+/);
        return { pid: Number(id), ppid: Number(ppid), rss_kib: Number(rss), cpu_percent: Number(cpu), cpu_seconds: cpuSeconds(time) };
      });
      const owned = new Set([pid]);
      let changed = true;
      while (changed) { changed = false; for (const row of rows) if (owned.has(row.ppid) && !owned.has(row.pid)) { owned.add(row.pid); changed = true; } }
      const processes = rows.filter(row => owned.has(row.pid));
      for (const row of processes) cpuMax.set(row.pid, Math.max(cpuMax.get(row.pid) || 0, row.cpu_seconds));
      samples.push({ elapsed_ms: now() - started, phase: phase(), mode, scope: 'engine process and all sampled descendants; Node CDP driver and ps helper excluded', rss_kib: processes.reduce((s, r) => s + r.rss_kib, 0), cpu_percent: processes.reduce((s, r) => s + r.cpu_percent, 0), processes });
    } catch (error) { errors.push(errorText(error)); }
  };
  const tick = async () => { await sample(); if (!stopped) timer = setTimeout(() => { inFlight = tick(); }, options.interval); };
  inFlight = tick();
  return { async stop() { stopped = true; clearTimeout(timer); await inFlight; await sample(); return { method: 'ps recursive PPID descendant closure; RSS is sum, not unique/PSS; CPU is ps lifetime percent and sampled cumulative CPU, not per-interval utilization', requested_interval_ms: options.interval, peak_tree_rss_kib: samples.length ? Math.max(...samples.map(s => s.rss_kib)) : null, peak_tree_cpu_percent: samples.length ? Math.max(...samples.map(s => s.cpu_percent)) : null, sampled_cpu_seconds: [...cpuMax.values()].reduce((a, b) => a + b, 0), samples, errors, limitation: 'Sampling can miss short-lived children and sub-interval peaks; cumulative CPU is a lower bound when a child exits between samples. ps/runner overhead excluded.' }; } };
}
async function terminate(child) {
  if (!child?.pid) return { status: 'not_started' };
  const signal = name => { try { process.kill(-child.pid, name); return true; } catch (error) { if (error.code === 'ESRCH') return false; throw error; } };
  signal('SIGTERM');
  const deadline = now() + 2000;
  while (now() < deadline) { try { process.kill(-child.pid, 0); } catch (error) { if (error.code === 'ESRCH') return { status: 'terminated', exit_code: child.exitCode, signal: child.signalCode }; } await delay(50); }
  signal('SIGKILL');
  return { status: 'kill_sent', exit_code: child.exitCode, signal: child.signalCode };
}
const activeChildren = new Set();
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, async () => { await Promise.all([...activeChildren].map(terminate)); process.exit(signal === 'SIGINT' ? 130 : 143); });

async function engineConfig(id, session, port) {
  let metadata;
  if (id === 'moli-installed') {
    const executable = process.env.MOLI_INSTALLED_PATH || '/Users/gl/.local/bin/moli';
    const version = await exec(executable, ['--version'], { timeout: 10_000 });
    metadata = { executable, installed_executable: executable, executable_sha256: sha256(await readFile(executable)), version_probe: { stdout: version.stdout, stderr: version.stderr }, source: 'Existing local binary; never modified; version and SHA256 observed' };
  } else {
    const release = releases.find(r => r.id === id);
    const directory = join(runtimeRoot, `${id}-${release.version}`);
    metadata = JSON.parse(await readFile(join(directory, 'provenance.json'), 'utf8'));
    const relativeExecutable = metadata.relative_executable || metadata.executable.split(`${id}-${release.version}/`)[1];
    if (!relativeExecutable || relativeExecutable.split('/').includes('..')) throw new Error('Invalid runtime relative executable path');
    metadata = { ...metadata, release_version: release.version, installed_executable: join(directory, relativeExecutable), version_probe: metadata.version_probe || metadata.version };
    const actual = sha256(await readFile(metadata.installed_executable));
    if (actual !== metadata.executable_sha256) throw new Error(`Runtime executable changed: ${id}; rerun setup-runtimes.mjs`);
  }
  let args;
  if (id === 'lightpanda') args = ['serve', '--host', '127.0.0.1', '--port', String(port), '--load-resources', 'iframe', '--load-resources', 'worker', '--load-resources', 'stylesheet', '--load-resources', 'image', '--cookie-jar', join(session, 'cookies.json')];
  else if (id === 'obscura') args = ['serve', '--host', '127.0.0.1', '--port', String(port), '--stealth', '--allow-private-network', '--storage-dir', join(session, 'profile')];
  else args = ['serve', '--host', '127.0.0.1', '--port', String(port), '--layout', '--resource', '--profile-dir', join(session, 'profile')];
  args.push(...(options.engine_args[id] || []));
  return { id, metadata, args, rendering: id === 'lightpanda' ? 'No real CSS layout/paint; text-only raster output is not a webpage screenshot' : 'Real renderer enabled; measured screenshot pixels separately from API availability', executable: metadata.installed_executable };
}

function deterministicWorkload() {
  const started = performance.now(); let checksum = 2166136261;
  for (let i = 0; i < 200_000; i++) checksum = Math.imul(checksum ^ i, 16777619) >>> 0;
  const cpu_ms = performance.now() - started;
  const domStart = performance.now(); const box = document.createElement('div'); box.id = 'comparison-workload';
  document.body.appendChild(box);
  for (let i = 0; i < 1000; i++) { const item = document.createElement('span'); item.setAttribute('data-item', String(i)); item.textContent = `item-${i}`; box.appendChild(item); }
  const count = box.querySelectorAll('span').length;
  const last = box.lastChild.textContent;
  box.remove();
  return { checksum, count, last, cpu_ms, dom_ms: performance.now() - domStart, total_ms: performance.now() - started };
}
let expectedChecksum = 2166136261;
for (let i = 0; i < 200_000; i++) expectedChecksum = Math.imul(expectedChecksum ^ i, 16777619) >>> 0;

// Decode non-interlaced 8-bit PNGs to inspect actual samples (not IHDR or bytes).
function pngPixels(buffer) {
  if (buffer.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a') throw new Error('Not a PNG');
  let width, height, color, channels; const chunks = [];
  for (let offset = 8; offset + 12 <= buffer.length;) {
    const length = buffer.readUInt32BE(offset); const kind = buffer.toString('ascii', offset + 4, offset + 8); const data = buffer.subarray(offset + 8, offset + 8 + length);
    if (kind === 'IHDR') { width = data.readUInt32BE(0); height = data.readUInt32BE(4); color = data[9]; channels = ({ 0: 1, 2: 3, 4: 2, 6: 4 })[color]; if (data[8] !== 8 || data[12] !== 0 || !channels) throw new Error('Unsupported PNG encoding for pixel comparison'); }
    if (kind === 'IDAT') chunks.push(data);
    offset += length + 12;
  }
  if (!width || !height || width * height > 16_000_000) throw new Error('PNG dimensions out of bound');
  const raw = inflateSync(Buffer.concat(chunks), { maxOutputLength: (width * channels + 1) * height }); const stride = width * channels; const pixels = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    for (let x = 0; x < stride; x++) {
      const a = x >= channels ? pixels[y * stride + x - channels] : 0; const b = y ? pixels[(y - 1) * stride + x] : 0; const c = y && x >= channels ? pixels[(y - 1) * stride + x - channels] : 0;
      let predictor = 0;
      if (filter === 1) predictor = a;
      else if (filter === 2) predictor = b;
      else if (filter === 3) predictor = Math.floor((a + b) / 2);
      else if (filter === 4) { const p = a + b - c; const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c); predictor = pa <= pb && pa <= pc ? a : pb <= pc ? b : c; }
      else if (filter !== 0) throw new Error(`Invalid PNG filter ${filter}`);
      pixels[y * stride + x] = (raw[y * (stride + 1) + 1 + x] + predictor) & 255;
    }
  }
  const x = Math.min(20, width - 1), y = Math.min(20, height - 1); const index = (y * width + x) * channels;
  const rgb = color === 0 || color === 4 ? [pixels[index], pixels[index], pixels[index]] : [...pixels.subarray(index, index + 3)];
  return { width, height, color_type: color, rgb_at_20_20: rgb, decoded_pixels_sha256: sha256(pixels) };
}

async function runEngine(id, index) {
  const runDir = join(artifactRoot, `${id}-${index}`); await mkdir(runDir, { recursive: true });
  const session = join(root, '.local', 'profiles', `comparison-${id}-${randomUUID()}`); await mkdir(session, { recursive: true });
  const screenshotDir = join(screenshotRoot, `${id}-${index}`); await mkdir(screenshotDir, { recursive: true });
  const logDir = join(logRoot, `${id}-${index}`); await mkdir(logDir, { recursive: true });
  const home = join(session, 'home'); await mkdir(home, { recursive: true });
  const result = { engine: id, run: index, started_at: new Date().toISOString(), session_dir: session, artifact_directory: runDir, status: 'error', stages: {}, errors: [], cdp: [] };
  let child, sampling, cdp; let stdout = '', stderr = ''; const started = now();
  let activePhase = 'configuration';
  async function stage(name, task) {
    const begin = now(); activePhase = name;
    try { const value = await task(); result.stages[name] = { status: 'pass', duration_ms: now() - begin, value }; return value; }
    catch (error) { result.stages[name] = { status: 'error', duration_ms: now() - begin, error: errorText(error) }; throw error; }
    finally { activePhase = 'between_phases'; }
  }
  try {
    const port = await freePort(); const config = await engineConfig(id, session, port);
    result.runtime = config; result.command = [config.executable, ...config.args]; result.port = port;
    result.environment_overrides = { HOME: home, XDG_CACHE_HOME: join(home, 'cache'), XDG_CONFIG_HOME: join(home, 'config'), XDG_DATA_HOME: join(home, 'data'), LIGHTPANDA_DISABLE_TELEMETRY: 'true', LIGHTPANDA_DISABLE_CORE_DUMP: '1', OBSCURA_ALLOW_PRIVATE_NETWORK: '1' };
    const launchStart = now();
    child = spawn(config.executable, config.args, { cwd: session, detached: true, env: { ...process.env, ...result.environment_overrides }, stdio: ['ignore', 'pipe', 'pipe'] });
    activeChildren.add(child); result.pid = child.pid;
    let launchError; child.once('error', error => { launchError = error; });
    child.stdout.on('data', data => { stdout += data; }); child.stderr.on('data', data => { stderr += data; });
    sampling = sampler(child.pid, started, () => activePhase, { engine: id, arguments: config.args, rendering: config.rendering });
    await stage('startup', async () => {
      const deadline = now() + 20_000; let lastError;
      while (now() < deadline) {
        if (launchError) throw launchError;
        if (child.exitCode !== null || child.signalCode) throw new Error(`Engine exited: ${child.exitCode}/${child.signalCode}; ${stderr}`);
        try {
          const response = await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(750) });
          if (response.ok) { const metadata = await response.json(); result.discovery = metadata; result.ws_endpoint = metadata.webSocketDebuggerUrl || `ws://127.0.0.1:${port}`; return { ready_method: 'GET /json/version', launch_to_ready_ms: now() - launchStart }; }
        } catch (error) { lastError = error; }
        // Some engines expose a CDP websocket but not HTTP discovery.
        try { cdp = await CDP.open(`ws://127.0.0.1:${port}`, result.cdp, 500); result.ws_endpoint = `ws://127.0.0.1:${port}`; return { ready_method: 'WebSocket open', launch_to_ready_ms: now() - launchStart }; }
        catch (error) { lastError = error; }
        await delay(100);
      }
      throw lastError || new Error('Startup timeout');
    });
    await stage('connect', async () => { if (!cdp) cdp = await CDP.open(result.ws_endpoint, result.cdp, 5000); return { transport: 'Node native WebSocket, flattened CDP session' }; });
    try { result.browser_version = await cdp.send('Browser.getVersion'); } catch (error) { result.errors.push(errorText(error)); }
    const target = await stage('create_target', () => cdp.send('Target.createTarget', { url: 'about:blank' }));
    const attached = await stage('attach', () => cdp.send('Target.attachToTarget', { targetId: target.targetId, flatten: true }));
    const sessionId = attached.sessionId;
    const evaluate = async (expression, timeout = 15_000) => {
      const response = await cdp.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, sessionId, timeout);
      if (response.exceptionDetails) throw new Error(JSON.stringify(response.exceptionDetails));
      const value = response.result?.value;
      if (typeof value === 'undefined') throw new Error(`Runtime.evaluate returned no by-value result: ${JSON.stringify(response)}`);
      return value;
    };
    for (const method of ['Page.enable', 'Runtime.enable']) { try { await cdp.send(method, {}, sessionId, 5000); } catch (error) { result.errors.push(errorText(error)); } }
    try { await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false }, sessionId, 5000); }
    catch (error) { result.errors.push(errorText(error)); }
    try {
      await stage('navigation', async () => {
        const navigation = await cdp.send('Page.navigate', { url: options.url }, sessionId, 20_000);
        if (navigation.errorText) throw new Error(navigation.errorText);
        const deadline = now() + 20_000;
        while (now() < deadline) {
          const state = await evaluate('JSON.stringify({url:location.href,ready:document.readyState,body:!!document.body,audit:typeof window.runAudit})', 3000);
          const parsed = JSON.parse(state);
          if (parsed.body && new URL(parsed.url).origin === new URL(options.url).origin && ['interactive', 'complete'].includes(parsed.ready)) return parsed;
          await delay(100);
        }
        throw new Error('Navigation readiness timed out waiting for document.body and interactive/complete state');
      });
    } catch (error) { result.errors.push(errorText(error)); }
    try {
      await stage('common_workload', async () => {
        // Kept independent of audit availability and errors; never substitute a
        // partial site's execution time for successful suite execution.
        const value = JSON.parse(await evaluate(`JSON.stringify((${deterministicWorkload.toString()})())`));
        result.common_workload = value;
        if (value.checksum !== expectedChecksum || value.count !== 1000 || value.last !== 'item-999') throw new Error(`Incorrect deterministic workload: ${JSON.stringify(value)}`);
        return value;
      });
    } catch (error) { result.errors.push(errorText(error)); }
    try {
      await stage('audit_ready', async () => {
        const deadline = now() + 15_000;
        while (now() < deadline) { if (await evaluate('typeof window.runAudit === "function"', 3000)) return true; await delay(100); }
        throw new Error('window.runAudit unavailable after 15000ms');
      });
      const report = await stage('collection', async () => {
        const value = JSON.parse(await evaluate('(async()=>JSON.stringify(await window.runAudit()))()', 120_000));
        if (!value?.id || !value.scores || !value.coverage || !Array.isArray(value.observations)) throw new Error('runAudit returned invalid server report shape');
        // Read back authority independently; the runner does not compute scores.
        const response = await fetch(new URL(`/api/reports/${encodeURIComponent(value.id)}`, options.url), { signal: AbortSignal.timeout(5000) });
        if (!response.ok) throw new Error(`Report readback failed: ${response.status}`);
        const stored = await response.json();
        if (JSON.stringify(stored.scores) !== JSON.stringify(value.scores)) throw new Error('Returned and server-stored scores differ');
        await save(join(runDir, 'server-report.json'), stored); return stored;
      });
      result.report = report;
      result.audit_path_ms = now() - launchStart;
    } catch (error) { result.errors.push(errorText(error)); }
    try {
      await stage('screenshot', async () => {
        const capture = await cdp.send('Page.captureScreenshot', { format: 'png' }, sessionId, 15_000);
        const png = Buffer.from(capture.data || '', 'base64');
        await writeFile(join(screenshotDir, 'audit.png'), png);
        const decoded = pngPixels(png);
        result.screenshot = { status: 'captured', path: join(screenshotDir, 'audit.png'), bytes: png.length, sha256: sha256(png), ...decoded, real_css_renderer: id !== 'lightpanda', interpretation: config.rendering };
        return result.screenshot;
      });
    } catch (error) { result.screenshot = { status: id === 'lightpanda' ? 'unsupported' : 'error', real_css_renderer: id !== 'lightpanda', error: errorText(error) }; }
    if (id !== 'lightpanda') {
      try {
        await stage('pixel_rendering', async () => {
          const frames = [];
          for (const color of ['rgb(240, 20, 30)', 'rgb(10, 40, 230)']) {
            await evaluate(`(()=>{let n=document.getElementById('comparison-color');if(!n){n=document.createElement('div');n.id='comparison-color';document.body.appendChild(n)}n.style.cssText='position:fixed;left:0;top:0;width:200px;height:200px;z-index:2147483647;background:${color}';return true})()`);
            const capture = await cdp.send('Page.captureScreenshot', { format: 'png' }, sessionId, 15_000);
            const png = Buffer.from(capture.data || '', 'base64'); const path = join(screenshotDir, `pixel-${frames.length}.png`); await writeFile(path, png);
            frames.push({ path, sha256: sha256(png), ...pngPixels(png) });
          }
          const a = frames[0].rgb_at_20_20, b = frames[1].rgb_at_20_20;
          const matches = (actual, expected) => actual.every((v, i) => Math.abs(v - expected[i]) <= 10);
          const pass = matches(a, [240, 20, 30]) && matches(b, [10, 40, 230]);
          result.pixel_rendering = { status: pass ? 'pass' : 'fail', frames, expected: [[240, 20, 30], [10, 40, 230]], decoded_pixels_change: frames[0].decoded_pixels_sha256 !== frames[1].decoded_pixels_sha256 };
          if (!pass) throw new Error(`CSS color pixels do not match: ${JSON.stringify(result.pixel_rendering)}`);
          return result.pixel_rendering;
        });
      } catch (error) { result.pixel_rendering ||= { status: 'error', error: errorText(error) }; }
    } else result.pixel_rendering = { status: 'unsupported', reason: 'Lightpanda provides text-only PNG/PDF surfaces, not real CSS webpage rendering; not comparable to render engines.' };
    result.status = result.stages.navigation?.status === 'pass' && result.stages.common_workload?.status === 'pass' && result.stages.collection?.status === 'pass' ? 'completed' : 'incomplete';
  } catch (error) { result.errors.push(errorText(error)); }
  finally {
    if (cdp) { result.cdp_events = cdp.events; cdp.close(); }
    if (sampling) result.resources = await sampling.stop();
    result.cleanup = await terminate(child); activeChildren.delete(child);
    result.total_ms = now() - started; result.finished_at = new Date().toISOString();
    await writeFile(join(logDir, 'stdout.log'), stdout); await writeFile(join(logDir, 'stderr.log'), stderr);
    result.stdout_path = join(logDir, 'stdout.log'); result.stderr_path = join(logDir, 'stderr.log'); result.stderr = stderr; result.exit_code = child?.exitCode; result.exit_signal = child?.signalCode;
    await save(join(runDir, 'run.json'), result);
  }
  return result;
}
function stats(values) {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b); if (!sorted.length) return { n: 0, median: null, min: null, max: null, mean: null };
  return { n: sorted.length, median: sorted.length % 2 ? sorted[Math.floor(sorted.length / 2)] : (sorted[sorted.length / 2 - 1] + sorted[sorted.length / 2]) / 2, min: sorted[0], max: sorted.at(-1), mean: sorted.reduce((a, b) => a + b, 0) / sorted.length };
}
function summarize(runs) {
  return options.engines.map(engine => {
    const all = runs.filter(r => r.engine === engine), completed = all.filter(r => r.status === 'completed');
    const stages = {};
    for (const stage of ['startup', 'connect', 'navigation', 'common_workload', 'audit_ready', 'collection', 'screenshot', 'pixel_rendering']) stages[stage] = { success_ms: stats(all.filter(r => r.stages[stage]?.status === 'pass').map(r => r.stages[stage].duration_ms)), failures: all.filter(r => r.stages[stage]?.status === 'error').length, not_reached: all.filter(r => !r.stages[stage]).length };
    return { engine, attempted: all.length, completed: completed.length, core_completed: completed.filter(r => r.pixel_rendering?.status === 'pass').length, stages, completed_path_total_ms: stats(completed.map(r => r.total_ms)), audit_path_ms: stats(completed.map(r => r.audit_path_ms)), completed_path_peak_tree_rss_kib: stats(completed.map(r => r.resources?.peak_tree_rss_kib)), completed_path_sampled_cpu_seconds: stats(completed.map(r => r.resources?.sampled_cpu_seconds)), successful_common_workload_ms: stats(all.filter(r => r.stages.common_workload?.status === 'pass').map(r => r.common_workload.total_ms)), pixel_passes: all.filter(r => r.pixel_rendering?.status === 'pass').length, scores: Object.fromEntries(['privacy', 'automation', 'functionality', 'performance'].map(axis => [axis, stats(completed.map(r => r.report?.scores?.[axis]?.score))])), coverage: stats(completed.map(r => r.report?.coverage?.ratio)) };
  });
}
function choose(summary) {
  const candidates = summary.filter(s => s.engine === 'obscura' || s.engine === 'moli');
  if (!candidates.length || candidates.some(c => !c.attempted)) return { selected: null, advisory: true, reason: 'Awaiting actual render-engine observations.' };
  if (candidates.length === 1) return { selected: candidates[0].core_completed > 0 ? candidates[0].engine : null, advisory: true, scope: 'single-render-engine-verification', reason: 'Verifies the active render engine against the common task and CSS pixels; initial Obscura/Moli comparison remains a separate report.', candidates };
  const eligible = candidates.filter(c => c.core_completed > 0);
  if (!eligible.length) return { selected: null, advisory: true, reason: 'Neither current render engine completed the audit/common workload and verified real CSS pixels.', candidates };
  // Actual path + pixels gate eligibility. Broad compatibility is lower
  // priority than resource cost once those core tasks are implemented.
  const ordered = [...eligible].sort((a, b) => b.core_completed - a.core_completed || (a.completed_path_peak_tree_rss_kib.median ?? Infinity) - (b.completed_path_peak_tree_rss_kib.median ?? Infinity) || (a.completed_path_total_ms.median ?? Infinity) - (b.completed_path_total_ms.median ?? Infinity));
  return { selected: ordered[0].engine, advisory: true, method: 'Gate: actual server-scored audit + verified common DOM/JS + real CSS pixels. Rank eligible engines by completed-run count, pixel-run count, engine-tree peak RSS, then complete-path total. Privacy/automation axes and nonessential feature gaps remain separate for the final development choice.', candidates, caveats: ['Local probes are not third-party anti-bot clearance.', 'Missing WebGL/audio/Worker support does not automatically outrank lightweight cost once core tasks pass.', 'RSS excludes the Node CDP driver and must not be directly compared with a Python+Playwright+browser wrapper total.', 'Source/license/development gaps remain explicit final-decision inputs.'], development_inputs: { obscura: runtimeFacts.obscura, moli: runtimeFacts.moli } };
}
const comparison = { schema_version: 1, started_at: new Date().toISOString(), options, artifact_directory: artifactRoot, machine: { platform: process.platform, arch: process.arch, node: process.version }, methodology: { mode: 'Cold isolated process and fresh storage per run; one page at same URL; deterministic DOM/JS workload before audit; rendering separate after collection; engine-major sequential execution, no concurrent browser workloads', scoring: 'Only actual GET-verified server reports; missing reports have no fabricated scores. Stage failures retained and excluded from success-only latency distributions.', intervals: 'Requested sample interval plus ps overhead; raw sample timestamps retained', timeouts_ms: { startup: 20_000, connect: 5000, cdp_default: 10_000, navigation_command: 20_000, navigation_ready: 20_000, collection: 120_000, screenshot: 15_000 }, common_workload: { version: 1, cpu_iterations: 200_000, dom_nodes: 1000, expected_checksum: expectedChecksum }, limitations: ['No production accounts/profiles.', 'Cold means fresh process/storage, not purged OS disk caches.', 'CDP API failures do not become privacy protection.', 'Lightpanda does not perform real CSS webpage paint; do not compare its screenshot cost as equivalent work.'] }, runs: [], summary: [], selection: null };
comparison.source_facts = runtimeFacts;
for (const engine of options.engines) for (let run = 1; run <= options.runs; run++) {
  const result = await runEngine(engine, run); comparison.runs.push(result); comparison.summary = summarize(comparison.runs); comparison.selection = choose(comparison.summary); await save(outputPath, comparison);
  console.log(JSON.stringify({ engine, run, status: result.status, total_ms: result.total_ms, report_id: result.report?.id, artifact_directory: result.artifact_directory, errors: result.errors }));
}
comparison.finished_at = new Date().toISOString(); await save(outputPath, comparison); console.log(JSON.stringify({ output: outputPath, summary: comparison.summary, selection: comparison.selection }));
