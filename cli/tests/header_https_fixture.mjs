// Loopback-only HTTPS fixture, HTTP/1.1 or HTTP/2, with server-side request evidence.
import fs from 'node:fs';
import https from 'node:https';
import http2 from 'node:http2';

const [certificate, key, protocol, recordsFile] = process.argv.slice(2);
const records = [];
const options = { cert: fs.readFileSync(certificate), key: fs.readFileSync(key) };
const handler = (request, response) => {
  const headers = Object.fromEntries(Object.entries(request.headers).filter(([name]) => !name.startsWith(':')));
  const url = new URL(request.url, `https://127.0.0.1:${server.address().port}`);
  const observed = { headers, method: request.method, url: url.href, protocol: `HTTP/${request.httpVersion}` };
  records.push(observed);
  fs.writeFileSync(recordsFile, JSON.stringify(records, null, 2));
  response.setHeader('cache-control', 'no-store');
  if (url.pathname === '/echo') {
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify(observed));
  } else if (url.pathname === '/redirect') {
    response.writeHead(302, { location: '/matrix' });
    response.end();
  } else if (url.pathname === '/worker.js') {
    response.setHeader('content-type', 'text/javascript');
    response.end("fetch('/echo?via=worker').then(r=>r.json()).then(v=>postMessage(v.protocol));");
  } else if (url.pathname === '/pixel.svg') {
    response.setHeader('content-type', 'image/svg+xml');
    response.end('<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"><rect width="1" height="1"/></svg>');
  } else {
    response.setHeader('content-type', 'text/html');
    response.end(`<title>Local protocol matrix</title><img src="/pixel.svg"><script>
      Promise.all([fetch('/echo?via=fetch').then(r=>r.json()), new Promise(resolve => {
        const worker = new Worker('/worker.js'); worker.onmessage=resolve;
      })]).then(() => document.body.dataset.complete='yes');
    </script>`);
  }
};
const server = protocol === 'h2' ? http2.createSecureServer({ ...options, allowHTTP1: false }, handler)
                                : https.createServer(options, handler);
const sessions = new Set();
server.on('session', session => {
  sessions.add(session);
  session.on('close', () => sessions.delete(session));
});
server.listen(0, '127.0.0.1', () => console.log(JSON.stringify({ port: server.address().port })));
process.on('SIGTERM', () => {
  for (const session of sessions) session.destroy();
  server.closeAllConnections?.();
  server.close(() => process.exit(0));
});
