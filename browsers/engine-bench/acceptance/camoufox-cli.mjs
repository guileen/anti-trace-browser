import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, writeFile, readFile } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { randomUUID, createHash } from 'node:crypto';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import os from 'node:os';
import { once } from 'node:events';
import { createAuditServer } from '../../../services/audit/src/server.mjs';
import { MANIFEST, SUITE_VERSION, RUNTIMES, PRODUCT_SCENARIOS, COLLECTOR_IDENTITY, evaluateAcceptance, generateInputs, generateInputVariants, generateCreationInputs, workloadFor, digest } from '../../../services/audit/src/manifest.mjs';
import { collectProductEvidence } from './product-collector.mjs';
import { eventsForScenario } from './scenario-events.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const args = process.argv.slice(2);
function option(name, fallback) { const index = args.indexOf(name); if (index < 0) return fallback; if (!args[index + 1] || args[index + 1].startsWith('--')) throw new Error(`${name} requires a value`); return args[index + 1]; }
if (args.includes('--help')) {
  console.log('node browsers/engine-bench/acceptance/camoufox-cli.mjs [--runtime camoufox|obscura|lightpanda] [--output NEW-DIR] [--cli PATH] [--executable PATH] [--input-seed SEED] [--race-id ID] [--cores-a 8] [--cores-b 12]\nOne shared collector creates private A/B profiles, drives real CLI create/start/exec/stop and retains failures. No downloads, GUI substitutions or external-product claims.');
  process.exit(0);
}
const runtime = option('--runtime', 'camoufox');
if (!RUNTIMES.includes(runtime)) throw new Error('Unknown runtime');
const output = resolve(option('--output', join(root, 'browsers/engine-bench/.local/acceptance', `${runtime}-${new Date().toISOString().replaceAll(':', '-')}`)));
const cli = resolve(option('--cli', join(root, 'cli/bin/anti-trace')));
const binaryVariable = { camoufox: 'ANTI_TRACE_BROWSER', obscura: 'ANTI_TRACE_OBSCURA_BINARY', lightpanda: 'ANTI_TRACE_LIGHTPANDA_BINARY' }[runtime];
const executable = option('--executable', process.env[binaryVariable] || (runtime === 'camoufox' ? process.env.CAMOUFOX_EXECUTABLE_PATH : undefined));
await mkdir(dirname(output), { recursive: true, mode: 0o700 });
await mkdir(output, { recursive: false, mode: 0o700 });
// Keep profile IPC paths short even when the repository is deeply nested.
const home = await mkdtemp(join(os.tmpdir(), 'at-a-'));
const env = { ...process.env, ANTI_TRACE_HOME: home, ...(executable ? { [binaryVariable]: executable } : {}) };
const seed = option('--input-seed', randomUUID()), inputs = generateInputs(seed);
const evidence = { schema: 2, suite_version: SUITE_VERSION, race_id: option('--race-id', randomUUID()), run_id: randomUUID(), inputs, input_generation: { version: 1, seed }, input_digest: digest(inputs), host: { platform: os.platform(), release: os.release(), arch: os.arch(), cpus: os.cpus().length, memory_bytes: os.totalmem(), node: process.version }, runtime: { id: runtime, executable: executable ?? null }, environments: {}, runs: [], commands: [], started_at: new Date().toISOString(), profile_home: home };
evidence.input_variants = generateInputVariants(inputs);
evidence.input_variants_digest = digest(evidence.input_variants);
evidence.creation_inputs = generateCreationInputs(seed);
evidence.workload = workloadFor(seed, option('--cores-a', '8'), option('--cores-b', '12'));
evidence.workload_digest = digest(evidence.workload);
evidence.host.hostname_sha256 = digest(os.hostname());
evidence.artifact_root = output;
// Bind all executable collector/page/realm inputs, not just one page script.
evidence.collector_sources = COLLECTOR_IDENTITY.sources;
evidence.collector_sha256 = COLLECTOR_IDENTITY.sha256;
if (!COLLECTOR_IDENTITY.available) evidence.collection_error = COLLECTOR_IDENTITY.error;
const command = async (...values) => {
  const sequence = evidence.commands.length;
  const entry = { sequence, args: values.map(v => v.length > 1024 ? `[controlled expression sha256=${createHash('sha256').update(v).digest('hex')}]` : v), started_at: new Date().toISOString() };
  evidence.commands.push(entry);
  return await new Promise((resolveCommand, reject) => {
    const child = spawn(cli, values, { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });
    const stdout = [], stderr = []; let size = 0, stderrSize = 0, failure, killTimer;
    const terminate = error => { failure ||= error; child.kill('SIGTERM'); killTimer ||= setTimeout(() => child.kill('SIGKILL'), 2000); };
    const timer = setTimeout(() => terminate(new Error('CLI command deadline exceeded')), 240000);
    child.stdout.on('data', data => { size += data.length; if (size > 32 * 1024 * 1024) terminate(new Error('CLI output exceeded 32MiB bound')); else stdout.push(data); });
    child.stderr.on('data', data => { stderrSize += data.length; if (stderrSize <= 1024 * 1024) stderr.push(data); });
    child.on('error', error => { failure = error; });
    child.on('close', async (code, signal) => {
      clearTimeout(timer); clearTimeout(killTimer); Object.assign(entry, { finished_at: new Date().toISOString(), exit_code: code, signal, error: failure?.message ?? null });
      const text = Buffer.concat(stdout).toString(), errors = Buffer.concat(stderr).toString();
      entry.stdout_sha256 = createHash('sha256').update(text).digest('hex'); entry.stderr_sha256 = createHash('sha256').update(errors).digest('hex');
      try { await writeFile(join(output, `command-${sequence}.json`), JSON.stringify({ ...entry, stdout: text, stderr: errors }, null, 2) + '\n', { flag: 'wx', mode: 0o600 }); } catch (error) { reject(error); return; }
      if (failure || code !== 0) { reject(failure || new Error(`CLI ${values[0]} exited ${code}: ${errors.slice(0, 1000)}`)); return; }
      try { const result = JSON.parse(text); if (result?.error) throw new Error(JSON.stringify(result.error)); resolveCommand(result); } catch (error) { reject(new Error(`CLI ${values[0]} invalid response: ${error.message}`)); }
    });
  });
};
const hashFile = async path => { const hash = createHash('sha256'); for await (const chunk of createReadStream(path)) hash.update(chunk); return hash.digest('hex'); };
const server = createAuditServer({ dataDir: join(output, 'audit-reports') });
let port, failure, productEvidence = [];
const failures = [];
const recordFailure = error => { failures.push(error.message); evidence.collection_error = failures.join('; '); failure ||= error; };
const rowFor = (phase, site, lifecycle, runID) => ({ run_id: runID, collection_run_id: evidence.run_id, suite_version: SUITE_VERSION, runtime_id: runtime, runtime_digest: evidence.runtime.artifact_sha256 ?? null, input_digest: evidence.input_digest, environment_digest: evidence.environments[phase[0]]?.sha256 ?? null, environment: phase[0], phase, lifecycle, site: `${site}:${port}`, features: {} });
try {
  server.listen(0, '127.0.0.1'); await once(server, 'listening'); port = server.address().port;
  await writeFile(join(output, 'manifest.json'), JSON.stringify(MANIFEST, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  for (const [environment, extras] of [['A', ['--cores', option('--cores-a', '8')]], ['B', ['--cores', option('--cores-b', '12'), '--fonts', 'subset:24']]]) {
    try {
      await command('create', `accept${environment}`, '--runtime', runtime, '--seed', evidence.creation_inputs[environment].seed, '--allow-private-network', ...extras, '--json');
      const info = await command('info', `accept${environment}`, '--json');
      evidence.runtime[environment] = info;
      if (info.runtime?.id !== runtime) throw new Error('CLI info runtime identity does not match requested selector');
      const configPath = info.config_path || join(home, 'profiles', `accept${environment}`, 'config.json');
      const configurationHash = await hashFile(configPath);
      evidence.runtime[environment].configuration = JSON.parse(await readFile(configPath, 'utf8'));
      if (info.configuration_sha256 && info.configuration_sha256 !== configurationHash) throw new Error('CLI configuration receipt does not match persisted file bytes');
      evidence.environments[environment] = { sha256: configurationHash };
      const browser = info.runtime?.executable || executable;
      if (browser) {
        const hash = await hashFile(browser);
        if (info.runtime?.artifact_sha256 && info.runtime.artifact_sha256 !== hash) throw new Error('CLI runtime digest does not match actual executable bytes');
        if (evidence.runtime.artifact_sha256 && evidence.runtime.artifact_sha256 !== hash) throw new Error('A/B runtime executable digests differ');
        Object.assign(evidence.runtime, { executable: browser, artifact_sha256: hash, version: info.runtime?.version ?? null });
      }
    } catch (error) { recordFailure(error); }
  }
  if (!evidence.runtime.artifact_sha256 && runtime === 'camoufox') {
    try {
      evidence.runtime.doctor = await command('doctor', '--json');
      const browser = evidence.runtime.doctor.checks?.find(check => check.check === 'browser' && check.result === 'pass')?.detail;
      if (!browser) throw new Error('Existing executable unavailable; fixture never downloads a browser');
      Object.assign(evidence.runtime, { executable: browser, artifact_sha256: await hashFile(browser) });
    } catch (error) { recordFailure(error); }
  }
  if (!evidence.runtime.artifact_sha256) recordFailure(new Error('No authoritative runtime executable path/digest from CLI info; provide --executable'));
  for (const phase of MANIFEST.phases) {
    const environment = phase[0], name = `accept${environment}`;
    let startError;
    try { await command('start', name, '--headless', '--url', `http://127.0.0.1:${port}/`, '--json'); } catch (error) { startError = error; recordFailure(error); }
    try {
      for (const site of MANIFEST.sites) {
        const runID = randomUUID(), url = `${site}:${port}/acceptance.html?context=navigation&run_id=${runID}`;
        let navigationError = startError;
        if (!navigationError) { try { await command('exec', name, 'goto', url, '--json'); } catch (error) { navigationError = error; recordFailure(error); } }
        for (const lifecycle of MANIFEST.lifecycles) {
          const row = rowFor(phase, site, lifecycle, runID); evidence.runs.push(row);
          try {
            if (navigationError) throw navigationError;
            if (lifecycle === 'refresh') await command('exec', name, 'reload', '--json');
            if (lifecycle === 'new_page') {
              const tab = await command('exec', name, 'tab_new', url, '--json');
              if (!Number.isInteger(tab.index)) throw new Error('tab_new omitted real created page index');
              await command('exec', name, 'use', String(tab.index), '--json');
            }
            const options = { input: evidence.inputs, environment, run_id: runID, storage_mode: phase.endsWith('1') && lifecycle === 'initial' ? 'write' : 'read' };
            const requestID = randomUUID();
            // The real runtime page owns probes. Only DOM strings cross isolated CLI realms.
            const expression = `(async () => {
              const output = document.getElementById('acceptance-output');
              if (!output) throw new Error('Controlled main-page fixture missing');
              document.documentElement.setAttribute('data-acceptance-request', ${JSON.stringify(JSON.stringify({ request_id: requestID, options }))});
              document.dispatchEvent(new Event('acceptance-collect'));
              const deadline = Date.now() + 100000;
              while (Date.now() < deadline) {
                if (output.getAttribute('data-request-id') === ${JSON.stringify(requestID)} && output.getAttribute('data-status') === 'complete') {
                  const result = JSON.parse(output.textContent); if (result.error) throw new Error(result.error); return result.features;
                }
                await new Promise(resolve => setTimeout(resolve, 50));
              }
              throw new Error('Controlled main-page collection deadline exceeded');
            })()`;
            row.features = (await command('exec', name, 'eval', expression, '--timeout', '120000', '--json')).result;
            if (!row.features || typeof row.features !== 'object' || Array.isArray(row.features)) throw new Error('CLI did not return raw feature observations');
            row.server_evidence = await (await fetch(`${site}:${port}/api/echo/events?run_id=${runID}`)).json();
            if (row.features.headers?.observed) { row.features.headers.observed.receipts = row.server_evidence.receipts; row.features.headers.observed.source = 'server (harness fetched independently of runtime)'; }
          } catch (error) { row.collection_error = error.message; recordFailure(error); }
          await writeFile(join(output, `${phase}-${new URL(site).hostname}-${lifecycle}.raw.json`), JSON.stringify(row) + '\n', { flag: 'wx', mode: 0o600 });
        }
      }
    } finally { try { await command('stop', name, '--json'); } catch (error) { recordFailure(error); } }
  }
  const events = await collectProductEvidence({ evidence, output, home, port, command });
  productEvidence = PRODUCT_SCENARIOS.map(scenario => {
    const content = { events: eventsForScenario(scenario.id, events) };
    return { schema: 1, suite_version: SUITE_VERSION, case_id: scenario.id, source: 'process', run_id: evidence.run_id, race_id: evidence.race_id, runtime_id: runtime, runtime_digest: evidence.runtime.artifact_sha256, input_digest: evidence.input_digest, environment_digests: evidence.environments, collector_sha256: evidence.collector_sha256, observed_at: new Date().toISOString(), artifacts: [{ id: `product/${scenario.id}`, content, sha256: digest(content) }] };
  });
} catch (error) { recordFailure(error); }
finally {
  for (const name of ['acceptA', 'acceptB']) { try { await command('stop', name, '--json'); } catch (error) { recordFailure(error); } }
  if (server.listening) { server.closeAllConnections(); await new Promise(resolveClose => server.close(resolveClose)); }
  evidence.finished_at = new Date().toISOString();
  await writeFile(join(output, 'product-evidence.json'), JSON.stringify(productEvidence) + '\n', { flag: 'wx', mode: 0o600 });
  await writeFile(join(output, 'raw.json'), JSON.stringify(evidence) + '\n', { flag: 'wx', mode: 0o600 });
  const verdict = evaluateAcceptance(evidence, { productEvidence });
  await writeFile(join(output, 'verdict.json'), JSON.stringify(verdict, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  console.log(JSON.stringify({ output, suite_version: SUITE_VERSION, runtime, overall: verdict.overall, status: verdict.status, coverage: verdict.coverage, error: failure?.message ?? null }));
  process.exitCode = verdict.overall === 'PASS' ? 0 : 1;
}
