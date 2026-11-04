#!/usr/bin/env python3
"""Behavioural acceptance for anti-trace.

Encodes the product invariants that matter:

1. one environment keeps the same observable identity across restarts
2. two environments of one runtime present different device identity
3. every local coherence check passes
4. concurrent starts never leave two engines on one environment
5. a dead proxy fails closed at create time
6. an exported environment restores with the same identity digest

Run: uv run --project . python tests/acceptance.py [--home DIR]
"""

from __future__ import annotations

import argparse
import json
import os
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
BIN = ROOT / "bin" / "anti-trace"

PROBE = """(async () => {
  const fnv = (a) => { let h = 0x811c9dc5; for (let i = 0; i < a.length; i++) { h ^= a[i]; h = Math.imul(h, 0x01000193) >>> 0; } return h; };
  const render = (text) => {
    const c = document.createElement('canvas'); c.width = 240; c.height = 60;
    const x = c.getContext('2d');
    x.fillStyle = '#f60'; x.fillRect(10, 10, 100, 30);
    x.beginPath(); x.arc(170, 30, 20, 0, Math.PI * 2); x.fillStyle = '#069'; x.fill();
    if (text) { x.font = '18px sans-serif'; x.fillStyle = '#000'; x.fillText('Cwm fjord \\u4f60\\u597d \\ud83d\\ude00', 5, 50); }
    return fnv(x.getImageData(0, 0, 240, 60).data);
  };
  const gl = document.createElement('canvas').getContext('webgl');
  const ext = gl && gl.getExtension('WEBGL_debug_renderer_info');
  let audio = null;
  try {
    const ctx = new OfflineAudioContext(1, 44100, 44100);
    const osc = ctx.createOscillator(); osc.type = 'triangle'; osc.frequency.value = 440;
    osc.connect(ctx.destination); osc.start(0);
    const buf = await ctx.startRendering();
    const d = new Float32Array(buf.length); buf.copyFromChannel(d, 0);
    let s = 0; for (let i = 0; i < d.length; i++) s += d[i] * d[i];
    audio = Math.round(Math.sqrt(s / d.length) * 1e6);
  } catch (e) { audio = 'unsupported'; }
  return {
    geo: render(false), text: render(true),
    gpu: ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : null,
    screen: [screen.width, screen.height], dpr: devicePixelRatio,
    cores: navigator.hardwareConcurrency, lang: navigator.language,
    tz: Intl.DateTimeFormat().resolvedOptions().timeZone, audio,
  };
})()"""

STABLE_FIELDS = ("geo", "text", "gpu", "screen", "dpr", "cores", "lang", "tz", "audio")
DISTINCT_FIELDS = ("screen", "cores", "text")


class Failure(AssertionError):
    pass


def call(env: dict[str, str], *args: str, timeout: int = 300) -> subprocess.CompletedProcess:
    return subprocess.run([str(BIN), *args], env=env, capture_output=True, text=True, timeout=timeout)


def call_json(env: dict[str, str], *args: str, timeout: int = 300) -> dict:
    result = call(env, *args, timeout=timeout)
    if result.returncode != 0:
        raise Failure(f"{' '.join(args)} failed ({result.returncode}):\n{result.stdout}\n{result.stderr}")
    try:
        return json.loads(result.stdout)
    except ValueError as exc:
        raise Failure(f"{' '.join(args)} printed no JSON:\n{result.stdout}\n{result.stderr}") from exc


def probe(env: dict[str, str], name: str) -> dict:
    call_json(env, "exec", name, "goto", "https://example.com/", "--json", timeout=120)
    return call_json(env, "exec", name, "eval", PROBE, "--json", timeout=180)["result"]


