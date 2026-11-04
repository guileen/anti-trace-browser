"""anti-trace: anti-tracking, anti-censorship environments with agent automation."""

from __future__ import annotations

import argparse
import json
import shlex
import os
import signal
import subprocess
import sys
import time
from pathlib import Path
from typing import Any
from urllib.parse import urlparse

from . import audit, client, field, identity, net, profile

EXEC_ARGUMENT_COUNT = {
    "goto": 1, "axtree": 0, "click": 1, "type": 2, "press": 1, "hover": 1,
    "select": 2, "scroll": 0, "wait": 0, "back": 0, "reload": 0, "screenshot": 1,
    "eval": 1, "cookies": 0, "tabs": 0, "use": 1, "tab_new": 1,
}


def table(rows: list[dict[str, Any]], columns: list[tuple[str, str]]) -> str:
    if not rows:
        return "(none)"
    widths = [max(len(header), *(len(str(row.get(key) or "-")) for row in rows)) for key, header in columns]
    head = "  ".join(header.ljust(width) for (_, header), width in zip(columns, widths))
    body = [
        "  ".join(str(row.get(key) or "-").ljust(width) for (key, _), width in zip(columns, widths))
        for row in rows
    ]
    return "\n".join([head, "-" * len(head), *body])


def log_tail(name: str, lines: int = 25) -> str:
    path = profile.log_path(name)
    if not path.is_file():
        return "(no log)"
    return "\n".join(path.read_text(encoding="utf-8", errors="replace").splitlines()[-lines:])


# --------------------------------------------------------------------------- commands


def cmd_setup(args: argparse.Namespace) -> int:
    from camoufox.pkgman import camoufox_path

    print("[setup] ensuring the Camoufox runtime is installed...")
    result = subprocess.run([sys.executable, "-m", "camoufox", "fetch"], capture_output=True, text=True)
    if result.returncode != 0:
        print(result.stdout, result.stderr, file=sys.stderr)
        return 1
    browser = camoufox_path()
    print(f"[browser] {browser}")
    if not args.skip_fonts:
        print("[setup] calibrating installed fonts (one headless run)...")
        pool = identity.font_pool(identity.host_os())
        print(f"[fonts] {len(pool)} families render on this host")
    print("[ok] setup complete")
    return 0


def cmd_create(args: argparse.Namespace) -> int:
    name = profile.sanitize(args.name)
    if profile.exists(name) and not args.force:
        print(f"[error] environment {name!r} already exists", file=sys.stderr)
        return 1

    proxy_url = args.proxy
    proxy = net.parse_proxy(proxy_url)
    try:
        egress = net.probe_egress(proxy)
    except net.NetworkError as exc:
        print(f"[error] {exc}", file=sys.stderr)
        return 1
    egress["locale"] = identity.locale_for(egress.get("country"))
    egress["probed_at"] = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())

    os_name = args.os or identity.host_os()
    font_count = 0
    if args.fonts != "host":
        font_count = int(args.fonts.split(":", 1)[1])
        if font_count < 8:
            print("[error] --fonts subset:N needs N >= 8", file=sys.stderr)
            return 1

    taken = [
        (row.get("identity") or {}).get("device")
        for row in (profile.load_config(existing) or {} for existing in _profile_names())
    ]
    device = identity.next_device(os_name, [name for name in taken if name])
    ident = identity.new_identity(os_name, cores=args.cores, font_count=font_count, device=device)
    cfg = {
        "schema": profile.SCHEMA,
        "name": name,
        "created_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "runtime": {"camoufox": _version("camoufox"), "playwright": _version("playwright")},
        "identity": ident,
        "network": {
            "proxy": proxy_url if proxy else None,
            "webrtc": args.webrtc,
            "follow_egress": bool(args.follow_egress),
            "egress": egress,
        },
        "policy": {"permissions": {"camera": "deny", "microphone": "deny", "geolocation": "deny"}},
        "automation": {"allow_main_world_eval": False},
    }
    from .engine import browser_path, build_options, decode_config

    resolved = decode_config(build_options(cfg, browser_path(), headless=True))
    ident["resolved"] = {
        key: resolved[key]
        for key in resolved
        if key.startswith("screen.")
        or key in {"navigator.hardwareConcurrency", "timezone", "timezoneOffset", "window.devicePixelRatio"}
    }
    if "screen.width" in resolved and "screen.height" in resolved:
        ident["screen"] = [resolved["screen.width"], resolved["screen.height"]]

    profile.save_config(name, cfg)
    (profile.profile_dir(name) / "data").mkdir(parents=True, exist_ok=True)

    summary = {
        "status": "ok",
        "environment": name,
        "identity_id": ident["id"],
        "os": ident["os"],
        "screen": ident["screen"],
        "cores": ident["cores"],
        "fonts": ident["fonts_mode"] + (f":{len(ident['fonts'])}" if ident.get("fonts") else ""),
        "device": ident.get("device"),
        "proxy": cfg["network"]["proxy"] or "DIRECT",
        "egress": {k: egress.get(k) for k in ("ip", "country", "city", "timezone", "locale", "source")},
        "webrtc": cfg["network"]["webrtc"],
        "store": str(profile.profile_dir(name)),
    }
    if args.json:
        print(json.dumps(summary, indent=2, ensure_ascii=False))
        return 0
    print(f"[ok]    created {name}  (identity {ident['id']})")
    print(f"[os]    {ident['os']}   {ident.get('device')}  screen {ident['screen'][0]}x{ident['screen'][1]} @{ident.get('dpr')}x   cores {ident['cores']}")
    print(f"[fonts] {summary['fonts']}")
    print(f"[net]   {summary['proxy']} -> {egress.get('ip')} {egress.get('country')}/{egress.get('city')} {egress.get('timezone')} {egress.get('locale')}")
    print(f"[path]  {summary['store']}")
    if ident.get("fonts"):
        print("[note]  font subset narrows the visible font list (canvas differs per environment, font list is narrower than a stock install)")
    if os_name != identity.host_os():
        print("[note]  foreign OS identity: canvas readback is randomised, so pixel stability is not guaranteed")
    return 0


