"""Attached environments: a browser we did not launch.

Fury, Chrome, Brave, Obscura and Lightpanda expose CDP. Registering one lets the
same `run` / `field` / `audit` commands score it without owning its lifecycle.
Every call pays one CDP connection; that cost is the price of not daemonising a
browser whose identity we do not control.
"""

from __future__ import annotations

import asyncio
from pathlib import Path
from typing import Any

from . import actions, profile

RECORDED_HEADERS: list[dict[str, Any]] = []


async def _call(cdp_url: str, action: str, args: dict[str, Any], workdir: Path, timeout: float) -> dict[str, Any]:
    from playwright.async_api import async_playwright

    async with async_playwright() as play:
        browser = await play.chromium.connect_over_cdp(cdp_url)
        try:
            context = browser.contexts[0] if browser.contexts else await browser.new_context()
            page = context.pages[0] if context.pages else await context.new_page()

            if action == "headers":
                seen: list[dict[str, Any]] = []
                tasks: list[asyncio.Task[Any]] = []

                def record(request: Any) -> None:
                    if getattr(request, "resource_type", "") != "document":
                        return

                    async def collect() -> None:
                        try:
                            headers = await request.all_headers()
                        except Exception:  # noqa: BLE001 - fall back to what is exposed
                            headers = dict(request.headers)
                        # HTTP/2 pseudo-headers (":authority") are framing, not identity.
                        seen.append({"url": request.url,
                                     "headers": {k: v for k, v in headers.items() if not k.startswith(":")}})

                    tasks.append(asyncio.create_task(collect()))

                context.on("request", record)
                target = page.url if str(page.url).startswith("http") else "https://example.com/"
                try:
                    await page.goto(target, wait_until="domcontentloaded", timeout=int(timeout * 1000))
                except Exception as exc:  # noqa: BLE001 - reported, not fatal
                    return {"status": "unsupported", "action": "headers",
                            "reason": f"navigation failed: {exc}"}
                for task in tasks:
                    await task
                seen = [row for row in seen if row["headers"]]
                if not seen:
                    return {"status": "unsupported", "action": "headers",
                            "reason": "this browser emits document requests with no headers over CDP"}
                return {"status": "ok", "action": "headers", "requests": seen[-10:]}

            if action == "info":
                return {"status": "ok", "action": "info", "url": page.url, "title": await page.title(),
                        "pages": len(context.pages), "mode": "attached", "cdp": cdp_url}

            if action == "stop":
                return {"status": "ok", "action": "stop", "message": "attached browser is owned externally"}

            if action == "run":
                from .runner import ScriptOperations, run_script
                operations = ScriptOperations(context,active_page=lambda:page,axtree=actions.axtree)
                return await run_script(args.get("path",""),args.get("args"),execute=operations.execute,
                    timeout=float(args.get("timeout",timeout)),max_output_bytes=int(args.get("max_output_bytes",1048576)))
            if action in {"viewer","control"} or str(args.get("target","")).startswith("@"):
                raise actions.ActionError("persistent control and references require a managed session",code="capability_unavailable")
            return await actions.run(page,action,args,workdir)
        finally:
            await browser.close()


def call(name: str, action: str, args: dict[str, Any] | None = None, timeout: float = 90.0) -> dict[str, Any]:
    from .client import EngineError

    cfg = profile.require(name)
    cdp = str(cfg.get("cdp") or "")
    if not cdp:
        raise profile.ProfileError(f"{name} is an attached environment without a cdp endpoint")
    try:
        return asyncio.run(_call(cdp, action, args or {}, profile.profile_dir(name), timeout))
    except EngineError:
        raise
    except Exception as exc:  # noqa: BLE001 - a dead endpoint must not crash callers
        raise EngineError(f"cannot reach the attached browser at {cdp}: {exc}") from exc


def attach(name: str, cdp: str) -> dict[str, Any]:
    cdp = cdp.strip()
    if not cdp.startswith(("ws://", "wss://", "http://", "https://")):
        raise profile.ProfileError("--cdp needs a ws:// or http:// endpoint")
    cfg = profile.load_config(name) or {}
    if cfg.get("mode") == "managed":
        raise profile.ProfileError(f"{name} is a managed environment; pick another name")
    cfg.update({"schema": 2, "name": name, "mode": "attached", "cdp": cdp})
    cfg.setdefault("created_at", __import__("time").strftime("%Y-%m-%dT%H:%M:%SZ", __import__("time").gmtime()))
    profile.save_config(name, cfg)
    profile.save_state(name, {"status": "READY", "mode": "attached", "cdp": cdp})
    return {"status": "ok", "environment": name, "mode": "attached", "cdp": cdp}
