import { webcrypto } from 'node:crypto';

const crypto = globalThis.crypto || webcrypto;
export const ATTEMPT_TTL = 300_000;
export const RETENTION = 86_400_000;
export const ACTION = 'browser_check';
const hex = bytes => [...bytes].map(n => n.toString(16).padStart(2, '0')).join('');
export const randomToken = () => hex(crypto.getRandomValues(new Uint8Array(32)));
const digest = async value => hex(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))));
export const json = (data, status = 200) => new Response(JSON.stringify(data), {
  status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'referrer-policy': 'no-referrer' },
});

// One durable SQLite row per experiment. SQL compare-and-set precedes external IO.
export class AttemptService {
  constructor(sql, env, { now = Date.now, verifyUrl = 'https://challenges.cloudflare.com/turnstile/v0/siteverify' } = {}) {
    this.sql = sql; this.env = env; this.now = now; this.verifyUrl = verifyUrl;
    sql.exec(`CREATE TABLE IF NOT EXISTS attempt (
      id TEXT PRIMARY KEY, nonce TEXT NOT NULL, access_hash TEXT NOT NULL,
      issued INTEGER NOT NULL, expires INTEGER NOT NULL, state TEXT NOT NULL,
      receipt TEXT, reason TEXT)`);
  }
  row() { return this.sql.exec('SELECT * FROM attempt LIMIT 1').toArray()[0]; }
  async create(runId) {
    if (this.row()) return json({ status: 'conflict' }, 409);
    const access = randomToken(), nonce = randomToken(), now = this.now();
    const accessHash = await digest(access);
    this.sql.exec('INSERT OR IGNORE INTO attempt VALUES (?, ?, ?, ?, ?, ?, NULL, NULL)', runId, nonce, accessHash, now, now + ATTEMPT_TTL, 'issued');
    const row = this.row();
    if (row.access_hash !== accessHash) return json({ status: 'conflict' }, 409);
    return json({ run_id: runId, nonce, access_token: access, expires_at: new Date(row.expires).toISOString(), action: ACTION }, 201);
  }
  async authorize(access) {
    const row = this.row();
    if (!row || this.now() >= row.issued + RETENTION || typeof access !== 'string' || access.length !== 64) return null;
    return await digest(access) === row.access_hash ? row : null;
  }
  async read(access) {
    const row = await this.authorize(access);
    if (!row) return json({ status: 'not_found' }, 404);
    if (row.receipt) return json({ status: row.state, ...JSON.parse(row.receipt) });
    const state = row.state === 'issued' && this.now() >= row.expires ? 'expired' : row.state;
    return json({ run_id: row.id, status: state, result: state, expires_at: new Date(row.expires).toISOString(), reason: row.reason });
  }
  async verify(access, data) {
    const row = await this.authorize(access);
    if (!row) return json({ status: 'not_found' }, 404);
    if (!this.env.TURNSTILE_SECRET) return json({ status: 'capability_unavailable' }, 503);
    if (row.state !== 'issued') return json({ status: 'replay_or_in_progress' }, 409);
    if (this.now() >= row.expires) return json({ status: 'expired' }, 410);
    if (data.nonce !== row.nonce || data.run_id !== row.id || typeof data.token !== 'string' || !data.token.length || data.token.length > 2048) {
      return json({ status: 'invalid_attempt' }, 400);
    }
    const claimed = this.sql.exec("UPDATE attempt SET state = 'verifying' WHERE id = ? AND state = 'issued' AND expires > ? RETURNING id", row.id, this.now()).toArray();
    if (!claimed.length) return json({ status: 'replay_or_expired' }, 409);
    try {
      const response = await fetch(this.verifyUrl, {
        method: 'POST', signal: AbortSignal.timeout(10_000),
        body: new URLSearchParams({ secret: this.env.TURNSTILE_SECRET, response: data.token, idempotency_key: row.id }),
      });
      if (!response.ok) throw new Error('upstream_status');
      const answer = await response.json();
      const expectedHost = new URL(this.env.LAB_ORIGIN).hostname;
      const valid = answer.success === true && answer.hostname === expectedHost && answer.action === ACTION && answer.cdata === row.nonce;
      if (this.now() >= row.expires) {
        this.sql.exec("UPDATE attempt SET state = 'rejected', reason = 'expired' WHERE id = ?", row.id);
        return json({ status: 'expired' }, 410);
      }
      if (!valid) {
        this.sql.exec("UPDATE attempt SET state = 'rejected', reason = 'verification_failed' WHERE id = ?", row.id);
        return json({ status: 'verification_failed' }, 403);
      }
      const receipt = { run_id: row.id, verified_at: new Date(this.now()).toISOString(), expires_at: new Date(row.expires).toISOString(),
        hostname: expectedHost, action: ACTION, result: 'passed', kind: 'turnstile-siteverify', receipt_id: randomToken() };
      this.sql.exec("UPDATE attempt SET state = 'passed', receipt = ? WHERE id = ? AND state = 'verifying'", JSON.stringify(receipt), row.id);
      return json({ status: 'passed', verification: receipt });
    } catch {
      this.sql.exec("UPDATE attempt SET state = 'error', reason = 'verification_upstream_error' WHERE id = ?", row.id);
      return json({ status: 'error', reason: 'verification_upstream_error' }, 502);
    }
  }
}