def _profile_names() -> list[str]:
    from . import profile as profile_module

    return [row["name"] for row in profile_module.list_profiles()]


def _version(package: str) -> str:
    from importlib.metadata import version

    try:
        return version(package)
    except Exception:  # noqa: BLE001
        return "unknown"


def _wait_ready(name: str, proc: subprocess.Popen | None, timeout: float) -> dict[str, Any] | None:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        state = client.running(name)
        if state:
            try:
                client.info(name)
                return state
            except client.EngineError:
                pass
        if proc is not None and proc.poll() is not None:
            return None
        time.sleep(0.2)
    return None


def cmd_start(args: argparse.Namespace) -> int:
    name = profile.sanitize(args.name)
    profile.require(name)
    state = client.running(name)
    if state:
        payload = {"status": "already_running", "environment": name, "pid": state.get("pid"), "socket": state.get("socket")}
        print(json.dumps(payload, indent=2) if args.json else f"[info] {name} is already running (pid {state.get('pid')})\n[socket] {state.get('socket')}")
        return 0

    if args.foreground:
        return _run_foreground(name, args)

    proc: subprocess.Popen | None = None
    with profile.exclusive(name, timeout=args.timeout, kind="spawn") as owned:
        spawning = True
        if owned:
            pending = profile.load_state(name)
            if pending and pending.get("pid") and profile.pid_alive(pending["pid"]):
                spawning = False
        else:
            spawning = False

        if spawning:
            command = [sys.executable, "-m", "anti_trace.engine", "--profile", name]
            if args.headless:
                command.append("--headless")
            if args.url:
                command += ["--url", args.url]
            log = open(profile.log_path(name), "a", encoding="utf-8")
            proc = subprocess.Popen(command, stdout=log, stderr=log, start_new_session=True, cwd=str(Path.home()))
            # Hand the environment over before releasing the spawn lock: wait
            # until the child owns it (writes STARTING) or dies trying.
            handoff = time.monotonic() + 20.0
            while time.monotonic() < handoff:
                pending = profile.load_state(name)
                if pending and pending.get("pid") and profile.pid_alive(pending["pid"]):
                    break
                if proc.poll() is not None:
                    break
                time.sleep(0.05)
        else:
            state = _wait_ready(name, None, args.timeout)
            if not state:
                print(f"[error] another start is in progress for {name} and never became ready", file=sys.stderr)
                print(log_tail(name), file=sys.stderr)
                return 1

    state = _wait_ready(name, proc, args.timeout)
    if not state:
        print(f"[error] {name} did not become ready within {args.timeout:.0f}s", file=sys.stderr)
        print(log_tail(name), file=sys.stderr)
        return 1

    payload = {
        "status": "ok" if proc is not None else "already_running",
        "environment": name,
        "pid": state.get("pid"),
        "socket": state.get("socket"),
        "headless": args.headless,
        "egress": state.get("observed_egress"),
        "url": state.get("url"),
    }
    if args.json:
        print(json.dumps(payload, indent=2, ensure_ascii=False))
        return 0
    print(f"[ok]     {name} started  pid {state.get('pid')}")
    print(f"[mode]   {'headless' if args.headless else 'window'}")
    print(f"[socket] {state.get('socket')}")
    print(f"[egress] {state.get('observed_egress') or 'direct'}"
          f"  coherent={'yes' if state.get('egress_consistent') else 'no'}"
          f"  identity={state.get('timezone')}/{state.get('locale')}")
    return 0


