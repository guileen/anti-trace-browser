"""Internal subprocess entry point for runner; not an alternate CLI.

Script API: async main(page, context, tools). Navigation, evaluation, locator
conditions and actions, mouse/keyboard, new pages and cookies are forwarded to
the real manager. Locators are lazy and chainable; .first/.last/.nth select a
real locator, not an axtree index. ``await context.refresh_pages()`` refreshes
``context.pages`` and their last observed ``page.url``/``page.is_closed()``
snapshots after external tab changes. ``await page.goto`` returns a JSON
navigation receipt, not a live Playwright Response. ``page.screenshot`` returns
bytes; final main return values must be strictly JSON (no bytes/NaN/objects).
Unsupported methods are not advertised and never emulated with fake results.

``tools.args``, ``tools.run_id``, ``tools.operations`` and bounded
``await tools.axtree(page=page, max_elements=300, max_text=120)`` are helpers.
No exec/eval/import of browser observations occurs in this module. The trusted
script itself retains the current user's filesystem and process privileges.
"""

from __future__ import annotations

import argparse
import asyncio
import base64
import importlib.util
from importlib.machinery import SourceFileLoader
import inspect
import os
from pathlib import Path
import select
import signal
import socket
import sys
import traceback
import threading
from typing import Any

# The worker is launched by absolute filename so it also works from a source
# checkout without relying on the caller's current directory or PYTHONPATH.
from runner import (MAX_ELEMENTS, MAX_TEXT, PROTOCOL_VERSION, ScriptError,
                    _json_bytes, _read_frame, _write_frame)

_THIS_FILE = str(Path(__file__).resolve())


class _LocalSourceLoader(SourceFileLoader):
    def get_code(self, fullname: str):
        # Compile the requested file bytes, never a stale same-size/mtime pyc.
        return self.source_to_code(self.get_data(self.path), self.path)


def _location() -> dict[str, Any] | None:
    frame = inspect.currentframe()
    try:
        while frame is not None:
            filename, module = frame.f_code.co_filename, frame.f_globals.get("__name__","")
            if filename != _THIS_FILE and not filename.startswith("<") and not module.startswith("asyncio"):
                return {"path":str(Path(filename).resolve()),"line":frame.f_lineno,"function":frame.f_code.co_name}
            frame = frame.f_back
    finally:
        del frame
    task = asyncio.current_task()
    for filename,line,function in getattr(task.get_coro() if task else None,"cr_origin",()) or ():
        if filename != _THIS_FILE and not filename.startswith("<") and "/asyncio/" not in filename:
            return {"path":str(Path(filename).resolve()),"line":line,"function":function}
    return None


def _exception_location(exc: BaseException) -> dict[str, Any] | None:
    if isinstance(exc, SyntaxError):
        return {"path": exc.filename, "line": exc.lineno, "column": exc.offset}
    entries = traceback.extract_tb(exc.__traceback__)
    for entry in reversed(entries):
        if entry.filename != _THIS_FILE:
            return {"path": str(Path(entry.filename).resolve()), "line": entry.lineno,
                    "function": entry.name}
    return None




class _Channel:
    def __init__(self, reader: asyncio.StreamReader, writer: asyncio.StreamWriter, limit: int):
        self.reader = reader
        self.writer = writer
        self.limit = limit
        self.sequence = 0
        self.run_id: str | None = None
        self.lock = asyncio.Lock()
        self.failure: ScriptError | None = None
        self.finishing = False

    async def call(self, operation: str, args: dict[str, Any]) -> Any:
        # The lock spans both send and response. A gather()/TaskGroup cannot
        # queue browser writes past a human-handover or failure boundary.
        async with self.lock:
            if self.failure is not None:
                raise self.failure
            if self.finishing:
                raise ScriptError("script_finished", "script main has already returned")
            self.sequence += 1
            try:
                await _write_frame(self.writer, {
                    "type": "action", "sequence": self.sequence, "operation": operation,
                    "run_id": self.run_id, "page_id": args.get("page_id"),
                    "args": args, "location": _location(),
                }, self.limit)
                reply = await _read_frame(self.reader, self.limit)
                if reply.get("type") != "reply" or reply.get("sequence") != self.sequence:
                    raise ScriptError("protocol_error", "out-of-order action response")
                if reply.get("status") != "ok":
                    error = reply.get("error") or {}
                    raise ScriptError(error.get("code", "operation_failed"), error.get("message", "operation failed"))
                if reply.get("encoding") == "base64":
                    return base64.b64decode(reply["value"], validate=True)
                if reply.get("encoding") != "json":
                    raise ScriptError("protocol_error", "unknown result encoding")
                return reply.get("value")
            except BaseException as exc:
                # Cancellation during a request leaves completion uncertain. No
                # later coroutine may reuse a channel with an unread response.
                self.failure = exc if isinstance(exc, ScriptError) else ScriptError(
                    "cancelled" if isinstance(exc, asyncio.CancelledError) else "channel_failed", str(exc))
                raise


