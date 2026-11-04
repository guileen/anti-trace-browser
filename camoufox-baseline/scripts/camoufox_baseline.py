#!/usr/bin/env python3
"""Bounded, process-isolated Camoufox audit and synthetic profile lifecycle test."""
from __future__ import annotations

import argparse
import asyncio
from contextlib import contextmanager
from datetime import datetime, timezone
import fcntl
import importlib.metadata
import json
import os
from pathlib import Path
import signal
import statistics
import subprocess
import sys
import tempfile
import threading
import time
import traceback
from urllib.parse import urlsplit, quote
from urllib.request import urlopen
import uuid

import psutil
from setup_camoufox import ROOT, RUNTIME, isolated_environment

PREFS = {
    "permissions.default.camera": 2,
    "permissions.default.microphone": 2,
    "permissions.default.geo": 2,
    "permissions.default.desktop-notification": 2,
    "dom.webnotifications.enabled": False,
}

STATE_JS = """async ({token, write}) => {
  const key = 'anti_trace_synthetic_' + token;
  const expected = 'synthetic-' + token;
  const db = await new Promise((resolve, reject) => {
    const request = indexedDB.open('anti_trace_runner_' + token, 1);
    request.onupgradeneeded = () => request.result.createObjectStore('markers');
    request.onerror = () => reject(request.error);
    request.onblocked = () => reject(new Error('IndexedDB open blocked'));
    request.onsuccess = () => resolve(request.result);
  });
  try {
    if (write) {
      document.cookie = key + '=' + expected + '; Path=/; Max-Age=86400; SameSite=Lax';
      localStorage.setItem(key, expected);
      await new Promise((resolve, reject) => {
        const tx = db.transaction('markers', 'readwrite', {durability:'strict'});
        tx.objectStore('markers').put(expected, key);
        tx.oncomplete = resolve; tx.onerror = () => reject(tx.error);
        tx.onabort = () => reject(tx.error || new Error('IndexedDB transaction aborted'));
      });
    }
    const indexedDBValue = await new Promise((resolve, reject) => {
      const tx = db.transaction('markers', 'readonly');
      const req = tx.objectStore('markers').get(key);
      req.onsuccess = () => resolve(req.result === undefined ? null : req.result);
      req.onerror = () => reject(req.error);
    });
    const cookie = document.cookie.split('; ').find(x => x.startsWith(key + '='));
    return {cookie: cookie ? cookie.slice(key.length + 1) : null,
      local_storage: localStorage.getItem(key), indexed_db: indexedDBValue};
  } finally { db.close(); }
}"""


def now() -> str:
    return datetime.now(timezone.utc).isoformat()


def failure(error: BaseException) -> dict:
    return {"type": type(error).__name__, "message": str(error), "traceback": traceback.format_exc()}


