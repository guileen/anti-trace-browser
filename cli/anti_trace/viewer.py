"""Loopback-only, same-runtime pixel viewer and exclusive input ownership.

Manager integration (all methods run on the manager's asyncio loop)::

    control = ControlState()
    control.begin_run(run_id, page_id=page_id, frame_id=frame_id)
    async with control.action("agent", run_id):
        await perform_real_browser_operation()
    control.set_observation(page_id, frame_id, observation_id)
    viewer = ViewerServer(control, execute)
    await viewer.start()

``execute(operation, args)`` is the ONLY browser access this module performs.
Read operations:
* viewer.pages -> {pages: [{page_id, title, url}], page_id}
* viewer.frame -> {png: bytes, page_id, frame_id, observation_id, width, height,
                   viewport: {width, height}}
  PNG must be the current runtime's viewport capture, never a full-page image.
Write operations:
* mouse.click {x, y, button, click_count}; mouse.move {x, y}
* mouse.wheel {delta_x, delta_y}; keyboard.press {key}
* keyboard.insert_text {text}; page.focus {}; context.select_page {target_page_id}
Each write ALSO carries page_id/frame_id/observation_id, owner_revision, viewer_id
and image_id. The manager MUST validate those expected IDs against the live
runtime immediately before dispatch, including DOM/navigation invalidation.
The local state check cannot detect a page mutation the manager has not reported.
``action`` supports same-task, same-lease nesting so the manager can use one
write wrapper for both viewer and script operations. ``observation`` serializes
real frame capture against those writes without claiming a writing lease.

``url`` contains a bearer secret in its fragment. Return it to the local caller,
never log it. No request URL, exception or browser page content is logged here.
"""

from __future__ import annotations

import asyncio
import base64
import hmac
import json
import math
import re
import secrets
import struct
import time
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Any, AsyncIterator, Awaitable, Callable
from urllib.parse import urlsplit

Execute = Callable[[str, dict[str, Any]], Awaitable[Any]]
_MAX_FRAME_BYTES = 8 * 1024 * 1024
_MAX_REQUEST_BYTES = 32 * 1024
_MAX_VIEWERS = 8
_VIEWER_ID = re.compile(r"[A-Za-z0-9_-]{16,80}\Z")
_ASSETS = {"/": ("index.html", "text/html; charset=utf-8"),
           "/viewer.js": ("viewer.js", "text/javascript; charset=utf-8"),
           "/viewer.css": ("viewer.css", "text/css; charset=utf-8")}


class ControlError(RuntimeError):
    """A typed manager error; ``code`` is safe for a JSON error response."""

    def __init__(self, code: str, message: str):
        super().__init__(message)
        self.code = code
        self.side_effects = "none"


