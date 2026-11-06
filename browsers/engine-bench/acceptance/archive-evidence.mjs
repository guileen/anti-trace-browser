import { createReadStream, createWriteStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { createGunzip, createGzip } from 'node:zlib';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';

// Inspect the retained real export without copying font bundles into JSON or
// expanding an entire profile in memory. Hashes identify the on-disk artifact;
// match counts are measurements, never acceptance/approval flags.
export async function inspectArchive(path) {
  const before = await stat(path), compressedHash = createHash('sha256'), input = createReadStream(path), unzip = createGunzip();
  input.on('data', chunk => compressedHash.update(chunk));
  input.on('error', error => unzip.destroy(error)); unzip.once('close', () => input.destroy());
  const needles = { username: Buffer.from('fixture-user'), password: Buffer.from('fixture-password') };
  const counts = { username: 0, password: 0 }, carries = { username: Buffer.alloc(0), password: Buffer.alloc(0) };
  const files = []; let header = Buffer.alloc(0), current = null, padding = 0, offset = 0, ended = false, config, configOffset;
  for await (const chunk of input.pipe(unzip)) {
    for (const [kind, needle] of Object.entries(needles)) {
      const carry = carries[kind], scan = Buffer.concat([carry, chunk]);
      for (let index = scan.indexOf(needle); index >= 0; index = scan.indexOf(needle, index + 1)) if (index + needle.length > carry.length) counts[kind]++;
      carries[kind] = Buffer.from(scan.subarray(Math.max(0, scan.length - needle.length + 1)));
    }
    let cursor = 0;
    while (cursor < chunk.length) {
      if (ended) { offset += chunk.length - cursor; break; }
      if (padding) { const size = Math.min(padding, chunk.length - cursor); cursor += size; offset += size; padding -= size; continue; }
      if (!current) {
        const size = Math.min(512 - header.length, chunk.length - cursor);
        header = Buffer.concat([header, chunk.subarray(cursor, cursor + size)]); cursor += size; offset += size;
        if (header.length !== 512) continue;
        if (header.every(byte => byte === 0)) { ended = true; header = Buffer.alloc(0); continue; }
        const name = header.subarray(0, 100).toString().replace(/\0.*$/s, ''), prefix = header.subarray(345, 500).toString().replace(/\0.*$/s, '');
        const length = parseInt(header.subarray(124, 136).toString().replace(/\0.*$/s, '').trim(), 8) || 0;
        if (!Number.isSafeInteger(length) || length < 0) throw new Error('Invalid archive entry length');
        const fullName = prefix ? `${prefix}/${name}` : name;
        current = { name: fullName, size: length, remaining: length, sha: createHash('sha256'), offset, capture: fullName.endsWith('/config.json') && fullName.split('/').length === 2 ? [] : null };
        if (current.capture && length > 8 * 1024 * 1024) throw new Error('Archive configuration exceeds 8MiB fixture bound');
        header = Buffer.alloc(0);
      }
      const size = Math.min(current.remaining, chunk.length - cursor), data = chunk.subarray(cursor, cursor + size);
      current.sha.update(data); if (current.capture) current.capture.push(Buffer.from(data));
      cursor += size; offset += size; current.remaining -= size;
      if (current.remaining === 0) {
        files.push({ name: current.name, size: current.size, sha256: current.sha.digest('hex') });
        if (current.capture) { config = JSON.parse(Buffer.concat(current.capture)); configOffset = current.offset; }
        padding = (512 - current.size % 512) % 512; current = null;
      }
    }
  }
  const after = await stat(path);
  if (!ended || current || padding || before.size !== after.size || before.mtimeMs !== after.mtimeMs) throw new Error('Incomplete or concurrently changed export artifact');
  return { raw_artifact: { path, byte_length: before.size, sha256: compressedHash.digest('hex') }, files, config, config_offset: configOffset, uncompressed_bytes: offset, credential_counts: counts };
}

export async function corruptArchive(source, destination, targetOffset) {
  if (!Number.isSafeInteger(targetOffset) || targetOffset < 512) throw new Error('No actual archive configuration offset to corrupt');
  let offset = 0, changed = false;
  const mutation = new Transform({ transform(chunk, encoding, callback) {
    let output = chunk;
    if (targetOffset >= offset && targetOffset < offset + chunk.length) { output = Buffer.from(chunk); output[targetOffset - offset] ^= 1; changed = true; }
    offset += chunk.length; callback(null, output);
  } });
  await pipeline(createReadStream(source), createGunzip(), mutation, createGzip(), createWriteStream(destination, { flags: 'wx', mode: 0o600 }));
  if (!changed) throw new Error('Archive mutation offset was outside the real artifact');
}