def cycle(env: dict[str, str], name: str) -> dict:
    call_json(env, "start", name, "--headless", "--url", "https://example.com/", "--json")
    data = probe(env, name)
    data["audit"] = call_json(env, "audit", name, "--local", "--json")
    call_json(env, "stop", name, "--json", timeout=120)
    return data


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--home", default=None, help="store directory (default: temporary)")
    args = parser.parse_args()
    home = Path(args.home or tempfile.mkdtemp(prefix="anti-trace-accept-"))
    env = dict(os.environ, ANTI_TRACE_HOME=str(home))
    failures: list[str] = []

    def check(condition: bool, message: str) -> None:
        print(("  pass  " if condition else "  FAIL  ") + message)
        if not condition:
            failures.append(message)

    if call(env, "doctor", "--json").returncode != 0:
        print("[skip] installation is incomplete; run 'anti-trace setup' first")
        return 2

    print(f"store: {home}")
    for name, extra in (("envA", []), ("envB", ["--fonts", "subset:24"])):
        if not (home / "profiles" / name).is_dir():
            call_json(env, "create", name, *extra, "--json", timeout=300)

    print("[1] restarts keep the identity")
    runs = {name: [cycle(env, name), cycle(env, name)] for name in ("envA", "envB")}
    for name, pair in runs.items():
        drift = [field for field in STABLE_FIELDS if pair[0][field] != pair[1][field]]
        check(not drift, f"{name} stable across restarts ({'drift: ' + ', '.join(drift) if drift else 'all fields equal'})")

    print("[2] environments present different devices")
    for field in DISTINCT_FIELDS:
        check(runs["envA"][0][field] != runs["envB"][0][field],
              f"{field} differs between envA and envB ({runs['envA'][0][field]!r} vs {runs['envB'][0][field]!r})")

    print("[3] local coherence")
    for name, pair in runs.items():
        for index, run in enumerate(pair, start=1):
            audit = run["audit"]["local"]
            check(audit["verdict"] == "pass", f"{name} run{index} audit pass ({audit['failures'] or 'no failures'})")

    print("[4] one engine per environment under concurrent starts")
    call_json(env, "stop", "envA", "--json")
    procs = [
        subprocess.Popen([str(BIN), "start", "envA", "--headless", "--json"], env=env,
                         stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        for _ in range(3)
    ]
    statuses = []
    for proc in procs:
        out, err = proc.communicate(timeout=300)
        statuses.append(out.strip() or err.strip())
        assert proc.returncode == 0, f"concurrent start failed: {out} {err}"
    listing = subprocess.run(["ps", "-Ao", "pid=,command="], capture_output=True, text=True).stdout
    engines = [line for line in listing.splitlines() if "anti_trace.engine --profile envA" in line]
    check(len(engines) == 1, f"exactly one engine after 3 concurrent starts (found {len(engines)})")
    check(any("already_running" in item or '"ok"' in item for item in statuses), "callers report a start result")
    call_json(env, "stop", "envA", "--json")

    print("[5] a dead proxy fails closed")
    dead = call(env, "create", "dead", "--proxy", "socks5://127.0.0.1:1", "--json", timeout=120)
    check(dead.returncode != 0, "create refuses an unreachable proxy")
    check(not (home / "profiles" / "dead").exists(), "no half-created environment is left behind")
    socks = call(env, "create", "socks", "--proxy", "socks5://user:pass@127.0.0.1:1080", "--json", timeout=60)
    check(socks.returncode != 0 and "SOCKS credentials" in socks.stderr, "SOCKS credentials are rejected with a reason")

    print("[6] export and import keep the identity")
    archive = home / "envB.atb.tar.gz"
    call_json(env, "export", "envB", str(archive), "--json")
    call_json(env, "import", str(archive), "--name", "envC", "--json")
    before = call_json(env, "info", "envB", "--json")["identity"]
    after = call_json(env, "info", "envC", "--json")["identity"]
    check(before["digest"] == after["digest"] and before["screen"] == after["screen"],
          f"restored identity matches ({before['digest']} == {after['digest']})")
    call_json(env, "rm", "envC", "--json")

    for name in ("envA", "envB"):
        subprocess.run([str(BIN), "stop", name, "--json"], env=env, capture_output=True, text=True, timeout=120)

    print()
    if failures:
        print(f"FAILED: {len(failures)} check(s)")
        for item in failures:
            print(f"  - {item}")
        return 1
    print("PASS: all acceptance checks")
    if args.home is None:
        shutil.rmtree(home, ignore_errors=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
