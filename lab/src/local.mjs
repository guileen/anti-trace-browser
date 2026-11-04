#!/usr/bin/env node
/**
 * Local target practice for anti-trace.
 *
 * The visitor must solve a SHA-256 proof-of-work before the page opens: no JS,
 * no cookie, no access. That turns "did this environment pass" into a signal we
 * own instead of an inference about a vendor's marketing page.
 *
 *   node src/local.mjs [--port 8788] [--difficulty 4]
 *   curl -i http://127.0.0.1:8788/          # 403 challenge
 *   anti-trace field <env> --sites http://127.0.0.1:8788/
 */
import { createServer } from 'node:http';
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const index = args.indexOf(name);
  return index === -1 ? fallback : args[index + 1];
};
export const PORT = Number(flag('--port', process.env.LAB_PORT || 8788));
export const DIFFICULTY = Number(flag('--difficulty', process.env.LAB_DIFFICULTY || 4));
const SECRET = process.env.LAB_SECRET || randomBytes(16).toString('hex');
const ZEROS = '0'.repeat(DIFFICULTY);
const issued = new Map();

export const solve = (nonce, counter) => createHash('sha256').update(`${nonce}:${counter}`).digest('hex').startsWith(ZEROS);
const mark = (nonce) => createHmac('sha256', SECRET).update(nonce).digest('hex').slice(0, 32);
const cookieOf = (nonce) => `lab=${nonce}.${mark(nonce)}; path=/; max-age=600; HttpOnly`;
const cookieValid = (value) => {
  const [nonce, mac] = String(value || '').split('.');
  if (!nonce || !mac) return false;
  const expected = mark(nonce);
  return mac.length === expected.length && timingSafeEqual(Buffer.from(mac), Buffer.from(expected));
};

const page = (nonce) => `<!doctype html><meta charset="utf-8"><title>Lab: verifying</title>
<h1>Checking your browser</h1><p id="status">working…</p>
<script>
const nonce = ${JSON.stringify(nonce)};
(async () => {
  const encoder = new TextEncoder();
  const hex = async (text) => [...new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(text)))]
    .map(byte => byte.toString(16).padStart(2, '0')).join('');
  for (let counter = 0; counter < 2e6; counter++) {
    if ((await hex(nonce + ':' + counter)).startsWith(${JSON.stringify(ZEROS)})) {
      const answer = await fetch('/solve?nonce=' + nonce + '&counter=' + counter, { method: 'POST' });
      document.getElementById('status').textContent = answer.ok ? 'solved at counter ' + counter : 'rejected';
      if (answer.ok) location.replace('/ok');
      return;
    }
  }
  document.getElementById('status').textContent = 'failed to solve';
})();
</script>`;

const server = createServer((request, response) => {
  const url = new URL(request.url || '/', `http://${request.headers.host}`);
  const cookies = Object.fromEntries(String(request.headers.cookie || '')
    .split(';').map(part => part.trim().split('=')).filter(pair => pair.length === 2));

  if (url.pathname === '/echo') {
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ method: request.method, headers: request.headers }, null, 2));
    return;
  }

  if (url.pathname === '/health') {
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ status: 'ok', difficulty: DIFFICULTY }));
    return;
  }

  if (url.pathname === '/solve' && request.method === 'POST') {
    const nonce = url.searchParams.get('nonce') || '';
    const counter = Number(url.searchParams.get('counter'));
    if (!issued.has(nonce) || Number.isNaN(counter) || !solve(nonce, counter)) {
      response.writeHead(400, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ status: 'rejected' }));
      return;
    }
    issued.delete(nonce);
    response.writeHead(204, { 'set-cookie': cookieOf(nonce) });
    response.end();
    return;
  }

  if (url.pathname === '/ok') {
    if (!cookieValid(cookies.lab)) {
      response.writeHead(403, { 'content-type': 'text/html; charset=utf-8' });
      response.end('<h1>Forbidden</h1><p>No signed challenge cookie.</p>');
      return;
    }
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({
      status: 'passed',
      user_agent: request.headers['user-agent'],
      accept_language: request.headers['accept-language'],
      cookies_seen: Object.keys(cookies),
    }, null, 2));
    return;
  }

  if (cookieValid(cookies.lab)) {
    response.writeHead(302, { location: '/ok' });
    response.end();
    return;
  }

  const nonce = randomBytes(12).toString('hex');
  issued.set(nonce, Date.now());
  for (const [key, issuedAt] of issued) if (Date.now() - issuedAt > 600_000) issued.delete(key);
  response.writeHead(403, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
  response.end(page(nonce));
});

if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  server.listen(PORT, '127.0.0.1', () => {
    console.log(`lab listening on http://127.0.0.1:${PORT}/ (difficulty ${DIFFICULTY}, ${ZEROS})`);
  });
}

export { server };
