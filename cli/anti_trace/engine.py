"""Environment daemon: opens one browser context, serves one local socket."""

from __future__ import annotations

import asyncio
import json
import logging
import os
import signal
import sys
import time
import uuid
from pathlib import Path
from typing import Any

from mioa_core import net, profile
from mioa_core.control import ControlError
from mioa_core.engine import Engine as CoreEngine
from mioa_core.operations import OPERATION_SPECS, ScriptOperations
from mioa_core.refs import ActionError

from . import actions, identity
from .runner import run_script
from .viewer import ViewerServer

logger = logging.getLogger("anti_trace.engine")


_CHECKOUT_SENTINEL = Path("cli") / "pyproject.toml"
_CHECKOUT_PRODUCT = 'name = "anti-trace"'
_CHECKOUT_SEARCH_DEPTH = 32


def _is_checkout(root: Path) -> bool:
    """True only for a tree that verifiably is the anti-trace product root."""
    sentinel = root / _CHECKOUT_SENTINEL
    try:
        if not sentinel.is_file():
            return False
        return _CHECKOUT_PRODUCT in sentinel.read_text(encoding="utf-8", errors="replace")
    except OSError:
        return False


def _checkout_starts() -> tuple[Path, ...]:
    """Deterministic starts: package location, invocation, then working directory."""
    starts = [Path(__file__).resolve().parents[2]]
    for raw in (sys.argv[0] if sys.argv else "", sys.executable):
        if not raw:
            continue
        try:
            location = Path(raw).expanduser().resolve()
        except OSError:
            continue
        starts.append(location.parent if location.is_file() else location)
    try:
        starts.append(Path.cwd().resolve())
    except OSError:
        pass
    return tuple(starts)


def checkout_root() -> Path | None:
    """The ATB checkout holding Core's pinned builds, or ``None`` when absent.

    An editable install lives inside the checkout, but an installed (noneditable)
    CLI sits in site-packages, so ``parents[2]`` there is not a product root.
    Search is a bounded ancestor walk from those starts, and only a sentinel
    verified match is accepted; unrelated ``cli/pyproject.toml`` files never
    qualify, so no unrelated binary can be selected.
    """
    seen: set[Path] = set()
    for start in _checkout_starts():
        for depth, directory in enumerate((start, *start.parents)):
            if depth > _CHECKOUT_SEARCH_DEPTH:
                break
            if directory in seen:
                continue
            seen.add(directory)
            if _is_checkout(directory):
                return directory
    return None


def native_binary(runtime: str, explicit: str | None = None) -> str | Path:
    """Resolve the native executable this installation can actually run.

    Core's ``PINS`` paths are relative to the ATB checkout, but ``native_spec``
    lives in the ``core/`` submodule, so its own root cannot find these builds.
    Explicit selection wins, then ``ANTI_TRACE_<RUNTIME>_BINARY``, then the
    verified checkout's pinned build. Without an explicit choice and without a
    reachable checkout, fail as ``capability_unavailable`` instead of guessing.
    Core validates the chosen file and reports ``capability_unavailable`` when it
    is missing or not executable.
    """
    from mioa_core.native_spec import PINS, NativeError

    override = explicit or os.environ.get(f"ANTI_TRACE_{runtime.upper()}_BINARY")
    if override:
        return override
    root = checkout_root()
    if root is None:
        raise NativeError(
            "capability_unavailable",
            f"no verifiable anti-trace checkout provides the pinned {runtime} build; "
            f"pass --native-binary PATH or set ANTI_TRACE_{runtime.upper()}_BINARY",
        )
    return root / PINS[runtime][1]


def browser_path() -> str:
    """The Camoufox binary this project runs. Never downloads on its own."""
    override = os.environ.get("ANTI_TRACE_BROWSER") or os.environ.get("CAMOUFOX_EXECUTABLE_PATH")
    if override:
        if not Path(override).is_file():
            raise RuntimeError(f"ANTI_TRACE_BROWSER points at a missing file: {override}")
        return str(Path(override).resolve())
    from camoufox.pkgman import camoufox_path, launch_path

    try:
        install = camoufox_path(download_if_missing=False)
        return str(launch_path(install))
    except Exception as exc:  # noqa: BLE001 - report the fix, not the traceback
        raise RuntimeError(f"Camoufox runtime is not usable ({exc}); run 'anti-trace setup'") from exc


