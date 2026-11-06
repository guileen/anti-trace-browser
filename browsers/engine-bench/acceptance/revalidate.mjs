import { readFile, writeFile, readdir, mkdir } from 'node:fs/promises';
import { resolve, join, basename, dirname } from 'node:path';
import { createHash } from 'node:crypto';
import { evaluateAcceptance, SUITE_VERSION } from '../../../services/audit/src/manifest.mjs';

const [source, destination] = process.argv.slice(2);
if (!source || !destination) throw new Error('Usage: node acceptance/revalidate.mjs HISTORICAL-REPORT-DIR NEW-OUTPUT-DIR');
const input = resolve(source), output = resolve(destination);
if (input === output || output.startsWith(input + '/')) throw new Error('Revalidation output must be outside original report directory');
await mkdir(dirname(output), { recursive: true, mode: 0o700 });
await mkdir(output, { recursive: false, mode: 0o700 });
const index = [];
for (const entry of await readdir(input, { withFileTypes: true })) {
  if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
  const bytes = await readFile(join(input, entry.name));
  let report, parseError;
  try { report = JSON.parse(bytes); } catch (error) { parseError = `Invalid historical JSON: ${error.message}`; report = {}; }
  if (!report || typeof report !== 'object' || Array.isArray(report)) { parseError = 'Historical JSON is not an evidence envelope'; report = {}; }
  const raw = Array.isArray(report.runs) ? report : { schema: report.schema_version ?? null, suite_version: report.suite_version ?? null, runs: [], ...(parseError ? { collection_error: parseError } : {}) };
  const verdict = evaluateAcceptance(raw);
  const result = { ...verdict, historical_source: { path: join(input, entry.name), sha256: createHash('sha256').update(bytes).digest('hex'), suite_version: report.suite_version ?? null }, collection_error: parseError ?? null, historical_observations: Array.isArray(report.observations) ? report.observations.map(o => ({ id: o?.id, original_status: o?.status, has_value: o?.value !== undefined })) : [], migration_note: parseError || (Array.isArray(report.runs) ? 'Re-evaluated retained raw lifecycle observations; original report unchanged.' : 'Legacy scores/hashes cannot reconstruct raw pixels, audio samples, controlled inputs or missing lifecycles; all corresponding current required checks remain outstanding. Historical scores remain in the original file.') };
  const name = basename(entry.name, '.json') + `.${SUITE_VERSION}.verdict.json`;
  await writeFile(join(output, name), JSON.stringify(result, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  index.push({ source: entry.name, verdict: name, source_suite_version: report.suite_version ?? null, status: verdict.status, coverage: verdict.coverage });
}
await writeFile(join(output, 'index.json'), JSON.stringify({ suite_version: SUITE_VERSION, source_directory: input, reports: index }, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
console.log(JSON.stringify({ suite_version: SUITE_VERSION, reports: index.length, output }));
