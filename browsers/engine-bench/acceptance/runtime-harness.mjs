import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile, writeFile, mkdir, mkdtemp } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const exec = promisify(execFile);
export const sha256 = value => createHash('sha256').update(value).digest('hex');
export const digest = value => sha256(JSON.stringify(value));
export async function save(path, value) {
  await writeFile(path, JSON.stringify(value, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
}
export async function harness(root, output) {
  await mkdir(output, { recursive: true, mode: 0o700 });
  const home = await mkdtemp(join(tmpdir(), 'at-fp-'));
  const commands = [];
  const call = async (...args) => {
    const row = { sequence: commands.length, args: args.map(value => value.length > 2048 ? { sha256: sha256(value), bytes: Buffer.byteLength(value) } : value), started_at: new Date().toISOString() };
    commands.push(row);
    return await new Promise((resolve, reject) => {
      const child = spawn(join(root, 'cli/bin/anti-trace'), args, { cwd: root, env: { ...process.env, ANTI_TRACE_HOME: home }, stdio: ['ignore', 'pipe', 'pipe'] });
      const out = [], err = []; let bytes = 0, errors = 0, failure, escalation;
      const terminate = error => { failure ||= error; child.kill('SIGTERM'); escalation ||= setTimeout(() => child.kill('SIGKILL'), 2000); };
      const timer = setTimeout(() => terminate(new Error('CLI command exceeded 150 seconds')), 150000);
      child.stdout.on('data', data => { bytes += data.length; if (bytes > 32 * 1024 * 1024) terminate(new Error('CLI output exceeded 32MiB')); else out.push(data); });
      child.stderr.on('data', data => { errors += data.length; if (errors <= 1024 * 1024) err.push(data); });
      child.once('error', error => { failure = error; });
      child.once('close', async (code, signal) => {
        clearTimeout(timer); clearTimeout(escalation);
        Object.assign(row, { finished_at: new Date().toISOString(), exit_code: code, signal, stdout_bytes: bytes, stderr_bytes: errors });
        const stdout = Buffer.concat(out).toString(), stderr = Buffer.concat(err).toString();
        row.stdout_sha256 = sha256(stdout); row.stderr_sha256 = sha256(stderr);
        try {
          await save(join(output, `command-${row.sequence}.json`), { ...row, stdout, stderr, error: failure?.message ?? null });
          if (failure || code !== 0) throw failure || new Error(`CLI ${args[0]} exited ${code}: ${stderr.slice(0, 800)} ${stdout.slice(0, 800)}`);
          const reply = JSON.parse(stdout);
          if (reply?.status === 'error') throw new Error(reply.message || JSON.stringify(reply));
          resolve(reply);
        } catch (error) { reject(error); }
      });
    });
  };
  return { home, commands, call, config: async name => JSON.parse(await readFile(join(home, 'profiles', name, 'config.json'), 'utf8')) };
}
export function summary(values) {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b), n = sorted.length;
  return { n, median: n ? (n % 2 ? sorted[(n - 1) / 2] : (sorted[n / 2 - 1] + sorted[n / 2]) / 2) : null, p95: n ? sorted[Math.ceil(n * .95) - 1] : null };
}
export function sampleTree(pid) {
  let stopped = false, timer, pending;
  const samples = [], cpu = new Map();
  const collect = async () => {
    try {
      const { stdout } = await exec('ps', ['-axo', 'pid=,ppid=,rss=,time=,lstart='], { env: { ...process.env, LC_ALL: 'C', TZ: 'UTC' }, maxBuffer: 8 * 1024 * 1024, timeout: 3000 });
      const rows = stdout.trim().split('\n').flatMap(line => {
        const match = line.trim().match(/^(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(.+)$/);
        return match ? [{ pid: +match[1], ppid: +match[2], rss_kib: +match[3], cpu_seconds: match[4].split(':').reduce((n, p) => n * 60 + Number(p), 0), born: match[5] }] : [];
      });
      if (!rows.some(row => row.pid === pid)) throw new Error('Owned manager PID absent from process sample');
      const ids = new Set([pid]); let changed = true;
      while (changed) { changed = false; for (const row of rows) if (ids.has(row.ppid) && !ids.has(row.pid)) { ids.add(row.pid); changed = true; } }
      const tree = rows.filter(row => ids.has(row.pid));
      for (const row of tree) {
        const key = `${row.pid}:${row.born}`, previous = cpu.get(key);
        cpu.set(key, { first: previous?.first ?? row.cpu_seconds, last: Math.max(previous?.last ?? 0, row.cpu_seconds) });
      }
      samples.push({ observed_at: new Date().toISOString(), tree, rss_kib: tree.reduce((n, row) => n + row.rss_kib, 0) });
    } catch (error) { samples.push({ observed_at: new Date().toISOString(), error: error.message }); }
    if (!stopped) timer = setTimeout(() => { pending = collect(); }, 50);
  };
  pending = collect();
  return async () => {
    stopped = true; clearTimeout(timer); await pending;
    // Force a final observation while the manager is alive; never count cleanup CPU.
    await collect();
    return { sample_interval_ms: 50, scope: 'Managed engine/driver/native descendant tree after readiness; task CPU is coarse process-time delta, excludes startup and pre-readiness RSS peak; no CLI helper CPU.', valid_samples: samples.filter(s => Number.isFinite(s.rss_kib) && s.tree?.length).length, observation_errors: samples.filter(s => s.error).length, peak_tree_rss_kib: samples.some(s => Number.isFinite(s.rss_kib)) ? Math.max(...samples.map(s => s.rss_kib || 0)) : null, cpu_seconds_delta: [...cpu.values()].reduce((n, value) => n + value.last - value.first, 0), samples };
  };
}