class _LocatorMethods:
    def locator(self, selector: str) -> Locator:
        return Locator(self._page, [*self._steps, {"kind": "css", "selector": selector}])

    def get_by_role(self, role: str, *, name: str | None = None, exact: bool = False) -> Locator:
        if name is not None and not isinstance(name, str):
            raise TypeError("get_by_role name must be a string; regular expressions are not supported")
        return Locator(self._page, [*self._steps, {"kind": "role", "role": role, "name": name, "exact": exact}])

    def get_by_text(self, text: str, *, exact: bool = False) -> Locator:
        if not isinstance(text, str):
            raise TypeError("get_by_text requires a string; regular expressions are not supported")
        return Locator(self._page, [*self._steps, {"kind": "text", "text": text, "exact": exact}])


class Locator(_LocatorMethods):
    def __init__(self, page: Page, steps: list[dict[str, Any]]):
        self._page = page
        self._steps = steps

    @property
    def first(self) -> Locator:
        return self.nth(0)

    @property
    def last(self) -> Locator:
        return self.nth(-1)

    def nth(self, index: int) -> Locator:
        if type(index) is not int:
            raise TypeError("locator index must be an integer")
        return Locator(self._page, [*self._steps, {"kind": "nth", "index": index}])

    async def _call(self, method: str, options: dict[str, Any], **fields: Any) -> Any:
        return await self._page._channel.call("locator." + method, {
            "page_id": self._page.page_id, "locator": self._steps, "options": options, **fields,
        })

    async def click(self, **options: Any) -> None:
        await self._call("click", options)

    async def fill(self, value: str, **options: Any) -> None:
        await self._call("fill", options, value=value)

    async def press(self, key: str, **options: Any) -> None:
        await self._call("press", options, key=key)

    async def hover(self, **options: Any) -> None:
        await self._call("hover", options)

    async def check(self, **options: Any) -> None:
        await self._call("check", options)

    async def uncheck(self, **options: Any) -> None:
        await self._call("uncheck", options)

    async def select_option(self, values: Any = None, **options: Any) -> list[str]:
        return await self._call("select_option", options, values=values)

    async def wait_for(self, **options: Any) -> None:
        await self._call("wait_for", options)

    async def count(self) -> int:
        return await self._call("count", {})

    async def is_visible(self, **options: Any) -> bool:
        return await self._call("is_visible", options)

    async def is_enabled(self, **options: Any) -> bool:
        return await self._call("is_enabled", options)

    async def inner_text(self, **options: Any) -> str:
        return await self._call("inner_text", options)

    async def text_content(self, **options: Any) -> str | None:
        return await self._call("text_content", options)

    async def input_value(self, **options: Any) -> str:
        return await self._call("input_value", options)

    async def get_attribute(self, name: str, **options: Any) -> str | None:
        return await self._call("get_attribute", options, name=name)

    async def all_text_contents(self) -> list[str]:
        return await self._call("all_text_contents", {})


class _Input:
    def __init__(self, page: Page, family: str):
        self.page = page
        self.family = family

    async def _call(self, method: str, options: dict[str, Any], **fields: Any) -> Any:
        return await self.page._channel.call(self.family + "." + method, {
            "page_id": self.page.page_id, "options": options, **fields,
        })

    async def down(self, key: str | None = None, **options: Any) -> None:
        if self.family == "keyboard":
            if key is None:
                raise TypeError("keyboard.down needs a key")
            await self._call("down", options, key=key)
        else:
            if key is not None:
                raise TypeError("mouse.down uses keyword options")
            await self._call("down", options)

    async def up(self, key: str | None = None, **options: Any) -> None:
        if self.family == "keyboard":
            if key is None:
                raise TypeError("keyboard.up needs a key")
            await self._call("up", options, key=key)
        else:
            if key is not None:
                raise TypeError("mouse.up uses keyword options")
            await self._call("up", options)


class Mouse(_Input):
    async def click(self, x: float, y: float, **options: Any) -> None:
        await self._call("click", options, x=x, y=y)

    async def move(self, x: float, y: float, **options: Any) -> None:
        await self._call("move", options, x=x, y=y)

    async def wheel(self, delta_x: float, delta_y: float) -> None:
        await self._call("wheel", {}, delta_x=delta_x, delta_y=delta_y)


class Keyboard(_Input):
    async def press(self, key: str, **options: Any) -> None:
        await self._call("press", options, key=key)

    async def type(self, text: str, **options: Any) -> None:
        await self._call("type", options, text=text)

    async def insert_text(self, text: str) -> None:
        await self._call("insert_text", {}, text=text)


