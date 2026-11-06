import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { createServer } from 'node:http';
import { AttemptService, ATTEMPT_TTL, RETENTION, ACTION } from '../src/attempt.mjs';
import { challengeRoute } from '../src/challenge.mjs';

async function fixture(t, answer) {
  const db = new DatabaseSync(':memory:');
  const sql = { exec(query, ...params) { const rows = db.prepare(query).all(...params); return { toArray: () => rows }; } };
  const server = createServer(async (request, response) => {
    let body = ''; for await (const part of request) body += part;
    const data = new URLSearchParams(body);
    const value = await answer(data);
    response.writeHead(value.http || 200, { 'content-type': 'application/json' });
    response.end(JSON.stringify(value.body || value));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { await new Promise(resolve => server.close(resolve)); db.close(); });
  let now = 10_000;
  const service = new AttemptService(sql, { TURNSTILE_SECRET: 'test-only-secret', LAB_ORIGIN: 'https://fixture.test' },
    { now: () => now, verifyUrl: `http://127.0.0.1:${server.address().port}` });
  const issued = await (await service.create(crypto.randomUUID())).json();
  return { service, issued, advance(ms) { now += ms; }, data: token => ({ run_id: issued.run_id, nonce: issued.nonce, token }) };
}

test('verified attempt is run bound, authenticated, single-use and retained for a bounded period', async t => {
  let f;
  f = await fixture(t, data => {
    assert.equal(data.get('secret'), 'test-only-secret');
    assert.equal(data.get('response'), 'fresh-token');
    assert.equal(data.get('idempotency_key'), f.issued.run_id);
    return { success: true, hostname: 'fixture.test', action: ACTION, cdata: f.issued.nonce };
  });
  assert.equal((await f.service.read('0'.repeat(64))).status, 404);
  const passed = await f.service.verify(f.issued.access_token, f.data('fresh-token'));
  assert.equal(passed.status, 200);
  const receipt = (await passed.json()).verification;
  assert.equal(receipt.run_id, f.issued.run_id);
  assert.equal(receipt.kind, 'turnstile-siteverify');
  assert.equal((await f.service.verify(f.issued.access_token, f.data('fresh-token'))).status, 409);
  const saved = await (await f.service.read(f.issued.access_token)).json();
  assert.deepEqual(saved, { status: 'passed', ...receipt });
  f.advance(RETENTION);
  assert.equal((await f.service.read(f.issued.access_token)).status, 404);
});

test('concurrent redemption invokes verifier exactly once', async t => {
  let release, started, calls = 0, f;
  const gate = new Promise(resolve => { release = resolve; });
  const entering = new Promise(resolve => { started = resolve; });
  f = await fixture(t, async () => {
    calls++; started(); await gate;
    return { success: true, hostname: 'fixture.test', action: ACTION, cdata: f.issued.nonce };
  });
  const first = f.service.verify(f.issued.access_token, f.data('fresh'));
  await entering;
  const second = await f.service.verify(f.issued.access_token, f.data('fresh'));
  assert.equal(second.status, 409);
  release(); assert.equal((await first).status, 200); assert.equal(calls, 1);
});

for (const field of ['hostname', 'action', 'cdata']) test(`mismatched ${field} rejects the attempt`, async t => {
  let f;
  f = await fixture(t, () => ({ success: true, hostname: 'fixture.test', action: ACTION, cdata: f.issued.nonce, [field]: 'wrong' }));
  assert.equal((await f.service.verify(f.issued.access_token, f.data('fresh'))).status, 403);
  assert.equal((await (await f.service.read(f.issued.access_token)).json()).status, 'rejected');
});

test('expiry and upstream uncertainty have distinct outcomes', async t => {
  const expired = await fixture(t, () => { throw new Error('must not call'); });
  expired.advance(ATTEMPT_TTL);
  assert.equal((await expired.service.verify(expired.issued.access_token, expired.data('fresh'))).status, 410);
  const failure = await fixture(t, () => ({ http: 503, body: { error: 'upstream' } }));
  assert.equal((await failure.service.verify(failure.issued.access_token, failure.data('fresh'))).status, 502);
  assert.equal((await (await failure.service.read(failure.issued.access_token)).json()).status, 'error');
  assert.equal((await failure.service.verify(failure.issued.access_token, failure.data('fresh'))).status, 409);
});

test('check is consent-gated and unconfigured attempt creation reports missing capability', async () => {
  const response = await challengeRoute(new Request('https://fixture.test/check'), {});
  const page = await response.text();
  assert.match(page, /Start verification/);
  assert.equal((await challengeRoute(new Request('https://fixture.test/attempts', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }), { LAB_ORIGIN: 'https://fixture.test' })).status, 503);
  const echo = await (await challengeRoute(new Request('https://fixture.test/echo', { headers: { cookie: 'session=secret', authorization: 'secret', 'user-agent': 'Browser' } }), {})).json();
  assert.equal(echo.headers['user-agent'], 'Browser');
  assert.equal(echo.headers.cookie, undefined);
  assert.equal(echo.headers.authorization, undefined);
});
