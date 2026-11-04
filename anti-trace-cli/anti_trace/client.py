"""Unix-socket client for a running environment daemon."""

from __future__ import annotations

import json
import socket
from pathlib import Path
from typing import Any

from . import profile


class EngineError(RuntimeError):
    pass


def running(name: str) -> dict[str, Any] | None:
    state = profile.load_state(name)
    if state and state.get("mode") == "attached" and state.get("cdp"):
        return state
    if not state:
        return None
    pid = state.get("pid") or 0
    socket_file = state.get("socket")
    if not pid or not profile.pid_alive(pid) or not socket_file or not Path(socket_file).exists():
        if state.get("status") != "STARTING":
            profile.clear_state(name)
        return None
    return state


def call(name: str, action: str, args: dict[str, Any] | None = None, timeout: float = 60.0) -> dict[str, Any]:
    cfg = profile.load_config(name) or {}
    if cfg.get("mode") == "attached":
        from . import attached

        return attached.call(name, action, args, timeout=max(timeout, 90.0))
    state = running(name)
    if state is None:
        raise EngineError(f"environment {name!r} is not running; start it with: anti-trace start {name}")
    payload = json.dumps({"action": action, "args": args or {}}).encode() + b"\n"
    with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as sock:
        sock.settimeout(timeout)
        try:
            sock.connect(state["socket"])
            sock.sendall(payload)
            chunks = bytearray()
            while True:
                block = sock.recv(65536)
                if not block:
                    break
                chunks += block
                if chunks.endswith(b"\n"):
                    break
        except socket.timeout as exc:
            raise EngineError(f"engine did not answer '{action}' within {timeout:.0f}s") from exc
        except OSError as exc:
            raise EngineError(f"cannot reach the engine for {name!r}: {exc}") from exc
    try:
        response = json.loads(chunks.decode() or "{}")
    except ValueError as exc:
        raise EngineError(f"malformed engine reply: {bytes(chunks[:200])!r}") from exc
    if response.get("status") == "error":
        raise EngineError(str(response.get("message") or "engine error"))
    return response


def info(name: str) -> dict[str, Any]:
    return call(name, "info", timeout=15.0)


def stop(name: str) -> dict[str, Any]:
    return call(name, "stop", timeout=15.0)
