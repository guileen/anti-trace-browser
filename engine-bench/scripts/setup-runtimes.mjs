import { mkdir, readFile, writeFile, chmod, readdir, stat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { resolve, join, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const runtimeRoot = join(root, '.local', 'runtimes');
export const releases = [
  { id: 'lightpanda', version: '1.0.2', repo: 'lightpanda-io/browser', tag: '1.0.2', asset: 'lightpanda-aarch64-macos', sha256: '9f3ee749a55d1abc5f8fdda0d9559c3b2abcec5bff5bfe902bc06c0a89538ec4', executable: 'lightpanda', archive: false },
  { id: 'obscura', version: '0.2.6', repo: 'h4ckf0r0day/obscura', tag: 'v0.2.6', asset: 'obscura-aarch64-macos-stealth.tar.gz', sha256: '01a29bb9eb3a7eda89c036db187bbdd9a01b76d3d8e4860117c00fc881ac40bf', executable: 'obscura', archive: true },
  { id: 'moli', version: '1.1.21', repo: 'lexmount/moli', tag: 'v1.1.21', asset: 'moli-aarch64-apple-darwin.tar.gz', sha256: 'ecf15b7e56e576bf69e5fcfc1069e025a0734d58dd660cd4c0830c1e6e8177c5', executable: 'moli', archive: true },
];
export const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
async function findExecutable(dir, name) {
  for (const item of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, item.name);
    if (item.isFile() && item.name === name) return path;
    if (item.isDirectory()) { const found = await findExecutable(path, name); if (found) return found; }
  }
}
export async function installRuntime(release) {
  const dir = join(runtimeRoot, `${release.id}-${release.version}`);
  await mkdir(dir, { recursive: true });
  const url = `https://github.com/${release.repo}/releases/download/${release.tag}/${release.asset}`;
  const assetPath = join(dir, release.asset);
  let bytes;
  try { bytes = await readFile(assetPath); } catch { /* Fresh project-local download. */ }
  if (!bytes || sha256(bytes) !== release.sha256) {
    const response = await fetch(url, { signal: AbortSignal.timeout(240_000) });
    if (!response.ok) throw new Error(`Download ${response.status}: ${url}`);
    bytes = Buffer.from(await response.arrayBuffer());
    if (sha256(bytes) !== release.sha256) throw new Error(`SHA256 mismatch: ${release.id}`);
    await writeFile(assetPath, bytes);
  }
  // No downloaded byte is executed or extracted before pinned SHA-256 matches.
  if (sha256(bytes) !== release.sha256) throw new Error(`SHA256 mismatch: ${release.id}`);
  if (release.archive) {
    const listing = spawnSync('tar', ['-tzf', assetPath], { encoding: 'utf8', timeout: 30_000 });
    if (listing.status !== 0) throw new Error(listing.stderr);
    if (listing.stdout.split('\n').some(p => p.startsWith('/') || p.split('/').includes('..'))) throw new Error('Unsafe archive path');
    const extracted = spawnSync('tar', ['-xzf', assetPath, '-C', dir], { encoding: 'utf8', timeout: 60_000 });
    if (extracted.status !== 0) throw new Error(extracted.stderr);
  } else if (assetPath !== join(dir, release.executable)) {
    await writeFile(join(dir, release.executable), bytes);
  }
  const executable = await findExecutable(dir, release.executable);
  if (!executable) throw new Error(`Executable missing for ${release.id}`);
  await chmod(executable, 0o755);
  const versionArgs = release.id === 'lightpanda' ? ['version'] : ['--version'];
  const version = spawnSync(executable, versionArgs, { encoding: 'utf8', timeout: 15_000, env: { ...process.env, LIGHTPANDA_DISABLE_TELEMETRY: 'true', LIGHTPANDA_DISABLE_CORE_DUMP: '1' } });
  const help = spawnSync(executable, ['serve', '--help'], { encoding: 'utf8', timeout: 15_000 });
  const metadata = { ...release, release_version: release.version, source: url, release_metadata: `https://api.github.com/repos/${release.repo}/releases/tags/${release.tag}`, downloaded_sha256: sha256(bytes), executable, relative_executable: relative(dir, executable), executable_sha256: sha256(await readFile(executable)), executable_bytes: (await stat(executable)).size, version_command: [executable, ...versionArgs], version_probe: { status: version.status, stdout: version.stdout, stderr: version.stderr, error: version.error?.message }, serve_help: { status: help.status, stdout: help.stdout, stderr: help.stderr, error: help.error?.message } };
  await writeFile(join(dir, 'provenance.json'), JSON.stringify(metadata, null, 2));
  return metadata;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.platform !== 'darwin' || process.arch !== 'arm64') throw new Error('Pinned assets require macOS arm64');
  const requested = process.argv.length > 2 ? process.argv.slice(2) : ['lightpanda', 'obscura'];
  for (const release of releases.filter(r => requested.includes(r.id))) {
    const result = await installRuntime(release);
    console.log(JSON.stringify(result));
  }
}
