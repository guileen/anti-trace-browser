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
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any
from urllib.parse import quote, urlsplit
from urllib.request import HTTPRedirectHandler, Request, build_opener

from . import client, profile
from .measure import chromium_executable

SITES: list[dict[str, str]] = [
    {"host": "nowsecure.nl", "url": "https://nowsecure.nl/", "vendor": "Cloudflare Turnstile"},
    {"host": "kasada.io", "url": "https://www.kasada.io/", "vendor": "Kasada"},
    {"host": "humansecurity.com", "url": "https://www.humansecurity.com/", "vendor": "HUMAN px-captcha"},
    {"host": "datadome.co", "url": "https://datadome.co/", "vendor": "DataDome"},
]

MARKERS_JS = """(() => {
  const found = [], passive = [];
  const visible = selector => [...document.querySelectorAll(selector)].some(el => {
    const rect = el.getBoundingClientRect(), style = getComputedStyle(el);
    return rect.width > 1 && rect.height > 1 && style.display !== 'none'
      && style.visibility !== 'hidden';
  });
  const add = (name, hit) => { if (hit) found.push(name); };
  add('turnstile', visible('.cf-turnstile, iframe[src*="challenges.cloudflare.com"]'));
  add('challenge-platform', visible('#challenge-stage, #challenge-running'));
  add('hcaptcha', visible('.h-captcha, iframe[src*="hcaptcha.com"]'));
  add('recaptcha', visible('.g-recaptcha, iframe[src*="recaptcha"]'));
  add('datadome-challenge', visible('iframe[src*="captcha-delivery.com"]'));
  add('px-captcha', visible('#px-captcha, .px-captcha'));
  add('captcha-text', /(verify you are (a )?human|checking your browser|are you a robot|just a moment)/i.test(document.body ? document.body.innerText : ''));
  const lower = (document.documentElement ? document.documentElement.outerHTML : '').toLowerCase();
  for (const name of ['turnstile', 'hcaptcha', 'recaptcha', 'datadome', 'kasada', 'perimeterx', 'akamai']) {
    if (lower.includes(name)) passive.push(name);
  }
  return {
    href: location.href,
    markers: found,
    passive_markers: passive,
    iframes: [...document.querySelectorAll('iframe')].map(f => f.getAttribute('src') || '').filter(Boolean).slice(0, 12),
    text: (document.body ? document.body.innerText : '').replace(/\\s+/g, ' ').trim().slice(0, 400),
    cookies: document.cookie.split('; ').filter(Boolean).map(c => c.split('=')[0]).slice(0, 30),
    elements: document.querySelectorAll('*').length,
  };
})()"""


async def _visit(call: Any, site: dict[str, str], directory: Path, settle: float, timeout: float) -> dict[str, Any]:
    """Keep observations, capture failures and trusted verification separate."""
    row: dict[str, Any] = {
        "visit_id": str(uuid.uuid4()), "run_id": site.get("run_id"),
        "host": site["host"], "vendor": site["vendor"], "url": site["url"],
        "challenge_kind": site.get("challenge_kind"), "phase": "not_observed",
        "started_at": time.time(), "timeline": [], "evidence_ids": [],
    }
    directory.mkdir(parents=True, exist_ok=True)

    async def step(action: str, args: dict[str, Any]) -> dict[str, Any]:
        reply = await asyncio.wait_for(call(action, args), timeout=timeout)
        if not isinstance(reply, dict) or reply.get("status", "ok") != "ok":
            raise RuntimeError(f"{action}: {reply.get('message') or reply.get('reason') or reply}" if isinstance(reply, dict)
                               else f"{action}: invalid response")
        row["timeline"].append({"action": action, "at": time.time()})
        return reply

    observed: dict[str, Any] = {}
    try:
        goto = await step("goto", {"url": site["url"], "timeout": timeout * 1000})
        row["http_status"] = goto.get("http_status")
        row["final_url"] = goto.get("url")
        await asyncio.sleep(settle)
        result = (await step("eval", {"js": MARKERS_JS})).get("result")
        if isinstance(result, dict):
            observed = result
        row["observation"] = observed
        for key, default in (("markers", []), ("passive_markers", []), ("iframes", []), ("cookies", []), ("text", "")):
            row[key] = observed.get(key) or default
        row["settled_url"] = observed.get("href") or goto.get("url")
        shot = directory / f"{row['visit_id']}.png"
        await step("screenshot", {"file": str(shot)})
        row["shots"] = str(shot)
        row["evidence_ids"].append(str(shot))
        tree = await step("axtree", {})
        row["title"] = tree.get("title")
        tree_path = directory / f"{row['visit_id']}.ax.txt"
        tree_path.write_text(
            "\n".join(
                f"{element.get('ref')}\t{element.get('tag')}\t{element.get('role') or ''}\t{element.get('text') or element.get('name') or ''}"
                for element in tree.get("elements") or []
            ), encoding="utf-8",
        )
        row["evidence_ids"].append(str(tree_path))
        row["interactive"] = len(tree.get("elements") or [])
        if site.get("receipt_url"):
            row["verification"] = await asyncio.to_thread(_read_receipt, site, timeout)
    except Exception as exc:  # noqa: BLE001 - retain partial evidence
        row["error"] = str(exc) or type(exc).__name__
        row["timeline"].append({"action": "capture_error", "at": time.time(), "error": row["error"]})
        if not row.get("shots"):
            try:
                shot = directory / f"{row['visit_id']}.png"
                await step("screenshot", {"file": str(shot)})
                row["shots"] = str(shot)
                row["evidence_ids"].append(str(shot))
            except Exception as screenshot_error:  # noqa: BLE001 - do not replace the original failure
                row["screenshot_error"] = str(screenshot_error) or type(screenshot_error).__name__
    usable = bool(observed.get("href")) and isinstance(observed.get("markers"), list)
    row["verdict"] = _verdict(
        row.get("http_status"), row.get("markers") or [],
        observed=usable, error=row.get("error"), verification=row.get("verification"),
        run_id=site.get("run_id"), challenge_kind=site.get("challenge_kind"), visit_started_at=row["started_at"],
    )
    row["phase"] = {
        "error": "capture_failed", "not_tested": "not_observed", "challenge": "active_challenge",
        "cleared": "verified", "blocked": "denied", "reached": "content_observed",
    }[row["verdict"]]
    if row["verdict"] == "error" and not row.get("error"):
        row["phase"] = "verification_failed"
    return row


