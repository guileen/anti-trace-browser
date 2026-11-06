"""anti-trace: anti-tracking, anti-censorship environments with agent automation."""

from __future__ import annotations

import argparse
import json
import hashlib
import os
import subprocess
import sys
import time
from pathlib import Path
from typing import Any
from urllib.parse import urlparse

from . import audit, client, field, identity, native_spec, net, profile

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
    return _redact("\n".join(path.read_text(encoding="utf-8", errors="replace").splitlines()[-lines:]))


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


def _json_input(value: str, *, object_only: bool = False) -> Any:
    text = Path(value[1:]).expanduser().read_text(encoding="utf-8") if value.startswith("@") else value
    def invalid_constant(constant: str) -> Any:
        raise ValueError(f"invalid JSON constant {constant}")
    result = json.loads(text, parse_constant=invalid_constant)
    if object_only and not isinstance(result, dict):
        raise ValueError("overrides must be a JSON object")
    return result


def _redact(value: Any) -> Any:
    """Never expose credential-bearing config fields or URL userinfo."""
    if isinstance(value, dict):
        safe = {}
        for key, item in value.items():
            if key.lower() in {"proxy", "password", "username", "credentials", "proxy_credentials", "token", "receipt_token", "authorization", "secret"}:
                continue
            if key == "network" and isinstance(item, dict):
                item = {name: field for name, field in item.items() if name in {
                    "proxy_ref", "egress_policy", "allow_private_network", "egress", "webrtc",
                    "locale", "languages", "timezone", "follow_egress", "proxy_credentials_required"}}
            safe[key] = _redact(item)
        return safe
    if isinstance(value, list):
        return [_redact(item) for item in value]
    if isinstance(value, str):
        import re
        return re.sub(r"([a-zA-Z][a-zA-Z0-9+.-]*://)[^/\s]*@", r"\1[redacted]@", value)
    return value


def _error(args: argparse.Namespace, code: str, message: str) -> int:
    message = _redact(message)
    print(json.dumps({"status": "error", "code": code, "message": message}, ensure_ascii=False)
          if getattr(args, "json", False) else f"[error] {code}: {message}",
          file=sys.stdout if getattr(args, "json", False) else sys.stderr)
    return 1


def _cfox_webrtc_policy(proxy: str | None, egress_policy: str, requested: str | None) -> str:
    strict_proxy = bool(proxy and proxy.strip().upper() != "DIRECT" and egress_policy == "strict")
    if strict_proxy and requested == "spoof":
        raise profile.ProfileError("capability_unavailable: strict proxy policy requires WebRTC block; spoof permits direct UDP")
    return requested or ("block" if strict_proxy else "spoof")


