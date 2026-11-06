import { readFile, writeFile } from 'node:fs/promises';
import { resolve, dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { RUNTIMES, SUITE_VERSION, digest, evaluateAcceptance } from '../../../services/audit/src/manifest.mjs';

export function buildScoreboard(reports, { now = Date.now(), productEvidence = {} } = {}) {
  const entries = RUNTIMES.map(runtime => {
    const candidates = reports.filter(row => row.runtime === runtime);
    const raw = candidates.length === 1 ? candidates[0].raw : {};
    const verdict = evaluateAcceptance(raw, { now, productEvidence: productEvidence[runtime] ?? candidates[0]?.productEvidence ?? [] });
    const errors = [];
    if (candidates.length !== 1) errors.push('Exactly one raw envelope per required runtime is mandatory');
    if (raw?.runtime?.id !== runtime) errors.push('Selected runtime does not match raw runtime identity');
    if (candidates[0]?.error) errors.push(candidates[0].error);
    if (candidates[0]?.product_error && productEvidence[runtime] === undefined) errors.push(candidates[0].product_error);
    return { runtime, raw_path: candidates[0]?.path ?? null, raw, verdict, errors };
  });
  const reference = entries[0].raw;
  for (const entry of entries) {
    for (const [field, actual, expected] of [
      ['race_id', entry.raw?.race_id, reference?.race_id],
      ['input_digest', entry.raw?.input_digest, reference?.input_digest],
      ['input_variants_digest', entry.raw?.input_variants_digest, reference?.input_variants_digest],
      ['workload_digest', entry.raw?.workload_digest, reference?.workload_digest],
      ['collector_sha256', entry.raw?.collector_sha256, reference?.collector_sha256],
      ['host', entry.raw?.host && digest(entry.raw.host), reference?.host && digest(reference.host)],
    ]) if (!actual || actual !== expected) entry.errors.push(`Non-comparable ${field}`);
    if (entry.raw?.suite_version !== SUITE_VERSION) entry.errors.push('Non-current suite version');
  }
  const rows = entries.map(({ runtime, raw_path, verdict, errors }) => ({ runtime, raw_path, raw_sha256: verdict.raw_sha256, runtime_digest: verdict.runtime_digest, overall: errors.length || verdict.overall !== 'PASS' ? 'NOT_PASS' : 'PASS', coverage: verdict.coverage, product_coverage: verdict.product_coverage, errors, gaps: verdict.gaps }));
  return { schema: 1, suite_version: SUITE_VERSION, evaluated_at: new Date(now).toISOString(), race_id: reference?.race_id ?? null, input_digest: reference?.input_digest ?? null, overall: rows.every(row => row.overall === 'PASS') ? 'PASS' : 'NOT_PASS', winner: null, selection: 'No runtime is preselected; complete identical product evidence is required before any later selection.', runtimes: rows };
}

export async function loadReports(paths) {
  return await Promise.all(RUNTIMES.map(async runtime => {
    const path = paths[runtime];
    if (!path) return { runtime, raw: {}, error: 'Raw report path missing' };
    try {
      const raw = JSON.parse(await readFile(path, 'utf8'));
      const productPath = join(dirname(resolve(path)), 'product-evidence.json');
      let productEvidence = [], productError;
      try { productEvidence = JSON.parse(await readFile(productPath, 'utf8')); if (!Array.isArray(productEvidence)) throw new Error('Expected harness product records array'); }
      catch (error) { productError = `Cannot load harness product evidence: ${error.message}`; }
      return { runtime, path: resolve(path), raw, productEvidence, ...(productError ? { product_error: productError } : {}) };
    }
    catch (error) { return { runtime, path: resolve(path), raw: {}, error: `Cannot load raw evidence: ${error.message}` }; }
  }));
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [output, camoufox, obscura, lightpanda, productEvidencePath] = process.argv.slice(2);
  if (!output) throw new Error('Usage: node acceptance/scoreboard.mjs NEW-OUTPUT.json CAMOUFOX-RAW.json OBSCURA-RAW.json LIGHTPANDA-RAW.json [HARNESS-PRODUCT-EVIDENCE-BY-RUNTIME.json]');
  let productEvidence = {}, sourceError;
  if (productEvidencePath) {
    try { productEvidence = JSON.parse(await readFile(productEvidencePath, 'utf8')); if (!productEvidence || typeof productEvidence !== 'object' || Array.isArray(productEvidence)) throw new Error('Expected runtime-to-product-records mapping'); }
    catch (error) { sourceError = `Cannot load independent harness product evidence: ${error.message}`; productEvidence = {}; }
  }
  const reports = await loadReports({ camoufox, obscura, lightpanda });
  if (sourceError) for (const report of reports) report.error = [report.error, sourceError].filter(Boolean).join('; ');
  const result = buildScoreboard(reports, { productEvidence });
  await writeFile(output, JSON.stringify(result, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  console.log(JSON.stringify(result)); process.exitCode = result.overall === 'PASS' ? 0 : 1;
}
