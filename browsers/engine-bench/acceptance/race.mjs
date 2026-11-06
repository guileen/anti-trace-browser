import { spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { RUNTIMES, SUITE_VERSION, generateInputs, digest } from '../../../services/audit/src/manifest.mjs';
import { buildScoreboard, loadReports } from './scoreboard.mjs';

const args = process.argv.slice(2), root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const option = (name, fallback) => { const index = args.indexOf(name); if (index < 0) return fallback; if (!args[index + 1] || args[index + 1].startsWith('--')) throw new Error(`${name} requires a value`); return args[index + 1]; };
if (args.includes('--help')) {
  console.log('node browsers/engine-bench/acceptance/race.mjs --output NEW-DIR [--cli PATH] [--input-seed SEED] [--cores-a 8] [--cores-b 12] [--camoufox-executable PATH] [--obscura-executable PATH] [--lightpanda-executable PATH]\nRuns the one shared CLI collector sequentially for all three runtimes, including failed collections; never downloads or substitutes a runtime. Non-pass scoreboard exits 1.');
  process.exit(0);
}
const output = resolve(option('--output', join(root, 'browsers/engine-bench/.local/acceptance', `race-${new Date().toISOString().replaceAll(':', '-')}`)));
await mkdir(dirname(output), { recursive: true, mode: 0o700 }); await mkdir(output, { recursive: false, mode: 0o700 });
const seed = option('--input-seed', randomUUID()), raceID = randomUUID(), inputs = generateInputs(seed);
const collection = { schema: 1, suite_version: SUITE_VERSION, race_id: raceID, input_generation: { version: 1, seed }, input_digest: digest(inputs), inputs, started_at: new Date().toISOString(), runs: [] };
const paths = {};
for (const runtime of RUNTIMES) {
  const directory = join(output, runtime); paths[runtime] = join(directory, 'raw.json');
  const command = [join(root, 'browsers/engine-bench/acceptance/camoufox-cli.mjs'), '--runtime', runtime, '--output', directory, '--input-seed', seed, '--race-id', raceID, '--cores-a', option('--cores-a', '8'), '--cores-b', option('--cores-b', '12')];
  const cli = option('--cli'), executable = option(`--${runtime}-executable`);
  if (cli) command.push('--cli', resolve(cli)); if (executable) command.push('--executable', resolve(executable));
  const receipt = { runtime, command: [process.execPath, ...command], started_at: new Date().toISOString() };
  collection.runs.push(receipt);
  await new Promise(resolveRun => {
    const child = spawn(process.execPath, command, { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] });
    const stdout = [], stderr = []; let size = 0;
    const capture = target => data => { size += data.length; if (size <= 4 * 1024 * 1024) target.push(data); else receipt.output_truncated = true; };
    child.stdout.on('data', capture(stdout)); child.stderr.on('data', capture(stderr));
    child.on('error', error => { receipt.error = error.message; });
    child.on('close', (code, signal) => { Object.assign(receipt, { exit_code: code, signal, stdout: Buffer.concat(stdout).toString(), stderr: Buffer.concat(stderr).toString(), finished_at: new Date().toISOString() }); resolveRun(); });
  });
  await writeFile(join(output, `${runtime}-collection.json`), JSON.stringify(receipt, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
}
collection.finished_at = new Date().toISOString();
await writeFile(join(output, 'collection.json'), JSON.stringify(collection, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
const reports = await loadReports(paths);
for (const report of reports) { const receipt = collection.runs.find(row => row.runtime === report.runtime); if (receipt.error || receipt.signal || receipt.exit_code === null || receipt.exit_code > 1) report.error = receipt.error || `Collector failed (${receipt.exit_code ?? receipt.signal})`; }
const scoreboard = buildScoreboard(reports);
await writeFile(join(output, 'scoreboard.json'), JSON.stringify(scoreboard, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
console.log(JSON.stringify({ output, ...scoreboard })); process.exitCode = scoreboard.overall === 'PASS' ? 0 : 1;