class Page(_LocatorMethods):
    def __init__(self, context: Context, descriptor: dict[str, Any]):
        self.context = context
        self._channel = context._channel
        self._page = self
        self._steps: list[dict[str, Any]] = []
        self.page_id = descriptor["page_id"]
        self.url = descriptor.get("url", "")
        self._closed = descriptor.get("closed", False)
        self.mouse = Mouse(self, "mouse")
        self.keyboard = Keyboard(self, "keyboard")

    async def _call(self, method: str, options: dict[str, Any], **fields: Any) -> Any:
        result = await self._channel.call("page." + method, {
            "page_id": self.page_id, "options": options, **fields,
        })
        if method in {"goto", "reload", "go_back"} and isinstance(result, dict) and "url" in result:
            self.url = result["url"]
        return result

    async def goto(self, url: str, **options: Any) -> dict[str, Any] | None:
        return await self._call("goto", options, url=url)

    async def evaluate(self, expression: str, arg: Any = None) -> Any:
        return await self._call("evaluate", {}, expression=expression, arg=arg)

    async def title(self) -> str:
        return await self._call("title", {})

    async def screenshot(self, **options: Any) -> bytes:
        return await self._call("screenshot", options)

    async def wait_for_load_state(self, state: str = "load", **options: Any) -> None:
        await self._call("wait_for_load_state", options, state=state)

    async def wait_for_timeout(self, timeout: float) -> None:
        await self._call("wait_for_timeout", {}, timeout=timeout)

    async def reload(self, **options: Any) -> dict[str, Any] | None:
        return await self._call("reload", options)

    async def go_back(self, **options: Any) -> dict[str, Any] | None:
        return await self._call("go_back", options)

    async def bring_to_front(self) -> None:
        await self._call("bring_to_front", {})

    async def close(self, **options: Any) -> None:
        await self._call("close", options)
        self._closed = True
        self.context.pages = [page for page in self.context.pages if page is not self]

    def is_closed(self) -> bool:
        return self._closed


class Context:
    def __init__(self, channel: _Channel, descriptors: list[dict[str, Any]]):
        self._channel = channel
        self._known: dict[str, Page] = {}
        self.pages: list[Page] = []
        self._update(descriptors)

    def _update(self, descriptors: list[dict[str, Any]]) -> None:
        pages = []
        current = {item["page_id"] for item in descriptors}
        for page_id, page in self._known.items():
            if page_id not in current:
                page._closed = True
        for item in descriptors:
            page_id = item["page_id"]
            if page_id not in self._known:
                self._known[page_id] = Page(self, item)
            page = self._known[page_id]
            page.url = item.get("url", "")
            page._closed = item.get("closed", False)
            pages.append(page)
        self.pages = pages

    async def refresh_pages(self) -> list[Page]:
        self._update(await self._channel.call("context.pages", {}))
        return list(self.pages)

    async def new_page(self) -> Page:
        descriptor = await self._channel.call("context.new_page", {})
        page = Page(self, descriptor)
        self._known[page.page_id] = page
        self.pages.append(page)
        return page

    async def cookies(self, urls: str | list[str] | None = None) -> list[dict[str, Any]]:
        if isinstance(urls, str):
            urls = [urls]
        return await self._channel.call("context.cookies", {"urls": urls})


class Tools:
    def __init__(self, channel: _Channel, page: Page, bootstrap: dict[str, Any]):
        self._channel = channel
        self._page = page
        self.args = bootstrap["args"]
        self.run_id = bootstrap["run_id"]
        self.operations = tuple(bootstrap["operations"])

    async def axtree(self, *, page: Page | None = None,
                     max_elements: int = MAX_ELEMENTS, max_text: int = MAX_TEXT) -> dict[str, Any]:
        if type(max_elements) is not int or not 1 <= max_elements <= MAX_ELEMENTS:
            raise ValueError(f"max_elements must be between 1 and {MAX_ELEMENTS}")
        if type(max_text) is not int or not 1 <= max_text <= MAX_TEXT:
            raise ValueError(f"max_text must be between 1 and {MAX_TEXT}")
        return await self._channel.call("tools.axtree", {
            "page_id": (page or self._page).page_id,
            "max_elements": max_elements, "max_text": max_text,
        })