def _report(label: str, rows: list[dict[str, Any]], directory: Path, target: dict[str, Any]) -> dict[str, Any]:
    report = {
        "environment": label,
        "target": target,
        "observed_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "output": str(directory),
        "sites": rows,
        "rules_version": 2,
        "summary": {verdict: sum(1 for row in rows if row["verdict"] == verdict)
                    for verdict in VERDICTS},
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
                if not executed:
                    raise ValueError(
                        "no installed Chromium found; install Chrome/Brave/Edge or pass --cdp"
                    )
                launched = await play.chromium.launch(headless=True, executable_path=executed)
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


VERDICTS = ("reached", "cleared", "challenge", "blocked", "error", "not_tested")
ACTIVE = {"turnstile", "hcaptcha", "recaptcha", "captcha-text", "px-captcha",
          "challenge-platform", "datadome-challenge"}


class _NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, req: Any, fp: Any, code: int, msg: str, headers: Any, newurl: str) -> None:
        # Never forward a run access token through an HTTP redirect.
        return None


def _read_receipt(site: dict[str, str], timeout: float) -> dict[str, Any]:
    """Fetch from operator-configured authority, never from page-provided JSON."""
    url = urlsplit(site["receipt_url"])
    trusted = urlsplit(site.get("trusted_receipt_origin") or "")
    loopback = url.hostname in {"localhost", "127.0.0.1", "::1"}
    if (url.scheme not in {"https", "http"} or (url.scheme != "https" and not loopback)
            or not trusted.netloc or trusted.path not in {"", "/"}
            or (url.scheme, url.netloc) != (trusted.scheme, trusted.netloc)
            or url.username or url.password or url.query or url.fragment
            or not site.get("run_id") or not site.get("receipt_token")
            or url.path != "/attempts/" + quote(site["run_id"], safe="")):
        raise ValueError("receipt requires an allowlisted HTTPS origin and exact authenticated run endpoint")
    request = Request(site["receipt_url"], headers={"Authorization": "Bearer " + site["receipt_token"]})
    with build_opener(_NoRedirect()).open(request, timeout=timeout) as response:
        receipt = json.load(response)
    if not isinstance(receipt, dict):
        raise ValueError("invalid server receipt")
    if receipt.get("result") == "passed" and receipt.get("hostname") != (
            site.get("expected_hostname") or urlsplit(site["url"]).hostname):
        raise ValueError("receipt hostname does not match the configured experiment")
    return {"source": "server", "authority": trusted.geturl().rstrip("/"), "receipt": receipt}


def _verified(
    verification: dict[str, Any] | None, run_id: str | None, challenge_kind: str | None,
    not_before: float | None = None,
) -> bool:
    if not verification or verification.get("source") != "server" or not verification.get("authority"):
        return False
    receipt = verification.get("receipt") or {}
    if not isinstance(receipt, dict):
        return False
    if (not run_id or not challenge_kind or receipt.get("run_id") != run_id
            or receipt.get("result") != "passed" or receipt.get("kind") != challenge_kind
            or receipt.get("action") != "browser_check" or not receipt.get("hostname")
            or not receipt.get("receipt_id")):
        return False
    try:
        def timestamp(value: Any) -> float:
            if isinstance(value, (int, float)):
                return float(value) / 1000 if value > 1e12 else float(value)
            return datetime.fromisoformat(str(value).replace("Z", "+00:00")).astimezone(timezone.utc).timestamp()
        verified_at, expires_at = timestamp(receipt["verified_at"]), timestamp(receipt["expires_at"])
        return (verified_at <= time.time() < expires_at and expires_at - verified_at <= 300
                and (not_before is None or verified_at >= not_before - 0.001))
    except (KeyError, TypeError, ValueError, OverflowError):
        return False


def _verdict(
    status: int | None, markers: list[str], moved: bool = False, *,
    observed: bool | None = None, error: str | None = None,
    verification: dict[str, Any] | None = None, run_id: str | None = None,
    challenge_kind: str | None = None, visit_started_at: float | None = None,
) -> str:
    """Movement is observation only; clearance requires a run-bound server receipt."""
    if error:
        return "error"
    if _verified(verification, run_id, challenge_kind, visit_started_at):
        return "cleared"
    if verification and verification.get("source") == "server" and verification.get("authority") and run_id and challenge_kind:
        receipt = verification.get("receipt") or {}
        if isinstance(receipt, dict) and receipt.get("run_id") == run_id:
            if receipt.get("result") in {"error", "expired"}:
                return "error"
            if receipt.get("result") == "rejected":
                return "blocked"
            if receipt.get("result") in {"issued", "verifying"}:
                return "challenge"
    if any(marker in ACTIVE for marker in markers):
        return "challenge"
    if observed is False or (observed is None and status is None):
        return "not_tested"
    if status is not None and status >= 400:
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