def cmd_create(args: argparse.Namespace) -> int:
    name = profile.sanitize(args.name)
    seed = identity.normalize_seed(args.seed)
    overrides = _json_input(args.overrides, object_only=True)
    if args.fonts != "host" and not args.fonts.startswith("subset:"):
        raise ValueError("--fonts must be host or subset:N")
    font_count = 0 if args.fonts == "host" else int(args.fonts.split(":", 1)[1])
    if args.fonts != "host" and font_count < 8:
        raise ValueError("--fonts subset:N needs N >= 8")
    network = {"proxy_ref": None, "egress_policy": args.egress_policy,
               "allow_private_network": args.allow_private_network}
    webrtc = _cfox_webrtc_policy(args.proxy, args.egress_policy, args.webrtc) if args.runtime == "camoufox" else None
    cfg = None
    with profile.exclusive(name, kind="spawn") as serialized, profile.exclusive(name) as owned, profile.exclusive("catalog", kind="catalog") as catalog:
        if not serialized or not owned or not catalog or profile.owner_alive(profile.load_state(name)):
            raise profile.ProfileError(f"busy: stop {name} before replacing it")
        if profile.exists(name) and not args.force:
            raise profile.ProfileError(f"environment {name!r} already exists")
        existing = [profile.require(other) for other in _profile_names() if other != name]
        if args.runtime == "camoufox":
            if args.font_file:
                raise profile.ProfileError("capability_unavailable: Camoufox cannot load standalone font files")
            from .engine import browser_path
            binary = str(Path(args.native_binary).expanduser().resolve()) if args.native_binary else browser_path()
            proxy_value = args.proxy
            if proxy_value and proxy_value.startswith("env:"):
                proxy_value = os.environ.get(proxy_value[4:])
                if not proxy_value:
                    raise profile.ProfileError("network_unavailable: proxy environment reference is unavailable")
            egress = net.probe_egress(net.parse_proxy(proxy_value))
            egress["locale"] = identity.locale_for(egress.get("country"))
            for key in ("locale", "timezone"):
                if egress.get(key):
                    overrides.setdefault(key, egress[key])
            network.update({"egress": egress, "webrtc": webrtc, "follow_egress": False})
            cfg = identity.create_cfox_spec(name, seed=seed, os_name=args.os or identity.host_os(),
                                            cores=args.cores, font_count=font_count, overrides=overrides,
                                            network=network, binary=binary, existing=existing)
        else:
            if args.os not in (None, "macos") or args.webrtc is not None:
                raise profile.ProfileError("capability_unavailable: native --os/--webrtc overrides are not supported")
            if args.cores is not None:
                if "hardware_concurrency" in overrides and overrides["hardware_concurrency"] != args.cores:
                    raise ValueError("conflicting --cores and hardware_concurrency override")
                overrides["hardware_concurrency"] = args.cores
            assets = {"fonts":sorted({str(Path(path).expanduser().resolve()) for path in args.font_file})} if args.font_file else native_spec.native_font_assets()
            families = native_spec.native_font_families(assets)
            if not families:
                raise profile.ProfileError("capability_unavailable: no native font families are available")
            if font_count > len(families):
                raise ValueError(f"requested {font_count} fonts, but only {len(families)} real families are available")
            if "fonts" in overrides and font_count:
                raise ValueError("choose --fonts subset:N or an explicit fonts override")
            selected = identity.pick_fonts(families, {}, font_count, int(seed, 16)) if font_count else families
            overrides.setdefault("fonts", sorted(selected))
            if not isinstance(overrides["fonts"], list) or any(family not in families for family in overrides["fonts"]):
                raise ValueError("fonts override must contain actual native font families")
            cfg = native_spec.create_native_spec(name, runtime=args.runtime, seed=seed, overrides=overrides,
                                                 network=network, binary=args.native_binary, existing=existing,
                                                 asset_paths=assets, storage_path=profile.profile_dir(name) / "data")
        cfg["created_at"] = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
        try:
            profile.configure_proxy(cfg, args.proxy)
            if profile.exists(name):
                profile.remove(name)
            profile.save_config(name, cfg)
            (profile.profile_dir(name) / "data").mkdir(parents=True, exist_ok=True)
        except Exception:
            profile.clear_proxy_secret(cfg)
            raise
    summary = {"status": "ok", "environment": name, "schema": cfg["schema"], "id": cfg["id"],
               "runtime": _redact(cfg["runtime"]), "seed": seed, "revision": cfg["revision"],
               "resolved": cfg["resolved"], "network": _redact(cfg["network"]),
               "store": str(profile.profile_dir(name))}
    print(json.dumps(summary, indent=2, ensure_ascii=False) if args.json
          else f"[ok] created {name} ({cfg['runtime']['id']}, revision {cfg['revision']})\n[path] {profile.profile_dir(name)}")
    return 0


def _profile_names() -> list[str]:
    from . import profile as profile_module

    return [row["name"] for row in profile_module.list_profiles()]


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


