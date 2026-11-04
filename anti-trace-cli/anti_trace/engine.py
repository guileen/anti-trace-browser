"""Environment daemon: opens one browser context, serves one local socket."""

from __future__ import annotations

import asyncio
import json
import logging
import os
import sys
import time
from pathlib import Path
from typing import Any

from . import actions, identity, net, profile

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
    proxy = net.parse_proxy(network.get("proxy"))

    config: dict[str, Any] = {"navigator.hardwareConcurrency": int(ident.get("cores") or identity.host_cores())}
    screen = list(ident.get("screen") or [])
    window = dict(ident.get("window") or {})
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
    if egress.get("timezone"):
        config["timezone"] = egress["timezone"]
    if network.get("webrtc") != "block" and egress.get("ip"):
        config["webrtc:ipv4" if ":" not in egress["ip"] else "webrtc:ipv6"] = egress["ip"]

    prefs: dict[str, Any] = {
        "permissions.default.camera": 2,
        "permissions.default.microphone": 2,
        "permissions.default.geo": 2,
        "privacy.donottrackheader.enabled": False,
    }
    if proxy and proxy["server"].startswith("socks"):
        prefs["network.proxy.socks_remote_dns"] = True

    kwargs: dict[str, Any] = {
        "executable_path": executable,
        "headless": headless,
        "os": ident.get("os") or identity.host_os(),
        "fingerprint": ident.get("fingerprint"),
        "config": config,
        "firefox_user_prefs": prefs,
        "locale": [egress["locale"]] if egress.get("locale") else None,
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
        self.name = name
        self.headless = headless
        self.initial_url = initial_url
        self.verify = verify
        self.playwright: Any = None
        self.context: Any = None
        self.active: Any = None
        self.server: asyncio.AbstractServer | None = None
        self.stopping = asyncio.Event()
        self.workdir = profile.profile_dir(name)

    def page(self) -> Any:
        pages = self.context.pages if self.context else []
        if self.active is not None and not self.active.is_closed():
            return self.active
        self.active = pages[-1] if pages else None
        if self.active is None:
            raise RuntimeError("no page available")
        return self.active

    async def _launch(self, cfg: dict[str, Any]) -> None:
        from camoufox.async_api import AsyncNewBrowser
        from playwright.async_api import async_playwright

        options = build_options(cfg, browser_path(), self.headless, self.workdir / "data")
        self.playwright = await async_playwright().start()
        self.context = await AsyncNewBrowser(self.playwright, from_options=options, persistent_context=True)
        self.active = self.context.pages[0] if self.context.pages else await self.context.new_page()

    async def _teardown_browser(self) -> None:
        try:
            if self.context is not None:
                await self.context.close()
        except Exception as exc:  # noqa: BLE001
            logger.warning("closing context failed: %s", exc)
        finally:
            self.context = None
            self.active = None
            if self.playwright is not None:
                await self.playwright.stop()
                self.playwright = None

    async def _observe_egress(self) -> dict[str, Any] | None:
        """Ask the browser itself where it exits from, and in which timezone."""
        probe = await self.context.new_page()
        try:
            return await net.browser_geography(probe)
        except Exception as exc:  # noqa: BLE001 - a failed probe is reported, not fatal
            logger.warning("egress probe failed: %s", exc)
            return None
        finally:
            await probe.close()

    async def start(self) -> None:
        cfg = profile.require(self.name)
        network = cfg.setdefault("network", {})
        egress = network.setdefault("egress", {})
        observed: dict[str, Any] | None = None
        coherent: bool | None = None
        follow = bool(network.get("follow_egress"))

        for attempt in range(2):
            await self._launch(cfg)
            observed = await self._observe_egress() if self.verify else None
            if observed is None:
                break

            exit_timezone = observed.get("timezone") or egress.get("timezone")
            exit_locale = identity.locale_for(observed.get("country"))
            coherent = (exit_timezone == egress.get("timezone")) and (exit_locale == egress.get("locale"))
            ip_changed = observed.get("ip") != egress.get("ip")

            egress["ip"] = observed.get("ip") or egress.get("ip")
            egress["observed_at"] = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
            egress["observed_country"] = observed.get("country")
            egress["observed_timezone"] = exit_timezone
            egress["source"] = observed.get("source")
            if follow:
                egress["timezone"] = exit_timezone
                egress["locale"] = exit_locale
                egress["country"] = observed.get("country")
                egress["city"] = observed.get("city")
                egress["latitude"] = observed.get("latitude")
                egress["longitude"] = observed.get("longitude")
                coherent = True
            profile.save_config(self.name, cfg)

            if not follow and not coherent:
                logger.warning(
                    "exit is %s (%s, %s) while the pinned identity is %s/%s; use a geographically stable "
                    "proxy or enable network.follow_egress",
                    observed.get("ip"), observed.get("country"), exit_timezone,
                    egress.get("timezone"), egress.get("locale"),
                )

            # A new exit IP also means the WebRTC address must be re-issued, so a
            # relaunch is worth exactly one attempt either way.
            if attempt == 1 or (coherent and not ip_changed):
                break
            logger.info("relaunching to bind the identity to %s", observed.get("ip"))
            await self._teardown_browser()

        if self.initial_url:
            try:
                await actions.run(self.page(), "goto", {"url": self.initial_url}, self.workdir)
            except Exception as exc:  # noqa: BLE001 - initial navigation is best effort
                logger.warning("initial navigation failed: %s", exc)

        socket_path = profile.socket_path(self.name)
        socket_path.unlink(missing_ok=True)
        self.server = await asyncio.start_unix_server(self._handle, path=str(socket_path))
        os.chmod(socket_path, 0o600)
        profile.save_state(self.name, {
            "pid": os.getpid(),
            "status": "READY",
            "socket": str(socket_path),
            "started_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
            "headless": self.headless,
            "observed_egress": (observed or {}).get("ip"),
            "egress_consistent": coherent,
            "timezone": egress.get("timezone"),
            "locale": egress.get("locale"),
            "url": self.active.url,
        })
        logger.info("ready pid=%s socket=%s egress=%s coherent=%s follow=%s",
                    os.getpid(), socket_path, (observed or {}).get("ip"), coherent, follow)

    async def _handle(self, reader: asyncio.StreamReader, writer: asyncio.StreamWriter) -> None:
        response: dict[str, Any]
        try:
            line = await reader.readline()
            request = json.loads(line or b"{}")
            action = str(request.get("action") or "")
            args = request.get("args") or {}

            if action == "info":
                page = self.page()
                response = {
                    "status": "ok",
                    "name": self.name,
                    "pid": os.getpid(),
                    "headless": self.headless,
                    "url": page.url,
                    "title": await page.title(),
                    "pages": len(self.context.pages),
                }
            elif action == "stop":
                response = {"status": "ok", "message": "stopping"}
                self.stopping.set()
            elif action == "use":
                index = int(args.get("index", -1))
                pages = self.context.pages
                if not (0 <= index < len(pages)):
                    raise RuntimeError(f"tab {index} does not exist ({len(pages)} open)")
                self.active = pages[index]
                await self.active.bring_to_front()
                response = {"status": "ok", "action": "use", "index": index, "url": self.active.url}
            else:
                response = await actions.run(self.page(), action, args, self.workdir)
                state = profile.load_state(self.name) or {}
                if state.get("url") != self.page().url:
                    state["url"] = self.page().url
                    profile.save_state(self.name, state)
        except Exception as exc:  # noqa: BLE001 - reported to the caller
            logger.exception("action failed")
            response = {"status": "error", "message": f"{type(exc).__name__}: {exc}"}

        try:
            writer.write(json.dumps(response, ensure_ascii=False, default=str).encode() + b"\n")
            await writer.drain()
        except Exception:  # noqa: BLE001 - caller may have gone away
            pass
        finally:
            writer.close()
            try:
                await writer.wait_closed()
            except Exception:  # noqa: BLE001
                pass

    async def run_forever(self) -> None:
        try:
            await self.start()
        except Exception:
            profile.clear_state(self.name)
            raise
        await self.stopping.wait()

    async def shutdown(self) -> None:
        if self.server is not None:
            self.server.close()
            try:
                await self.server.wait_closed()
            except Exception:  # noqa: BLE001
                pass
        profile.socket_path(self.name).unlink(missing_ok=True)
        try:
            if self.context is not None:
                await self.context.close()
        except Exception as exc:  # noqa: BLE001
            logger.warning("closing context failed: %s", exc)
        try:
            if self.playwright is not None:
                await self.playwright.stop()
        except Exception as exc:  # noqa: BLE001
            logger.warning("stopping playwright failed: %s", exc)
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
            "status": "STARTING",
            "started_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        })
        engine = Engine(args.profile, args.headless, args.url, verify=not args.no_verify)

        async def main() -> None:
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
            profile.clear_state(args.profile)
            return 1
    return 0


if __name__ == "__main__":
    sys.exit(run_cli())
