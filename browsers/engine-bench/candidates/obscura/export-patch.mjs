import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';

const candidate = import.meta.dirname;
const source = resolve(candidate, '../../.local/obscura-cost/source');
const temporary = mkdtempSync(resolve(tmpdir(), 'obscura-patch-'));
const env = { ...process.env, GIT_INDEX_FILE: resolve(temporary, 'index') };
function git(args) {
  const result = spawnSync('git', args, {cwd: source, env, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024});
  if (result.status !== 0) throw new Error(result.stderr || result.error?.message || 'git export failed');
  return result.stdout;
}
try {
  const metadataPath = resolve(candidate, 'native-schema3-preparation.json');
  const metadata = JSON.parse(readFileSync(metadataPath, 'utf8'));
  const commit = git(['rev-parse', 'HEAD']).trim();
  if (commit !== metadata.source_commit) throw new Error('Pinned source commit mismatch');
  git(['read-tree', 'HEAD']);
  git(['add', '-A', '--', '.']);
  const patch = git(['diff', '--cached', '--binary', '--full-index', 'HEAD', '--']);
  const sha256 = createHash('sha256').update(patch).digest('hex');
  const path = resolve(candidate, 'runtime-environment.patch');
  if (existsSync(path)) {
    const previous = readFileSync(path);
    const previousSha = createHash('sha256').update(previous).digest('hex');
    if (previousSha !== sha256) {
      const archives = resolve(source, '../patches');
      mkdirSync(archives, {recursive: true});
      const archive = resolve(archives, `runtime-environment-${previousSha}.patch`);
      if (!existsSync(archive)) writeFileSync(archive, previous);
    }
  }
  writeFileSync(path, patch);
  metadata.patch.sha256 = sha256;
  metadata.patch.bytes = Buffer.byteLength(patch);
  metadata.patch.includes_new_files = git(['diff', '--cached', '--name-only', '--diff-filter=A', 'HEAD', '--']).trim().split('\n').filter(Boolean);
  metadata.status = 'authenticity_source_updated_awaiting_build';
  writeFileSync(metadataPath, JSON.stringify(metadata, null, 2) + '\n');
  console.log(JSON.stringify({path, sha256, bytes: metadata.patch.bytes, status: metadata.status}));
} finally {
  rmSync(temporary, {recursive: true, force: true});
}