def _startup_failure(args: argparse.Namespace, name: str, previous_state: dict[str, Any] | None,
                     process: subprocess.Popen | None = None) -> int:
    failed = profile.load_state(name)
    error = (failed or {}).get("error")
    if (failed and failed != previous_state and failed.get("status") == "ERROR"
            and (process is None or failed.get("pid") == process.pid)
            and type(failed.get("process_start")) in (int, float)
            and isinstance(error, dict) and isinstance(error.get("code"), str)
            and isinstance(error.get("message"), str)):
        return _error(args, error["code"], error["message"])
    return _error(args, "startup_failed", f"{name} never became ready\n{log_tail(name)}")


def cmd_start(args: argparse.Namespace) -> int:
    name = profile.sanitize(args.name)
    if (profile.require(name).get("mode") == "attached"):
        return _error(args, "externally_owned", f"{name} is attached; use run/field/audit or re-attach with a new --cdp")

    profile.require(name)
    state = client.running(name)
    if state:
        payload = {"status": "already_running", "environment": name, "pid": state.get("pid"), "socket": state.get("socket")}
        print(json.dumps(payload, indent=2) if args.json else f"[info] {name} is already running (pid {state.get('pid')})\n[socket] {state.get('socket')}")
        return 0

    if args.foreground:
        return _run_foreground(name, args)

    proc: subprocess.Popen | None = None
    previous_state = profile.load_state(name)
    with profile.exclusive(name, timeout=args.timeout, kind="spawn") as owned:
        spawning = True
        if owned:
            if not profile.exists(name):
                raise profile.ProfileError(f"environment {name!r} was removed before startup")
            pending = profile.load_state(name)
            if pending and pending.get("status") != "STOPPING" and profile.owner_alive(pending):
                spawning = False
        else:
            spawning = False

        if spawning:
            with profile.exclusive(name, timeout=args.timeout) as available:
                if not available:
                    return _error(args, "busy", f"{name} is still owned by another engine")
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
                if profile.owner_alive(pending):
                    break
                if proc.poll() is not None:
                    break
                time.sleep(0.05)
        else:
            state = _wait_ready(name, None, args.timeout)
            if not state:
                return _startup_failure(args, name, previous_state)

    state = _wait_ready(name, proc, args.timeout)
    if not state:
        return _startup_failure(args, name, previous_state, proc)

    payload = {
        "status": "ok" if proc is not None else "already_running",
        "environment": name,
        "pid": state.get("pid"),
        "socket": state.get("socket"),
        "headless": state.get("headless"),
        "gui": state.get("gui",not args.headless),
        "egress": state.get("observed_egress"),
        "url": state.get("url"),
    }
    if payload["gui"]:
        payload["viewer_url"] = client.call(name,"viewer")["url"]
    if args.json:
        print(json.dumps(payload, indent=2, ensure_ascii=False))
        return 0
    print(f"[ok]     {name} started  pid {state.get('pid')}")
    print(f"[mode]   {'shared viewer' if payload['gui'] else 'headless'}")
    if payload.get("viewer_url"):
        print(f"[viewer] {payload['viewer_url']}")
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


def _stop_owned(name: str, timeout: float) -> str | None:
    """Stop the observed owner while the caller holds the spawn lease."""
    state = client.running(name) or profile.load_state(name)
    if not profile.owner_alive(state):
        # Missing/mismatched birthtime disproves this PID binding, not engine
        # ownership. Only the store-level lease can prove the environment idle.
        with profile.exclusive(name, timeout=timeout) as available:
            if not available:
                print(f"[error] {name} is still owned; its state and lease are retained", file=sys.stderr)
                return None
            current = profile.load_state(name)
            if current != state:
                print(f"[error] {name} ownership changed while stopping; state is retained", file=sys.stderr)
                return None
            if current:
                profile.clear_state(name)
        return "not_running"
    if state.get("status") == "STARTING":
        print(f"[error] {name} is initializing; wait for readiness before stopping", file=sys.stderr)
        return None
    try:
        if state.get("status") == "READY":
            client.stop(name)
    except ValueError as exc:
        print(f"[error] {exc}", file=sys.stderr)
        return None
    except client.EngineError as exc:
        print(f"[warn] {_redact(str(exc))}", file=sys.stderr)
    pid = state.get("pid")
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if not profile.owner_alive(state):
            break
        time.sleep(0.2)
    else:
        print(f"[error] {name} is still stopping; its state and lease are retained", file=sys.stderr)
        return None
    with profile.exclusive(name, timeout=timeout) as available:
        if not available:
            print(f"[error] {name} process exited but its profile is still owned", file=sys.stderr)
            return None
        current = profile.load_state(name)
        if current and current.get("pid") == pid and current.get("process_start") == state.get("process_start"):
            profile.clear_state(name)
    return "ok"


