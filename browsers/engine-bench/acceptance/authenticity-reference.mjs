import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile, mkdir } from 'node:fs/promises';
import { resolve, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { once } from 'node:events';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { createAuditServer } from '../../../services/audit/src/server.mjs';
import { AUTHENTICITY_MANIFEST, evaluateAuthenticity, generateAuthenticityInputs } from '../../../services/audit/src/authenticity.mjs';
import { save, sha256, digest } from './runtime-harness.mjs';
const root = resolve(fileURLToPath(new URL('../../..', import.meta.url))), args = process.argv.slice(2), exec = promisify(execFile);
const option = (key, fallback) => { const i = args.indexOf(key); if (i < 0) return fallback; if (!args[i + 1] || args[i + 1].startsWith('--')) throw new Error(`${key} requires a value`); return args[i + 1]; };
if (args.includes('--help')) { console.log('node browsers/engine-bench/acceptance/authenticity-reference.mjs --executable INSTALLED_CHROME [--output NEW-DIR] [--seed SEED]\nEmpirical one-host production-Chrome reference; no downloads or shared user profile.'); process.exit(0); }
const executable = option('--executable'); if (!executable) throw new Error('--executable must identify installed production Chrome');
const output = resolve(option('--output', join(root, 'browsers/engine-bench/.local/authenticity', 'chrome-reference-' + Date.now()))), seed = option('--seed', randomUUID());
await mkdir(dirname(output), { recursive: true, mode: 0o700 }); await mkdir(output, { recursive: false, mode: 0o700 });
const report = { schema: 1, kind: 'empirical-reference', seed, input: generateAuthenticityInputs(seed), started_at: new Date().toISOString(), manifest: AUTHENTICITY_MANIFEST, host: { platform: os.platform(), release: os.release(), arch: os.arch(), cpu: os.cpus()[0]?.model }, executable, artifact_sha256: sha256(await readFile(executable)), sources: [], samples: [], errors: [] };
for (const file of ['chrome-reference.py', 'authenticity-reference.mjs']) report.sources.push({ path: file, sha256: sha256(await readFile(join(root, 'browsers/engine-bench/acceptance', file))) });
const server = createAuditServer({ dataDir: join(output, 'server') });
try {
  server.listen(0, '127.0.0.1'); await once(server, 'listening'); const port = server.address().port;
  for (const [index, site] of ['http://127.0.0.1', 'http://localhost'].entries()) {
    const directory = join(output, 'sample-' + index); await mkdir(directory, { mode: 0o700 });
    const url = `${site}:${port}/authenticity.html?context=navigation&run_id=chrome-reference`;
    try {
      const result = await exec('uv', ['run', '--locked', '--project', join(root, 'cli'), 'python', join(root, 'browsers/engine-bench/acceptance/chrome-reference.py'), '--executable', executable, '--url', url, '--seed', seed, '--output', directory], { cwd: root, timeout: 150000, maxBuffer: 2 * 1024 * 1024 });
      const metadata = JSON.parse(result.stdout), raw = JSON.parse(await readFile(metadata.raw, 'utf8'));
      if (digest(raw.input) !== digest(report.input)) throw new Error('Reference input binding mismatch');
      const verdict = evaluateAuthenticity(raw), server_evidence = await (await fetch(`http://127.0.0.1:${port}/api/echo/events?run_id=chrome-reference`)).json();
      await save(join(directory, 'verdict.json'), verdict);
      report.samples.push({ site, metadata, raw_sha256: digest(raw), verdict, server_evidence });
    } catch (error) { report.errors.push({ site, error: error.message, stderr: error.stderr ?? null }); }
  }
} finally {
  server.closeAllConnections(); if (server.listening) await new Promise(resolve => server.close(resolve));
  report.finished_at = new Date().toISOString(); report.coverage = { hosts: 1, expected_samples: 2, samples: report.samples.length, policy: 'Single-host empirical observations; semantic thresholds remain the previously frozen analytic rules. Global prevalence is unmeasured.' };
  report.overall = report.samples.length === 2 && !report.errors.length && report.samples.every(sample => sample.verdict.overall === 'pass') ? 'PASS' : 'NOT_PASS';
  await save(join(output, 'report.json'), report);
  console.log(JSON.stringify({ output, overall: report.overall, coverage: report.coverage, errors: report.errors }));
  process.exitCode = report.overall === 'PASS' ? 0 : 1;
}