def _run_foreground(name: str, args: argparse.Namespace) -> int:
    from .engine import run_cli as engine_run

    argv = sys.argv
    sys.argv = [argv[0], "--profile", name] + (["--headless"] if args.headless else []) + (["--url", args.url] if args.url else [])
    try:
        return engine_run()
    finally:
        sys.argv = argv


def cmd_stop(args: argparse.Namespace) -> int:
    name = profile.sanitize(args.name)
    state = client.running(name)
    if not state:
        print(json.dumps({"status": "not_running", "environment": name}) if args.json else f"[info] {name} is not running")
        return 0
    try:
        client.stop(name)
    except client.EngineError as exc:
        print(f"[warn] {exc}", file=sys.stderr)
    pid = state.get("pid")
    deadline = time.monotonic() + args.timeout
    while time.monotonic() < deadline:
        if not client.running(name):
            break
        time.sleep(0.2)
    else:
        print(f"[warn] {name} did not stop cleanly; sending SIGTERM", file=sys.stderr)
        try:
            os.kill(pid, signal.SIGTERM)
        except Exception:  # noqa: BLE001
            pass
    profile.clear_state(name)
    print(json.dumps({"status": "ok", "environment": name}) if args.json else f"[ok] {name} stopped")
    return 0


def cmd_list(args: argparse.Namespace) -> int:
    rows = profile.list_profiles()
    if args.json:
        print(json.dumps(rows, indent=2, ensure_ascii=False))
        return 0
    print(table(rows, [
        ("name", "NAME"), ("status", "STATUS"), ("pid", "PID"), ("proxy", "PROXY"),
        ("egress_ip", "EGRESS"), ("timezone", "TIMEZONE"), ("locale", "LOCALE"),
    ]))
    return 0


def cmd_info(args: argparse.Namespace) -> int:
    name = profile.sanitize(args.name)
    cfg = profile.require(name)
    state = client.running(name)
    live: dict[str, Any] | None = None
    if state:
        try:
            live = client.info(name)
        except client.EngineError:
            live = None
    ident = cfg.get("identity") or {}
    payload = {
        "environment": name,
        "status": "RUNNING" if state else "IDLE",
        "identity": {
            "id": ident.get("id"), "os": ident.get("os"), "screen": ident.get("screen"),
            "cores": ident.get("cores"), "fonts": ident.get("fonts_mode"),
            "fonts_visible": len(ident.get("fonts") or []) or None,
            "digest": identity.digest(ident)[:16] if ident.get("fingerprint") else None,
        },
        "network": cfg.get("network"),
        "runtime": cfg.get("runtime"),
        "created_at": cfg.get("created_at"),
        "live": live,
    }
    if args.json:
        print(json.dumps(payload, indent=2, ensure_ascii=False))
        return 0
    egress = (cfg.get("network") or {}).get("egress") or {}
    print(f"{name}  [{payload['status']}]")
    print(f"  identity  {ident.get('id')}  os={ident.get('os')}  screen={'x'.join(map(str, ident.get('screen') or []))}  cores={ident.get('cores')}  fonts={ident.get('fonts_mode')}")
    print(f"  network   {(cfg.get('network') or {}).get('proxy') or 'DIRECT'}  webrtc={(cfg.get('network') or {}).get('webrtc')}")
    print(f"  egress    {egress.get('ip')}  {egress.get('country')}/{egress.get('city')}  {egress.get('timezone')}  {egress.get('locale')}  ({egress.get('source')})")
    print(f"  runtime   camoufox {((cfg.get('runtime') or {}).get('camoufox'))}  playwright {((cfg.get('runtime') or {}).get('playwright'))}")
    if live:
        print(f"  live      pid={live.get('pid')}  tabs={live.get('pages')}  url={live.get('url')}")
    print(f"  store     {profile.profile_dir(name)}")
    return 0