def cmd_stop(args: argparse.Namespace) -> int:
    name = profile.sanitize(args.name)
    if profile.require(name).get("mode") == "attached":
        if args.json:
            print(json.dumps({"status": "ok", "environment": name, "message": "attached browser is owned externally"}))
        else:
            print(f"[ok] {name} is attached; nothing to stop")
        return 0

    with profile.exclusive(name, timeout=args.timeout, kind="spawn") as owned:
        if not owned:
            return _error(args, "busy", f"{name} lifecycle operation is still in progress")
        status = _stop_owned(name, args.timeout)
        if status is None:
            return _error(args, "busy", f"{name} has not stopped; ownership is retained")
        message = f"[ok] {name} stopped" if status == "ok" else f"[info] {name} is not running"
        print(json.dumps({"status": status, "environment": name}) if args.json else message)
        return 0


def cmd_list(args: argparse.Namespace) -> int:
    rows = _redact(profile.list_profiles())
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
    live = client.info(name) if state else None
    config_path = (profile.profile_dir(name) / "config.json").resolve()
    runtime = dict(cfg.get("runtime") or {})
    runtime["executable"] = runtime.get("binary")
    if runtime.get("binary"):
        runtime["artifact_sha256"] = native_spec.file_sha256(runtime["binary"])
    payload = _redact({
        "environment": name, "status": "RUNNING" if state else "IDLE",
        "schema": cfg.get("schema"), "id": cfg.get("id"), "seed": cfg.get("seed"),
        "revision": cfg.get("revision"), "config_path": str(config_path),
        "configuration_sha256": native_spec.file_sha256(config_path),
        "runtime": runtime, "identity": cfg.get("identity"), "resolved": cfg.get("resolved"),
        "assets": cfg.get("assets"), "asset_paths": cfg.get("asset_paths"),
        "network": cfg.get("network"), "storage": cfg.get("storage"),
        "created_at": cfg.get("created_at"), "live": live,
    })
    print(json.dumps(payload, indent=2, ensure_ascii=False))
    return 0


def cmd_reset(args: argparse.Namespace) -> int:
    name = profile.sanitize(args.name)
    profile.require(name)
    with profile.exclusive(name, kind="spawn") as serialized, profile.exclusive(name) as owned, profile.exclusive("catalog", kind="catalog") as catalog:
        if not serialized or not owned or not catalog or profile.owner_alive(profile.load_state(name)):
            return _error(args, "busy", f"stop {name} before resetting it")
        profile.reset_data(name)
    print(json.dumps({"status": "ok", "environment": name, "kept": "identity"}) if args.json
          else f"[ok] {name} storage cleared; identity kept")
    return 0


def cmd_rm(args: argparse.Namespace) -> int:
    name = profile.sanitize(args.name)
    cfg = profile.require(name)
    with profile.exclusive(name, kind="spawn") as serialized:
        if not serialized:
            return _error(args, "busy", f"{name} lifecycle operation is still in progress")
        if cfg.get("mode") != "attached" and args.force and _stop_owned(name, 20.0) is None:
            return _error(args, "busy", f"{name} has not stopped")
        with profile.exclusive(name) as owned, profile.exclusive("catalog", kind="catalog") as catalog:
            if not owned or not catalog or profile.owner_alive(profile.load_state(name)):
                return _error(args, "busy", f"{name} is still owned; stop it first or pass --force")
            profile.remove(name)
    print(json.dumps({"status": "ok", "removed": name}) if args.json else f"[ok] {name} removed")
    return 0


