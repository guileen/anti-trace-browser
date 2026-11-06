import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdir } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { CDP } from './cdp.mjs';
import { generatePreloadScript } from './preload.mjs';

const DEFAULT_BINARY = resolve(import.meta.dirname, '../../engine-bench/.local/runtimes/obscura-0.2.6/obscura');

async function freePort() {
  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const port = server.address().port;
  await new Promise(r => server.close(r));
  return port;
}

const delay = ms => new Promise(r => setTimeout(r, ms));

export class ObscuraManager {
  constructor(spec, options = {}) {
    this.spec = spec;
    this.profileDir = resolve(options.profileDir || `./.local/profiles/${spec.name}`);
    this.binaryPath = options.binaryPath || process.env.OBSCURA_BIN || DEFAULT_BINARY;
    this.port = null;
    this.child = null;
    this.cdp = null;
    this.sessionId = null;
    this.targetId = null;
    this.stdout = '';
    this.stderr = '';
  }

  async launch() {
    await mkdir(this.profileDir, { recursive: true });
    this.port = await freePort();
    const args = [
      'serve',
      '--host', '127.0.0.1',
      '--port', String(this.port),
      '--stealth',
      '--allow-private-network',
      '--storage-dir', this.profileDir,
      '--user-agent', this.spec.userAgent,
    ];

    const env = {
      ...process.env,
      OBSCURA_ALLOW_PRIVATE_NETWORK: '1',
      OBSCURA_TIMEZONE: this.spec.timezone || 'Asia/Shanghai',
    };

    this.child = spawn(this.binaryPath, args, {
      cwd: this.profileDir,
      detached: false,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    this.child.stdout.on('data', d => { this.stdout += d; });
    this.child.stderr.on('data', d => { this.stderr += d; });

    // Wait for readiness
    const deadline = Date.now() + 15000;
    let connected = false;
    while (Date.now() < deadline) {
      if (this.child.exitCode !== null) {
        throw new Error(`Obscura exited prematurely: code ${this.child.exitCode}; stderr: ${this.stderr}`);
      }
      try {
        const res = await fetch(`http://127.0.0.1:${this.port}/json/version`, { signal: AbortSignal.timeout(500) });
        if (res.ok) {
          const meta = await res.json();
          const wsUrl = meta.webSocketDebuggerUrl || `ws://127.0.0.1:${this.port}`;
          this.cdp = await CDP.open(wsUrl, 3000);
          connected = true;
          break;
        }
      } catch (_) {}
      await delay(100);
    }

    if (!connected) {
      this.close();
      throw new Error(`Failed to connect to Obscura on port ${this.port} within timeout`);
    }

    // Attach to page target
    const target = await this.cdp.send('Target.createTarget', { url: 'about:blank' });
    this.targetId = target.targetId;
    const attached = await this.cdp.send('Target.attachToTarget', { targetId: this.targetId, flatten: true });
    this.sessionId = attached.sessionId;

    await this.cdp.send('Page.enable', {}, this.sessionId);
    await this.cdp.send('Runtime.enable', {}, this.sessionId);

    // Apply preload script before any navigation
    const preloadSource = generatePreloadScript(this.spec);
    await this.cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: preloadSource }, this.sessionId);

    return this;
  }

  async evaluate(expression, timeoutMs = 15000) {
    const res = await this.cdp.send('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true,
    }, this.sessionId, timeoutMs);

    if (res.exceptionDetails) {
      throw new Error('Evaluation exception: ' + JSON.stringify(res.exceptionDetails));
    }
    return res.result?.value;
  }

  async navigate(url, timeoutMs = 20000) {
    const nav = await this.cdp.send('Page.navigate', { url }, this.sessionId, timeoutMs);
    if (nav.errorText) throw new Error('Navigation failed: ' + nav.errorText);

    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const state = await this.evaluate('JSON.stringify({url:location.href,ready:document.readyState,body:!!document.body})', 3000);
      try {
        const parsed = JSON.parse(state);
        if (parsed.body && ['interactive', 'complete'].includes(parsed.ready)) {
          return parsed;
        }
      } catch (_) {}
      await delay(100);
    }
    throw new Error('Navigation timeout waiting for document.body and readyState');
  }

  async runAudit(auditUrl = 'http://127.0.0.1:8765') {
    await this.navigate(auditUrl);

    // Wait for audit function availability
    const deadline = Date.now() + 10000;
    while (Date.now() < deadline) {
      const available = await this.evaluate('typeof window.runAudit === "function"', 2000);
      if (available) break;
      await delay(100);
    }

    const reportVal = await this.evaluate('(async() => JSON.stringify(await window.runAudit()))()', 60000);
    const report = JSON.parse(reportVal);

    // Fetch official server-stored report
    const res = await fetch(new URL(`/api/reports/${encodeURIComponent(report.id)}`, auditUrl));
    if (!res.ok) throw new Error(`Audit report readback failed: ${res.status}`);
    return await res.json();
  }

  async close() {
    if (this.cdp) {
      try { await this.cdp.close(); } catch (_) {}
      this.cdp = null;
    }
    if (this.child) {
      try {
        this.child.kill('SIGTERM');
        await delay(150);
        if (this.child.exitCode === null) this.child.kill('SIGKILL');
      } catch (_) {}
      this.child = null;
    }
  }
}
