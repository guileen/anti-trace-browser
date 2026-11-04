"""Experiment field: drive one environment through strict sites and keep evidence.

The four vendor-first-party sites each run their own bot defence, so they are
strict without carrying real business traffic. Every visit records what a site
could observe and what the environment had to solve, so a human can review the
raw material instead of trusting one score.
"""

from __future__ import annotations

import json
import time
from pathlib import Path
from typing import Any

from . import client, profile

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
    markers: found,
    iframes: [...document.querySelectorAll('iframe')].map(f => f.getAttribute('src') || '').filter(Boolean).slice(0, 12),
    text: (document.body ? document.body.innerText : '').replace(/\\s+/g, ' ').trim().slice(0, 400),
    cookies: document.cookie.split('; ').filter(Boolean).map(c => c.split('=')[0]).slice(0, 30),
    elements: document.querySelectorAll('*').length,
  };
})()"""


def _verdict(status: int | None, markers: list[str]) -> str:
    if status is not None and status >= 400:
        return "blocked"
    if any(marker in {"turnstile", "hcaptcha", "recaptcha", "captcha-text", "px-captcha", "challenge-platform"} for marker in markers):
        return "challenge"
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

    rows: list[dict[str, Any]] = []
    for site in sites or SITES:
        row: dict[str, Any] = {"host": site["host"], "vendor": site["vendor"], "url": site["url"]}
        try:
            goto = client.call(name, "goto", {"url": site["url"], "timeout": timeout * 1000}, timeout=timeout + 30)
            row["http_status"] = goto.get("http_status")
            row["final_url"] = goto.get("url")
            time.sleep(settle)
            observed = client.call(name, "eval", {"js": MARKERS_JS}, timeout=60).get("result") or {}
            row["markers"] = observed.get("markers") or []
            row["iframes"] = observed.get("iframes") or []
            row["cookies"] = observed.get("cookies") or []
            row["text"] = observed.get("text") or ""
            shot = directory / f"{site['host']}.png"
            client.call(name, "screenshot", {"file": str(shot)}, timeout=60)
            tree = client.call(name, "axtree", timeout=90)
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
        except (client.EngineError, profile.ProfileError) as exc:
            row["error"] = str(exc)
        row["verdict"] = _verdict(row.get("http_status"), row.get("markers") or [])
        rows.append(row)

    report = {
        "environment": name,
        "observed_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "output": str(directory),
        "sites": rows,
        "summary": {verdict: sum(1 for row in rows if row["verdict"] == verdict)
                    for verdict in ("reached", "challenge", "blocked")},
    }
    (directory / "report.json").write_text(json.dumps(report, indent=2, ensure_ascii=False), encoding="utf-8")
    return report