def cmd_export(args: argparse.Namespace) -> int:
    name = profile.sanitize(args.name)
    profile.require(name)
    target = Path(args.file) if args.file else None
    out = profile.export(name, target, include_credentials=args.include_credentials)
    print(json.dumps({"status": "ok", "archive": str(out)}) if args.json else f"[ok] exported to {out}")
    return 0


def cmd_import(args: argparse.Namespace) -> int:
    archive = Path(args.archive)
    name = profile.import_archive(archive.expanduser(), rename=args.name, proxy=args.proxy, native_binary=args.native_binary)
    print(json.dumps({"status": "ok", "environment": name}) if args.json else f"[ok] imported as {name}")
    return 0

def cmd_migrate(args: argparse.Namespace) -> int:
    overrides = _json_input(args.overrides, object_only=True) if args.overrides is not None else None
    result = profile.migrate(profile.sanitize(args.name), binary=args.native_binary,
                             overrides=overrides, rollback=args.rollback)
    print(json.dumps(_redact(result), indent=2, ensure_ascii=False))
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
            return _error(args, "invalid_config", "type needs: <target> <text>")
        payload["target"] = values[0]
        payload["text"] = " ".join(values[1:])
    elif action == "press":
        payload["keys"] = " ".join(values)
    elif action in {"hover", "select"}:
        if not values:
            return _error(args, "invalid_config", f"{action} needs a target")
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
        return _error(args, "invalid_config", f"unknown action {action!r}")

    if action == "eval" and args.main_world:
        if not (profile.require(name).get("automation") or {}).get("allow_main_world_eval"):
            return _error(args, "capability_unavailable", "main-world eval is disabled for this environment")
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
    if getattr(args, "frame", None) is not None:
        payload["frame"] = args.frame


    try:
        response = client.call(name, action, payload, timeout=float(args.timeout or 60))
    except (ValueError, client.EngineError) as exc:
        return _error(args, getattr(exc, "code", "invalid_config"), str(exc))

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
    kinds = [kind for kind in ("local", "headers", "leaks", "fp") if getattr(args, kind)]
    if not kinds or args.all:
        kinds = ["local", "headers", "leaks", "fp"]
    if kinds != ["local"]:
        print("[note] audit navigates the environment's active tab", file=sys.stderr)
    report: dict[str, Any] = {"environment": name, "kinds": kinds}
    code = 0
    for kind in kinds:
        if kind == "local":
            report["local"] = audit.local(name)
            code = code or (0 if report["local"]["verdict"] == "pass" else 1)
        elif kind == "headers":
            report["headers"] = audit.headers(name, echo_url=args.echo_url)
            code = code or (0 if report["headers"]["verdict"] == "pass" else 1)
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
    heads = report.get("headers")
    if heads:
        print(f"[headers] {heads['verdict']}  {heads.get('url')}")
        for row in heads["checks"]:
            print(f"  {row['result'].ljust(4)} {row['class'].ljust(12)} {row['header']}: {row['detail'][:90]}")
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


def _script_path(source: str) -> str:
    path = Path(source).expanduser().resolve(strict=True)
    if not path.is_file() or path.suffix != ".py":
        raise ValueError("run requires a trusted local .py file with async main(page, context, tools)")
    return str(path)


