"""Pinned environment identity: one fingerprint per environment, drawn once.

Camoufox salting: a launch without a pinned ``fingerprint`` draws a fresh
identity salt, so screen, fonts, voices and media devices change between
launches. This module draws the fingerprint once, stores it, and replays it.
"""

from __future__ import annotations

import hashlib
import functools
import json
import os
import platform
import re
import subprocess
import sys
import secrets
from pathlib import Path
from typing import Any
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

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
    seed: int | str | None = None,
) -> dict[str, Any]:
    from camoufox.fingerprints import generate_fingerprint

    chosen = device or next_device(os_name, [])
    if seed is None:
        fingerprint = generate_fingerprint(os=os_name)
    else:
        code = "import json,random,sys; from camoufox.fingerprints import generate_fingerprint; p=json.load(sys.stdin); random.seed(p['seed']); print(json.dumps(generate_fingerprint(os=p['os']),ensure_ascii=False,separators=(',',':')))"
        generated = subprocess.run(
            [sys.executable, "-c", code], input=json.dumps({"seed": seed, "os": os_name}),
            text=True, capture_output=True, env={**os.environ, "PYTHONHASHSEED": "0"}, timeout=60,
        )
        if generated.returncode:
            raise RuntimeError(f"fingerprint generation failed: {generated.stderr[-1000:]}")
        fingerprint = json.loads(generated.stdout)
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


def normalize_seed(value: str | None) -> str:
    if value is None:
        return secrets.token_hex(32)
    lowered = str(value).lower()
    if 32 <= len(lowered) <= 128 and len(lowered) % 2 == 0 and all(c in "0123456789abcdef" for c in lowered):
        return lowered
    return hashlib.sha256(str(value).encode()).hexdigest()


@functools.lru_cache(maxsize=1)
def generator_version() -> str:
    import camoufox.fingerprints as fingerprints
    from camoufox.fpgen_model import load_fpgen
    from .native_spec import file_sha256
    material = []
    for label, root in (("camoufox", Path(fingerprints.__file__).parent), ("fpgen", Path(load_fpgen().__file__).parent)):
        for path in sorted(root.rglob("*")):
            if path.is_file() and "__pycache__" not in path.parts and path.suffix not in {".pyc", ".pyo"}:
                material.append([label, path.relative_to(root).as_posix(), file_sha256(path)])
    return "camoufox-seed-v1:" + hashlib.sha256(profile.canonical_bytes(material)).hexdigest()


def cfox_assets(resolved: dict[str, Any], asset_paths: dict[str, Any]) -> dict[str, str]:
    from .native_spec import file_sha256
    fonts = sorted({file_sha256(path) for path in asset_paths["fonts"]})
    return {"fonts_sha256": hashlib.sha256(json.dumps(fonts, separators=(",", ":")).encode()).hexdigest(),
            "render_config_sha256": hashlib.sha256(profile.canonical_bytes(resolved)).hexdigest()}