def cmd_reset(args: argparse.Namespace) -> int:
    name = profile.sanitize(args.name)
    profile.require(name)
    if client.running(name):
        print(f"[error] stop {name} before resetting it", file=sys.stderr)
        return 1
    profile.reset_data(name)
    print(json.dumps({"status": "ok", "environment": name, "kept": "identity"}) if args.json
          else f"[ok] {name} storage cleared; identity kept")
    return 0


def cmd_rm(args: argparse.Namespace) -> int:
    name = profile.sanitize(args.name)
    profile.require(name)
    if client.running(name) and not args.force:
        print(f"[error] {name} is running; stop it first or pass --force", file=sys.stderr)
        return 1
    if client.running(name):
        try:
            client.stop(name)
        except client.EngineError:
            pass
        time.sleep(0.5)
    profile.remove(name)
    print(json.dumps({"status": "ok", "removed": name}) if args.json else f"[ok] {name} removed")
    return 0


def cmd_export(args: argparse.Namespace) -> int:
    name = profile.sanitize(args.name)
    profile.require(name)
    target = Path(args.file) if args.file else None
    out = profile.export(name, target)
    print(json.dumps({"status": "ok", "archive": str(out)}) if args.json else f"[ok] exported to {out}")
    return 0


def cmd_import(args: argparse.Namespace) -> int:
    archive = Path(args.archive)
    name = profile.import_archive(archive, rename=args.name)
    print(json.dumps({"status": "ok", "environment": name}) if args.json else f"[ok] imported as {name}")
    return 0


def cmd_exec(args: argparse.Namespace) -> int:
    name = profile.sanitize(args.name)
    action = args.action
    payload: dict[str, Any] = {}
    values = list(args.values or [])

    if action == "goto":
        payload["url"] = " ".join(values)
    elif action == "tab_new":
        payload["url"] = " ".join(values) if values else "about:blank"
    elif action == "click":
        payload["target"] = " ".join(values)
    elif action == "type":
        if len(values) < 2:
            print("[error] type needs: <target> <text>", file=sys.stderr)
            return 1
        payload["target"] = values[0]
        payload["text"] = " ".join(values[1:])
    elif action == "press":
        payload["keys"] = " ".join(values)
    elif action in {"hover", "select"}:
        if not values:
            print(f"[error] {action} needs a target", file=sys.stderr)
            return 1
        payload["target"] = values[0]
        if len(values) > 1:
            payload["value"] = " ".join(values[1:])
    elif action == "screenshot":
        payload["file"] = values[0] if values else None
    elif action == "eval":
        payload["js"] = " ".join(values)
    elif action == "use":
        payload["index"] = int(values[0]) if values else -1
    elif action in {"scroll", "wait", "axtree", "back", "reload", "cookies", "tabs"}:
        pass
    else:
        print(f"[error] unknown action {action!r}", file=sys.stderr)
        return 1

    if action == "eval" and args.main_world:
        if not (profile.require(name).get("automation") or {}).get("allow_main_world_eval"):
            print("[error] main-world eval is disabled for this environment", file=sys.stderr)
            return 1
        payload["main_world"] = True

    for key in ("enter", "fill", "full_page"):
        if getattr(args, key, False):
            payload[key] = True
    if getattr(args, "file", None):
        payload["file"] = args.file
    for key, attr in (("delay", "delay"), ("amount", "amount"), ("ms", "ms"), ("timeout", "timeout")):
        value = getattr(args, attr, None)
        if value is not None:
            payload[key] = value
    for key, attr in (("direction", "direction"), ("selector", "selector"), ("url_substring", "url_substring")):
        value = getattr(args, attr, None)
        if value:
            payload[key] = value

    try:
        response = client.call(name, action, payload, timeout=float(args.timeout or 60))
    except client.EngineError as exc:
        print(json.dumps({"status": "error", "action": action, "message": str(exc)}) if args.json else f"[error] {exc}",
              file=sys.stdout if args.json else sys.stderr)
        return 1

    if args.json:
        print(json.dumps(response, indent=2, ensure_ascii=False, default=str))
        return 0

    if action == "axtree":
        print(f"[title] {response.get('title')}")
        print(f"[url]   {response.get('url')}")
        print(f"[shot]  {response.get('screenshot')}")
        total = response.get("total", 0)
        shown = len(response.get("elements") or [])
        print(f"[ax]    {shown} of {total} interactive elements{' (truncated)' if response.get('truncated') else ''}")
        for item in response.get("elements") or []:
            label = item.get("text") or item.get("value") or item.get("placeholder") or ""
            flags = []
            if not item.get("in_viewport"):
                flags.append("offscreen")
            if item.get("checked"):
                flags.append("checked")
            suffix = f"  [{', '.join(flags)}]" if flags else ""
            print(f"  {item['ref'].ljust(4)} {str(item.get('role')).ljust(12)} {label!r}{suffix}")
    elif action == "eval":
        print(response.get("result"))
    elif action == "tabs":
        for tab in response.get("tabs") or []:
            print(f"  [{tab['index']}]{' *' if tab['active'] else '  '} {tab['title'][:60]!r} {tab['url']}")
    elif action == "cookies":
        print(f"[ok] {response.get('count')} cookies")
    else:
        print(f"[ok] {action} {json.dumps({k: v for k, v in response.items() if k not in {'status', 'action'}}, default=str, ensure_ascii=False)}")
    return 0


