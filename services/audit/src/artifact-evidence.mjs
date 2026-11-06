import { openSync, readSync, closeSync, statSync, realpathSync } from 'node:fs';
import { sep } from 'node:path';
import { createHash } from 'node:crypto';

// One bounded buffer and one per-evaluation cache; large bundled-font archives
// are hashed once, not copied or rehashed for every required scenario.
export function artifactVerifier(roots) {
  const cache = new Map(); let buffer;
  return reference => {
    try {
      if (!reference || typeof reference.path !== 'string' || !Number.isSafeInteger(reference.byte_length) || reference.byte_length < 0 || !/^[a-f0-9]{64}$/.test(reference.sha256)) return false;
      const path = realpathSync(reference.path), allowed = roots.filter(root => typeof root === 'string').some(root => { const actual = realpathSync(root); return path.startsWith(actual + sep); });
      if (!allowed) return false;
      const before = statSync(path);
      if (!before.isFile() || before.size !== reference.byte_length) return false;
      const key = `${path}:${before.size}:${before.mtimeMs}:${reference.sha256}`;
      if (cache.has(key)) return cache.get(key);
      buffer ??= Buffer.allocUnsafe(1024 * 1024);
      const descriptor = openSync(path, 'r'), hash = createHash('sha256');
      try { for (let size; (size = readSync(descriptor, buffer, 0, buffer.length, null)) > 0;) hash.update(buffer.subarray(0, size)); }
      finally { closeSync(descriptor); }
      const after = statSync(path), valid = before.size === after.size && before.mtimeMs === after.mtimeMs && hash.digest('hex') === reference.sha256;
      cache.set(key, valid); return valid;
    } catch { return false; }
  };
}
