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

from . import actions, identity, net, profile
from .runner import OPERATION_SPECS, ScriptOperations, run_script
from .viewer import ControlError, ControlState, ViewerServer

logger = logging.getLogger("anti_trace.engine")


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
    from .native_spec import resolve_proxy
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


class Engine:
    def __init__(self, name: str, headless: bool, initial_url: str | None, verify: bool = True):
        self.name,self.initial_url,self.verify = name,initial_url,verify
        self.headless,self.gui = True,not headless
        self.playwright: Any = None
        self.native: Any = None
        self.context: Any = None
        self.active: Any = None
        self.server: asyncio.AbstractServer | None = None
        self.stopping = asyncio.Event()
        self.seen_headers: list[dict[str, Any]] = []
        self.workdir = profile.profile_dir(name)
        self.control = ControlState()
        self.operations: ScriptOperations | None = None
        self.refs = actions.RefStore(lambda page:self.operations.page_id(page),
                                    lambda:(self.control.run_revision,self.control.owner_revision))
        self.viewer: ViewerServer | None = None
        self.viewer_lock = asyncio.Lock()
        self.run_cancel: asyncio.Event | None = None
        self.run_task: asyncio.Task | None = None
        self.handlers: set[asyncio.Task] = set()
        self.receipt: dict[str, Any] = {}
        self.failed_documents: dict[Any,int] = {}
        self.failure_sequence = 0
        self.human_selection_epoch = 0
        self.run_selection_epoch = 0

    def page(self) -> Any:
        pages = self.context.pages if self.context else []
        if self.active is not None and not self.active.is_closed():
            return self.active
        self.active = pages[-1] if pages else None
        if self.active is None:
            raise actions.ActionError("no page available",code="stale_reference")
        self.control.set_page(self.operations.page_id(self.active),
                              self.refs.frame_id(getattr(self.active,"main_frame",self.active)))
        return self.active

    async def refresh_pages(self) -> None:
        refresh = getattr(self.context,"refresh_pages",None)
        if refresh:
            await refresh()

    def _record(self, request: Any) -> None:
        if request.resource_type == "document":
            self.seen_headers.append({"url":request.url,"headers":dict(request.headers)})
            del self.seen_headers[:-20]
    def _record_failure(self, request: Any) -> None:
        if request.resource_type == "document":
            self.failure_sequence += 1
            self.failed_documents[request.frame.page] = self.failure_sequence

    async def _navigation(self, page: Any, execute: Any) -> Any:
        previous = self.failed_documents.get(page)
        try:
            return await execute()
        except Exception as exc:
            if self.failed_documents.get(page) != previous:
                error = actions.ActionError("document transport failed; no navigation retry was attempted",code="network_unavailable")
                error.side_effects = "unknown"
                raise error from exc
            raise


    async def _launch(self, cfg: dict[str, Any]) -> None:
        runtime = (cfg.get("runtime") or {}).get("id")
        if runtime in {"obscura","lightpanda"}:
            from .native import launch_native
            self.native = await launch_native(self.name,cfg,self.headless)
            self.context, self.receipt = self.native.context,self.native.receipt
        elif runtime == "camoufox":
            from camoufox.async_api import AsyncNewBrowser
            from playwright.async_api import async_playwright
            identity.validate_cfox_spec(cfg)
            options = build_options(cfg,cfg["runtime"]["binary"],self.headless,self.workdir/"data")
            self.playwright = await async_playwright().start()
            self.context = await AsyncNewBrowser(self.playwright,from_options=options,persistent_context=True)
            self.context.on("requestfailed",self._record_failure)
        else:
            raise profile.ProfileError("incompatible_profile: explicit migration to a pinned schema3 runtime is required")
        self.context.on("request",self._record)
        self.active = self.context.pages[0] if self.context.pages else await self.context.new_page()
        self.operations = ScriptOperations(self.context,active_page=self.page,axtree=self._axtree)
        self.control.set_page(self.operations.page_id(self.active),
                              self.refs.frame_id(getattr(self.active,"main_frame",self.active)))

    async def _observe_egress(self) -> dict[str, Any] | None:
        probe = await self.context.new_page()
        try:
            return await net.browser_geography(probe)
        finally:
            await probe.close()

    async def start(self) -> None:
        cfg = profile.require(self.name)
        await self._launch(cfg)
        observed = None
        network = cfg.get("network") or {}
        if self.verify:
            try:
                observed = await self._observe_egress()
            except Exception as exc:
                if (network.get("proxy_ref") or network.get("proxy")) and network.get("egress_policy","strict") == "strict":
                    raise actions.ActionError("declared proxy egress could not be verified",code="network_unavailable") from exc
                logger.warning("egress observation unavailable: %s",type(exc).__name__)
        if self.initial_url:
            await self._navigation(self.page(),lambda:actions.run(
                self.page(),"goto",{"url":self.initial_url},self.workdir,refs=self.refs))
        socket_path = profile.socket_path(self.name)
        socket_path.unlink(missing_ok=True)
        self.server = await asyncio.start_unix_server(self._handle,path=str(socket_path),limit=1024*1024)
        os.chmod(socket_path,0o600)
        resolved = cfg.get("resolved") or {}
        coherent = None if not observed else observed.get("timezone") == resolved.get("timezone")
        profile.save_state(self.name,{
            "pid":os.getpid(),"process_start":profile.process_start(os.getpid()),"status":"READY",
            "socket":str(socket_path),"started_at":time.strftime("%Y-%m-%dT%H:%M:%SZ",time.gmtime()),
            "headless":self.headless,"gui":self.gui,"observed_egress":(observed or {}).get("ip"),
            "egress_consistent":coherent,"timezone":resolved.get("timezone"),"locale":resolved.get("locale"),
            "url":self.page().url,"runtime":(cfg.get("runtime") or {}).get("id"),
            "native_pid":self.native.pid if self.native else None,"receipt":self.receipt,
        })
        if self.gui:
            await self._viewer()
        logger.info("ready pid=%s socket=%s runtime=%s",os.getpid(),socket_path,(cfg.get("runtime") or {}).get("id"))

    async def _axtree(self, page: Any, **kwargs: Any) -> dict[str, Any]:
        result = await actions.axtree(page,refs=self.refs,**kwargs)
        self.control.set_observation(result["page_id"],result["frame_id"],result["observation_id"])
        return result

    async def _select(self, page: Any) -> None:
        if page is not self.active:
            await self.refs.clear()
            self.active = page
            self.control.set_page(self.operations.page_id(page),
                                  self.refs.frame_id(getattr(page,"main_frame",page)))
            await page.bring_to_front()

    async def _script_execute(self, run_id: str, operation: str, args: dict[str, Any]) -> Any:
        await self.refresh_pages()
        if operation in {"page.wait_for_timeout","page.wait_for_load_state","locator.wait_for"}:
            await self.control.wait_agent(run_id)
            return await self.operations.execute(operation,args)
        async with self.control.action("agent",run_id):
            if args.get("page_id"):
                target = self.operations.page(args["page_id"])
                if self.run_selection_epoch != self.human_selection_epoch and target is not self.page():
                    raise actions.ActionError("selected page changed during human handover; start a fresh run",code="stale_reference")
                await self._select(target)
            if operation.startswith("locator.") and len(args.get("locator",[])) == 1:
                step = args["locator"][0]
                if step.get("kind") == "css" and str(step.get("selector","")).startswith("@"):
                    node = await self.refs.resolve(self.page(),step["selector"])
                    method = operation.split(".",1)[1]
                    function = getattr(node,method,None)
                    if not function:
                        raise actions.ActionError("operation unavailable on original node",code="capability_unavailable")
                    return await function(*[args[key] for key in OPERATION_SPECS[operation]],**args.get("options",{}))
            result = await self._navigation(self.page(),lambda:self.operations.execute(operation,args)) if operation in {
                "page.goto","page.reload","page.go_back"} else await self.operations.execute(operation,args)
            if operation == "session.describe":
                result["run_id"] = run_id
            elif operation == "context.new_page":
                await self._select(self.operations.page(result["page_id"]))
            return result

    async def _run_script(self, args: dict[str, Any]) -> dict[str, Any]:
        if self.run_task is not None:
            raise ControlError("busy","a script is already running")
        run_id = "run-"+uuid.uuid4().hex
        self.control.begin_run(run_id,page_id=self.operations.page_id(self.page()),
                               frame_id=self.refs.frame_id(getattr(self.page(),"main_frame",self.page())))
        self.run_selection_epoch = self.human_selection_epoch
        self.run_task,self.run_cancel = asyncio.current_task(),asyncio.Event()
        try:
            report = await run_script(args.get("path",""),args.get("args"),
                execute=lambda op,parameters:self._script_execute(run_id,op,parameters),
                timeout=float(args.get("timeout",300)),max_output_bytes=int(args.get("max_output_bytes",1048576)),
                cancel=self.run_cancel)
            if report.get("side_effects",{}).get("state") == "unknown" or (report.get("error") or {}).get("code") in {"timeout","cancelled"}:
                self.control.pause("script_interrupted")
            return report
        finally:
            self.run_task,self.run_cancel = None,None
            self.control.finish_run(run_id)
            await self.refs.clear()

    async def _viewer(self) -> ViewerServer:
        async with self.viewer_lock:
            if self.viewer is None:
                self.viewer = ViewerServer(self.control,self._viewer_execute,title=f"{self.name} · 同会话")
                await self.viewer.start()
            return self.viewer

    async def _viewer_execute(self, operation: str, args: dict[str, Any]) -> Any:
        await self.refresh_pages()
        if operation == "viewer.pages":
            return {"pages":[{"page_id":self.operations.page_id(page),"url":page.url,"title":await page.title()}
                             for page in self.context.pages],"page_id":self.operations.page_id(self.page())}
        if operation == "viewer.frame":
            return await self.refs.viewport(self.page())
        page = self.page()
        try:
            await self.refs.validate(self.refs.visual,page)
        except actions.ActionError as exc:
            raise ControlError(exc.code,str(exc)) from exc
        if operation == "context.select_page":
            target = self.operations.page(args["target_page_id"])
            if target is not page:
                self.human_selection_epoch += 1
            await self._select(target)
        elif operation == "page.focus":
            await page.bring_to_front()
        else:
            family,method = operation.split(".",1)
            values = [args[key] for key in OPERATION_SPECS[operation]]
            options = {key:value for key,value in args.items() if key not in {
                "page_id","frame_id","observation_id","owner_revision","viewer_id","image_id",*OPERATION_SPECS[operation]}}
            await getattr(getattr(page,family),method)(*values,**options)
        self.control.invalidate_observation()
        return {"status":"ok","operation":operation}

    async def _dispatch(self, action: str, args: dict[str, Any]) -> dict[str, Any]:
        if action == "control":
            command = args.get("command","status")
            if command == "pause":
                self.control.pause()
            elif command in {"resume","reclaim"}:
                await (self.control.resume_agent if command == "resume" else self.control.reclaim)()
            elif command == "cancel":
                if self.run_cancel:
                    self.run_cancel.set()
                self.control.pause("explicit_cancel")
            elif command != "status":
                raise ControlError("invalid_config","unknown control command")
            return {"status":"ok","state":self.control.snapshot()}
        if action == "viewer":
            viewer = await self._viewer()
            return {"status":"ok","url":viewer.url,"state":self.control.snapshot()}
        if action == "run":
            return await self._run_script(args)
        if action == "headers":
            return {"status":"ok","action":"headers","requests":list(self.seen_headers[-10:])}
        if action == "info":
            page = self.page()
            return {"status":"ok","name":self.name,"pid":os.getpid(),"headless":self.headless,"gui":self.gui,
                    "url":page.url,"title":await page.title(),"pages":len(self.context.pages),
                    "control":self.control.snapshot(),"receipt":self.receipt}
        if action == "stop":
            state = profile.load_state(self.name) or {}
            state["status"] = "STOPPING"
            profile.save_state(self.name,state)
            if self.run_cancel:
                self.run_cancel.set()
            return {"status":"ok","message":"stopping"}
        if self.control.run_id is not None:
            raise ControlError("busy","a script owns this session")
        if self.control.owner != "agent":
            raise ControlError("paused","explicit resume or reclaim required")
        async with self.control.action("agent","cli"):
            await self.refresh_pages()
            if action == "use":
                index = int(args.get("index",-1))
                pages = self.context.pages
                if not 0 <= index < len(pages):
                    raise actions.ActionError("tab does not exist")
                await self._select(pages[index])
                return {"status":"ok","action":"use","index":index,"url":self.page().url}
            if action == "axtree":
                return await self._axtree(self.page(),frame=args.get("frame"))
            page = self.page()
            result = await self._navigation(page,lambda:actions.run(page,action,args,self.workdir,refs=self.refs)) if action in {
                "goto","reload","back"} else await actions.run(page,action,args,self.workdir,refs=self.refs)
            if action == "tab_new":
                await self._select(self.context.pages[result["index"]])
            state = profile.load_state(self.name) or {}
            if state.get("url") != self.page().url:
                state["url"] = self.page().url
                profile.save_state(self.name,state)
            return result

    async def _handle(self, reader: asyncio.StreamReader, writer: asyncio.StreamWriter) -> None:
        task = asyncio.current_task()
        self.handlers.add(task)
        action = ""
        try:
            async with asyncio.timeout(10):
                request = json.loads(await reader.readline())
            action,args = request.get("action"),request.get("args") or {}
            if not isinstance(action,str) or not isinstance(args,dict):
                raise actions.ActionError("invalid manager request")
            response = await self._dispatch(action,args)
        except Exception as exc:
            response = {"status":"error","code":getattr(exc,"code","operation_failed"),"message":str(exc)}
            logger.warning("action %s failed: %s",action,type(exc).__name__)
        try:
            writer.write(json.dumps(response,ensure_ascii=False,default=str).encode()+b"\n")
            await writer.drain()
        except (ConnectionError,BrokenPipeError):
            pass
        finally:
            if action == "stop":
                self.stopping.set()
            writer.close()
            try:
                await writer.wait_closed()
            except (ConnectionError,BrokenPipeError):
                pass
            self.handlers.discard(task)

    async def run_forever(self) -> None:
        await self.start()
        await self.stopping.wait()

    async def shutdown(self) -> None:
        if self.server:
            self.server.close()
            await self.server.wait_closed()
        if self.run_cancel:
            self.run_cancel.set()
        if self.run_task and self.run_task is not asyncio.current_task():
            await asyncio.wait({self.run_task},timeout=3)
        for handler in tuple(self.handlers):
            if handler is not asyncio.current_task():
                handler.cancel()
        await self.refs.clear()
        if self.viewer:
            await self.viewer.close()
        try:
            if self.native:
                await self.native.close()
            elif self.context:
                await self.context.close()
        finally:
            if self.playwright:
                await self.playwright.stop()
            self.context = self.active = None
            profile.socket_path(self.name).unlink(missing_ok=True)
            profile.clear_state(self.name)


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
