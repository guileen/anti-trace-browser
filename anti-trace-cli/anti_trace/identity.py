"""Pinned environment identity: one fingerprint per environment, drawn once.

Camoufox salting: a launch without a pinned ``fingerprint`` draws a fresh
identity salt, so screen, fonts, voices and media devices change between
launches. This module draws the fingerprint once, stores it, and replays it.
"""

from __future__ import annotations

import hashlib
import json
import os
import platform
from pathlib import Path
from typing import Any

from . import profile

FONT_CACHE = profile.BASE / "fonts"

# Device classes per OS: plausible screen/DPR/core combinations that a real
# machine of that kind reports together. Environments take one class each, so a
# new environment differs from the ones already in the store.
DEVICES: dict[str, list[dict[str, Any]]] = {
    "macos": [
        {"name": "mbp14", "screen": [1512, 982], "dpr": 2, "cores": 8},
        {"name": "mbp16", "screen": [1728, 1117], "dpr": 2, "cores": 12},
        {"name": "mba13", "screen": [1440, 900], "dpr": 2, "cores": 8},
        {"name": "display-fhd", "screen": [1920, 1080], "dpr": 1, "cores": 12},
        {"name": "display-wuxga", "screen": [1680, 1050], "dpr": 1, "cores": 10},
        {"name": "display-qhd", "screen": [2560, 1440], "dpr": 1, "cores": 16},
    ],
    "windows": [
        {"name": "laptop-fhd", "screen": [1920, 1080], "dpr": 1, "cores": 8},
        {"name": "laptop-qhd", "screen": [2560, 1440], "dpr": 1, "cores": 16},
        {"name": "laptop-hd", "screen": [1366, 768], "dpr": 1, "cores": 4},
        {"name": "laptop-scaled", "screen": [1536, 864], "dpr": 1.25, "cores": 8},
    ],
    "linux": [
        {"name": "desktop-fhd", "screen": [1920, 1080], "dpr": 1, "cores": 8},
        {"name": "desktop-qhd", "screen": [2560, 1440], "dpr": 1, "cores": 16},
        {"name": "laptop-hd", "screen": [1366, 768], "dpr": 1, "cores": 4},
    ],
}

# Families that exist on a stock install of the target OS. A subset always
# carries them, so the common Canvas font measurements still vary.
CORE_FONTS = (
    "Arial", "Helvetica", "Helvetica Neue", "Times New Roman", "Times", "Courier New",
    "Courier", "Menlo", "Monaco", "Georgia", "Verdana", "Trebuchet MS", "Tahoma",
    "Palatino", "Optima", "Futura", "Gill Sans", "Baskerville", "Avenir", "Avenir Next",
    "Lucida Grande", "Geneva", "Segoe UI", "Calibri", "Cambria", "Consolas",
    "PingFang SC", "Hiragino Sans", "Songti SC", "Apple SD Gothic Neo", "Noto Sans",
    "DejaVu Sans", "Liberation Sans", "Cantarell", "Ubuntu",
)

# Countries where the primary language is not the region's first-listed language
# in upstream's territory table (e.g. US -> fil, GB -> pl). Canonical tags only.
LOCALE_BY_COUNTRY = {
    "US": "en-US", "GB": "en-GB", "CA": "en-CA", "AU": "en-AU", "NZ": "en-NZ",
    "IE": "en-IE", "SG": "en-SG", "ZA": "en-ZA", "IN": "en-IN", "PH": "en-PH",
    "DE": "de-DE", "AT": "de-AT", "CH": "de-CH", "NL": "nl-NL", "BE": "nl-BE",
    "FR": "fr-FR", "ES": "es-ES", "MX": "es-MX", "AR": "es-AR", "CL": "es-CL",
    "CO": "es-CO", "PE": "es-PE", "IT": "it-IT", "PT": "pt-PT", "BR": "pt-BR",
    "JP": "ja-JP", "KR": "ko-KR", "TW": "zh-TW", "HK": "zh-HK", "CN": "zh-CN",
    "SE": "sv-SE", "NO": "nb-NO", "DK": "da-DK", "FI": "fi-FI", "PL": "pl-PL",
    "CZ": "cs-CZ", "RO": "ro-RO", "HU": "hu-HU", "GR": "el-GR", "TR": "tr-TR",
    "RU": "ru-RU", "UA": "uk-UA", "IL": "he-IL", "AE": "ar-AE", "SA": "ar-SA",
    "EG": "ar-EG", "NG": "en-NG", "KE": "en-KE", "TH": "th-TH", "VN": "vi-VN",
    "ID": "id-ID", "MY": "ms-MY",
}

_FONT_PROBE = """(families) => {
  const measure = (f) => {
    const c = document.createElement('canvas').getContext('2d');
    c.font = '16px ' + (f ? '"' + f + '", monospace' : 'monospace');
    return c.measureText('mmmmmmmmmmlliWW').width;
  };
  const base = measure(null);
  return families.filter((f) => Math.abs(measure(f) - base) > 0.05);
}"""


def host_os() -> str:
    return {"Darwin": "macos", "Windows": "windows"}.get(platform.system(), "linux")


def host_cores() -> int:
    return os.cpu_count() or 8


def locale_for(country: str | None) -> str:
    return LOCALE_BY_COUNTRY.get((country or "").upper(), "en-US")


def device_classes(os_name: str) -> list[dict[str, Any]]:
    return DEVICES.get(os_name, DEVICES["linux"])


