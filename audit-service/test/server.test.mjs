import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAuditServer } from '../src/server.mjs';
import { SCHEMA_VERSION, SUITE_VERSION, RULES } from '../src/scoring.mjs';

async function fixture(t) {
  const dir = await mkdtemp(join(tmpdir(), 'trace-lab-test-'));
  const server = createAuditServer({ dataDir: dir });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await rm(dir, { recursive: true, force: true }); });
  return `http://127.0.0.1:${server.address().port}`;
}
const body = observations => ({ schema_version: SCHEMA_VERSION, suite_version: SUITE_VERSION, started_at: '2026-11-03T10:00:00Z', finished_at: '2026-11-03T10:00:01Z', observations });
const post = (base, value) => fetch(base + '/api/reports', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(value) });

test('health, single rule source and static content have correct HTTP boundaries', async t => {
  const base = await fixture(t);
  const health = await fetch(base + '/health');
  assert.equal(health.status, 200); assert.equal((await health.json()).suite_version, SUITE_VERSION);
  const suite = await (await fetch(base + '/api/suite')).json();
  assert.deepEqual(suite.rules, RULES);
  const root = await fetch(base + '/');
  assert.match(root.headers.get('content-type'), /^text\/html/);
  assert.equal(root.headers.get('cache-control'), 'no-store');
  assert.equal(root.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(root.headers.get('permissions-policy'), null);
  assert.equal((await fetch(base + '/src/server.mjs')).status, 404);
  assert.equal((await fetch(base + '/api/reports/../../package.json')).status, 404);
});

test('saved report exactly matches server response and fixed-denominator computation', async t => {
  const base = await fixture(t);
  const response = await post(base, body([{ id: 'cookie', status: 'pass', value: { written: 'audit-value-7319', read: 'corrupted', deleted: true } }]));
  assert.equal(response.status, 201);
  const saved = await response.json();
  assert.equal(saved.scores.functionality.score, 0);
  assert.equal(saved.coverage.total, RULES.length);
  assert.equal(saved.observations.find(o => o.id === 'cookie').status, 'fail');
  const read = await fetch(base + '/api/reports/' + saved.id);
  assert.equal(read.status, 200); assert.deepEqual(await read.json(), saved);
  assert.equal((await fetch(base + '/api/reports/00000000-0000-4000-8000-000000000000')).status, 404);
  assert.equal((await fetch(base + '/api/reports/not-safe')).status, 400);
});

test('malformed, duplicate, cross-origin and oversized submissions are rejected', async t => {
  const base = await fixture(t);
  assert.equal((await post(base, body([{ id: 'unknown', status: 'pass' }]))).status, 400);
  assert.equal((await post(base, body([{ id: 'cookie', status: 'pass' }, { id: 'cookie', status: 'pass' }]))).status, 400);
  assert.equal((await fetch(base + '/api/reports', { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: '{}' })).status, 415);
  assert.equal((await fetch(base + '/api/reports', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{' })).status, 400);
  assert.equal((await fetch(base + '/health', { headers: { Origin: 'https://example.com' } })).status, 403);
  assert.equal((await fetch(base + '/api/reports', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: 'x'.repeat(512 * 1024 + 1) })).status, 413);
});
