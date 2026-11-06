import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { evaluateAcceptance, MANIFEST, SUITE_VERSION } from '../../../services/audit/src/manifest.mjs';
export { evaluateAcceptance, MANIFEST, SUITE_VERSION };

export async function evaluateFile(input, output, productEvidencePath) {
  if (resolve(input) === resolve(output) || (productEvidencePath && resolve(productEvidencePath) === resolve(output))) throw new Error('Source evidence must not be overwritten');
  let bytes, raw, productEvidence = [], sourceError;
  try { bytes = await readFile(input); raw = JSON.parse(bytes); }
  catch (error) { sourceError = `Cannot read raw evidence: ${error.message}`; raw = { collection_error: sourceError }; }
  if (productEvidencePath) {
    try { productEvidence = JSON.parse(await readFile(productEvidencePath, 'utf8')); if (!Array.isArray(productEvidence)) throw new Error('Expected product evidence array'); }
    catch (error) { sourceError = `Cannot read independent product evidence: ${error.message}`; productEvidence = []; raw = { ...(raw && typeof raw === 'object' ? raw : {}), collection_error: sourceError }; }
  }
  const verdict = { ...evaluateAcceptance(raw, { productEvidence }), raw_file_sha256: bytes ? createHash('sha256').update(bytes).digest('hex') : null, raw_path: resolve(input), product_evidence_path: productEvidencePath ? resolve(productEvidencePath) : null, source_error: sourceError ?? null };
  await writeFile(output, JSON.stringify(verdict, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  return verdict;
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [input, output, productEvidencePath] = process.argv.slice(2);
  if (!input || !output) throw new Error('Usage: node acceptance/evaluate.mjs RAW.json NEW-VERDICT.json [HARNESS-PRODUCT-EVIDENCE.json]');
  const result = await evaluateFile(input, output, productEvidencePath);
  console.log(JSON.stringify({ suite_version: result.suite_version, overall: result.overall, status: result.status, coverage: result.coverage, output }));
  process.exitCode = result.overall === 'PASS' ? 0 : 1;
}
