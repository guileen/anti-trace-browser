"""Run one trusted async Python file against an unmodified control browser.

Uses the same supervised runner and real-object ScriptOperations as managed
environments. CDP attachment never retries a failed action on another context.
"""

from __future__ import annotations

import asyncio
import os
import time
from pathlib import Path
from typing import Any

from mioa_core.operations import ScriptOperations

from . import actions
from .runner import run_script


def chromium_executable() -> str | None:
    """A real Chromium-family browser the user installed.

    Playwright's bundled Chrome for Testing is deliberately excluded: it reports
    HeadlessChrome and navigator.webdriver, so its numbers say nothing about the
    Chromium population.
    """
    candidates = [
        os.environ.get("ANTI_TRACE_CHROMIUM") or "",
        *[os.path.expanduser(f"~/Applications/{name}.app/Contents/MacOS/{name}") for name in
          ("Google Chrome", "Brave Browser", "Microsoft Edge")],
        "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
        "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
        "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
        "/usr/bin/google-chrome",
        "/usr/bin/chromium",
    ]
    for candidate in candidates:
        if candidate and Path(candidate).is_file():
            return candidate
    return None



async def measure(
    path: str | Path,
    cdp_url: str | None = None,
    browser: str | None = None,
    headless: bool = True,
    workdir: Path | None = None,
    args: Any = None,
    timeout: float = 300.0,
    max_output_bytes: int = 1048576,
) -> dict[str, Any]:
    from playwright.async_api import async_playwright

    if bool(cdp_url) == bool(browser):
        raise ValueError("measure needs exactly one of --cdp URL or --browser chromium")
    directory = (workdir or Path.cwd()).resolve()
    directory.mkdir(parents=True, exist_ok=True)
    started = time.monotonic()
    async with async_playwright() as play:
        if cdp_url:
            connected = await play.chromium.connect_over_cdp(cdp_url)
            context = connected.contexts[0] if connected.contexts else await connected.new_context()
            page = context.pages[0] if context.pages else await context.new_page()
            target = {"mode": "cdp", "cdp_url": cdp_url}
        elif browser == "chromium":
            executed = chromium_executable()
            if not executed:
                raise ValueError(
                    "no installed Chromium found; install Chrome/Brave/Edge, set ANTI_TRACE_CHROMIUM, "
                    "or attach with --cdp. Playwright's Chrome for Testing is deliberately not used."
                )
            launched = await play.chromium.launch(headless=headless, executable_path=executed)
            context = await launched.new_context()
            page = await context.new_page()
            target = {"mode": "launch", "browser": "chromium", "headless": headless,
                      "executable": executed,
                      "profile": "unmodified Chromium with automation defaults - a control, not a hardened browser"}
        else:
            raise ValueError("measure needs --cdp URL or --browser chromium")
        active = [page]
        async def snapshot(target_page: Any, *, max_elements: int, max_text: int) -> dict[str, Any]:
            return await actions.axtree(target_page, max_elements=max_elements, max_text=max_text)
        operations = ScriptOperations(context, active_page=lambda: active[0], axtree=snapshot)
        async def execute(operation: str, parameters: dict[str, Any]) -> Any:
            if operation == "page.screenshot" and (parameters.get("options") or {}).get("path"):
                destination = Path(parameters["options"]["path"]).expanduser()
                if not destination.is_absolute():
                    destination = directory / destination
                parameters = {**parameters, "options": {**parameters["options"], "path": str(destination)}}
            result = await operations.execute(operation, parameters)
            if operation == "page.bring_to_front":
                active[0] = operations.page(parameters["page_id"])
            return result
        try:
            metadata = {"user_agent": await page.evaluate("navigator.userAgent"),
                        "webdriver": await page.evaluate("navigator.webdriver")}
            report = await run_script(path, args, execute=execute, timeout=timeout,
                                      max_output_bytes=max_output_bytes)
            report.update(metadata)
            report["target"] = target
        finally:
            if cdp_url:
                await connected.close()
            else:
                await launched.close()
    report["seconds"] = round(time.monotonic() - started, 2)
    return report


def run_sync(**kwargs: Any) -> dict[str, Any]:
    return asyncio.run(measure(**kwargs))