def create_cfox_spec(name: str, *, seed: str, os_name: str, cores: int | None,
                     font_count: int, overrides: dict[str, Any], network: dict[str, Any],
                     binary: str, existing: list[dict[str, Any]], environment_id: str | None = None) -> dict[str, Any]:
    from importlib.metadata import version
    from .engine import build_options, decode_config
    from .native_spec import file_sha256, native_font_assets
    supported = {"user_agent", "platform", "locale", "languages", "timezone", "hardware_concurrency",
                 "screen_width", "screen_height", "avail_width", "avail_height", "color_depth",
                 "pixel_depth", "device_scale_factor", "fonts", "default_sans"}
    if set(overrides) - supported:
        raise profile.ProfileError(f"capability_unavailable: unsupported Camoufox overrides {sorted(set(overrides)-supported)}")
    if cores is not None:
        if "hardware_concurrency" in overrides and overrides["hardware_concurrency"] != cores:
            raise profile.ProfileError("invalid_config: conflicting --cores and override")
        overrides = {**overrides, "hardware_concurrency": cores}
    for key in ("hardware_concurrency", "screen_width", "screen_height", "avail_width", "avail_height", "color_depth", "pixel_depth"):
        if key in overrides and (type(overrides[key]) is not int or overrides[key] < 1):
            raise profile.ProfileError(f"invalid_config: {key} must be a positive integer")
    if "device_scale_factor" in overrides and (type(overrides["device_scale_factor"]) not in (int, float) or not 0.5 <= overrides["device_scale_factor"] <= 4):
        raise profile.ProfileError("invalid_config: unsupported device_scale_factor")
    timezone = overrides.get("timezone", "UTC")
    try:
        ZoneInfo(timezone)
    except (ZoneInfoNotFoundError, ValueError, TypeError) as exc:
        raise profile.ProfileError("invalid_config: unknown timezone") from exc
    locale = overrides.get("locale", "en-US")
    languages = overrides.get("languages", list(dict.fromkeys([locale, locale.split("-")[0]]))) if isinstance(locale, str) else []
    if not languages or not all(isinstance(v, str) and v and not any(c in v for c in "\r\n\0") for v in languages) or languages[0] != locale:
        raise profile.ProfileError("invalid_config: locale must be first in languages")
    for key in ("user_agent", "platform"):
        if key in overrides and (not isinstance(overrides[key], str) or not overrides[key] or any(c in overrides[key] for c in "\r\n\0")):
            raise profile.ProfileError(f"invalid_config: invalid {key}")
    candidates = device_classes(os_name)
    selected = candidates[int(seed[:16], 16) % len(candidates)]
    ident = new_identity(os_name, cores=overrides.get("hardware_concurrency"), font_count=font_count, device=selected, seed=seed)
    visible = ident["fonts"] if ident["fonts"] is not None else font_pool(os_name)
    if "fonts" in overrides:
        if not isinstance(overrides["fonts"], list) or not overrides["fonts"] or any(f not in visible for f in overrides["fonts"]):
            raise profile.ProfileError("invalid_config: fonts must be verified available families")
        ident["fonts"], ident["fonts_mode"] = list(overrides["fonts"]), "explicit"
        visible = ident["fonts"]
    preferred = [family for family in ("Arial", "Helvetica Neue", "Avenir", "Verdana", "Georgia", "Times New Roman") if family in visible]
    default_sans = overrides.get("default_sans") or (preferred[int(seed[16:32], 16) % len(preferred)] if preferred else visible[0])
    if default_sans not in visible:
        raise profile.ProfileError("invalid_config: default_sans is not in the visible font set")
    ident["font_defaults"] = {"sans-serif": default_sans}
    runtime = {"id": "camoufox", "version": version("camoufox"), "version_source": "python-package",
               "artifact_sha256": file_sha256(binary), "adapter_version": "playwright:" + version("playwright"),
               "binary": str(Path(binary).resolve()), "target": f"{sys.platform}-{platform.machine()}"}
    cfg = {"schema": profile.SCHEMA, "id": environment_id or secrets.token_hex(16), "name": name, "mode": "managed",
           "seed": seed, "revision": 1, "generator_version": generator_version(), "runtime": runtime,
           "overrides": dict(overrides), "identity": ident, "network": dict(network),
           "permissions": {"camera": "deny", "microphone": "deny", "geolocation": "deny"},
           "storage": {"format_version": 1, "path": str((profile.profile_dir(name) / "data").resolve())},
           "identity_scope": "environment", "capabilities": {}}
    cfg["network"].update({"locale": locale, "languages": languages, "timezone": timezone})
    decoded = decode_config(build_options(cfg, binary, headless=True))
    mapping = {"user_agent": "navigator.userAgent", "platform": "navigator.platform",
               "hardware_concurrency": "navigator.hardwareConcurrency", "screen_width": "screen.width",
               "screen_height": "screen.height", "avail_width": "screen.availWidth", "avail_height": "screen.availHeight",
               "color_depth": "screen.colorDepth", "pixel_depth": "screen.pixelDepth", "device_scale_factor": "window.devicePixelRatio"}
    for key, native in mapping.items():
        if key in overrides and decoded.get(native) != overrides[key]:
            raise profile.ProfileError(f"invalid_config: runtime adjusts requested {key}; requested={overrides[key]!r}, actual={decoded.get(native)!r}")
    cfg["resolved"] = {key: decoded.get(native) for key, native in mapping.items()}
    cfg["resolved"].update({"locale": locale, "languages": languages, "timezone": timezone,
                            "fonts": list(visible), "default_sans": default_sans})
    if cfg["resolved"].get("hardware_concurrency") is not None:
        ident["cores"] = cfg["resolved"]["hardware_concurrency"]
    if cfg["resolved"].get("screen_width") and cfg["resolved"].get("screen_height"):
        ident["screen"] = [cfg["resolved"]["screen_width"], cfg["resolved"]["screen_height"]]
    ident["resolved"], ident["id"] = decoded, _digest(ident)[:12]
    cfg["resolved_sha256"] = hashlib.sha256(profile.canonical_bytes(cfg["resolved"])).hexdigest()
    cfg["asset_paths"] = native_font_assets()
    cfg["assets"] = cfox_assets(cfg["resolved"], cfg["asset_paths"])
    from .native_spec import check_identity_collision
    check_identity_collision(cfg, existing)
    return cfg