def build_options(
    cfg: dict[str, Any],
    executable: str,
    headless: bool,
    user_data_dir: Any = None,
) -> dict[str, Any]:
    """Launch options from the stored environment, replaying the pinned identity."""
    from camoufox.utils import launch_options

    ident = cfg.get("identity") or {}
    network = cfg.get("network") or {}
    egress = network.get("egress") or {}
    from mioa_core.native_spec import resolve_proxy
    proxy = net.parse_proxy(resolve_proxy(cfg) if network.get("proxy_ref") else network.get("proxy"))

    config: dict[str, Any] = {"navigator.hardwareConcurrency": int(ident.get("cores") or identity.host_cores())}
    screen = list(ident.get("screen") or [])
    requested = cfg.get("resolved") or cfg.get("overrides") or {}
    window = dict(ident.get("window") or {})
    if "screen_width" in requested or "screen_height" in requested:
        screen = [requested.get("screen_width", screen[0] if screen else 1280),
                  requested.get("screen_height", screen[1] if screen else 800)]
        window = identity.window_for(screen)
    if len(screen) == 2:
        width, height = int(screen[0]), int(screen[1])
        window = window or identity.window_for([width, height])
        config.update({
            "screen.width": width, "screen.height": height,
            "screen.availWidth": width, "screen.availHeight": height - 76,
            "screen.availLeft": 0, "screen.availTop": 25,
            "window.innerWidth": int(window["innerWidth"]), "window.innerHeight": int(window["innerHeight"]),
            "window.outerWidth": int(window["outerWidth"]), "window.outerHeight": int(window["outerHeight"]),
            "window.devicePixelRatio": float(ident.get("dpr") or 1),
            "window.screenX": 20, "window.screenY": 30,
        })
    timezone = requested.get("timezone") or network.get("timezone") or egress.get("timezone")
    if timezone:
        config["timezone"] = timezone
    if network.get("webrtc") != "block" and egress.get("ip"):
        config["webrtc:ipv4" if ":" not in egress["ip"] else "webrtc:ipv6"] = egress["ip"]
    field_map = {"user_agent": "navigator.userAgent", "platform": "navigator.platform",
                 "hardware_concurrency": "navigator.hardwareConcurrency",
                 "avail_width": "screen.availWidth", "avail_height": "screen.availHeight",
                 "color_depth": "screen.colorDepth", "pixel_depth": "screen.pixelDepth",
                 "device_scale_factor": "window.devicePixelRatio"}
    config.update({native: requested[key] for key, native in field_map.items() if requested.get(key) is not None})

    prefs: dict[str, Any] = {
        "permissions.default.camera": 2,
        "permissions.default.microphone": 2,
        "permissions.default.geo": 2,
        "privacy.donottrackheader.enabled": False,
    }
    for generic, family in (ident.get("font_defaults") or {}).items():
        for group in ("x-western", "x-unicode", "zh-CN", "ja", "ko", "x-cyrillic"):
            prefs[f"font.name.{generic}.{group}"] = family
    if proxy:
        prefs.update({"network.proxy.no_proxies_on":"","network.proxy.allow_hijacking_localhost":True,
                      "network.proxy.failover_direct":False})
    if proxy and proxy["server"].startswith("socks"):
        prefs["network.proxy.socks_remote_dns"] = True

    kwargs: dict[str, Any] = {
        "executable_path": executable,
        "headless": headless,
        "os": ident.get("os") or identity.host_os(),
        "fingerprint": ident.get("fingerprint"),
        "config": config,
        "firefox_user_prefs": prefs,
        "locale": requested.get("languages") or network.get("languages") or ([egress["locale"]] if egress.get("locale") else None),
        "proxy": proxy,
        "main_world_eval": True,
        "i_know_what_im_doing": True,
    }
    if ident.get("fonts"):
        kwargs["fonts"] = list(ident["fonts"])
        kwargs["custom_fonts_only"] = True
    if network.get("webrtc") == "block":
        kwargs["block_webrtc"] = True
    if user_data_dir is not None:
        kwargs["user_data_dir"] = str(user_data_dir)
    return launch_options(**kwargs)