def save(path: Path, value: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(path.name + f".{os.getpid()}.tmp")
    temporary.write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n")
    temporary.replace(path)


@contextmanager
def profile_lock(profile: Path):
    profile.mkdir(parents=True, exist_ok=True)
    # Keep the lock inode: unlinking it would allow concurrent locks on two inodes.
    lock = (profile / ".anti-trace.lock").open("a+")
    try:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        lock.seek(0)
        lock.truncate()
        lock.write(str(os.getpid()) + "\n")
        lock.flush()
        yield
    finally:
        fcntl.flock(lock, fcntl.LOCK_UN)
        lock.close()


class ProcessTreeSampler:
    """Sample only a freshly spawned worker and its owned descendants."""
    def __init__(self, pid: int, interval: float):
        self.root = psutil.Process(pid)
        self.interval = interval
        self.stop_event = threading.Event()
        self.known = {}
        self.cpu = {}
        self.samples = []
        self.errors = []
        self.thread = threading.Thread(target=self.run, daemon=True)

    def sample(self):
        try:
            processes = [self.root] + self.root.children(recursive=True)
        except psutil.Error:
            processes = list(self.known.values())
        rss = 0
        browser_rss = 0
        live = 0
        for process in processes:
            try:
                identity = (process.pid, process.create_time())
                self.known[identity] = process
                with process.oneshot():
                    memory = process.memory_info().rss
                    cpu = process.cpu_times()
                    name = process.name()
                self.cpu[identity] = max(self.cpu.get(identity, 0), cpu.user + cpu.system)
                rss += memory
                if 'camoufox' in name.lower() or 'plugin-container' in name.lower():
                    browser_rss += memory
                live += 1
            except psutil.NoSuchProcess:
                pass
            except psutil.AccessDenied as error:
                self.errors.append({"pid": process.pid, "error": str(error)})
        self.samples.append({"monotonic_s": time.monotonic(), "rss_bytes": rss,
                             "browser_rss_bytes": browser_rss, "live_processes": live})

    def run(self):
        while not self.stop_event.is_set():
            self.sample()
            self.stop_event.wait(self.interval)
        self.sample()

    def finish(self):
        self.stop_event.set()
        self.thread.join(timeout=5)
        duration = self.samples[-1]['monotonic_s'] - self.samples[0]['monotonic_s'] if len(self.samples) > 1 else 0
        cpu = sum(self.cpu.values())
        return {"scope": "fresh Python worker + Playwright driver + entire observed browser descendant tree; excludes supervisor and HTTP server",
                "sample_interval_ms": self.interval * 1000,
                "rss_semantics": "sum live process RSS; shared pages counted per process, not PSS; transient processes between samples may be missed",
                "cpu_semantics": "sum max observed (user+system) lifetime CPU seconds per (pid, creation time), no child-time double-counting; final unsampled exit CPU may be missed",
                "cpu_seconds": cpu, "cpu_percent_one_core": cpu / duration * 100 if duration else None,
                "wall_seconds": duration, "peak_tree_rss_bytes": max((x['rss_bytes'] for x in self.samples), default=0),
                "peak_browser_rss_bytes": max((x['browser_rss_bytes'] for x in self.samples), default=0),
                "observed_processes": len(self.known), "access_errors": self.errors,
                "samples": self.samples}

    def cleanup(self):
        """Terminate only processes actually created under this runner's worker."""
        self.sample()
        survivors = []
        for identity, process in self.known.items():
            try:
                if process.is_running() and process.create_time() == identity[1] and process.status() != psutil.STATUS_ZOMBIE:
                    survivors.append(process)
                    process.terminate()
            except psutil.Error:
                pass
        _, alive = psutil.wait_procs(survivors, timeout=3)
        for process in alive:
            try:
                process.kill()
            except psutil.Error:
                pass
        _, alive = psutil.wait_procs(alive, timeout=3)
        return [p.pid for p in alive]


async def worker(args) -> int:
    outcome = {"status": "error", "started_at": now(), "phase": "import"}
    manager = None
    context = None
    try:
        from camoufox.async_api import AsyncCamoufox
        from camoufox.pkgman import camoufox_path, launch_path
        installed = camoufox_path(download_if_missing=False)
        setup = json.loads((RUNTIME / "setup.json").read_text())
        if setup.get('status') != 'ready':
            raise RuntimeError('Run uv run python scripts/setup_camoufox.py first')
        outcome['versions'] = {n: importlib.metadata.version(n) for n in ('camoufox', 'playwright', 'psutil', 'fpgen')}
        outcome['browser_install'] = json.loads((installed / 'version.json').read_text())
        outcome['executable'] = launch_path(installed)
        options = {"persistent_context": True, "user_data_dir": str(Path(args.profile).resolve()),
                   "headless": args.headless, "os": "macos" if sys.platform == "darwin" else "linux",
                   "main_world_eval": True, "firefox_user_prefs": PREFS,
                   "timeout": args.launch_timeout * 1000}
        outcome['launch_options'] = options
        outcome['phase'] = 'launch'
        manager = AsyncCamoufox(**options)
        started = time.perf_counter()
        context = await asyncio.wait_for(manager.__aenter__(), timeout=args.launch_timeout + 15)
        outcome['cold_startup_ms'] = (time.perf_counter() - started) * 1000
        outcome['startup_semantics'] = 'fresh browser process/context launch including wrapper identity generation; OS disk cache is not flushed; profile may be warm; Python import excluded'
        context.set_default_timeout(args.navigation_timeout * 1000)
        context.set_default_navigation_timeout(args.navigation_timeout * 1000)
        outcome['browser_version'] = context.browser.version if context.browser else None
        page = context.pages[0] if context.pages else await context.new_page()
        events = []
        page.on('pageerror', lambda error: events.append({'type': 'pageerror', 'message': str(error)}))
        page.on('console', lambda message: events.append({'type': 'console', 'level': message.type, 'text': message.text}) if message.type == 'error' else None)
        outcome['page_errors'] = events
        outcome['phase'] = 'navigation'
        navigation_started = time.perf_counter()
        response = await page.goto(args.url, wait_until='domcontentloaded')
        outcome['navigation_ms'] = (time.perf_counter() - navigation_started) * 1000
        outcome['http_status'] = response.status if response else None
        if not response or not response.ok:
            raise RuntimeError(f'Audit navigation failed: {outcome["http_status"]}')
        if args.mode == 'audit':
            outcome['phase'] = 'audit'
            started = time.perf_counter()
            report = await asyncio.wait_for(page.evaluate('mw:window.runAudit()'), timeout=args.audit_timeout)
            outcome['audit_ms'] = (time.perf_counter() - started) * 1000
            outcome['navigation_audit_ms'] = (time.perf_counter() - navigation_started) * 1000
            outcome['server_report'] = report
            if not isinstance(report, dict) or not all(k in report for k in ('id', 'scores', 'coverage', 'observations')):
                raise RuntimeError('window.runAudit() did not return a complete server-scored report')
            for axis in ('privacy', 'automation', 'functionality', 'performance'):
                if not isinstance(report['scores'].get(axis), dict):
                    raise RuntimeError(f'Server report lacks {axis} scoring axis')
            with urlopen(args.url.rstrip('/') + '/api/reports/' + quote(report['id'], safe=''), timeout=15) as remote:
                persisted = json.load(remote)
            outcome['server_persistence_verified'] = persisted == report
            if persisted != report:
                raise RuntimeError('Server persisted report differs from window.runAudit()')
            outcome['phase'] = 'screenshot'
            started = time.perf_counter()
            await asyncio.wait_for(page.screenshot(path=args.screenshot, full_page=True, timeout=15000), timeout=20)
            outcome['screenshot_ms'] = (time.perf_counter() - started) * 1000
            outcome['screenshot'] = args.screenshot
            outcome['phase'] = 'synthetic_state_write'
            outcome['synthetic_state'] = await asyncio.wait_for(page.evaluate('mw:(' + STATE_JS + ')(' + json.dumps({'token': args.token, 'write': True}) + ')'), timeout=15)
            expected = 'synthetic-' + args.token
            if any(value != expected for value in outcome['synthetic_state'].values()):
                raise RuntimeError('Synthetic state readback mismatch before restart')
        elif args.mode in ('restart', 'isolation'):
            outcome['phase'] = args.mode
            state = await asyncio.wait_for(page.evaluate('mw:(' + STATE_JS + ')(' + json.dumps({'token': args.token, 'write': False}) + ')'), timeout=15)
            expected = 'synthetic-' + args.token if args.mode == 'restart' else None
            outcome['synthetic_state'] = state
            outcome['expected_state'] = {key: expected for key in ('cookie', 'local_storage', 'indexed_db')}
            outcome['verified'] = state == outcome['expected_state']
            if not outcome['verified']:
                raise RuntimeError(f'Synthetic {args.mode} state mismatch')
        elif args.mode == 'interactive':
            outcome['phase'] = 'interactive'
            print('Dedicated synthetic Camoufox profile open. Close the browser or press Ctrl-C to finish.', flush=True)
            while context.browser and context.browser.is_connected():
                await asyncio.sleep(.5)
        outcome['status'] = 'pass'
        outcome['phase'] = 'complete'
    except BaseException as error:
        outcome['error'] = failure(error)
    finally:
        if manager is not None:
            try:
                await asyncio.wait_for(manager.__aexit__(None, None, None), timeout=15)
            except BaseException as error:
                outcome['close_error'] = failure(error)
                outcome['status'] = 'error'
        outcome['finished_at'] = now()
        save(Path(args.worker_output), outcome)
    return 0 if outcome['status'] == 'pass' else 1


def run_session(args, mode: str, profile: Path, token: str, index: int, directory: Path):
    worker_output = directory / f'{mode}-{index}.json'
    screenshot_dir = Path(args.screenshot_dir).resolve()
    screenshot_dir.mkdir(parents=True, exist_ok=True)
    screenshot = screenshot_dir / (Path(args.output).stem + (f'-run-{index + 1}' if index > 0 else '') + '.png')
    command = [sys.executable, str(Path(__file__).resolve()), '--worker', '--mode', mode,
               '--worker-output', str(worker_output), '--url', args.url, '--profile', str(profile),
               '--token', token, '--screenshot', str(screenshot), '--launch-timeout', str(args.launch_timeout),
               '--navigation-timeout', str(args.navigation_timeout), '--audit-timeout', str(args.audit_timeout)]
    if args.headless:
        command.append('--headless')
    started = time.perf_counter()
    process = subprocess.Popen(command, env=isolated_environment(), stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                               text=True, start_new_session=True)
    sampler = ProcessTreeSampler(process.pid, args.sample_interval / 1000)
    sampler.thread.start()
    timed_out = False
    stdout = stderr = ''
    interrupted = False
    try:
        timeout = None if mode == 'interactive' else args.launch_timeout + args.navigation_timeout + args.audit_timeout + 90
        stdout, stderr = process.communicate(timeout=timeout)
    except (subprocess.TimeoutExpired, KeyboardInterrupt) as error:
        timed_out = isinstance(error, subprocess.TimeoutExpired)
        interrupted = isinstance(error, KeyboardInterrupt)
        # The worker owns a separate process group; no user browser is in it.
        os.killpg(process.pid, signal.SIGTERM)
        try:
            stdout, stderr = process.communicate(timeout=10)
        except subprocess.TimeoutExpired:
            os.killpg(process.pid, signal.SIGKILL)
            stdout, stderr = process.communicate(timeout=5)
    finally:
        resources = sampler.finish()
        remaining = sampler.cleanup()
    log_dir = ROOT / '.local' / 'logs'
    log_dir.mkdir(parents=True, exist_ok=True)
    log_base = log_dir / f'camoufox-{token}-{mode}-{index + 1}'
    stdout_path = log_base.with_suffix('.stdout.log')
    stderr_path = log_base.with_suffix('.stderr.log')
    stdout_path.write_text(stdout)
    stderr_path.write_text(stderr)
    if worker_output.exists():
        result = json.loads(worker_output.read_text())
    else:
        result = {'status': 'error', 'error': {'type': 'MissingWorkerResult', 'message': 'Worker exited without a result artifact'}}
    result.update(exit_code=process.returncode, timed_out=timed_out, interrupted=interrupted,
                  session_wall_ms=(time.perf_counter() - started) * 1000, resources=resources,
                  stdout=stdout, stderr=stderr, stdout_log=str(stdout_path), stderr_log=str(stderr_path),
                  remaining_owned_pids=remaining, command=command)
    if timed_out or remaining or (process.returncode != 0 and not (mode == 'interactive' and interrupted)):
        result['status'] = 'error'
    return result


def main(args) -> int:
    output = Path(args.output).resolve()
    profile = Path(args.profile).resolve()
    output.parent.mkdir(parents=True, exist_ok=True)
    token = uuid.uuid4().hex
    report = {'schema_version': 1, 'engine': 'camoufox', 'status': 'error', 'started_at': now(),
              'url': args.url, 'profile': str(profile), 'requested_runs': args.runs,
              'headless': args.headless, 'samples': [],
              'safety': {'synthetic_accounts_only': True, 'permission_policy': 'camera/microphone/geolocation/notifications denied through native Firefox preferences; no requests granted', 'firefox_user_prefs': PREFS},
              'limitations': ['OS page cache not flushed: cold means process-cold, not machine-cold.',
                              'Resource sampling can miss short-lived processes and final CPU increments.',
                              'RSS sums include shared pages multiple times; this is not PSS.',
                              'Profile persistence/isolation checks are local synthetic state, not cross-site unlinkability.',
                              'Default Camoufox fingerprint generation may rotate identity across launches; persistent storage is measured separately.',
                              'No external challenge, production account, IP/DNS/TLS or real-world anonymity claim.']}
    try:
        parsed = urlsplit(args.url)
        if parsed.scheme not in ('http', 'https') or parsed.path not in ('', '/') or parsed.query or parsed.fragment:
            raise ValueError('--url must be an HTTP(S) origin with no path/query/fragment')
        report['setup'] = json.loads((RUNTIME / 'setup.json').read_text())
        if report['setup'].get('status') != 'ready':
            raise RuntimeError('Camoufox setup not ready; run uv run python scripts/setup_camoufox.py')
        with profile_lock(profile), tempfile.TemporaryDirectory(prefix='camoufox-work-', dir=output.parent) as directory_name:
            directory = Path(directory_name)
            if args.interactive:
                report['interactive'] = run_session(args, 'interactive', profile, token, 0, directory)
                report['status'] = report['interactive']['status']
            else:
                with urlopen(args.url.rstrip('/') + '/health', timeout=10) as response:
                    report['service_health'] = json.load(response)
                if report['service_health'].get('ok') is not True:
                    raise RuntimeError('Audit service /health did not return ok:true')
                for index in range(args.runs):
                    result = run_session(args, 'audit', profile, token, index, directory)
                    report['samples'].append(result)
                    save(output, report)
                if any(s.get('synthetic_state') for s in report['samples']):
                    report['restart'] = run_session(args, 'restart', profile, token, 0, directory)
                    isolation = profile.parent / ('camoufox-isolation-' + token)
                    report['isolation_profile'] = str(isolation)
                    with profile_lock(isolation):
                        report['isolation'] = run_session(args, 'isolation', isolation, token, 0, directory)
                else:
                    report['restart'] = {'status': 'not_tested', 'reason': 'No sample persisted a synthetic marker'}
                    report['isolation'] = {'status': 'not_tested', 'reason': 'No sample persisted a synthetic marker'}
                success = [s for s in report['samples'] if s['status'] == 'pass']
                report['summary'] = {'successful_runs': len(success), 'requested_runs': args.runs,
                                     'median_basis': 'successful samples only; failures retained and baseline marked unusable if any failed',
                                     'repeat_samples_sufficient': len(success) >= 3}
                for name in ('cold_startup_ms', 'navigation_ms', 'audit_ms', 'navigation_audit_ms', 'session_wall_ms'):
                    values = [s[name] for s in success if name in s]
                    report['summary']['median_' + name] = statistics.median(values) if values else None
                for name in ('peak_tree_rss_bytes', 'peak_browser_rss_bytes', 'cpu_seconds', 'cpu_percent_one_core'):
                    values = [s['resources'][name] for s in success if s['resources'][name] is not None]
                    report['summary']['median_' + name] = statistics.median(values) if values else None
                report['status'] = 'pass' if len(success) == args.runs and all(report[k]['status'] == 'pass' for k in ('restart', 'isolation')) else 'error'
    except BaseException as error:
        report['error'] = failure(error)
    report['finished_at'] = now()
    save(output, report)
    print(json.dumps({'status': report['status'], 'output': str(output), 'summary': report.get('summary'), 'error': report.get('error')}, ensure_ascii=False, indent=2))
    return 0 if report['status'] == 'pass' else 1


def parse_args():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--url', default='http://127.0.0.1:8765')
    parser.add_argument('--output', default=str(ROOT / '.local/reports/benchmarks/camoufox.json'))
    parser.add_argument('--profile', default=str(ROOT / '.local/profiles/camoufox'))
    parser.add_argument('--screenshot-dir', default=str(ROOT / '.local/screenshots'))
    parser.add_argument('--headless', action='store_true')
    parser.add_argument('--runs', type=int, default=3)
    parser.add_argument('--interactive', action='store_true', help='Open only the dedicated persistent profile; close the window or Ctrl-C to exit; no audit/persistence run')
    parser.add_argument('--launch-timeout', type=float, default=60)
    parser.add_argument('--navigation-timeout', type=float, default=30)
    parser.add_argument('--audit-timeout', type=float, default=120)
    parser.add_argument('--sample-interval', type=float, default=100, help='Process-tree sampling interval in milliseconds')
    parser.add_argument('--worker', action='store_true', help=argparse.SUPPRESS)
    parser.add_argument('--mode', choices=('audit', 'restart', 'isolation', 'interactive'), default='audit', help=argparse.SUPPRESS)
    parser.add_argument('--worker-output', help=argparse.SUPPRESS)
    parser.add_argument('--token', help=argparse.SUPPRESS)
    parser.add_argument('--screenshot', help=argparse.SUPPRESS)
    args = parser.parse_args()
    if args.runs < 1 or args.runs > 30:
        parser.error('--runs must be between 1 and 30 (use >=3 for useful medians)')
    if any(not 0 < value <= 600 for value in (args.launch_timeout, args.navigation_timeout, args.audit_timeout)):
        parser.error('timeouts must be >0 and <=600 seconds')
    if not 20 <= args.sample_interval <= 1000:
        parser.error('--sample-interval must be 20..1000 milliseconds')
    return args


if __name__ == '__main__':
    arguments = parse_args()
    raise SystemExit(asyncio.run(worker(arguments)) if arguments.worker else main(arguments))
