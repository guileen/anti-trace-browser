import { readFile, writeFile, mkdir, copyFile, cp } from 'node:fs/promises';
import { constants } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { command, exportPatch, sha256 } from './export-patch.mjs';
const here = dirname(fileURLToPath(import.meta.url));
const owned = resolve(here, '../../.local/lightpanda-cost');
const source = resolve(owned, 'source');
const renderer = resolve(owned, '../obscura-cost/source');
const phase = process.argv[2];
if (!['prepare', 'build'].includes(phase)) throw new Error('Usage: native-build.mjs prepare|build');
const run = resolve(owned, `native-${phase}-${Date.now()}`);
await mkdir(run, { recursive: true });
const env = { ...process.env, CARGO_HOME: resolve(owned, 'cargo-home'), CARGO_NET_OFFLINE: 'true', ZIG_GLOBAL_CACHE_DIR: resolve(owned, 'zig-global-cache') };
const receipts = [];
async function execute(name, program, args, cwd = source) {
  const started = performance.now();
  const result = await command(cwd, program, args, env);
  await writeFile(resolve(run, `${name}.stdout`), result.stdout);
  await writeFile(resolve(run, `${name}.stderr`), result.stderr);
  receipts.push({ name, program, args, cwd, status: result.status, signal: result.signal, elapsed_ms: performance.now() - started });
  if (result.status !== 0) throw new Error(`${name} failed; see ${run}/${name}.stderr`);
  return result.stdout;
}
const record = { schema: 1, phase, run, source_commit: 'c5f7bb29b127040c899d4e181b5709f76fc71a6f', renderer_commit: '7c751c5', commands: receipts, acceptance: 'not_tested', performance: 'not_measured' };
if (phase === 'build') {
  record.source_patch_before = await exportPatch(source, resolve(here, 'runtime.patch'), resolve(owned, 'revisions'));
  record.renderer_patch = { path: resolve(here, '../obscura/runtime-environment.patch'), sha256: sha256(await readFile(resolve(here, '../obscura/runtime-environment.patch'))) };
}
try {
  if (phase === 'prepare') {
    // Retain both old lock and binary before changing dependency resolution.
    for (const relative of ['src/rust/Cargo.lock', 'zig-out/bin/lightpanda']) {
      const bytes = await readFile(resolve(source, relative));
      const revision = resolve(owned, 'revisions', sha256(bytes));
      await mkdir(revision, { recursive: true });
      await writeFile(resolve(revision, relative.endsWith('lock') ? 'Cargo.lock' : 'lightpanda'), bytes, { flag: 'wx', mode: relative.endsWith('lock') ? 0o644 : 0o755 }).catch(error => { if (error.code !== 'EEXIST') throw error; });
    }
    // Merge only source/index/archive caches; never borrow another runtime's objects.
    const cargo = resolve(process.env.HOME, '.cargo/registry');
    for (const directory of ['cache', 'src', 'index']) {
      await cp(resolve(cargo, directory), resolve(owned, 'cargo-home/registry', directory), { recursive: true, force: false, errorOnExist: false });
    }
    await execute('resolve-native-dependencies', 'cargo', ['generate-lockfile', '--offline', '--manifest-path', 'src/rust/ffi/Cargo.toml']);
    const metadata = JSON.parse(await execute('dependency-metadata', 'cargo', ['metadata', '--locked', '--offline', '--format-version', '1', '--manifest-path', 'src/rust/ffi/Cargo.toml']));
    record.dependencies = metadata.packages.map(p => ({ name: p.name, version: p.version, license: p.license, license_file: p.license_file, source: p.source, manifest_path: p.manifest_path })).sort((a, b) => `${a.name}@${a.version}`.localeCompare(`${b.name}@${b.version}`));
    record.renderer_manifest_sha256 = sha256(await readFile(resolve(renderer, 'Cargo.toml')));
  } else {
    const binary = resolve(source, 'zig-out/bin/lightpanda');
    const old = await readFile(binary);
    const revision = resolve(owned, 'revisions', sha256(old));
    await mkdir(revision, { recursive: true });
    await copyFile(binary, resolve(revision, 'lightpanda'), constants.COPYFILE_EXCL).catch(error => { if (error.code !== 'EEXIST') throw error; });
    await execute('native-build', 'zig', ['build', '-Doptimize=fast', '-j4']);
    const bytes = await readFile(binary);
    record.binary = { path: binary, bytes: bytes.length, sha256: sha256(bytes) };
    // Compilation is not a component smoke, and is never product acceptance.
    record.compilation = 'completed';
  }
  record.patch = await exportPatch(source, resolve(here, 'runtime.patch'), resolve(owned, 'revisions'));
  if (phase === 'build' && (record.source_patch_before.sha256 !== record.patch.sha256 || record.renderer_patch.sha256 !== sha256(await readFile(record.renderer_patch.path)))) throw new Error('Build inputs changed during compilation; artifact requires a new source-bound build.');
  if (phase === 'build') {
    const root = resolve(here, '../../../..');
    const relative = path => path.slice(root.length + 1);
    await writeFile(resolve(here, 'current-build.json'), JSON.stringify({ schema: 1, runtime: 'lightpanda', source_commit: record.source_commit, artifact: record.binary, patch: { path: 'browsers/engine-bench/candidates/lightpanda/runtime.patch', sha256: record.patch.sha256 }, renderer_patch: { path: relative(record.renderer_patch.path), sha256: record.renderer_patch.sha256 }, build_receipt: relative(resolve(run, 'receipt.json')), qualification: 'Successful compilation with unchanged source inputs; functionality and release acceptance are separate.' }, null, 2) + '\n');
  }
} finally {
  await writeFile(resolve(run, 'receipt.json'), `${JSON.stringify(record, null, 2)}\n`);
  console.log(JSON.stringify({ receipt: resolve(run, 'receipt.json'), phase }));
}