def cmd_audit(args: argparse.Namespace) -> int:
    name = profile.sanitize(args.name)
    profile.require(name)
    kinds = [kind for kind in ("local", "leaks", "fp") if getattr(args, kind)]
    if not kinds or args.all:
        kinds = ["local", "leaks", "fp"]
    if kinds != ["local"]:
        print("[note] audit navigates the environment's active tab", file=sys.stderr)
    report: dict[str, Any] = {"environment": name, "kinds": kinds}
    code = 0
    for kind in kinds:
        if kind == "local":
            report["local"] = audit.local(name)
            code = code or (1 if report["local"]["verdict"] == "fail" else 0)
        elif kind == "leaks":
            report["leaks"] = audit.leaks(name)
            if report["leaks"].get("egress_matches") is False:
                code = 1
        else:
            report["fingerprint_site"] = audit.fingerprint_site(name)
    if args.json:
        print(json.dumps(report, indent=2, ensure_ascii=False, default=str))
        return code

    local = report.get("local")
    if local:
        print(f"[local] {local['verdict']}")
        for item in local["checks"]:
            print(f"  {item['result'].ljust(7)} {item['check']}: {item['detail']}")
    leaks = report.get("leaks")
    if leaks:
        print(f"[leaks] egress expected={leaks.get('expected_egress')} observed={leaks.get('observed_egress')} match={leaks.get('egress_matches')}")
        for page, info in (leaks.get("pages") or {}).items():
            print(f"  {page}: {info.get('url')}")
            for line in info.get("lines") or []:
                print(f"    {line}")
    fp = report.get("fingerprint_site")
    if fp:
        print(f"[amiunique] unique={fp.get('unique')} shot={fp.get('screenshot')}")
        for line in (fp.get("headline") or [])[:12]:
            print(f"  {line}")
    return code


STEP_FLAGS = {"wait": {"--ms": "ms", "--selector": "selector", "--url-substring": "url_substring"},
              "scroll": {"--direction": "direction", "--amount": "amount"}}


