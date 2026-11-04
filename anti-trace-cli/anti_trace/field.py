"""Experiment field: drive one environment through strict sites and keep evidence.

The four vendor-first-party sites each run their own bot defence, so they are
strict without carrying real business traffic. Every visit records what a site
could observe and what the environment had to solve, so a human can review the
raw material instead of trusting one score.
"""

from __future__ import annotations

import asyncio
import json
import time
from pathlib import Path
from typing import Any

from . import client, profile
from .measure import chromium_executable

SITES: list[dict[str, str]] = [
    {"host": "nowsecure.nl", "url": "https://nowsecure.nl/", "vendor": "Cloudflare Turnstile"},
    {"host": "kasada.io", "url": "https://www.kasada.io/", "vendor": "Kasada"},
    {"host": "humansecurity.com", "url": "https://www.humansecurity.com/", "vendor": "HUMAN px-captcha"},
    {"host": "datadome.co", "url": "https://datadome.co/", "vendor": "DataDome"},
]

MARKERS_JS = """(() => {
  const html = document.documentElement ? document.documentElement.outerHTML : '';
  const lower = html.toLowerCase();
  const found = [];
  const add = (name, hit) => { if (hit) found.push(name); };
  add('turnstile', /turnstile/.test(lower) || !!document.querySelector('iframe[src*="challenges.cloudflare.com"]'));
  add('challenge-platform', /challenge-platform/.test(lower));
  add('hcaptcha', /hcaptcha/.test(lower) || !!document.querySelector('iframe[src*="hcaptcha.com"]'));
  add('recaptcha', /recaptcha/.test(lower));
  add('datadome', /datadome/.test(lower));
  add('kasada', /kasada/.test(lower));
  add('px-captcha', /px-captcha|_pxAppId|perimeterx/.test(lower));
  add('akamai-bm', /_sec_cpt|ak_bmsc|bm-verify|_abck/.test(lower));
  add('captcha-text', /(verify you are (a )?human|checking your browser|are you a robot|just a moment)/i.test(document.body ? document.body.innerText : ''));
  return {
    href: location.href,
    markers: found,
    iframes: [...document.querySelectorAll('iframe')].map(f => f.getAttribute('src') || '').filter(Boolean).slice(0, 12),
    text: (document.body ? document.body.innerText : '').replace(/\\s+/g, ' ').trim().slice(0, 400),
    cookies: document.cookie.split('; ').filter(Boolean).map(c => c.split('=')[0]).slice(0, 30),
    elements: document.querySelectorAll('*').length,
  };
})()"""


async def _visit(call: Any, site: dict[str, str], directory: Path, settle: float, timeout: float) -> dict[str, Any]:
    """One site, through any caller that can run a step."""
    row: dict[str, Any] = {"host": site["host"], "vendor": site["vendor"], "url": site["url"]}
    try:
        goto = await call("goto", {"url": site["url"], "timeout": timeout * 1000})
        row["http_status"] = goto.get("http_status")
        row["final_url"] = goto.get("url")
        await asyncio.sleep(settle)
        observed = (await call("eval", {"js": MARKERS_JS})).get("result") or {}
        row["markers"] = observed.get("markers") or []
        row["iframes"] = observed.get("iframes") or []
        row["cookies"] = observed.get("cookies") or []
        row["text"] = observed.get("text") or ""
        row["settled_url"] = observed.get("href") or goto.get("url")
        shot = directory / f"{site['host']}.png"
        await call("screenshot", {"file": str(shot)})
        tree = await call("axtree", {})
        row["title"] = tree.get("title")
        row["shots"] = str(shot)
        (directory / f"{site['host']}.ax.txt").write_text(
            "\n".join(
                f"{element.get('ref')}\t{element.get('tag')}\t{element.get('role') or ''}\t{element.get('text') or element.get('name') or ''}"
                for element in tree.get("elements") or []
            ),
            encoding="utf-8",
        )
        row["interactive"] = len(tree.get("elements") or [])
    except Exception as exc:  # noqa: BLE001 - a failed visit is evidence, not a crash
        row["error"] = str(exc)
    row["verdict"] = _verdict(
        row.get("http_status"),
        row.get("markers") or [],
        moved=bool(row.get("settled_url")) and row.get("settled_url") != row.get("url"),
    )
    return row