def next_device(os_name: str, taken: list[str]) -> dict[str, Any]:
    classes = device_classes(os_name)
    for candidate in classes:
        if candidate["name"] not in taken:
            return dict(candidate)
    return dict(classes[len(taken) % len(classes)])


def window_for(screen: list[int]) -> dict[str, int]:
    width, height = screen
    inner_width = width - 112
    inner_height = height - 122
    return {
        "innerWidth": inner_width,
        "innerHeight": inner_height,
        "outerWidth": inner_width,
        "outerHeight": inner_height + 95,
    }


def new_identity(
    os_name: str,
    cores: int | None = None,
    font_count: int = 0,
    device: dict[str, Any] | None = None,
    seed: int | None = None,
) -> dict[str, Any]:
    from camoufox.fingerprints import generate_fingerprint

    chosen = device or next_device(os_name, [])
    fingerprint = generate_fingerprint(os=os_name)
    identity: dict[str, Any] = {
        "os": os_name,
        "cores": int(cores or chosen["cores"]),
        "fingerprint": fingerprint,
        "device": chosen["name"],
        "screen": list(chosen["screen"]),
        "dpr": chosen["dpr"],
        "window": window_for(chosen["screen"]),
        "fonts": None,
        "fonts_mode": "host",
    }
    if font_count:
        pool = font_pool(os_name)
        identity["fonts"] = pick_fonts(pool, identity["fingerprint"], font_count, seed)
        identity["fonts_mode"] = "subset"
    identity["id"] = _digest(identity)[:12]
    return identity


def _digest(identity: dict[str, Any]) -> str:
    material = {
        "fingerprint": identity.get("fingerprint"),
        "cores": identity.get("cores"),
        "fonts": identity.get("fonts"),
        "os": identity.get("os"),
        "screen": identity.get("screen"),
        "dpr": identity.get("dpr"),
        "device": identity.get("device"),
    }
    blob = json.dumps(material, sort_keys=True, default=str).encode()
    return hashlib.sha256(blob).hexdigest()


def digest(identity: dict[str, Any]) -> str:
    return _digest(identity)


def _identity_seed(identity: dict[str, Any]) -> int:
    return int(_digest(identity)[:16], 16)


def pick_fonts(pool: list[str], fingerprint: dict[str, Any], count: int, seed: int | None) -> list[str]:
    """A stable subset that keeps the OS's core families and varies the rest."""
    if not pool:
        raise RuntimeError("font pool is empty; run 'anti-trace setup' first")
    target = min(count, len(pool))
    picked = [name for name in CORE_FONTS if name in pool][:target]
    others = [name for name in sorted(pool) if name not in picked]
    if not others:
        return sorted(picked, key=str.lower)
    material = {
        "pool": sorted(pool),
        "seed": seed if seed is not None else 0,
        "screen": fingerprint.get("screen"),
        "ua": (fingerprint.get("navigator") or {}).get("userAgent"),
    }
    state = int(hashlib.sha256(json.dumps(material, sort_keys=True, default=str).encode()).hexdigest(), 16)
    guard = 0
    while len(picked) < target and guard < 10000:
        guard += 1
        state = (state * 6364136223846793005 + 1442695040888963407) & ((1 << 64) - 1)
        candidate = others[(state >> 17) % len(others)]
        if candidate not in picked:
            picked.append(candidate)
    return sorted(picked, key=str.lower)


def font_pool(os_name: str) -> list[str]:
    """Families the host really renders, verified once inside the browser."""
    cached = FONT_CACHE / f"{os_name}.json"
    if cached.is_file():
        try:
            data = json.loads(cached.read_text(encoding="utf-8"))
            if data.get("families"):
                return data["families"]
        except (OSError, ValueError):
            pass
    families = _calibrate_fonts(os_name)
    FONT_CACHE.mkdir(parents=True, exist_ok=True)
    cached.write_text(json.dumps({"os": os_name, "families": families}, indent=2), encoding="utf-8")
    return families


def _candidates(os_name: str) -> list[str]:
    from camoufox.fingerprints import generate_fingerprint

    fingerprint = generate_fingerprint(os=os_name)
    names = list(fingerprint.get("allFonts") or [])
    names += list((fingerprint.get("baseFonts") or {}).values())
    seen: dict[str, None] = {}
    for name in names:
        if isinstance(name, str) and name.strip():
            seen.setdefault(name.strip(), None)
    return list(seen)


def _calibrate_fonts(os_name: str) -> list[str]:
    """Measure every candidate family on the host; keep the ones that render."""
    import shutil
    import tempfile

    from playwright.sync_api import sync_playwright

    from .engine import browser_path, build_options

    candidates = _candidates(os_name)
    scratch = Path(tempfile.mkdtemp(prefix="anti-trace-fonts-"))
    try:
        with sync_playwright() as pw:
            options = build_options(
                cfg={
                    "identity": {"os": os_name, "cores": host_cores(), "fingerprint": None},
                    "network": {"proxy": None},
                },
                executable=browser_path(),
                headless=True,
                user_data_dir=scratch,
            )
            context = pw.firefox.launch_persistent_context(**options)
            try:
                page = context.pages[0] if context.pages else context.new_page()
                page.goto("about:blank")
                verified = page.evaluate(_FONT_PROBE, candidates)
            finally:
                context.close()
    finally:
        shutil.rmtree(scratch, ignore_errors=True)
    if not verified:
        raise RuntimeError("font calibration produced no results")
    return sorted(set(verified), key=str.lower)