def step_from_line(line: str) -> dict[str, Any]:
    """`goto https://x` -> {"action": "goto", "args": {"url": "https://x"}}.

    One action per line, quoting only where a value contains spaces. This is the
    same shape Playwright CLI users already type, so an agent needs no new model.
    """
    tokens = shlex.split(line)
    action, rest = tokens[0], tokens[1:]
    args: dict[str, Any] = {}
    if action in {"goto", "tab_new", "eval"}:
        key = {"goto": "url", "tab_new": "url", "eval": "js"}[action]
        args[key] = " ".join(rest)
    elif action in {"click", "hover", "press"}:
        key = "keys" if action == "press" else "target"
        args[key] = " ".join(rest)
    elif action == "type":
        if len(rest) < 2:
            raise ValueError("type needs: <target> <text>")
        args["target"], args["text"] = rest[0], " ".join(rest[1:])
    elif action == "select":
        if len(rest) < 1:
            raise ValueError("select needs: <target> [value]")
        args["target"] = rest[0]
        if len(rest) > 1:
            args["value"] = " ".join(rest[1:])
    elif action in {"screenshot", "use"}:
        args["file" if action == "screenshot" else "index"] = rest[0] if rest else None
    elif action in STEP_FLAGS:
        index = 0
        while index < len(rest):
            token = rest[index]
            if token.startswith("--") and token in STEP_FLAGS[action] and index + 1 < len(rest):
                key = STEP_FLAGS[action][token]
                value: Any = rest[index + 1]
                args[key] = int(value) if key in {"ms", "amount"} else value
                index += 2
            else:
                args.setdefault("direction" if action == "scroll" else "ms", token)
                index += 1
    elif action in {"axtree", "back", "reload", "cookies", "tabs"}:
        pass
    else:
        raise ValueError(f"unknown action {action!r}")
    return {"action": action, "args": args}


def parse_script(text: str) -> list[dict[str, Any]]:
    stripped = text.strip()
    if stripped.startswith("["):
        steps = json.loads(stripped)
        if not isinstance(steps, list):
            raise ValueError("JSON form must be a list of steps")
        return steps
    steps = []
    for number, raw in enumerate(text.splitlines(), 1):
        line = raw.strip()
        if not line or line.startswith("#"):
            continue
        try:
            steps.append(step_from_line(line))
        except ValueError as exc:
            raise ValueError(f"line {number}: {exc}") from exc
    if not steps:
        raise ValueError("script has no steps")
    return steps


def cmd_measure(args: argparse.Namespace) -> int:
    from . import measure

    source = args.script
    text = sys.stdin.read() if source in {"", "-"} else (
        Path(os.path.expanduser(source)).read_text(encoding="utf-8")
        if os.path.isfile(os.path.expanduser(source)) else source
    )
    try:
        steps = parse_script(text)
    except ValueError as exc:
        print(f"[error] {exc}", file=sys.stderr)
        return 1
    report = measure.run_sync(
        steps=steps, cdp_url=args.cdp, browser=args.browser, headless=not args.headful,
        workdir=Path(args.out).expanduser() if args.out else Path.cwd(),
    )
    if args.json:
        print(json.dumps(report, indent=2, ensure_ascii=False, default=str))
        return 0 if report.get("status") == "ok" else 1
    print(table([{"k": key, "v": value} for key, value in (
        ("target", report["target"].get("mode")),
        ("ua", report.get("user_agent")),
        ("webdriver", report.get("webdriver")),
        ("status", report.get("status")),
        ("seconds", report.get("seconds")),
    )], [("k", "KEY"), ("v", "VALUE")]))
    for item in report.get("results") or []:
        detail = item.get("result")
        if isinstance(detail, (dict, list)):
            detail = f"{len(detail)} items" if isinstance(detail, list) else ""
        print(f"  {str(item.get('step')).rjust(2)}  {str(item.get('action')).ljust(9)} {item.get('status')}"
              f"  {str(detail or item.get('message') or '')[:90]}")
    return 0 if report.get("status") == "ok" else 1


def cmd_run(args: argparse.Namespace) -> int:
    name = profile.sanitize(args.name)
    profile.require(name)
    source = args.script
    if source in {"", "-"}:
        text = sys.stdin.read()
    else:
        expanded = os.path.expanduser(source)
        text = Path(expanded).read_text(encoding="utf-8") if os.path.isfile(expanded) else source
    try:
        steps = parse_script(text)
    except ValueError as exc:
        print(f"[error] {exc}", file=sys.stderr)
        return 1
    reply = client.call(name, "batch", {"steps": steps}, timeout=args.timeout)
    if args.json:
        print(json.dumps(reply, indent=2, ensure_ascii=False, default=str))
        return 0 if reply.get("status") == "ok" else 1
    for item in reply.get("results") or []:
        detail = item.get("result")
        if isinstance(detail, (dict, list)):
            detail = f"{len(detail)} items" if isinstance(detail, list) else ""
        print(f"  {str(item.get('step')).rjust(2)}  {str(item.get('action')).ljust(9)} {item.get('status')}"
              f"  {str(detail or item.get('message') or '')[:90]}")
    return 0 if reply.get("status") == "ok" else 1


