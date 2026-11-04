import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { server, DIFFICULTY } from '../src/local.mjs';

const ZEROS = '0'.repeat(DIFFICULTY);
const hex = (value) => createHash('sha256').update(value).digest('hex');
const findCounter = (nonce) => {
  for (let counter = 0; counter < 5e6; counter++) if (hex(`${nonce}:${counter}`).startsWith(ZEROS)) return counter;
  throw new Error('no solution');
};

test('a solved challenge opens the page, an unsolved one stays 403', async () => {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const gated = await fetch(`${base}/`, { redirect: 'manual' });
    assert.equal(gated.status, 403);
    const html = await gated.text();
    assert.match(html, /Checking your browser/);
    const nonce = /const nonce = "([0-9a-f]+)"/.exec(html)[1];

    const wrong = await fetch(`${base}/solve?nonce=${nonce}&counter=-1`, { method: 'POST' });
    assert.equal(wrong.status, 400);

    const accepted = await fetch(`${base}/solve?nonce=${nonce}&counter=${findCounter(nonce)}`, { method: 'POST' });
    assert.equal(accepted.status, 204);
    const cookie = accepted.headers.get('set-cookie').split(';')[0];

    const opened = await fetch(`${base}/ok`, { headers: { cookie } });
    assert.equal(opened.status, 200);
    assert.equal((await opened.json()).status, 'passed');

    const replay = await fetch(`${base}/solve?nonce=${nonce}&counter=0`, { method: 'POST' });
    assert.equal(replay.status, 400, 'a nonce is single-use');

    const forged = await fetch(`${base}/ok`, { headers: { cookie: 'lab=deadbeef.deadbeef' } });
    assert.equal(forged.status, 403, 'an unsigned cookie is refused');
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