def _watch_parent() -> None:
    """A killed manager cannot leave its separately grouped script writing."""
    parent = int(os.environ.pop("ANTI_TRACE_SCRIPT_PARENT_PID"))
    def stop_owned_group() -> None:
        if os.getpgrp() == os.getpid():
            os.killpg(os.getpid(),signal.SIGKILL)
        os._exit(71)
    if os.getppid() != parent:
        stop_owned_group()
    if hasattr(select,"kqueue"):
        queue = select.kqueue()
        try:
            queue.control([select.kevent(parent,filter=select.KQ_FILTER_PROC,
                flags=select.KQ_EV_ADD|select.KQ_EV_ONESHOT,fflags=select.KQ_NOTE_EXIT)],0,0)
        except ProcessLookupError:
            stop_owned_group()
        def wait_exit() -> None:
            try:
                queue.control(None,1,None)
                stop_owned_group()
            finally:
                queue.close()
    elif hasattr(os,"pidfd_open"):
        try:
            descriptor = os.pidfd_open(parent)
        except ProcessLookupError:
            stop_owned_group()
        def wait_exit() -> None:
            try:
                select.select([descriptor],[],[])
                stop_owned_group()
            finally:
                os.close(descriptor)
    else:
        raise ScriptError("capability_unavailable","OS parent-exit notifications are required for script ownership")
    if os.getppid() != parent:
        stop_owned_group()
    threading.Thread(target=wait_exit,name="script-owner",daemon=True).start()



async def _main(fd: int, path: Path) -> int:
    token = os.environ.pop("ANTI_TRACE_SCRIPT_TOKEN")
    limit = int(os.environ.pop("ANTI_TRACE_SCRIPT_FRAME_LIMIT"))
    _watch_parent()
    sys.set_coroutine_origin_tracking_depth(8)
    sock = socket.socket(fileno=fd)
    # Avoid leaking the authenticated control channel to script subprocesses.
    sock.set_inheritable(False)
    reader, writer = await asyncio.open_connection(sock=sock)
    channel = _Channel(reader, writer, limit)
    try:
        await _write_frame(writer, {"type": "hello", "protocol": PROTOCOL_VERSION, "token": token}, limit)
        bootstrap = await _read_frame(reader, limit)
        del token
        if bootstrap.get("type") != "ready":
            raise ScriptError("protocol_error", "missing script bootstrap")
        channel.run_id = bootstrap["run_id"]
        context = Context(channel, bootstrap["session"]["pages"])
        page_id = bootstrap["session"]["page_id"]
        if page_id not in context._known:
            raise ScriptError("verification_failed", "selected page is absent from session metadata")
        page = context._known[page_id]
        tools = Tools(channel, page, bootstrap)
        arguments = tools.args
        sys.argv = [str(path), *(arguments if isinstance(arguments, list) and all(isinstance(item, str) for item in arguments) else [])]
        sys.path.insert(0, str(path.parent))
        result: dict[str, Any]
        try:
            module_name = "_anti_trace_user_" + tools.run_id
            spec = importlib.util.spec_from_file_location(
                module_name, path, loader=_LocalSourceLoader(module_name, str(path)))
            if spec is None or spec.loader is None:
                raise ScriptError("invalid_config", "cannot import script")
            module = importlib.util.module_from_spec(spec)
            sys.modules[spec.name] = module
            spec.loader.exec_module(module)
            main = getattr(module, "main", None)
            if not inspect.iscoroutinefunction(main):
                raise ScriptError("invalid_config", "script must define async def main(page, context, tools)")
            value = await main(page, context, tools)
            # Stop background page tasks before finalizing. Already dispatched
            # work must reach its boundary; queued writes see finishing=True.
            channel.finishing = True
            async with channel.lock:
                if channel.failure is not None:
                    raise channel.failure
                try:
                    _json_bytes(value)
                except (TypeError, ValueError, RecursionError) as exc:
                    raise ScriptError("invalid_result", "main must return a JSON-serializable value without NaN or Infinity") from exc
                result = {"type": "result", "status": "ok", "value": value}
                if len(_json_bytes(result)) > limit:
                    raise ScriptError("output_limit", "final JSON result exceeds the channel output limit")
        except BaseException as exc:
            channel.finishing = True
            result = {"type": "result", "status": "error", "error": {
                "code": exc.code if isinstance(exc, ScriptError) else "script_failed",
                "message": str(exc)[:2048], "type": type(exc).__name__,
            }, "location": _exception_location(exc)}
        # Import errors and failed actions also wait for an outstanding action,
        # rather than interleave a final result with a pending channel response.
        async with channel.lock:
            await _write_frame(writer, result, limit)
            reply = await _read_frame(reader, limit)
            if reply.get("type") != "finished":
                raise ScriptError("protocol_error", "missing final result acknowledgement")
        return 0
    finally:
        writer.close()
        await writer.wait_closed()


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="anti-trace trusted script worker (internal)")
    parser.add_argument("--fd", type=int, required=True)
    parser.add_argument("--script", type=Path, required=True)
    options = parser.parse_args()
    raise SystemExit(asyncio.run(_main(options.fd, options.script)))