def _sites_from(value: str | None) -> list[dict[str, str]] | None:
    if not value:
        return None
    return [{"host": urlparse(url).netloc or url, "url": url, "vendor": "custom"}
            for url in (item.strip() for item in value.split(",")) if url]


def cmd_field(args: argparse.Namespace) -> int:
    sites = _sites_from(args.sites)
    out = Path(args.out).expanduser() if args.out else None
    if args.cdp or args.browser:
        report = field.control(
            sites=sites, cdp_url=args.cdp, browser=args.browser or "chromium",
            out=out, settle=args.settle, timeout=args.timeout,
        )
    else:
        if not args.name:
            print("[error] name an environment, or pass --browser/--cdp for a control run", file=sys.stderr)
            return 1
        name = profile.sanitize(args.name)
        profile.require(name)
        report = field.run(name, sites=sites, out=out, settle=args.settle, timeout=args.timeout)
    if args.json:
        print(json.dumps(report, indent=2, ensure_ascii=False))
        return 0 if not any(row["verdict"] == "blocked" for row in report["sites"]) else 1
    print(table(report["sites"], [("host", "HOST"), ("vendor", "VENDOR"), ("verdict", "VERDICT"),
                                 ("http_status", "HTTP"), ("markers", "MARKERS"), ("interactive", "AX")]))
    for row in report["sites"]:
        if row.get("error"):
            print(f"  {row['host']}: {row['error']}")
        elif row.get("markers"):
            print(f"  {row['host']}: {', '.join(row['markers'])}")
    print(f"[evidence] {report['output']}")
    return 0 if not any(row["verdict"] == "blocked" for row in report["sites"]) else 1


def cmd_doctor(args: argparse.Namespace) -> int:
    report = audit.doctor()
    if args.json:
        print(json.dumps(report, indent=2, ensure_ascii=False))
        return 0
    for item in report["checks"]:
        print(f"  {item['result'].ljust(6)} {item['check']}: {item['detail']}")
    return 0