class ControlState:
    """Single-loop lease state; a check alone does NOT reserve an action boundary.

    ``begin_run`` and ``finish_run`` are synchronous. Ownership transitions are
    asynchronous and wait for the previously accepted action to finish. Call
    ``pause`` after uncertain/cancelled side effects. No timeout or disconnect
    silently transfers ownership back to the agent.
    """

    def __init__(self, *, page_id: str | None = None, frame_id: str | None = None):
        self.owner = "agent"
        self.owner_id: str | None = None
        self.run_id: str | None = None
        self.page_id = page_id
        self.frame_id = frame_id
        self.observation_id: str | None = None
        self.run_revision = 0
        self.owner_revision = 0
        self.page_revision = 0
        self.observation_revision = 0
        self.reason: str | None = None
        self._pending_human: str | None = None
        self._condition = asyncio.Condition()
        self._active_task: asyncio.Task[Any] | None = None
        self._active_lease: tuple[str, str] | None = None
        self._revision_event = asyncio.Event()

    def snapshot(self) -> dict[str, Any]:
        return {"owner": self.owner, "owner_id": self.owner_id,
                "run_id": self.run_id, "run_revision": self.run_revision,
                "owner_revision": self.owner_revision,
                "page_id": self.page_id, "frame_id": self.frame_id,
                "page_revision": self.page_revision,
                "observation_id": self.observation_id,
                "observation_revision": self.observation_revision,
                "pending_human": self._pending_human is not None,
                "in_flight": self._active_task is not None, "reason": self.reason}

    def begin_run(self, run_id: str, *, page_id: str | None = None,
                  frame_id: str | None = None) -> dict[str, Any]:
        if not isinstance(run_id, str) or not run_id:
            raise ControlError("invalid_config", "run_id is required")
        if self.owner != "agent" or self._pending_human:
            raise ControlError("paused", "人工接管或暂停中；请显式恢复 Agent")
        if self.run_id is not None or self._active_task is not None:
            raise ControlError("busy", "已有运行或动作尚未结束")
        self.run_id = run_id
        self.owner_id = run_id
        self.run_revision += 1
        self.owner_revision += 1
        self.reason = None
        self.invalidate_observation()
        if page_id is not None:
            self.set_page(page_id, frame_id)
        self._signal_revision()
        return self.snapshot()

    def finish_run(self, run_id: str) -> dict[str, Any]:
        if run_id != self.run_id:
            raise ControlError("stale_reference", "运行版本已改变")
        if self._active_task is not None:
            raise ControlError("busy", "动作仍在执行，不能释放运行")
        self.run_id = None
        self.run_revision += 1
        if self.owner == "agent":
            self.owner_id = None
            self.owner_revision += 1
        self.invalidate_observation()
        self._signal_revision()
        return self.snapshot()

    def set_page(self, page_id: str, frame_id: str | None) -> None:
        if (page_id, frame_id) != (self.page_id, self.frame_id):
            self.page_id, self.frame_id = page_id, frame_id
            self.page_revision += 1
            self.invalidate_observation()

    def set_observation(self, page_id: str, frame_id: str,
                        observation_id: str) -> dict[str, Any]:
        if not all(isinstance(value, str) and value for value in
                   (page_id, frame_id, observation_id)):
            raise ControlError("invalid_config", "页面、frame 和观察 ID 必须来自实际运行时")
        self.set_page(page_id, frame_id)
        if observation_id != self.observation_id:
            self.observation_id = observation_id
            self.observation_revision += 1
        return self.snapshot()

    def invalidate_observation(self) -> None:
        self.observation_id = None
        self.observation_revision += 1

    def _signal_revision(self) -> None:
        self._revision_event.set()
        self._revision_event = asyncio.Event()

    async def wait_agent(self, run_id: str | None) -> dict[str, Any]:
        """Cancellable lease wait; the runner's deadline bounds this await.

        A real run supplies its ID. ``None`` is reserved for manager operations
        outside a script. A handover does not fail a running script, but a
        changed/finished run cannot acquire the next run's writing lease.
        """
        while True:
            event = self._revision_event
            if run_id is not None and run_id != self.run_id:
                raise ControlError("stale_reference", "等待中的运行已经结束或改变")
            if self.owner == "agent" and self._pending_human is None:
                return self.snapshot()
            await event.wait()

    def pause(self, reason: str = "explicit_pause") -> dict[str, Any]:
        self.owner, self.owner_id = "paused", None
        self._pending_human = None
        self.owner_revision += 1
        self.reason = reason
        self.invalidate_observation()
        self._signal_revision()
        return self.snapshot()

    async def request_human(self, viewer_id: str) -> dict[str, Any]:
        if not isinstance(viewer_id, str) or not viewer_id:
            raise ControlError("invalid_config", "viewer_id is required")
        async with self._condition:
            if self.owner == "human":
                if self.owner_id != viewer_id:
                    raise ControlError("busy", "另一查看器持有人工控制权")
                return self.snapshot()
            if self._pending_human is not None:
                raise ControlError("busy", "人工接管请求正在等待动作边界")
            self.pause("waiting_for_action_boundary")
            self._pending_human = viewer_id
            try:
                await self._condition.wait_for(lambda: self._active_task is None)
                if self._pending_human != viewer_id:
                    raise ControlError("paused", "接管请求已断开或取消")
                self.owner, self.owner_id = "human", viewer_id
                self._pending_human = None
                self.owner_revision += 1
                self.reason = None
                self.invalidate_observation()
                self._signal_revision()
                return self.snapshot()
            except BaseException:
                if self._pending_human == viewer_id:
                    self.pause("handover_interrupted")
                raise

    async def _resume(self, run_id: str | None, reason: str) -> dict[str, Any]:
        async with self._condition:
            if run_id is not None and run_id != self.run_id:
                raise ControlError("stale_reference", "不能恢复已结束的运行")
            self.pause(reason)
            transition = self.owner_revision
            await self._condition.wait_for(lambda: self._active_task is None)
            if transition != self.owner_revision:
                raise ControlError("busy", "恢复期间控制权再次改变")
            self.owner, self.owner_id = "agent", self.run_id
            self.owner_revision += 1
            self.reason = None
            self.invalidate_observation()
            self._signal_revision()
            self._condition.notify_all()
            return self.snapshot()

    async def resume_agent(self, run_id: str | None = None) -> dict[str, Any]:
        return await self._resume(run_id, "explicit_resume")

    async def reclaim(self, run_id: str | None = None) -> dict[str, Any]:
        return await self._resume(run_id, "explicit_reclaim")

    async def disconnect(self, viewer_id: str) -> dict[str, Any]:
        async with self._condition:
            if ((self.owner == "human" and self.owner_id == viewer_id)
                    or self._pending_human == viewer_id):
                self.pause("viewer_disconnected")
                self._condition.notify_all()
            return self.snapshot()

    def check_write(self, actor: str, owner_id: str, *,
                    page_id: str | None = None, frame_id: str | None = None,
                    observation_id: str | None = None,
                    owner_revision: int | None = None) -> dict[str, Any]:
        if actor not in {"agent", "human"} or not isinstance(owner_id, str) or not owner_id:
            raise ControlError("invalid_config", "写操作必须声明 Agent 或人工所有者")
        if self.owner != actor or self._pending_human is not None:
            raise ControlError("paused", "当前控制权不允许此写操作")
        if actor == "human" and self.owner_id != owner_id:
            raise ControlError("busy", "此查看器没有人工控制权")
        if actor == "agent" and self.run_id is not None and owner_id != self.run_id:
            raise ControlError("busy", "此动作不属于当前运行")
        self._check_versions(page_id, frame_id, observation_id, owner_revision)
        return self.snapshot()

    def _check_versions(self, page_id: str | None, frame_id: str | None,
                        observation_id: str | None, owner_revision: int | None) -> None:
        for expected, actual in ((page_id, self.page_id), (frame_id, self.frame_id),
                                 (observation_id, self.observation_id),
                                 (owner_revision, self.owner_revision)):
            if expected is not None and expected != actual:
                raise ControlError("stale_reference", "页面、画面或控制版本已改变，请重新观察")

    @asynccontextmanager
    async def action(self, actor: str, owner_id: str, **versions: Any) -> AsyncIterator[None]:
        task = asyncio.current_task()
        if task is self._active_task:
            if self._active_lease != (actor, owner_id):
                raise ControlError("busy", "嵌套动作不能改变控制租约")
            self._check_versions(versions.get("page_id"), versions.get("frame_id"),
                                 versions.get("observation_id"), versions.get("owner_revision"))
            yield
            return
        expected_run = self.run_id if actor == "agent" else None
        if expected_run is not None and owner_id != expected_run:
            raise ControlError("busy", "此动作不属于当前运行")
        while True:
            if actor == "agent":
                await self.wait_agent(expected_run)
            async with self._condition:
                if actor == "agent" and (self.owner != "agent" or self._pending_human):
                    continue
                self.check_write(actor, owner_id, **versions)
                if self._active_task is not None:
                    await self._condition.wait()
                    continue
                self._active_task, self._active_lease = task, (actor, owner_id)
                break
        try:
            yield
        except asyncio.CancelledError:
            self.pause("action_cancelled_side_effects_unknown")
            raise
        finally:
            async with self._condition:
                self._active_task = self._active_lease = None
                self._condition.notify_all()

    @asynccontextmanager
    async def observation(self) -> AsyncIterator[None]:
        task = asyncio.current_task()
        if task is self._active_task:
            yield
            return
        async with self._condition:
            await self._condition.wait_for(lambda: self._active_task is None)
            self._active_task, self._active_lease = task, ("observation", "")
        try:
            yield
        finally:
            async with self._condition:
                self._active_task = self._active_lease = None
                self._condition.notify_all()