def decode_config(options: dict[str, Any]) -> dict[str, Any]:
    """The resolved CAMOU_CONFIG that the browser will actually apply."""
    chunks = sorted(
        ((int(key.rsplit("_", 1)[1]), value)
         for key, value in (options.get("env") or {}).items()
         if key.startswith("CAMOU_CONFIG_")),
        key=lambda item: item[0],
    )
    if not chunks:
        return {}
    try:
        return json.loads("".join(value for _, value in chunks))
    except ValueError:
        return {}


class Engine(CoreEngine):
    def __init__(self, name: str, headless: bool, initial_url: str | None, verify: bool = True):
        super().__init__(name, headless, initial_url, verify)
        self.playwright: Any = None
        self.server: asyncio.AbstractServer | None = None
        self.seen_headers: list[dict[str, Any]] = []
        self.viewer: ViewerServer | None = None
        self.viewer_lock = asyncio.Lock()
        self.run_cancel: asyncio.Event | None = None
        self.run_task: asyncio.Task | None = None
        self.handlers: set[asyncio.Task] = set()

    # --- lifecycle seams -------------------------------------------------

    async def _launch(self, cfg: dict[str, Any]) -> None:
        if (cfg.get("runtime") or {}).get("id") == "camoufox":
            await self._launch_camoufox(cfg)
            return
        await super()._launch(cfg)
        # ATB attached this to every context; without it the ``headers`` action
        # silently returns an empty list.
        self.context.on("request", self._record)

    async def _launch_camoufox(self, cfg: dict[str, Any]) -> None:
        from camoufox.async_api import AsyncNewBrowser
        from playwright.async_api import async_playwright
        identity.validate_cfox_spec(cfg)
        options = build_options(cfg, cfg["runtime"]["binary"], self.headless, self.workdir / "data")
        self.playwright = await async_playwright().start()
        self.context = await AsyncNewBrowser(self.playwright, from_options=options, persistent_context=True)
        self.context.on("requestfailed", self._record_failure)
        self.context.on("request", self._record)
        await self.activate()

    async def start(self) -> None:
        # The old initial navigation went through ``actions.run(..., "goto")``,
        # which prepends the scheme for a URL without one.
        if self.initial_url and "://" not in self.initial_url and self.initial_url != "about:blank":
            self.initial_url = "https://" + self.initial_url
        socket_file = profile.socket_path(self.name)
        socket_file.unlink(missing_ok=True)
        self.server = await asyncio.start_unix_server(self._handle, path=str(socket_file), limit=1024 * 1024)
        os.chmod(socket_file, 0o600)
        try:
            # Core writes READY once; state_extra makes the manager socket part
            # of that same atomic write, so READY is never visible without it.
            await super().start(state_extra={"socket": str(socket_file)})
        except BaseException:
            self.server.close()
            await self.server.wait_closed()
            self.server = None
            socket_file.unlink(missing_ok=True)
            raise
        if self.gui:
            await self._viewer()
        logger.info("ready pid=%s socket=%s runtime=%s", os.getpid(), socket_file,
                    (profile.load_state(self.name) or {}).get("runtime"))

    async def shutdown(self) -> None:
        if self.server:
            self.server.close()
            await self.server.wait_closed()
            self.server = None
        if self.run_cancel:
            self.run_cancel.set()
        if self.run_task and self.run_task is not asyncio.current_task():
            await asyncio.wait({self.run_task}, timeout=3)
        for handler in tuple(self.handlers):
            if handler is not asyncio.current_task():
                handler.cancel()
        if self.viewer:
            await self.viewer.close()
            self.viewer = None
        try:
            await super().shutdown()
        finally:
            if self.playwright:
                await self.playwright.stop()
                self.playwright = None
            profile.socket_path(self.name).unlink(missing_ok=True)

    # --- ATB product methods ---------------------------------------------

    def _record(self, request: Any) -> None:
        if request.resource_type == "document":
            self.seen_headers.append({"url": request.url, "headers": dict(request.headers)})
            del self.seen_headers[:-20]

    def _record_failure(self, request: Any) -> None:
        if request.resource_type == "document":
            self.failure_sequence += 1
            self.failed_documents[request.frame.page] = self.failure_sequence

    async def _script_execute(self, run_id: str, operation: str, args: dict[str, Any]) -> Any:
        await self.refresh_pages()
        if operation in {"page.wait_for_timeout", "page.wait_for_load_state", "locator.wait_for"}:
            await self.control.wait_agent(run_id)
            return await self.operations.execute(operation, args)
        async with self.control.action("agent", run_id):
            if args.get("page_id"):
                target = self.operations.page(args["page_id"])
                if self.run_selection_epoch != self.human_selection_epoch and target is not self.page():
                    raise ActionError("selected page changed during human handover; start a fresh run", code="stale_reference")
                await self._select(target)
            if operation.startswith("locator.") and len(args.get("locator", [])) == 1:
                step = args["locator"][0]
                if step.get("kind") == "css" and str(step.get("selector", "")).startswith("@"):
                    node = await self.refs.resolve(self.page(), step["selector"])
                    method = operation.split(".", 1)[1]
                    function = getattr(node, method, None)
                    if not function:
                        raise ActionError("operation unavailable on original node", code="capability_unavailable")
                    return await function(*[args[key] for key in OPERATION_SPECS[operation]], **args.get("options", {}))
            result = await self._navigation(self.page(), lambda: self.operations.execute(operation, args)) if operation in {
                "page.goto", "page.reload", "page.go_back"} else await self.operations.execute(operation, args)
            if operation == "session.describe":
                result["run_id"] = run_id
            elif operation == "context.new_page":
                await self._select(self.operations.page(result["page_id"]))
            return result

    async def _run_script(self, args: dict[str, Any]) -> dict[str, Any]:
        if self.run_task is not None:
            raise ControlError("busy", "a script is already running")
        run_id = "run-" + uuid.uuid4().hex
        self.control.begin_run(run_id, page_id=self.operations.page_id(self.page()),
                               frame_id=self.refs.frame_id(getattr(self.page(), "main_frame", self.page())))
        self.run_selection_epoch = self.human_selection_epoch
        self.run_task, self.run_cancel = asyncio.current_task(), asyncio.Event()
        try:
            report = await run_script(args.get("path", ""), args.get("args"),
                execute=lambda op, parameters: self._script_execute(run_id, op, parameters),
                timeout=float(args.get("timeout", 300)), max_output_bytes=int(args.get("max_output_bytes", 1048576)),
                cancel=self.run_cancel)
            if report.get("side_effects", {}).get("state") == "unknown" or (report.get("error") or {}).get("code") in {"timeout", "cancelled"}:
                self.control.pause("script_interrupted")
            return report
        finally:
            self.run_task, self.run_cancel = None, None
            self.control.finish_run(run_id)
            await self.refs.clear()

    async def _viewer(self) -> ViewerServer:
        async with self.viewer_lock:
            if self.viewer is None:
                self.viewer = ViewerServer(self.control, self._viewer_execute, title=f"{self.name} · 同会话")
                await self.viewer.start()
            return self.viewer

    async def _dispatch(self, action: str, args: dict[str, Any]) -> dict[str, Any]:
        if action == "control":
            command = args.get("command", "status")
            if command == "pause":
                self.control.pause()
            elif command in {"resume", "reclaim"}:
                await (self.control.resume_agent if command == "resume" else self.control.reclaim)()
            elif command == "cancel":
                if self.run_cancel:
                    self.run_cancel.set()
                self.control.pause("explicit_cancel")
            elif command != "status":
                raise ControlError("invalid_config", "unknown control command")
            return {"status": "ok", "state": self.control.snapshot()}
        if action == "viewer":
            viewer = await self._viewer()
            return {"status": "ok", "url": viewer.url, "state": self.control.snapshot()}
        if action == "run":
            return await self._run_script(args)
        if action == "headers":
            return {"status": "ok", "action": "headers", "requests": list(self.seen_headers[-10:])}
        if action == "info":
            page = self.page()
            return {"status": "ok", "name": self.name, "pid": os.getpid(), "headless": self.headless, "gui": self.gui,
                    "url": page.url, "title": await page.title(), "pages": len(self.context.pages),
                    "control": self.control.snapshot(), "receipt": self.receipt}
        if action == "stop":
            state = profile.load_state(self.name) or {}
            state["status"] = "STOPPING"
            profile.save_state(self.name, state)
            if self.run_cancel:
                self.run_cancel.set()
            return {"status": "ok", "message": "stopping"}
        if self.control.run_id is not None:
            raise ControlError("busy", "a script owns this session")
        if self.control.owner != "agent":
            raise ControlError("paused", "explicit resume or reclaim required")
        async with self.control.action("agent", "cli"):
            await self.refresh_pages()
            if action == "use":
                index = int(args.get("index", -1))
                pages = self.context.pages
                if not 0 <= index < len(pages):
                    raise ActionError("tab does not exist")
                await self._select(pages[index])
                return {"status": "ok", "action": "use", "index": index, "url": self.page().url}
            if action == "axtree":
                return await self._axtree(self.page(), frame=args.get("frame"))
            page = self.page()
            result = await self._navigation(page, lambda: actions.run(page, action, args, self.workdir, refs=self.refs)) if action in {
                "goto", "reload", "back"} else await actions.run(page, action, args, self.workdir, refs=self.refs)
            if action == "tab_new":
                await self._select(self.context.pages[result["index"]])
            state = profile.load_state(self.name) or {}
            if state.get("url") != self.page().url:
                state["url"] = self.page().url
                profile.save_state(self.name, state)
            return result

    async def _handle(self, reader: asyncio.StreamReader, writer: asyncio.StreamWriter) -> None:
        task = asyncio.current_task()
        self.handlers.add(task)
        action = ""
        try:
            async with asyncio.timeout(10):
                request = json.loads(await reader.readline())
            action, args = request.get("action"), request.get("args") or {}
            if not isinstance(action, str) or not isinstance(args, dict):
                raise ActionError("invalid manager request")
            response = await self._dispatch(action, args)
        except Exception as exc:
            response = {"status": "error", "code": getattr(exc, "code", "operation_failed"), "message": str(exc)}
            logger.warning("action %s failed: %s", action, type(exc).__name__)
        try:
            writer.write(json.dumps(response, ensure_ascii=False, default=str).encode() + b"\n")
            await writer.drain()
        except (ConnectionError, BrokenPipeError):
            pass
        finally:
            if action == "stop":
                self.stopping.set()
            writer.close()
            try:
                await writer.wait_closed()
            except (ConnectionError, BrokenPipeError):
                pass
            self.handlers.discard(task)

    async def run_forever(self) -> None:
        await self.start()
        await self.stopping.wait()


