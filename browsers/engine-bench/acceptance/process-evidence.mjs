import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readdir, lstat } from 'node:fs/promises';
import { join } from 'node:path';
const exec = promisify(execFile), wait = ms => new Promise(resolve => setTimeout(resolve, ms));
export const PS_ENV = Object.freeze({ ...process.env, LANG: 'C', LC_ALL: 'C', TZ: 'UTC' });
export function parseProcesses(text) {
  return text.split('\n').flatMap(raw => {
    const m = raw.trim().match(/^(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(.{24})\s+(.+)$/);
    if (!m) return [];
    const born = Date.parse(m[5] + ' UTC') / 1000;
    return Number.isFinite(born) ? [{ pid: Number(m[1]), ppid: Number(m[2]), group: Number(m[3]), state: m[4], born, command: m[6], raw }] : [];
  });
}
const identity = (a, b) => a.pid === b.pid && a.born === b.born;
const same = (a, b) => identity(a, b) && a.command === b.command;
export const live = row => !row.state.includes('Z') && !row.state.includes('X');
async function ps(ids) {
  if (!ids.length) return '';
  try { return (await exec('ps', ['-ww', '-p', ids.join(','), '-o', 'pid=', '-o', 'ppid=', '-o', 'pgid=', '-o', 'stat=', '-o', 'lstart=', '-o', 'command='], { env: PS_ENV })).stdout; }
  catch (error) { if (error.code === 1) return error.stdout || ''; throw error; }
}
export async function initialChildren(ownerPID, ownerBorn) {
  const topology = (await exec('ps', ['-axo', 'pid=', '-o', 'ppid='], { env: PS_ENV })).stdout.split('\n').map(line => line.trim().split(/\s+/).map(Number));
  const ids = new Set([ownerPID]); let changed = true;
  while (changed) { changed = false; for (const [pid, parent] of topology) if (ids.has(parent) && !ids.has(pid)) { ids.add(pid); changed = true; } }
  const rows = parseProcesses(await ps([...ids])), owner = rows.find(row => row.pid === ownerPID);
  if (!owner || !live(owner) || !Number.isFinite(ownerBorn) || Math.abs(owner.born - ownerBorn) > 1.5) throw new Error('Owned manager changed during child discovery');
  const verified = new Set([ownerPID]); changed = true;
  while (changed) { changed = false; for (const row of rows) if (row.born >= owner.born && verified.has(row.ppid) && !verified.has(row.pid)) { verified.add(row.pid); changed = true; } }
  return rows.filter(row => row.pid !== ownerPID && verified.has(row.pid));
}
const probeSource = `import os,sys,json,fcntl\np=sys.argv[1]\ntry:\n f=os.open(p,os.O_RDWR)\n s=os.fstat(f)\n try:\n  fcntl.flock(f,fcntl.LOCK_EX|fcntl.LOCK_NB)\n  state='acquired'\n  fcntl.flock(f,fcntl.LOCK_UN)\n except BlockingIOError:\n  state='busy'\n os.close(f)\n print(json.dumps({'state':state,'device':s.st_dev,'inode':s.st_ino}))\nexcept Exception as e:\n print(json.dumps({'state':'error','error':str(e)}))\n sys.exit(1)\n`;
async function lease(path) {
  try { const result = await exec('python3', ['-c', probeSource, path]); return { command: ['python3', '-c', probeSource, path], exit_code: 0, stdout: result.stdout, stderr: result.stderr }; }
  catch (error) { return { command: ['python3', '-c', probeSource, path], exit_code: error.code ?? null, stdout: error.stdout ?? '', stderr: error.stderr ?? error.message }; }
}
async function files(path) {
  const entries = await readdir(path, { recursive: true }), output = [];
  for (const name of entries.sort()) { const s = await lstat(join(path, name)); if (!s.isDirectory()) output.push({ path: name, size: s.size, mtime_ms: s.mtimeMs, inode: s.ino, kind: s.isSymbolicLink() ? 'symlink' : 'file' }); }
  return output;
}
// SIGKILL is sent by the caller to the verified manager PID ALONE. This observes
// the original children without signalling them until the drain deadline fails.
export async function observeDrain(children, dataPath, lockPath, milliseconds = 10000) {
  const samples = [], deadline = Date.now() + milliseconds;
  const observed = async () => parseProcesses(await ps(children.map(row => row.pid))).filter(row => children.some(original => identity(original, row)));
  while (Date.now() <= deadline) {
    const before = await observed(), probe = await lease(lockPath), after = await observed();
    samples.push({ observed_at: new Date().toISOString(), before: before.map(row => row.raw), lease: probe, after: after.map(row => row.raw) });
    if (!after.some(live)) break;
    await wait(50);
  }
  const remaining = await observed(), cleanup = [];
  // Cleanup never turns a failed drain into a pass. Only the very same original
  // PID/birthtime/command tuple may be signalled; no group or foreign PID kill.
  for (const row of remaining.filter(row => live(row) && children.some(original => same(original, row)))) {
    const current = parseProcesses(await ps([row.pid])).find(value => same(value, row));
    if (current) { process.kill(current.pid, 'SIGKILL'); cleanup.push({ pid: current.pid, born: current.born, command: current.command, signal: 'SIGKILL' }); }
  }
  const first = await files(dataPath); await wait(250); const second = await files(dataPath);
  return { deadline_ms: milliseconds, children_before: children.map(row => row.raw), samples, remaining_before_cleanup: remaining.map(row => row.raw), cleanup, data_snapshots: [first, second], lease_after: await lease(lockPath) };
}
export function drainValid(receipt) {
  const children = parseProcesses((receipt?.children_before ?? []).join('\n'));
  if (!children.length || !receipt.samples?.length || receipt.cleanup?.length || parseProcesses((receipt.remaining_before_cleanup ?? []).join('\n')).some(live)) return false;
  let inode;
  for (const sample of receipt.samples) {
    const before = parseProcesses(sample.before.join('\n')), after = parseProcesses(sample.after.join('\n'));
    let probe; try { probe = JSON.parse(sample.lease.stdout); } catch { return false; }
    if (sample.lease.exit_code !== 0 || !['busy','acquired'].includes(probe.state) || !Number.isInteger(probe.inode)) return false;
    if (inode !== undefined && inode !== probe.inode) return false; inode = probe.inode;
    if (before.some(a => live(a) && after.some(b => live(b) && identity(a, b))) && probe.state !== 'busy') return false;
    if ([...before, ...after].some(row => !children.some(original => identity(original, row)))) return false;
  }
  let final; try { final = JSON.parse(receipt.lease_after.stdout); } catch { return false; }
  return receipt.lease_after.exit_code === 0 && final.state === 'acquired' && final.inode === inode && Array.isArray(receipt.data_snapshots) && receipt.data_snapshots.length === 2 && JSON.stringify(receipt.data_snapshots[0]) === JSON.stringify(receipt.data_snapshots[1]);
}