def _run_report(args: argparse.Namespace, report: dict[str, Any]) -> int:
    if args.json:
        print(json.dumps(report, indent=2, ensure_ascii=False))
    else:
        print(f"[run] {report.get('run_id')} {report.get('status')}")
        if report.get("stdout"):
            print(report["stdout"], end="")
        if report.get("stderr"):
            print(report["stderr"], end="", file=sys.stderr)
        if report.get("error"):
            error = report["error"]
            print(f"[error] {error.get('code')}: {_redact(error.get('message'))}", file=sys.stderr)
        if report.get("result") is not None:
            print(json.dumps(report["result"], ensure_ascii=False))
    return 0 if report.get("status") == "ok" else 1


def cmd_measure(args: argparse.Namespace) -> int:
    from . import measure
    report = measure.run_sync(
        path=_script_path(args.script), args=_json_input(args.args),
        timeout=args.timeout, max_output_bytes=args.max_output_bytes,
        cdp_url=args.cdp, browser=args.browser, headless=not args.headful,
        workdir=Path(args.out).expanduser() if args.out else Path.cwd(),
    )
    return _run_report(args, report)




def cmd_attach(args: argparse.Namespace) -> int:
    from . import attached

    result = attached.attach(profile.sanitize(args.name), args.cdp)
    if args.json:
        print(json.dumps(result, indent=2, ensure_ascii=False))
        return 0
    print(f"[ok] {result['environment']} attached")
    print(f"[cdp] {result['cdp']}")
    print("[note] lifecycle belongs to that browser; run/field/audit work as usual")
    return 0


def cmd_run(args: argparse.Namespace) -> int:
    name = profile.sanitize(args.name)
    profile.require(name)
    reply = client.call(name, "run", {"path": _script_path(args.script),
                                    "args": _json_input(args.args), "timeout": args.timeout,
                                    "max_output_bytes": args.max_output_bytes}, timeout=args.timeout + 10)
    return _run_report(args, reply)


def cmd_control(args: argparse.Namespace) -> int:
    response = client.call(profile.sanitize(args.name), "control", {"command": args.control_command})
    print(json.dumps(_redact(response), indent=2, ensure_ascii=False))
    return 0 if response.get("status") == "ok" else 1


def cmd_viewer(args: argparse.Namespace) -> int:
    response = client.call(profile.sanitize(args.name), "viewer")
    print(json.dumps(response, indent=2, ensure_ascii=False) if args.json else response.get("url", response))
    return 0 if response.get("status") == "ok" else 1


def _sites_from(value: str | None) -> list[dict[str, str]] | None:
    if not value:
        return None
    return [{"host": urlparse(url).netloc or url, "url": url, "vendor": "custom"}
            for url in (item.strip() for item in value.split(",")) if url]


def cmd_field(args: argparse.Namespace) -> int:
    sites = _sites_from(args.sites)
    if args.site_config:
        if sites:
            raise profile.ProfileError("choose --sites or --site-config")
        sites = json.loads(Path(args.site_config).expanduser().read_text(encoding="utf-8"))
        if not isinstance(sites, list) or not sites or any(
            not isinstance(site, dict) or not all(isinstance(site.get(key), str) and site[key] for key in ("host", "url", "vendor"))
            for site in sites
        ):
            raise profile.ProfileError("--site-config requires a non-empty JSON array with host, url and vendor")
    out = Path(args.out).expanduser() if args.out else None
    if args.cdp or args.browser:
        report = field.control(
            sites=sites, cdp_url=args.cdp, browser=args.browser or "chromium",
            out=out, settle=args.settle, timeout=args.timeout,
        )
    else:
        if not args.name:
            return _error(args, "invalid_config", "name an environment, or pass --browser/--cdp for a control run")
        name = profile.sanitize(args.name)
        profile.require(name)
        report = field.run(name, sites=sites, out=out, settle=args.settle, timeout=args.timeout)
    if args.json:
        print(json.dumps(report, indent=2, ensure_ascii=False))
        return 0 if all(row["verdict"] in {"reached", "cleared"} for row in report["sites"]) else 1
    print(table(report["sites"], [("host", "HOST"), ("vendor", "VENDOR"), ("verdict", "VERDICT"),
                                 ("http_status", "HTTP"), ("markers", "MARKERS"), ("interactive", "AX")]))
    for row in report["sites"]:
        if row.get("error"):
            print(f"  {row['host']}: {row['error']}")
        elif row.get("markers"):
            print(f"  {row['host']}: {', '.join(row['markers'])}")
    print(f"[evidence] {report['output']}")
    return 0 if all(row["verdict"] in {"reached", "cleared"} for row in report["sites"]) else 1