# --------------------------------------------------------------------------- wiring


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="anti-trace", description="Anti-tracking, anti-censorship browser environments with agent automation")
    sub = parser.add_subparsers(dest="command", required=True)

    def add(name: str, help_text: str) -> argparse.ArgumentParser:
        return sub.add_parser(name, help=help_text)

    p = add("setup", "install the Camoufox runtime and calibrate fonts")
    p.add_argument("--skip-fonts", action="store_true")
    p.set_defaults(func=cmd_setup)

    p = add("create", "create an environment with a pinned identity")
    p.add_argument("name")
    p.add_argument("--proxy", help="http(s):// or socks5:// proxy URL")
    p.add_argument("--os", choices=["macos", "windows", "linux"])
    p.add_argument("--cores", type=int)
    p.add_argument("--fonts", default="host", help="host (coherent) or subset:N (per-environment canvas text)")
    p.add_argument("--webrtc", choices=["spoof", "block"], default="spoof")
    p.add_argument("--follow-egress", action="store_true",
                   help="re-derive timezone and language from each start's exit IP (rotating proxies)")
    p.add_argument("--force", action="store_true")
    p.add_argument("--json", action="store_true")
    p.set_defaults(func=cmd_create)

    for alias in ("start",):
        p = add(alias, "start an environment (window by default)")
        p.add_argument("name")
        p.add_argument("--headless", action="store_true")
        p.add_argument("--url")
        p.add_argument("--foreground", action="store_true")
        p.add_argument("--timeout", type=float, default=90.0)
        p.add_argument("--json", action="store_true")
        p.set_defaults(func=cmd_start)

    p = add("stop", "stop an environment and flush its storage")
    p.add_argument("name")
    p.add_argument("--timeout", type=float, default=20.0)
    p.add_argument("--json", action="store_true")
    p.set_defaults(func=cmd_stop)

    for alias in ("list", "ls"):
        p = add(alias, "list environments")
        p.add_argument("--json", action="store_true")
        p.set_defaults(func=cmd_list)

    p = add("info", "show an environment's identity, network and live state")
    p.add_argument("name")
    p.add_argument("--json", action="store_true")
    p.set_defaults(func=cmd_info)

    p = add("reset", "clear cookies and storage, keep the identity")
    p.add_argument("name")
    p.add_argument("--json", action="store_true")
    p.set_defaults(func=cmd_reset)

    p = add("rm", "delete an environment and its data")
    p.add_argument("name")
    p.add_argument("--force", action="store_true")
    p.add_argument("--json", action="store_true")
    p.set_defaults(func=cmd_rm)

    p = add("export", "archive an environment")
    p.add_argument("name")
    p.add_argument("file", nargs="?")
    p.add_argument("--json", action="store_true")
    p.set_defaults(func=cmd_export)

    p = add("import", "restore an archived environment")
    p.add_argument("archive")
    p.add_argument("--name")
    p.add_argument("--json", action="store_true")
    p.set_defaults(func=cmd_import)

    p = add("exec", "run one page action inside a running environment")
    p.add_argument("name")
    p.add_argument("action", choices=sorted(EXEC_ARGUMENT_COUNT))
    p.add_argument("values", nargs="*")
    p.add_argument("--json", action="store_true")
    p.add_argument("--enter", action="store_true")
    p.add_argument("--fill", action="store_true")
    p.add_argument("--delay", type=int)
    p.add_argument("--timeout", type=float)
    p.add_argument("--file")
    p.add_argument("--full-page", action="store_true")
    p.add_argument("--main-world", action="store_true")
    p.add_argument("--direction")
    p.add_argument("--amount", type=int)
    p.add_argument("--ms", type=int)
    p.add_argument("--selector")
    p.add_argument("--url-substring")
    p.set_defaults(func=cmd_exec)

    p = add("audit", "verify what the environment presents and leaks")
    p.add_argument("name")
    p.add_argument("--local", action="store_true", help="identity coherence and stability")
    p.add_argument("--leaks", action="store_true", help="WebRTC/DNS/IP leak pages")
    p.add_argument("--fp", action="store_true", help="AmIUnique fingerprint page")
    p.add_argument("--all", action="store_true")
    p.add_argument("--json", action="store_true")
    p.set_defaults(func=cmd_audit)

    p = add("run", "run a step script against a running environment")
    p.add_argument("name")
    p.add_argument("script", help="path, inline text, or '-' for stdin")
    p.add_argument("--json", action="store_true")
    p.add_argument("--timeout", type=float, default=300.0)
    p.set_defaults(func=cmd_run)

    p = add("measure", "run a step script on a control browser (Chromium or a CDP endpoint)")
    p.add_argument("script", nargs="?", default="-", help="path, inline text, or '-' for stdin")
    p.add_argument("--browser", choices=["chromium"], help="launch the Playwright Chromium build")
    p.add_argument("--cdp", help="attach to an existing CDP endpoint (Fury, Chrome, Cloak)")
    p.add_argument("--headful", action="store_true")
    p.add_argument("--out", help="directory for screenshots")
    p.add_argument("--json", action="store_true")
    p.set_defaults(func=cmd_measure)

    p = add("field", "visit strict sites and keep human-reviewable evidence")
    p.add_argument("name", nargs="?")
    p.add_argument("--sites", help="comma-separated URLs (default: the four vendor sites)")
    p.add_argument("--out", help="evidence directory (default: <profile>/field/<timestamp>)")
    p.add_argument("--browser", choices=["chromium"], help="score a control browser instead of an environment")
    p.add_argument("--cdp", help="score an existing CDP endpoint instead of an environment")
    p.add_argument("--settle", type=float, default=6.0, help="seconds to let a challenge settle")
    p.add_argument("--timeout", type=float, default=90.0, help="navigation timeout in seconds")
    p.add_argument("--json", action="store_true")
    p.set_defaults(func=cmd_field)

    p = add("doctor", "check the local installation")
    p.add_argument("--json", action="store_true")
    p.set_defaults(func=cmd_doctor)

    return parser


def main(argv: list[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    try:
        return args.func(args)
    except profile.ProfileError as exc:
        print(f"[error] {exc}", file=sys.stderr)
        return 1
    except net.NetworkError as exc:
        print(f"[error] {exc}", file=sys.stderr)
        return 1
    except client.EngineError as exc:
        print(f"[error] {exc}", file=sys.stderr)
        return 1
    except KeyboardInterrupt:
        return 130


if __name__ == "__main__":
    sys.exit(main())
