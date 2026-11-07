"""Trusted local Python scripts, supervised independently of browser ownership.

``await run_script(path, args, execute=..., timeout=300,
max_output_bytes=1048576, cancel=None)`` imports ``async main(page, context,
tools)`` in one owned subprocess. ``args`` is JSON and is available as
``tools.args`` (also as ``sys.argv[1:]`` when it is a list of strings).
This is not a Python sandbox: only explicitly trusted local .py files belong
here. Page contents are data; they are never imported or evaluated as Python.

The single authenticated socketpair carries length-prefixed JSON. execute is
an async callback, invoked serially, and MUST check the engine's control lease
at each operation boundary. It may wait for explicit human-to-agent resume;
no later operation is dispatched in the meantime. Exceptions are terminal,
including when caught by the script. A callback may expose ``code`` and
``side_effects`` attributes; ``paused`` is reported distinctly. If an operation
is interrupted, its side effects are unknown and the engine must keep control
paused until reconciliation. Only the script's process group is terminated.

``ScriptOperations`` is optional real-object dispatch for that callback. The
engine wraps ``operations.execute`` in its lease, and supplies its authoritative
bounded axtree callback. No DOM, network, storage or browser is created here.
``OPERATION_SPECS`` is the complete advertised protocol subset. Method kwargs
are in ``options``; locator steps select real objects, never page-generated
Python. All page IDs are stable for the lifetime of ScriptOperations.

max_output_bytes bounds the combined captured stdout/stderr, JSON action
receipts and final JSON result. Protocol/error envelope metadata is separate
and bounded. An oversized action result is represented by its actual byte
count and digest, then execution stops with output_limit; it is not a success
value delivered to the script. Screenshot bytes use the same budget. Evidence
never includes fill values, cookie values or evaluate arguments implicitly.
"""

from __future__ import annotations

import asyncio
import base64
import hashlib
import hmac
import inspect
import json
import math
import os
from pathlib import Path
import secrets
import signal
import socket
import struct
import sys
import time
from typing import Any, Awaitable, Callable
import uuid

from mioa_core.operations import MAX_ELEMENTS, MAX_TEXT, OPERATION_SPECS, ScriptError

Execute = Callable[[str, dict[str, Any]], Awaitable[Any]]
PROTOCOL_VERSION = 1


_READ_ONLY = {
    "session.describe", "context.pages", "context.cookies", "page.title",
    "page.wait_for_load_state", "page.wait_for_timeout", "tools.axtree",
    "locator.wait_for", "locator.count", "locator.is_visible", "locator.is_enabled",
    "locator.inner_text", "locator.text_content", "locator.input_value",
    "locator.get_attribute", "locator.all_text_contents",
}





def _json_bytes(value: Any) -> bytes:
    return json.dumps(value, ensure_ascii=False, allow_nan=False, separators=(",", ":")).encode("utf-8")


def _wire_value(value: Any) -> Any:
    return base64.b64encode(value).decode("ascii") if isinstance(value, bytes) else value


async def _read_frame(reader: asyncio.StreamReader, limit: int) -> dict[str, Any]:
    size = struct.unpack("!I", await reader.readexactly(4))[0]
    if size == 0 or size > limit:
        raise ScriptError("protocol_error", f"channel frame size {size} exceeds {limit}")
    try:
        frame = json.loads(await reader.readexactly(size))
    except (ValueError, UnicodeError) as exc:
        raise ScriptError("protocol_error", "channel frame is not valid UTF-8 JSON") from exc
    if not isinstance(frame, dict):
        raise ScriptError("protocol_error", "channel frame must be an object")
    return frame


async def _write_frame(writer: asyncio.StreamWriter, value: dict[str, Any], limit: int) -> None:
    data = _json_bytes(value)
    if len(data) > limit:
        raise ScriptError("output_limit", f"channel frame exceeds {limit} bytes")
    writer.write(struct.pack("!I", len(data)) + data)
    await writer.drain()


def _error(exc: BaseException) -> dict[str, Any]:
    code = getattr(exc, "code", None)
    if not code:
        code = (
            "timeout" if isinstance(exc, TimeoutError) else
            "worker_exited" if isinstance(exc, asyncio.IncompleteReadError) else
            "channel_failed" if isinstance(exc, ConnectionError) else "operation_failed"
        )
    return {"code": str(code), "message": str(exc)[:2048], "type": type(exc).__name__}





class _Budget:
    def __init__(self, limit: int):
        self.limit = limit
        self.used = 0
        self.exceeded = asyncio.Event()

    def take(self, size: int) -> bool:
        if self.exceeded.is_set() or size > self.limit - self.used:
            self.exceeded.set()
            return False
        self.used += size
        return True