class _HTTPError(Exception):
    def __init__(self, status: int, code: str, message: str):
        super().__init__(message)
        self.status, self.code = status, code


class ViewerServer:
    """Bounded HTTP/1.1 viewer; always binds 127.0.0.1 and an OS-selected port.

    A bearer token is generated per server. Viewer IDs distinguish holders but
    are not authentication. The browser keeps the token only in JS memory and
    removes the fragment before any API call. Closing/reloading requires the
    original local URL again. Heartbeat loss pauses control after eight seconds.
    """

    def __init__(self, control: ControlState, execute: Execute, *, title: str = "同会话查看器"):
        self.control, self.execute = control, execute
        self.title = str(title)[:160]
        self._token = secrets.token_urlsafe(32)
        self._server: asyncio.AbstractServer | None = None
        self._watcher: asyncio.Task[None] | None = None
        self._handlers: set[asyncio.Task[Any]] = set()
        self._viewers: dict[str, float] = {}
        self._frames: dict[str, dict[str, Any]] = {}
        self._assets = {route: ((Path(__file__).with_name("public") / filename).read_bytes(), mime)
                        for route, (filename, mime) in _ASSETS.items()}
        self._io_lock = asyncio.Lock()
        self._closing = False
        self.origin: str | None = None

    def __repr__(self) -> str:
        return f"ViewerServer(origin={self.origin!r})"

    @property
    def url(self) -> str:
        if self.origin is None:
            raise RuntimeError("viewer is not started")
        return f"{self.origin}/#token={self._token}"

    async def start(self) -> dict[str, Any]:
        if self._server is not None:
            raise ControlError("busy", "查看器已经启动")
        if self._closing:
            raise ControlError("busy", "已关闭的查看器不能重启")
        self._server = await asyncio.start_server(self._handle, "127.0.0.1", 0, limit=16384)
        port = self._server.sockets[0].getsockname()[1]
        self.origin = f"http://127.0.0.1:{port}"
        self._watcher = asyncio.create_task(self._watch_disconnects())
        return {"url": self.url, "origin": self.origin}

    async def close(self) -> None:
        self._closing = True
        if self._server is not None:
            self._server.close()
            await self._server.wait_closed()
            self._server = None
        if self._watcher is not None:
            self._watcher.cancel()
            await asyncio.gather(self._watcher, return_exceptions=True)
            self._watcher = None
        for viewer_id in tuple(self._viewers):
            await self.control.disconnect(viewer_id)
        tasks = [task for task in self._handlers if task is not asyncio.current_task()]
        for task in tasks:
            task.cancel()
        if tasks:
            await asyncio.gather(*tasks, return_exceptions=True)
        self._viewers.clear()
        self._frames.clear()
        self._token = secrets.token_urlsafe(32)

    async def _watch_disconnects(self) -> None:
        while True:
            await asyncio.sleep(1)
            now = time.monotonic()
            for viewer_id, last_seen in tuple(self._viewers.items()):
                if now - last_seen > 8:
                    await self.control.disconnect(viewer_id)
                    self._viewers.pop(viewer_id, None)
                    self._frames.pop(viewer_id, None)

    async def _call(self, operation: str, args: dict[str, Any]) -> Any:
        try:
            async with asyncio.timeout(20):
                result = await self.execute(operation, args)
        except TimeoutError as exc:
            if not operation.startswith("viewer."):
                self.control.pause("input_timeout_side_effects_unknown")
            raise ControlError("timeout", "运行时操作超时；未确认的输入保持暂停") from exc
        if isinstance(result, dict) and result.get("status") == "error":
            error = result.get("error")
            if isinstance(error, dict):
                raise ControlError(str(error.get("code") or "runtime_error"),
                                   str(error.get("message") or "运行时操作失败")[:1024])
            raise ControlError(str(result.get("code") or "runtime_error"),
                               str(error or "运行时操作失败")[:1024])
        return result

    def _authenticate(self, method: str, headers: dict[str, str]) -> str:
        if headers.get("host") != self.origin.removeprefix("http://"):
            raise _HTTPError(403, "forbidden", "Host 不匹配")
        origin = headers.get("origin")
        if (origin is not None and origin != self.origin) or (method == "POST" and origin != self.origin):
            raise _HTTPError(403, "forbidden", "只允许查看器同源请求")
        if headers.get("sec-fetch-site", "none") not in {"same-origin", "none"}:
            raise _HTTPError(403, "forbidden", "拒绝跨站请求")
        supplied = headers.get("authorization", "")
        if not hmac.compare_digest(supplied, f"Bearer {self._token}"):
            raise _HTTPError(401, "unauthorized", "请使用本次会话的本地查看器链接")
        viewer_id = headers.get("x-viewer-id", "")
        if not _VIEWER_ID.fullmatch(viewer_id):
            raise _HTTPError(400, "invalid_config", "缺少合法查看器 ID")
        if viewer_id not in self._viewers and len(self._viewers) >= _MAX_VIEWERS:
            raise _HTTPError(429, "busy", "查看器连接数已达上限")
        self._viewers[viewer_id] = time.monotonic()
        return viewer_id

    async def _handle(self, reader: asyncio.StreamReader, writer: asyncio.StreamWriter) -> None:
        task = asyncio.current_task()
        if self._closing or len(self._handlers) >= 16:
            writer.close()
            await writer.wait_closed()
            return
        self._handlers.add(task)
        try:
            async with asyncio.timeout(5):
                raw = await reader.readuntil(b"\r\n\r\n")
                if len(raw) > 16384:
                    raise _HTTPError(431, "invalid_config", "请求头过大")
                lines = raw.decode("ascii").split("\r\n")
                method, target, version = lines[0].split(" ")
                if version != "HTTP/1.1" or method not in {"GET", "POST"}:
                    raise _HTTPError(405, "invalid_config", "仅接受 GET/POST HTTP/1.1")
                if len(target) > 2048:
                    raise _HTTPError(414, "invalid_config", "请求路径过长")
                headers: dict[str, str] = {}
                for line in lines[1:]:
                    if not line:
                        continue
                    key, value = line.split(":", 1)
                    key = key.lower()
                    if not re.fullmatch(r"[a-z0-9!#$%&'*+.^_`|~-]+", key) or key in headers:
                        raise _HTTPError(400, "invalid_config", "请求头重复或格式错误")
                    headers[key] = value.strip()
                if "transfer-encoding" in headers or "expect" in headers:
                    raise _HTTPError(400, "invalid_config", "不接受分块请求")
                length = int(headers.get("content-length", "0"))
                if not 0 <= length <= _MAX_REQUEST_BYTES or (method == "GET" and length):
                    raise _HTTPError(413, "invalid_config", "请求体过大或方法不匹配")
                parsed = urlsplit(target)
                if parsed.scheme or parsed.netloc or parsed.query or parsed.fragment or not target.startswith("/"):
                    raise _HTTPError(400, "invalid_config", "无效请求路径")
                route = parsed.path
                if headers.get("host") != self.origin.removeprefix("http://"):
                    raise _HTTPError(403, "forbidden", "Host 不匹配")
                viewer_id = self._authenticate(method, headers) if route.startswith("/api/") else None
                body = await reader.readexactly(length)
            if route in self._assets and method == "GET":
                data, mime = self._assets[route]
                await self._respond(writer, 200, data, mime)
            elif viewer_id is not None:
                if method == "POST":
                    if headers.get("content-type", "").split(";", 1)[0].strip() != "application/json":
                        raise _HTTPError(415, "invalid_config", "仅接受 JSON 请求体")
                    try:
                        payload = json.loads(body)
                    except (UnicodeDecodeError, ValueError) as exc:
                        raise _HTTPError(400, "invalid_config", "JSON 格式错误") from exc
                    if not isinstance(payload, dict):
                        raise _HTTPError(400, "invalid_config", "请求必须是 JSON 对象")
                else:
                    payload = {}
                await self._api(writer, method, route, viewer_id, payload)
            else:
                raise _HTTPError(404, "not_found", "不存在的查看器路径")
        except ControlError as exc:
            status = 409 if exc.code in {"paused", "busy", "stale_reference"} else 400
            await self._error(writer, status, exc.code, str(exc))
        except _HTTPError as exc:
            await self._error(writer, exc.status, exc.code, str(exc))
        except (asyncio.IncompleteReadError, ConnectionError, BrokenPipeError):
            pass
        except (ValueError, UnicodeDecodeError, asyncio.LimitOverrunError):
            await self._error(writer, 400, "invalid_config", "请求格式错误")
        except TimeoutError:
            await self._error(writer, 408, "timeout", "请求读取超时")
        except asyncio.CancelledError:
            raise
        except Exception as exc:
            code = getattr(exc, "code", "runtime_error")
            await self._error(writer, 500, str(code), str(exc)[:1024] or "运行时操作失败")
        finally:
            writer.close()
            try:
                await writer.wait_closed()
            except (ConnectionError, BrokenPipeError):
                pass
            self._handlers.discard(task)

    async def _api(self, writer: asyncio.StreamWriter, method: str, route: str,
                   viewer_id: str, payload: dict[str, Any]) -> None:
        if method == "GET" and route == "/api/state":
            await self._json(writer, {"state": self.control.snapshot(), "viewer_id": viewer_id,
                                      "title": self.title})
        elif method == "GET" and route == "/api/pages":
            async with self.control.observation():
                result = await self._call("viewer.pages", {})
            if not isinstance(result, dict) or not isinstance(result.get("pages"), list):
                raise ControlError("verification_failed", "运行时没有提供真实标签页列表")
            pages = [{"page_id": str(page["page_id"])[:256],
                      "title": str(page.get("title") or "未命名页面")[:256],
                      "url": str(page.get("url") or "")[:2048]}
                     for page in result["pages"][:100] if isinstance(page, dict) and page.get("page_id")]
            await self._json(writer, {"pages": pages, "page_id": result.get("page_id"),
                                      "state": self.control.snapshot()})
        elif method == "GET" and route == "/api/frame":
            async with self._io_lock:
                async with self.control.observation():
                    result = await self._call("viewer.frame", {})
                    png, frame = self._make_frame(result)
                    frame["state"] = self.control.set_observation(
                        frame["page_id"], frame["frame_id"], frame["observation_id"])
                    self._frames[viewer_id] = frame
                metadata = base64.b64encode(self._encode(frame)).decode("ascii")
                await self._respond(writer, 200, png, "image/png", {"X-Viewer-Frame": metadata})
        elif method == "POST" and route == "/api/control":
            operation = payload.get("operation")
            if operation == "request_human":
                state = await self.control.request_human(viewer_id)
            elif operation in {"resume_agent", "reclaim"}:
                # A different viewer cannot silently steal an active human lease.
                state = self.control.snapshot()
                if state["owner"] == "human" and state["owner_id"] != viewer_id:
                    raise ControlError("busy", "另一查看器持有人工控制权")
                if payload.get("owner_revision") != state["owner_revision"]:
                    raise ControlError("stale_reference", "控制版本已改变，请刷新")
                transition = self.control.resume_agent if operation == "resume_agent" else self.control.reclaim
                state = await transition(payload.get("run_id"))
            elif operation == "disconnect":
                state = await self.control.disconnect(viewer_id)
                self._viewers.pop(viewer_id, None)
            else:
                raise ControlError("invalid_config", "未知控制操作")
            self._frames.pop(viewer_id, None)
            await self._json(writer, {"state": state})
        elif method == "POST" and route == "/api/action":
            async with self._io_lock:
                expected, args = self._validate_action(viewer_id, payload)
                async with self.control.action("human", viewer_id, **expected):
                    # Recheck image freshness after waiting for a safe boundary.
                    self._validate_action(viewer_id, payload)
                    result = await self._call(payload["operation"], args)
                self._frames.pop(viewer_id, None)
            await self._json(writer, {"result": result, "state": self.control.snapshot()})
        else:
            raise _HTTPError(404, "not_found", "不存在的查看器 API")

    def _make_frame(self, result: Any) -> tuple[bytes, dict[str, Any]]:
        if not isinstance(result, dict):
            raise ControlError("capability_unavailable", "运行时未提供页面 PNG")
        png = result.get("png")
        if (not isinstance(png, bytes) or not 24 <= len(png) <= _MAX_FRAME_BYTES
                or png[:8] != b"\x89PNG\r\n\x1a\n" or png[12:16] != b"IHDR"):
            raise ControlError("verification_failed", "页面画面必须是有界的真实 PNG 字节")
        width, height = struct.unpack(">II", png[16:24])
        if not 0 < width <= 16384 or not 0 < height <= 16384 or width * height > 32_000_000:
            raise ControlError("verification_failed", "页面 PNG 尺寸超出查看器限制")
        if result.get("width", width) != width or result.get("height", height) != height:
            raise ControlError("verification_failed", "PNG 与运行时画面尺寸不匹配")
        viewport = result.get("viewport")
        if not isinstance(viewport, dict):
            raise ControlError("verification_failed", "缺少运行时 CSS viewport 尺寸")
        vw, vh = viewport.get("width"), viewport.get("height")
        if not self._number(vw, 1, 16384) or not self._number(vh, 1, 16384):
            raise ControlError("verification_failed", "无效运行时 viewport")
        if abs(width / height - vw / vh) > max(0.01, 2 / height):
            raise ControlError("verification_failed", "截图不是当前 viewport，拒绝错误坐标映射")
        for key in ("page_id", "frame_id", "observation_id"):
            if not isinstance(result.get(key), str) or not 0 < len(result[key]) <= 256:
                raise ControlError("verification_failed", "缺少实际页面/frame/观察标识")
        frame = {key: result[key] for key in ("page_id", "frame_id", "observation_id")}
        frame.update({"image_id": secrets.token_urlsafe(18), "width": width, "height": height,
                      "viewport": {"width": vw, "height": vh}, "captured_at": time.time()})
        return png, frame

    @staticmethod
    def _number(value: Any, minimum: float, maximum: float) -> bool:
        return (isinstance(value, (int, float)) and not isinstance(value, bool)
                and math.isfinite(value) and minimum <= value <= maximum)

    def _validate_action(self, viewer_id: str, payload: dict[str, Any]) -> tuple[dict[str, Any], dict[str, Any]]:
        frame = self._frames.get(viewer_id)
        if frame is None or payload.get("image_id") != frame["image_id"]:
            raise ControlError("stale_reference", "画面已过时，请等待下一帧后再操作")
        expected = {key: payload.get(key) for key in
                    ("page_id", "frame_id", "observation_id", "owner_revision")}
        if any(payload.get(key) != frame[key] for key in ("page_id", "frame_id", "observation_id")):
            raise ControlError("stale_reference", "动作与所见画面的页面/frame/观察不匹配")
        if not isinstance(expected["owner_revision"], int) or isinstance(expected["owner_revision"], bool):
            raise ControlError("stale_reference", "缺少控制版本")
        self.control.check_write("human", viewer_id, **expected)
        operation, supplied = payload.get("operation"), payload.get("args")
        if not isinstance(supplied, dict):
            raise ControlError("invalid_config", "动作参数必须为对象")
        args: dict[str, Any] = {}
        if operation in {"mouse.click", "mouse.move"}:
            for key, maximum in (("x", frame["viewport"]["width"]), ("y", frame["viewport"]["height"])):
                value = supplied.get(key)
                if not self._number(value, 0, maximum) or value >= maximum:
                    raise ControlError("invalid_config", "坐标超出当前 CSS viewport")
                args[key] = value
            if operation == "mouse.click":
                button, count = supplied.get("button", "left"), supplied.get("click_count", 1)
                if button not in {"left", "middle", "right"} or type(count) is not int or count not in {1, 2, 3}:
                    raise ControlError("invalid_config", "无效鼠标按钮或点击次数")
                args.update(button=button, click_count=count)
        elif operation == "mouse.wheel":
            for key in ("delta_x", "delta_y"):
                if not self._number(supplied.get(key), -10000, 10000):
                    raise ControlError("invalid_config", "无效滚轮位移")
                args[key] = supplied[key]
        elif operation == "keyboard.press":
            key = supplied.get("key")
            if not isinstance(key, str) or not 0 < len(key) <= 100 or any(ord(char) < 32 for char in key):
                raise ControlError("invalid_config", "无效按键")
            args["key"] = key
        elif operation == "keyboard.insert_text":
            text = supplied.get("text")
            if not isinstance(text, str) or not text or len(text.encode("utf-8")) > 8192 or "\x00" in text:
                raise ControlError("invalid_config", "文本为空、过大或包含无效字符")
            args["text"] = text
        elif operation == "context.select_page":
            target = supplied.get("target_page_id")
            if not isinstance(target, str) or not 0 < len(target) <= 256:
                raise ControlError("invalid_config", "缺少实际目标标签页 ID")
            args["target_page_id"] = target
        elif operation != "page.focus":
            raise ControlError("invalid_config", "未允许的查看器输入操作")
        args.update(expected)
        args.update(viewer_id=viewer_id, image_id=frame["image_id"])
        return expected, args

    @staticmethod
    def _encode(value: Any) -> bytes:
        return json.dumps(value, ensure_ascii=False, allow_nan=False, separators=(",", ":")).encode("utf-8")

    async def _json(self, writer: asyncio.StreamWriter, value: Any) -> None:
        await self._respond(writer, 200, self._encode(value), "application/json; charset=utf-8")

    async def _error(self, writer: asyncio.StreamWriter, status: int, code: str, message: str) -> None:
        if writer.is_closing():
            return
        try:
            # Even rejected unauthenticated requests must not expose session IDs.
            body = self._encode({"error": {"code": code, "message": message}})
            await self._respond(writer, status, body, "application/json; charset=utf-8")
        except (ConnectionError, BrokenPipeError, TimeoutError):
            pass

    async def _respond(self, writer: asyncio.StreamWriter, status: int, body: bytes,
                       mime: str, extra: dict[str, str] | None = None) -> None:
        labels = {200: "OK", 400: "Bad Request", 401: "Unauthorized", 403: "Forbidden",
                  404: "Not Found", 405: "Method Not Allowed", 408: "Request Timeout",
                  409: "Conflict", 413: "Content Too Large", 414: "URI Too Long",
                  415: "Unsupported Media Type", 429: "Too Many Requests",
                  431: "Request Header Fields Too Large", 500: "Internal Server Error"}
        headers = {"Content-Type": mime, "Content-Length": str(len(body)),
                   "Connection": "close", "Cache-Control": "no-store", "Pragma": "no-cache",
                   "Referrer-Policy": "no-referrer", "X-Content-Type-Options": "nosniff",
                   "X-Frame-Options": "DENY", "Cross-Origin-Resource-Policy": "same-origin",
                   "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
                   "Content-Security-Policy": "default-src 'none'; script-src 'self'; style-src 'self'; "
                   "img-src blob:; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'"}
        headers.update(extra or {})
        head = f"HTTP/1.1 {status} {labels.get(status, 'Error')}\r\n"
        head += "".join(f"{key}: {value}\r\n" for key, value in headers.items()) + "\r\n"
        writer.write(head.encode("ascii"))
        writer.write(body)
        async with asyncio.timeout(5):
            await writer.drain()