def run_cli() -> int:
    import argparse

    parser = argparse.ArgumentParser(description="anti-trace environment daemon (internal)")
    parser.add_argument("--profile", required=True)
    parser.add_argument("--headless", action="store_true")
    parser.add_argument("--url", default=None)
    parser.add_argument("--no-verify", action="store_true")
    args = parser.parse_args()

    logging.basicConfig(
        level=logging.INFO,
        format="[%(asctime)s] %(levelname)s %(message)s",
        handlers=[logging.FileHandler(profile.log_path(args.profile), encoding="utf-8")],
    )

    with profile.exclusive(args.profile, timeout=0.0) as owned:
        if not owned:
            print("another process owns this environment", file=sys.stderr)
            return 3
        # Announce the start before the slow launch, so a second CLI waits
        # instead of spawning its own engine.
        profile.save_state(args.profile, {
            "pid": os.getpid(),
            "process_start": profile.process_start(os.getpid()),
            "status": "STARTING",
            "started_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        })
        engine = Engine(args.profile, args.headless, args.url, verify=not args.no_verify)

        async def main() -> None:
            loop = asyncio.get_running_loop()
            for sig in (signal.SIGTERM, signal.SIGINT):
                loop.add_signal_handler(sig, engine.stopping.set)
            try:
                await engine.run_forever()
            finally:
                await engine.shutdown()

        try:
            asyncio.run(main())
        except KeyboardInterrupt:
            return 0
        except Exception as exc:  # noqa: BLE001
            logger.exception("fatal: %s", exc)
            profile.save_state(args.profile,{"pid":os.getpid(),"process_start":profile.process_start(os.getpid()),
                "status":"ERROR","error":{"code":getattr(exc,"code","startup_failed"),"message":str(exc)}})
            return 1
    return 0


if __name__ == "__main__":
    sys.exit(run_cli())
