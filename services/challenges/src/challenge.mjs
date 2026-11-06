import { ACTION, json } from './attempt.mjs';

const bearer = request => (request.headers.get('authorization') || '').replace(/^Bearer /, '');
const pathId = path => /^\/attempts\/([0-9a-f-]{36})$/.exec(path)?.[1];
const hash = async value => [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)))].map(n => n.toString(16).padStart(2, '0')).join('');
const html = body => new Response(body, { headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'referrer-policy': 'no-referrer', 'x-content-type-options': 'nosniff' } });
const readBody = async request => {
  const reader = request.body?.getReader();
  if (!reader) throw new Error('missing_body');
  const chunks = []; let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > 4096) { await reader.cancel(); throw new Error('body_limit'); }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size); let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  return JSON.parse(new TextDecoder().decode(bytes));
};

export async function challengeRoute(request, env) {
  const url = new URL(request.url), id = pathId(url.pathname);
  if (url.pathname === '/echo') {
    const hidden = new Set(['cookie', 'authorization', 'proxy-authorization', 'cf-connecting-ip', 'x-forwarded-for', 'true-client-ip']);
    return json({ method: request.method, url: url.origin + url.pathname, protocol: request.cf?.httpProtocol || 'unknown',
      headers: Object.fromEntries([...request.headers].filter(([name]) => !hidden.has(name))) });
  }
  if (url.pathname === '/check' && request.method === 'GET') return html(CHECK_PAGE);
  if (url.pathname !== '/attempts' && url.pathname !== '/verify' && !id) return null;
  if (url.origin !== env.LAB_ORIGIN) return json({ status: 'invalid_origin' }, 403);
  if (!env.ATTEMPTS || !env.TURNSTILE_SECRET || !env.TURNSTILE_SITEKEY) return json({ status: 'capability_unavailable', capability: 'turnstile' }, 503);
  if (request.method === 'POST') {
    if ((request.headers.get('origin') && request.headers.get('origin') !== env.LAB_ORIGIN) || request.headers.get('sec-fetch-site') === 'cross-site') return json({ status: 'invalid_origin' }, 403);
    if (!(request.headers.get('content-type') || '').startsWith('application/json')) return json({ status: 'json_required' }, 415);
  }
  if (url.pathname === '/attempts' && request.method === 'POST') {
    const key = await hash(request.headers.get('cf-connecting-ip') || 'local');
    if (!await env.ATTEMPTS.getByName('rate:' + key).allowIssue()) return json({ status: 'rate_limited' }, 429);
    const runId = crypto.randomUUID();
    const response = await env.ATTEMPTS.getByName(runId).create(runId);
    return json({ ...response.body, sitekey: env.TURNSTILE_SITEKEY, check_url: env.LAB_ORIGIN + '/check', kind: 'turnstile-siteverify' }, response.status);
  }
  if (id && request.method === 'GET') {
    const response = await env.ATTEMPTS.getByName(id).read(bearer(request));
    return json(response.body, response.status);
  }
  if (url.pathname === '/verify' && request.method === 'POST') {
    let data;
    try { data = await readBody(request); } catch { return json({ status: 'invalid_body' }, 400); }
    if (typeof data.run_id !== 'string' || !pathId('/attempts/' + data.run_id)) return json({ status: 'invalid_run' }, 400);
    const response = await env.ATTEMPTS.getByName(data.run_id).verify(bearer(request), data);
    return json(response.body, response.status);
  }
  return json({ status: 'method_not_allowed' }, 405);
}

const CHECK_PAGE = `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex"><title>Browser verification — Fingerprint Test</title>
<style>body{font:17px/1.6 system-ui;max-width:46rem;margin:3rem auto;padding:0 1rem}button{font:inherit;padding:.6rem 1rem}pre{white-space:pre-wrap;overflow-wrap:anywhere}#status{min-height:3rem}</style>
<h1>Browser verification</h1><p>This experiment sends a Turnstile token to this site's server for verification. It records a short-lived result for 24 hours. Detailed fingerprints are kept by your local testing tool.</p>
<button id="start">Start verification</button><p id="status" role="status">Ready when you are.</p><div id="widget"></div><pre id="result"></pre><a href="/">Back to overview</a>
<script>
let attempt, access;
const status = document.getElementById('status'), output = document.getElementById('result');
const payload = async response => { const body = await response.json(); if (!response.ok) throw new Error(body.status); return body; };
const message = error => ({ capability_unavailable: 'Verification setup is pending. The operator is completing Turnstile authorization.', invalid_origin: 'Open this experiment on its configured site address.', rate_limited: 'Attempt limit reached. Start again in one minute.' })[error.message] || error.message;
document.getElementById('start').onclick = async () => {
  document.getElementById('start').disabled = true;
  try {
    // An external CLI may preload a server-issued attempt into this tab's sessionStorage.
    const provided = sessionStorage.getItem('anti-trace-attempt');
    if (provided) { attempt = JSON.parse(provided); sessionStorage.removeItem('anti-trace-attempt'); }
    else attempt = await payload(await fetch('/attempts', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }));
    access = attempt.access_token;
    status.textContent = 'Waiting for Turnstile…';
    const script = document.createElement('script'); script.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';
    script.onerror = () => { status.textContent = 'Challenge script unavailable. Start a new attempt.'; };
    script.onload = () => turnstile.render('#widget', { sitekey: attempt.sitekey, action: '${ACTION}', cData: attempt.nonce,
      callback: async token => {
        try {
          const verified = await payload(await fetch('/verify', { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer ' + access }, body: JSON.stringify({ run_id: attempt.run_id, nonce: attempt.nonce, token }) }));
          status.textContent = 'Server verified this attempt.';
          output.textContent = JSON.stringify(verified, null, 2);
          window.labResult = { run_id: attempt.run_id, status: verified.status };
        } catch (error) { status.textContent = message(error) + ' Start a new attempt.'; }
      }, 'error-callback': code => { status.textContent = 'Challenge error: ' + code + '. Start a new attempt.'; },
      'expired-callback': () => { status.textContent = 'Challenge expired. Start a new attempt.'; }
    });
    document.head.appendChild(script);
  } catch (error) { status.textContent = message(error); document.getElementById('start').disabled = false; }
};
</script></html>`;
