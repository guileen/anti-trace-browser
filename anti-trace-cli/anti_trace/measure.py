"""Engine-agnostic measurement: run the same steps on any browser.

Two modes:

- ``browser="chromium"`` launches the Playwright Chromium build. Useful as a
  control: it is not a hardened browser, so its numbers say what an unhidden
  automation client gets, not what the Chromium population gets.
- ``cdp_url`` attaches to a browser someone else launched (Fury, Chrome,
  CloakBrowser), which is how a third-party runtime is scored with our steps.
"""

from __future__ import annotations

import asyncio
import os
import time
from pathlib import Path
from typing import Any

from . import actions


def chromium_executable() -> str | None:
    """A real Chromium-family browser the user installed.

    Playwright's bundled Chrome for Testing is deliberately excluded: it reports
    HeadlessChrome and navigator.webdriver, so its numbers say nothing about the
    Chromium population.
    """
    candidates = [
        os.environ.get("ANTI_TRACE_CHROMIUM") or "",
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


async def _run(steps: list[dict[str, Any]], page: Any, workdir: Path) -> dict[str, Any]:
    results: list[dict[str, Any]] = []
    for index, step in enumerate(steps):
        try:
            results.append({"step": index, **await actions.run(page, str(step["action"]), step.get("args") or {}, workdir)})
        except Exception as exc:  # noqa: BLE001 - report the failing step
            results.append({"step": index, "status": "error", "action": step.get("action"), "message": str(exc)})
            return {"status": "partial", "failed_step": index, "results": results}
    return {"status": "ok", "results": results}


async def measure(
    steps: list[dict[str, Any]],
    cdp_url: str | None = None,
    browser: str | None = None,
    headless: bool = True,
    workdir: Path | None = None,
) -> dict[str, Any]:
    from playwright.async_api import async_playwright

    directory = workdir or Path.cwd()
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
        report = await _run(steps, page, directory)
        report["target"] = target
        report["user_agent"] = await page.evaluate("navigator.userAgent")
        report["webdriver"] = await page.evaluate("navigator.webdriver")
        if cdp_url:
            await connected.close()
        else:
            await launched.close()
    report["seconds"] = round(time.monotonic() - started, 2)
    return report


def run_sync(**kwargs: Any) -> dict[str, Any]:
    return asyncio.run(measure(**kwargs))