async def run_script(path: str | Path, args: Any, *, execute: Execute,
                     timeout: float, max_output_bytes: int,
                     cancel: asyncio.Event | Awaitable[Any] | None = None) -> dict[str, Any]:
    """Run a trusted .py file once; return ordered evidence, never retry actions.

    Status is ok/partial/error/paused/cancelled. Partial means a failed run had
    completed actions. timeout/output_limit retain their precise error codes.
    cancel is an asyncio.Event or awaitable; cancelling this coroutine also
    cleans up and returns a cancelled receipt. No browser lifecycle API is used.
    """
    run_id = uuid.uuid4().hex
    started = time.monotonic()
    report: dict[str, Any] = {
        "run_id": run_id, "status": "error", "completed": [], "result": None,
        "failed_location": None, "error": None,
        "side_effects": {"state": "none", "completed_writes": 0, "uncertain": None},
        "artifacts": [], "stdout": "", "stderr": "", "output_bytes": 0,
    }
    try:
        script = Path(path).expanduser().resolve(strict=True)
        if not script.is_file() or script.suffix != ".py":
            raise ScriptError("invalid_config", "run requires a trusted local .py file")
        if isinstance(timeout, bool) or not math.isfinite(timeout) or timeout <= 0:
            raise ScriptError("invalid_config", "timeout must be finite and positive")
        if type(max_output_bytes) is not int or max_output_bytes <= 0:
            raise ScriptError("invalid_config", "max_output_bytes must be a positive integer")
        _json_bytes(args)
        if cancel is not None and not isinstance(cancel, asyncio.Event) and not inspect.isawaitable(cancel):
            raise ScriptError("invalid_config", "cancel must be an asyncio.Event or awaitable")
    except Exception as exc:
        report["error"] = _error(exc if isinstance(exc, ScriptError) else ScriptError("invalid_config", str(exc)))
        return report

    budget = _Budget(max_output_bytes)
    frame_limit = max(65536, max_output_bytes + 8192)
    parent_sock, worker_sock = socket.socketpair()
    token = secrets.token_hex(32)
    worker = Path(__file__).with_name("script_worker.py")
    process: asyncio.subprocess.Process | None = None
    writer: asyncio.StreamWriter | None = None
    tasks: list[asyncio.Task[Any]] = []
    captures = {"stdout": bytearray(), "stderr": bytearray()}
    in_flight: dict[str, Any] | None = None
    failed: dict[str, Any] | None = None
    sequence = 0
    terminal = False
    stopping = False

    async def capture(name: str, stream: asyncio.StreamReader) -> None:
        while chunk := await stream.read(8192):
            available = max(0, budget.limit - budget.used)
            kept = chunk[:available]
            if kept and budget.take(len(kept)):
                captures[name].extend(kept)
            if len(kept) != len(chunk):
                budget.exceeded.set()

    async def conversation(reader: asyncio.StreamReader, channel: asyncio.StreamWriter) -> None:
        nonlocal in_flight, failed, sequence, terminal, run_id
        hello = await _read_frame(reader, frame_limit)
        if hello.get("type") != "hello" or hello.get("protocol") != PROTOCOL_VERSION or not hmac.compare_digest(str(hello.get("token", "")), token):
            raise ScriptError("authentication_failed", "script channel authentication failed")
        initial = await execute("session.describe", {})
        if not isinstance(initial, dict) or not initial.get("page_id") or not isinstance(initial.get("pages"), list):
            raise ScriptError("verification_failed", "session.describe must return page_id and page descriptors")
        if initial.get("run_id") is not None:
            manager_run_id = initial["run_id"]
            if not isinstance(manager_run_id, str) or not 1 <= len(manager_run_id) <= 128:
                raise ScriptError("verification_failed", "manager run_id must be a non-empty string of at most 128 characters")
            run_id = manager_run_id
            report["run_id"] = run_id
        for field in ("environment", "revision"):
            if field in initial:
                report[field] = initial[field]
        report["source"] = {"path": str(script)}
        await _write_frame(channel, {"type": "ready", "run_id": run_id, "args": args,
                                    "session": initial, "operations": list(OPERATION_SPECS)}, frame_limit)
        while True:
            frame = await _read_frame(reader, frame_limit)
            if frame.get("type") == "result":
                if frame.get("status") not in {"ok", "error"}:
                    raise ScriptError("protocol_error", "invalid script result status")
                if failed is None:
                    if frame["status"] == "error":
                        report["error"] = frame.get("error") or {"code": "script_failed", "message": "script failed"}
                        report["failed_location"] = frame.get("location")
                    else:
                        data = _json_bytes(frame.get("value"))
                        if not budget.take(len(data)):
                            raise ScriptError("output_limit", "final JSON result exceeds the remaining output budget")
                        report["result"] = frame.get("value")
                terminal = True
                await _write_frame(channel, {"type": "finished"}, frame_limit)
                return
            if frame.get("type") != "action" or failed is not None:
                raise ScriptError("protocol_error", "script sent an action after termination or an unknown frame")
            sequence += 1
            operation = frame.get("operation")
            parameters = frame.get("args")
            if frame.get("sequence") != sequence or operation not in OPERATION_SPECS or not isinstance(parameters, dict):
                raise ScriptError("protocol_error", "invalid or out-of-order script operation")
            if frame.get("run_id") != run_id or frame.get("page_id") != parameters.get("page_id"):
                raise ScriptError("protocol_error", "script action targets a different run or page")
            location = frame.get("location")
            if location is not None and (not isinstance(location, dict) or len(_json_bytes(location)) > 4096):
                raise ScriptError("protocol_error", "invalid script source location")
            record = {"sequence": sequence, "operation": operation, "page_id": parameters.get("page_id"),
                      "source": location, "status": "ok"}
            # Reserve receipt space before executing so unbounded action loops
            # stop before the next browser side effect, not after losing evidence.
            receipt_reserve = len(_json_bytes(record)) + 160
            if not budget.take(receipt_reserve):
                raise ScriptError("output_limit", "action evidence exceeds the remaining output budget")
            in_flight = record
            action_start = time.monotonic()
            try:
                value = await execute(operation, parameters)
                if stopping:
                    return
            except Exception as exc:
                if stopping:
                    return
                error = _error(exc)
                failed = {**record, "status": "error", "error": error}
                report["failed_action"] = failed
                report["error"] = error
                report["failed_location"] = location
                if operation not in _READ_ONLY and getattr(exc,"side_effects",None) != "none":
                    report["side_effects"]["uncertain"] = {"sequence": sequence, "operation": operation}
                in_flight = None
                await _write_frame(channel, {"type": "reply", "sequence": sequence, "status": "error", "error": error}, frame_limit)
                continue
            record["elapsed_ms"] = round((time.monotonic() - action_start) * 1000, 3)
            in_flight = None
            if operation not in _READ_ONLY:
                report["side_effects"]["completed_writes"] += 1
            if isinstance(value, bytes) and ((len(value) + 2) // 3) * 4 + 2 > budget.limit - budget.used:
                digest = hashlib.sha256(value).hexdigest()
                record["result"] = {
                    "omitted": "output_limit", "bytes": len(value),
                    "sha256": digest, "encoding": "binary",
                }
                report["completed"].append(record)
                if operation == "page.screenshot":
                    report["artifacts"].append({
                        "kind": "screenshot", "sequence": sequence,
                        "bytes": len(value), "sha256": digest,
                    })
                budget.exceeded.set()
                raise ScriptError("output_limit", "operation completed but its binary result exceeds the output budget")
            try:
                encoded = _wire_value(value)
                raw = _json_bytes(encoded)
            except (TypeError, ValueError, RecursionError) as exc:
                record["result"] = {"omitted": "invalid_result", "type": type(value).__name__}
                report["completed"].append(record)
                raise ScriptError("invalid_result", "operation completed but did not return JSON or screenshot bytes") from exc
            if operation == "page.screenshot" and isinstance(value, bytes):
                report["artifacts"].append({
                    "kind": "screenshot", "sequence": sequence, "bytes": len(value),
                    "sha256": hashlib.sha256(value).hexdigest(),
                })
            if not budget.take(len(raw)):
                record["result"] = {"omitted": "output_limit", "bytes": len(raw), "sha256": hashlib.sha256(raw).hexdigest()}
                report["completed"].append(record)
                raise ScriptError("output_limit", "operation completed but its result exceeds the output budget")
            record["result"] = encoded
            record["result_encoding"] = "base64" if isinstance(value, bytes) else "json"
            report["completed"].append(record)
            await _write_frame(channel, {
                "type": "reply", "sequence": sequence, "status": "ok",
                "value": encoded, "encoding": record["result_encoding"],
            }, frame_limit)

    async def cancellation() -> None:
        if isinstance(cancel, asyncio.Event):
            await cancel.wait()
        elif cancel is not None:
            await cancel
        else:
            await asyncio.Future()

    try:
        environment = os.environ.copy()
        environment["ANTI_TRACE_SCRIPT_TOKEN"] = token
        environment["ANTI_TRACE_SCRIPT_FRAME_LIMIT"] = str(frame_limit)
        environment["ANTI_TRACE_SCRIPT_PARENT_PID"] = str(os.getpid())
        process = await asyncio.create_subprocess_exec(
            sys.executable, "-u", str(worker), "--fd", str(worker_sock.fileno()), "--script", str(script),
            pass_fds=(worker_sock.fileno(),), stdin=asyncio.subprocess.DEVNULL,
            stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE,
            start_new_session=True, cwd=str(script.parent), env=environment,
        )
        worker_sock.close()
        reader, writer = await asyncio.open_connection(sock=parent_sock)
        assert process.stdout is not None and process.stderr is not None
        tasks = [asyncio.create_task(capture("stdout", process.stdout)),
                 asyncio.create_task(capture("stderr", process.stderr))]
        session_task = asyncio.create_task(conversation(reader, writer))
        cancel_task = asyncio.create_task(cancellation())
        limit_task = asyncio.create_task(budget.exceeded.wait())
        tasks += [session_task, cancel_task, limit_task]
        remaining = max(0, timeout - (time.monotonic() - started))
        done, _ = await asyncio.wait([session_task, cancel_task, limit_task], timeout=remaining,
                                     return_when=asyncio.FIRST_COMPLETED)
        if cancel_task in done:
            raise ScriptError("cancelled", "script cancellation requested")
        if limit_task in done:
            raise ScriptError("output_limit", "script output exceeds max_output_bytes")
        if session_task not in done:
            raise ScriptError("timeout", "script deadline exceeded")
        await session_task
        remaining = max(0, timeout - (time.monotonic() - started))
        try:
            await asyncio.wait_for(process.wait(), timeout=remaining)
        except TimeoutError as exc:
            raise ScriptError("timeout", "script did not exit before its deadline") from exc
        if process.returncode != 0 and report["error"] is None:
            raise ScriptError("script_failed", f"script worker exited with code {process.returncode}")
    except asyncio.CancelledError:
        report["error"] = {"code": "cancelled", "message": "script runner cancelled"}
    except Exception as exc:
        if report["error"] is None:
            report["error"] = _error(exc)
    finally:
        stopping = True
        if in_flight is not None:
            report["failed_location"] = in_flight.get("source")
            report["failed_action"] = {**in_flight, "status": "interrupted"}
            if in_flight["operation"] not in _READ_ONLY:
                report["side_effects"]["uncertain"] = {
                    "sequence": in_flight["sequence"], "operation": in_flight["operation"]}
        # Stop the command channel before tearing down the owned process group.
        # No browser PID is used or inferred from runtime ownership.
        if writer is not None:
            writer.close()
        parent_sock.close()
        worker_sock.close()
        for task in tasks[2:]:
            if not task.done():
                task.cancel()
        if process is not None:
            try:
                os.killpg(process.pid, signal.SIGTERM)
            except ProcessLookupError:
                pass
            try:
                await asyncio.wait_for(process.wait(), timeout=0.3)
            except TimeoutError:
                pass
            try:
                os.killpg(process.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
            try:
                await asyncio.wait_for(process.wait(), timeout=1)
            except TimeoutError:
                report["cleanup_error"] = "owned script process did not reap within one second"
            report["process"] = {"pid": process.pid, "returncode": process.returncode}
        if tasks:
            settled, pending = await asyncio.wait(tasks, timeout=0.3)
            for task in pending:
                task.cancel()
                task.add_done_callback(lambda finished: None if finished.cancelled() else finished.exception())
            # Consume settled exceptions, without waiting forever on a callback
            # that suppresses cancellation; that action remains explicitly unknown.
            for task in settled:
                if not task.cancelled():
                    task.exception()
            if any(task is tasks[2] for task in pending):
                report["operation_pending"] = True
        report["stdout"] = captures["stdout"].decode("utf-8", errors="replace")
        report["stderr"] = captures["stderr"].decode("utf-8", errors="replace")
        report["output_bytes"] = budget.used
        report["elapsed_ms"] = round((time.monotonic() - started) * 1000, 3)
    if budget.exceeded.is_set() and report["error"] is None:
        report["error"] = {"code": "output_limit", "message": "script output exceeds max_output_bytes"}
    effects = report["side_effects"]
    effects["state"] = "unknown" if effects["uncertain"] else "completed" if effects["completed_writes"] else "none"
    error = report["error"]
    report["status"] = (
        "cancelled" if error and error.get("code") == "cancelled" else
        "paused" if error and error.get("code") == "paused" else
        "partial" if error and report["completed"] else
        "error" if error or not terminal else "ok"
    )
    return report