def validate_cfox_spec(cfg: dict[str, Any], *, check_artifacts: bool = True) -> None:
    from .native_spec import file_sha256
    from importlib.metadata import version
    if not isinstance(cfg, dict) or cfg.get("schema") != profile.SCHEMA or not isinstance(cfg.get("runtime"), dict) or cfg["runtime"].get("id") != "camoufox":
        raise profile.ProfileError("incompatible_profile: migrate this profile before launch")
    if any(not isinstance(cfg.get(key), dict) for key in ("identity", "resolved", "assets", "asset_paths", "storage", "network")):
        raise profile.ProfileError("invalid_config: missing managed configuration sections")
    if not isinstance(cfg.get("id"), str) or not cfg["id"] or type(cfg.get("revision")) is not int or cfg["revision"] < 1 or cfg.get("identity_scope") != "environment":
        raise profile.ProfileError("invalid_config: invalid environment id/revision/scope")
    if not isinstance(cfg.get("name"), str) or re.fullmatch(r"[\w-]+", cfg["name"]) is None or cfg.get("mode") != "managed":
        raise profile.ProfileError("invalid_config: invalid managed environment name/mode")
    if not isinstance(cfg.get("seed"), str) or re.fullmatch(r"[0-9a-f]{32,128}", cfg["seed"]) is None or len(cfg["seed"]) % 2:
        raise profile.ProfileError("invalid_config: invalid deterministic seed")
    storage, paths = cfg["storage"], cfg["asset_paths"]
    if storage.get("format_version") != 1 or not isinstance(storage.get("path"), str) or not Path(storage["path"]).is_absolute():
        raise profile.ProfileError("incompatible_profile: invalid storage format/path")
    if not isinstance(paths.get("fonts"), list) or not paths["fonts"] or any(not isinstance(path, str) or not Path(path).is_absolute() for path in paths["fonts"]):
        raise profile.ProfileError("invalid_config: font assets must be absolute paths")
    ref = cfg["network"].get("proxy_ref")
    if cfg["network"].get("proxy") or (ref is not None and (not isinstance(ref, str) or re.fullmatch(r"env:[A-Za-z_][A-Za-z0-9_]*", ref) is None)):
        raise profile.ProfileError("invalid_config: proxy credentials require an environment/private-store reference")
    if cfg.get("generator_version") != generator_version():
        raise profile.ProfileError("incompatible_profile: fingerprint generator changed; migrate explicitly")
    runtime = cfg["runtime"]
    if runtime.get("version") != version("camoufox") or runtime.get("adapter_version") != "playwright:" + version("playwright"):
        raise profile.ProfileError("incompatible_profile: runtime/adapter version changed; migrate explicitly")
    if runtime.get("target") != f"{sys.platform}-{platform.machine()}":
        raise profile.ProfileError("incompatible_profile: runtime host changed; migrate explicitly")
    if not isinstance(runtime.get("binary"), str) or not Path(runtime["binary"]).is_absolute():
        raise profile.ProfileError("invalid_config: runtime binary must be absolute")
    if check_artifacts and file_sha256(runtime["binary"]) != runtime.get("artifact_sha256"):
        raise profile.ProfileError("incompatible_profile: runtime bytes changed; migrate explicitly")
    if check_artifacts and cfox_assets(cfg["resolved"], cfg["asset_paths"]) != cfg.get("assets"):
        raise profile.ProfileError("incompatible_profile: actual font/render assets changed; migrate explicitly")
    if hashlib.sha256(profile.canonical_bytes(cfg["resolved"])).hexdigest() != cfg.get("resolved_sha256"):
        raise profile.ProfileError("incompatible_profile: resolved configuration changed; migrate explicitly")
