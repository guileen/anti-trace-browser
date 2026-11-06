import { spawn } from 'node:child_process';
import { readFile, writeFile, mkdir, stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
export function command(cwd, file, args, env = process.env) {
  return new Promise((resolveResult, reject) => {
    const child = spawn(file, args, { cwd, env });
    const stdout = [], stderr = [];
    child.stdout.on('data', chunk => stdout.push(chunk));
    child.stderr.on('data', chunk => stderr.push(chunk));
    child.once('error', reject);
    child.once('exit', (status, signal) => resolveResult({ status, signal, stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr) }));
  });
}
export const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
export async function exportPatch(source, destination, revisionRoot) {
  const tracked = await command(source, 'git', ['diff', '--binary', '--no-ext-diff', 'HEAD', '--']);
  if (tracked.status !== 0) throw new Error(tracked.stderr.toString());
  const untracked = await command(source, 'git', ['ls-files', '--others', '--exclude-standard', '-z', '--', 'src']);
  if (untracked.status !== 0) throw new Error(untracked.stderr.toString());
  const chunks = [tracked.stdout];
  for (const path of untracked.stdout.toString().split('\0').filter(Boolean).sort()) {
    if (!(await stat(resolve(source, path))).isFile()) throw new Error(`Non-file source patch member: ${path}`);
    const added = await command(source, 'git', ['diff', '--no-index', '--binary', '--no-ext-diff', '--', '/dev/null', path]);
    if (added.status !== 1) throw new Error(`Cannot export ${path}: ${added.stderr}`);
    chunks.push(added.stdout);
  }
  const patch = Buffer.concat(chunks);
  if (!patch.length) throw new Error('Refusing an empty implementation patch');
  const digest = sha256(patch);
  const revision = resolve(revisionRoot, digest);
  await mkdir(revision, { recursive: true });
  await writeFile(resolve(revision, 'runtime.patch'), patch, { flag: 'wx' }).catch(error => { if (error.code !== 'EEXIST') throw error; });
  let previous;
  try { previous = await readFile(destination); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (previous && !previous.equals(patch)) {
    const old = resolve(revisionRoot, sha256(previous));
    await mkdir(old, { recursive: true });
    await writeFile(resolve(old, 'runtime.patch'), previous, { flag: 'wx' }).catch(error => { if (error.code !== 'EEXIST') throw error; });
  }
  if (!previous?.equals(patch)) await writeFile(destination, patch);
  return { sha256: digest, bytes: patch.length, revision, includes_new_source_files: true };
}