def _report(label: str, rows: list[dict[str, Any]], directory: Path, target: dict[str, Any]) -> dict[str, Any]:
    report = {
        "environment": label,
        "target": target,
        "observed_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "output": str(directory),
        "sites": rows,
        "summary": {verdict: sum(1 for row in rows if row["verdict"] == verdict)
                    for verdict in ("reached", "cleared", "challenge", "blocked")},
    }
    directory.mkdir(parents=True, exist_ok=True)
    (directory / "report.json").write_text(json.dumps(report, indent=2, ensure_ascii=False), encoding="utf-8")
    return report


def control(
    sites: list[dict[str, str]] | None = None,
    cdp_url: str | None = None,
    browser: str = "chromium",
    out: Path | None = None,
    settle: float = 6.0,
    timeout: float = 90.0,
) -> dict[str, Any]:
    """Score the same sites on a browser we do not manage (control group)."""
    from playwright.async_api import async_playwright

    from . import actions as page_actions

    directory = out or (profile.BASE / "field" / time.strftime("control-%Y%m%d-%H%M%S"))
    directory.mkdir(parents=True, exist_ok=True)
    target = {"mode": "cdp", "cdp_url": cdp_url} if cdp_url else {
        "mode": "launch", "browser": browser, "headless": True,
        "executable": chromium_executable(),
        "profile": "unmodified Chromium with automation defaults - a control, not a hardened browser",
    }

    async def main() -> list[dict[str, Any]]:
        async with async_playwright() as play:
            if cdp_url:
                connected = await play.chromium.connect_over_cdp(cdp_url)
                context = connected.contexts[0] if connected.contexts else await connected.new_context()
                page = context.pages[0] if context.pages else await context.new_page()
            else:
                executed = chromium_executable()
                launched = await play.chromium.launch(headless=True, executable_path=executed) if executed \
                    else await play.chromium.launch(headless=True)
                context = await launched.new_context()
                page = await context.new_page()

            async def call(action: str, args: dict[str, Any] | None = None, **_kwargs: Any) -> dict[str, Any]:
                return await page_actions.run(page, action, args or {}, directory)

            rows = [await _visit(call, site, directory, settle, timeout) for site in (sites or SITES)]
            if cdp_url:
                await connected.close()
            else:
                await launched.close()
            return rows

    rows = asyncio.run(main())
    return _report("control", rows, directory, target)


ACTIVE = {"turnstile", "hcaptcha", "recaptcha", "captcha-text", "px-captcha", "challenge-platform"}


def _verdict(status: int | None, markers: list[str], moved: bool = False) -> str:
    """What the visit ended as, not what it started as.

    A gate answers 403 with a challenge page; if the page then solves it and
    navigates away, the outcome is `cleared`, not `blocked`.
    """
    if any(marker in ACTIVE for marker in markers):
        return "blocked" if (status or 0) >= 400 else "challenge"
    if moved:
        return "cleared"
    if (status or 0) >= 400:
        return "blocked"
    return "reached"


def run(
    name: str,
    sites: list[dict[str, str]] | None = None,
    out: Path | None = None,
    settle: float = 6.0,
    timeout: float = 90.0,
) -> dict[str, Any]:
    profile.require(name)
    if client.running(name) is None:
        raise profile.ProfileError(f"{name} is not running; 'start' it first")
    directory = out or (profile.profile_dir(name) / "field" / time.strftime("%Y%m%d-%H%M%S"))
    directory.mkdir(parents=True, exist_ok=True)

    async def visit(site: dict[str, str]) -> dict[str, Any]:
        async def call(action: str, args: dict[str, Any] | None = None, **kwargs: Any) -> dict[str, Any]:
            return await asyncio.to_thread(client.call, name, action, args or {}, kwargs.get("timeout", 120))

        return await _visit(call, site, directory, settle, timeout)

    rows = [asyncio.run(visit(site)) for site in (sites or SITES)]
    # axtree and screenshot already carry what a reviewer needs; report is shared
    return _report(name, rows, directory, {"mode": "profile"})
