import http from 'node:http';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { RULES, LIMITATIONS, SUITE_VERSION, SCHEMA_VERSION, scoreSubmission } from './scoring.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const MAX_BODY = 512 * 1024;
const REPORT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const staticPaths = new Map([
  ['/', ['index.html', 'text/html; charset=utf-8']],
  ['/app.js', ['app.js', 'text/javascript; charset=utf-8']],
  ['/probes.js', ['probes.js', 'text/javascript; charset=utf-8']],
  ['/styles.css', ['styles.css', 'text/css; charset=utf-8']],
  ['/frame.html', ['frame.html', 'text/html; charset=utf-8']],
  ['/frame.js', ['frame.js', 'text/javascript; charset=utf-8']],
  ['/worker.js', ['worker.js', 'text/javascript; charset=utf-8']],
]);
const securityHeaders = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'X-Frame-Options': 'SAMEORIGIN',
  'Content-Security-Policy': "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self'; frame-src 'self'; worker-src 'self'; font-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'self'",
  'Cache-Control': 'no-store',
};
function send(res, status, value, type = 'application/json; charset=utf-8') {
  const body = Buffer.isBuffer(value) ? value : Buffer.from(typeof value === 'string' && !type.startsWith('application/json') ? value : JSON.stringify(value));
  res.writeHead(status, { ...securityHeaders, 'Content-Type': type, 'Content-Length': body.length });
  res.end(body);
}
async function readJSON(req) {
  if (!/^application\/json(?:\s*;|$)/i.test(req.headers['content-type'] || '')) throw Object.assign(new Error('Content-Type 必须为 application/json'), { status: 415 });
  if (Number(req.headers['content-length']) > MAX_BODY) throw Object.assign(new Error('请求过大，最大 512 KiB'), { status: 413 });
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY) throw Object.assign(new Error('请求过大，最大 512 KiB'), { status: 413 });
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw Object.assign(new Error('无效 JSON'), { status: 400 }); }
}
export function createAuditServer({ dataDir = process.env.DATA_DIR ? resolve(process.env.DATA_DIR) : join(root, '.local', 'reports', 'audits') } = {}) {
  const ready = mkdir(dataDir, { recursive: true });
  const server = http.createServer(async (req, res) => {
    try {
      const port = server.address()?.port;
      const allowedHosts = new Set([`127.0.0.1:${port}`, `localhost:${port}`]);
      if (port === 80) { allowedHosts.add('127.0.0.1'); allowedHosts.add('localhost'); }
      if (!allowedHosts.has(req.headers.host)) return send(res, 403, { error: '仅接受本机 Host' });
      if (req.headers.origin) {
        let origin;
        try { origin = new URL(req.headers.origin); } catch { return send(res, 403, { error: '无效 Origin' }); }
        if (origin.protocol !== 'http:' || !allowedHosts.has(origin.host)) return send(res, 403, { error: '禁止跨源请求' });
      }
      const url = new URL(req.url, `http://127.0.0.1:${port}`);
      if (req.method === 'GET' && url.pathname === '/health') return send(res, 200, { ok: true, schema_version: SCHEMA_VERSION, suite_version: SUITE_VERSION });
      if (req.method === 'GET' && url.pathname === '/api/suite') return send(res, 200, { schema_version: SCHEMA_VERSION, suite_version: SUITE_VERSION, rules: RULES, limitations: LIMITATIONS, deadlines: { probe_ms: 1800, audio_ms: 3500, total_ms: 30000 } });
      if (req.method === 'GET' && url.pathname === '/api/context') return send(res, 200, { user_agent: req.headers['user-agent'] || '', accept_language: req.headers['accept-language'] || '', sec_ch_ua: req.headers['sec-ch-ua'] || '', sec_ch_ua_platform: req.headers['sec-ch-ua-platform'] || '' });
      if (req.method === 'POST' && url.pathname === '/api/reports') {
        const input = await readJSON(req);
        let scored;
        try { scored = scoreSubmission(input); }
        catch (error) { return send(res, 400, { error: error.message }); }
        const id = randomUUID();
        const report = { id, ...scored, saved_at: new Date().toISOString() };
        await ready;
        await writeFile(join(dataDir, `${id}.json`), `${JSON.stringify(report, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
        return send(res, 201, report);
      }
      if (req.method === 'GET' && url.pathname.startsWith('/api/reports/')) {
        const id = url.pathname.slice('/api/reports/'.length);
        if (!REPORT_ID.test(id)) return send(res, 400, { error: '无效报告 ID' });
        try {
          const bytes = await readFile(join(dataDir, `${id}.json`));
          return send(res, 200, bytes);
        } catch (error) {
          if (error.code === 'ENOENT') return send(res, 404, { error: '报告不存在' });
          throw error;
        }
      }
      if (req.method === 'GET' && staticPaths.has(url.pathname)) {
        const [name, type] = staticPaths.get(url.pathname);
        return send(res, 200, await readFile(join(root, 'public', name)), type);
      }
      if (!['GET', 'POST'].includes(req.method)) {
        res.setHeader('Allow', 'GET, POST');
        return send(res, 405, { error: 'Method not allowed' });
      }
      return send(res, 404, { error: 'Not found' });
    } catch (error) {
      if (!res.headersSent) send(res, error.status || 500, { error: error.status ? error.message : '本地服务处理失败' });
      else res.destroy();
      if (!error.status) console.error(error);
    }
  });
  server.requestTimeout = 10000;
  server.headersTimeout = 8000;
  server.keepAliveTimeout = 3000;
  server.maxRequestsPerSocket = 100;
  return server;
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const port = Number(process.env.PORT || 8765);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT 必须为 1–65535');
  const server = createAuditServer();
  server.on('error', error => { console.error(error.message); process.exitCode = 1; });
  server.listen(port, '127.0.0.1', () => console.log(`Audit service http://127.0.0.1:${port} · ${SUITE_VERSION}`));
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => { server.close(); server.closeIdleConnections(); });
}
