import { createServer, request } from 'node:http';
import { connect } from 'node:net';
import { once } from 'node:events';

// Only real forwarding is used during create-time egress measurement. No IP,
// country, challenge response or page output is manufactured by this fixture.
export async function proxyFixture(fixturePort) {
  const sockets = new Set(), events = [], authentication = 'Basic ' + Buffer.from('fixture-user:fixture-password').toString('base64');
  let mode = 'forwarding';
  const allowed = (host, port) => (['ipinfo.io','ip-api.com','api.ipify.org'].includes(host) && [80,443].includes(port)) || (['127.0.0.1','localhost'].includes(host) && port === fixturePort);
  const server = createServer((req, res) => {
    let url; try { url = new URL(req.url); } catch { res.writeHead(400); res.end(); return; }
    const port = Number(url.port || 80); events.push({ method: req.method, host: url.hostname, port, mode, at: new Date().toISOString() });
    if (mode !== 'forwarding') { req.socket.destroy(); return; }
    if (req.headers['proxy-authorization'] !== authentication) { res.writeHead(407, { 'Proxy-Authenticate': 'Basic realm="fixture"' }); res.end(); return; }
    if (url.protocol !== 'http:' || !allowed(url.hostname, port)) { res.writeHead(403); res.end(); return; }
    const headers = { ...req.headers }; delete headers['proxy-authorization']; delete headers['proxy-connection'];
    const outgoing = request(url, { method: req.method, headers }, response => { res.writeHead(response.statusCode, response.headers); response.pipe(res); });
    outgoing.on('error', () => { if (!res.headersSent) res.writeHead(502); res.end(); }); req.pipe(outgoing);
  });
  server.on('connection', socket => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)); if (mode !== 'forwarding') socket.destroy(); });
  server.on('connect', (req, client, head) => {
    let target; try { target = new URL('http://' + req.url); } catch { client.destroy(); return; }
    const port = Number(target.port || 443); events.push({ method: 'CONNECT', host: target.hostname, port, mode, at: new Date().toISOString() });
    if (mode !== 'forwarding' || !allowed(target.hostname, port) || req.headers['proxy-authorization'] !== authentication) { client.destroy(); return; }
    const upstream = connect(port, target.hostname, () => { client.write('HTTP/1.1 200 Connection Established\r\n\r\n'); if (head.length) upstream.write(head); client.pipe(upstream); upstream.pipe(client); });
    sockets.add(upstream); upstream.once('close', () => sockets.delete(upstream)); upstream.on('error', () => client.destroy()); client.on('error', () => upstream.destroy()); client.once('close', () => upstream.destroy());
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const port = server.address().port;
  return { url: `http://fixture-user:fixture-password@127.0.0.1:${port}`, events,
    disconnect() { mode = 'disconnected'; for (const socket of sockets) socket.destroy(); },
    async close() { for (const socket of sockets) socket.destroy(); await new Promise(resolve => server.close(resolve)); },
  };
}