def cmd_doctor(args: argparse.Namespace) -> int:
    report = audit.doctor()
    if args.json:
        print(json.dumps(report, indent=2, ensure_ascii=False))
        return 0
    for item in report["checks"]:
        print(f"  {item['result'].ljust(6)} {item['check']}: {item['detail']}")
    return 0


# --------------------------------------------------------------------------- wiring


class _ArgumentParser(argparse.ArgumentParser):
    def error(self, message: str) -> None:
        raise ValueError(message)


def build_parser() -> argparse.ArgumentParser:
    parser = _ArgumentParser(prog="anti-trace", description="Anti-tracking, anti-censorship browser environments with agent automation")
    sub = parser.add_subparsers(dest="command", required=True)

    def add(name: str, help_text: str) -> argparse.ArgumentParser:
        return sub.add_parser(name, help=help_text)

    p = add("setup", "install the Camoufox runtime and calibrate fonts")
    p.add_argument("--skip-fonts", action="store_true")
    p.set_defaults(func=cmd_setup)

    p = add("create", "create an environment with a pinned identity")
    p.add_argument("name")
    p.add_argument("--runtime", choices=["camoufox", "obscura", "lightpanda"], default="camoufox")
    p.add_argument("--seed", help="stable seed text or 16..64-byte hexadecimal seed")
    p.add_argument("--overrides", default="{}", help="JSON object or @FILE")
    p.add_argument("--native-binary", help="explicit executable; native defaults may use ANTI_TRACE_<RUNTIME>_BINARY")
    p.add_argument("--proxy", help="proxy URL, DIRECT, or env:VARIABLE (credentials remain private)")
    p.add_argument("--egress-policy", choices=["strict", "observe"], default="strict")
    p.add_argument("--allow-private-network", action="store_true")
    p.add_argument("--os", choices=["macos", "windows", "linux"])
    p.add_argument("--cores", type=int)
    p.add_argument("--fonts", default="host", help="host (coherent) or subset:N (per-environment canvas text)")
    p.add_argument("--font-file",action="append",default=[],help="native runtime font file; repeat to replace the host font bundle")
    p.add_argument("--webrtc", choices=["spoof", "block"], help="Camoufox WebRTC policy")
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
    p.add_argument("--include-credentials", action="store_true")
    p.add_argument("--json", action="store_true")
    p.set_defaults(func=cmd_export)

    p = add("import", "restore an archived environment")
    p.add_argument("archive")
    p.add_argument("--name")
    p.add_argument("--proxy", help="replacement proxy URL, DIRECT, or env:VARIABLE")
    p.add_argument("--native-binary")
    p.add_argument("--json", action="store_true")
    p.set_defaults(func=cmd_import)

    p = add("migrate", "explicitly migrate a stopped same-runtime environment or restore a snapshot")
    p.add_argument("name")
    p.add_argument("--native-binary")
    p.add_argument("--overrides", help="JSON object or @FILE")
    p.add_argument("--rollback", help="migration snapshot to restore")
    p.add_argument("--json", action="store_true")
    p.set_defaults(func=cmd_migrate)

    p = add("control", "inspect or change exclusive human/agent control")
    p.add_argument("name")
    p.add_argument("control_command", choices=["status", "pause", "resume", "reclaim", "cancel"])
    p.add_argument("--json", action="store_true")
    p.set_defaults(func=cmd_control)

    p = add("viewer", "open the private same-runtime pixel viewer")
    p.add_argument("name")
    p.add_argument("--json", action="store_true")
    p.set_defaults(func=cmd_viewer)

    p = add("axtree", "observe bounded elements in the current page or selected frame")
    p.add_argument("name")
    p.add_argument("--frame", help="CSS selector for a child frame")
    p.add_argument("--json", action="store_true")
    p.set_defaults(func=cmd_exec, action="axtree", values=[], timeout=None, main_world=False)

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
    p.add_argument("--frame", help="CSS selector for axtree's child frame")
    p.set_defaults(func=cmd_exec)

    p = add("audit", "verify what the environment presents and leaks")
    p.add_argument("name")
    p.add_argument("--local", action="store_true", help="identity coherence and stability")
    p.add_argument("--headers", action="store_true", help="classify the headers actually sent")
    p.add_argument("--echo-url", help="trusted server echo URL for independently observed request headers")
    p.add_argument("--leaks", action="store_true", help="WebRTC/DNS/IP leak pages")
    p.add_argument("--fp", action="store_true", help="AmIUnique fingerprint page")
    p.add_argument("--all", action="store_true")
    p.add_argument("--json", action="store_true")
    p.set_defaults(func=cmd_audit)

    p = add("attach", "register a browser you launched yourself (CDP)")
    p.add_argument("name")
    p.add_argument("--cdp", required=True, help="ws:// or http:// devtools endpoint")
    p.add_argument("--json", action="store_true")
    p.set_defaults(func=cmd_attach)

    p = add("run", "run a trusted async Python file against an existing environment")
    p.add_argument("name")
    p.add_argument("script", help="trusted FILE.py defining async main(page, context, tools)")
    p.add_argument("--args", default="{}", help="JSON input available as tools.args")
    p.add_argument("--max-output-bytes", type=int, default=1048576)
    p.add_argument("--json", action="store_true")
    p.add_argument("--timeout", type=float, default=300.0)
    p.set_defaults(func=cmd_run)

    p = add("measure", "run the same async Python file on a control browser")
    p.add_argument("script", help="trusted FILE.py defining async main(page, context, tools)")
    p.add_argument("--args", default="{}", help="JSON input available as tools.args")
    p.add_argument("--timeout", type=float, default=300.0)
    p.add_argument("--max-output-bytes", type=int, default=1048576)
    p.add_argument("--browser", choices=["chromium"], help="launch an installed Chrome/Brave/Edge control")
    p.add_argument("--cdp", help="attach to an existing CDP endpoint (Fury, Chrome, Cloak)")
    p.add_argument("--headful", action="store_true")
    p.add_argument("--out", help="directory for screenshots")
    p.add_argument("--json", action="store_true")
    p.set_defaults(func=cmd_measure)

    p = add("field", "visit strict sites and keep human-reviewable evidence")
    p.add_argument("name", nargs="?")
    p.add_argument("--sites", help="comma-separated URLs (default: the four vendor sites)")
    p.add_argument("--site-config", help="private JSON site array with optional trusted receipt metadata")
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
    arguments = list(argv) if argv is not None else sys.argv[1:]
    args = argparse.Namespace(json="--json" in arguments)
    try:
        parser = build_parser()
        args = parser.parse_args(arguments)
        return args.func(args)
    except (profile.ProfileError, native_spec.NativeError, net.NetworkError, ValueError, OSError, client.EngineError) as exc:
        code = getattr(exc, "code", None)
        if not code:
            prefix = str(exc).split(":", 1)[0]
            code = prefix if prefix in {"busy", "identity_collision", "incompatible_profile", "capability_unavailable", "network_unavailable", "invalid_config"} else (
                "network_unavailable" if isinstance(exc, net.NetworkError) else "invalid_config")
        return _error(args, code, str(exc))
    except KeyboardInterrupt:
        return 130


if __name__ == "__main__":
    sys.exit(main())
