"""Unix-socket client for a running environment daemon."""

from __future__ import annotations

import json
import socket
from pathlib import Path
from typing import Any

from . import profile


class EngineError(RuntimeError):
    def __init__(self, message: str, *, code: str = "engine_error"):
        super().__init__(message)
        self.code = code


def running(name: str) -> dict[str, Any] | None:
    state = profile.load_state(name)
    if state and state.get("mode") == "attached" and state.get("cdp"):
        return state
    if not state:
        return None
    if not profile.owner_alive(state):
        return None
    # The owner can remain alive after its IPC socket closes during shutdown.
    socket_file = state.get("socket")
    if state.get("status") != "READY" or not socket_file or not Path(socket_file).exists():
        return None
    return state


def call(name: str, action: str, args: dict[str, Any] | None = None, timeout: float = 60.0) -> dict[str, Any]:
    cfg = profile.load_config(name) or {}
    if cfg.get("mode") == "attached":
        from . import attached

        return attached.call(name, action, args, timeout=max(timeout, 90.0))
    state = running(name)
    if state is None:
        raise EngineError(f"environment {name!r} is not running; start it with: anti-trace start {name}", code="not_running")
    payload = json.dumps({"action": action, "args": args or {}}, ensure_ascii=False, allow_nan=False).encode() + b"\n"
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
            raise EngineError(f"engine did not answer '{action}' within {timeout:.0f}s", code="timeout") from exc
        except OSError as exc:
            raise EngineError(f"cannot reach the engine for {name!r}: {exc}", code="engine_unavailable") from exc
    try:
        response = json.loads(chunks.decode() or "{}")
    except ValueError as exc:
        raise EngineError("malformed engine reply", code="protocol_error") from exc
    if not isinstance(response, dict):
        raise EngineError("engine reply must be a JSON object", code="protocol_error")
    # Script failures are terminal evidence, not transport failures. Keep all
    # completed actions and side-effect uncertainty in the report.
    if response.get("status") == "error" and not (action == "run" and response.get("run_id")):
        error = response.get("error") or {}
        if not isinstance(error, dict):
            error = {}
        raise EngineError(str(response.get("message") or error.get("message") or "engine error"),
                          code=str(response.get("code") or error.get("code") or "engine_error"))
    return response


def info(name: str) -> dict[str, Any]:
    return call(name, "info", timeout=15.0)


def stop(name: str) -> dict[str, Any]:
    return call(name, "stop", timeout=15.0)
