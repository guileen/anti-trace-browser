"""Verification: what the environment actually presents, and what leaks."""

from __future__ import annotations

import json
import time
from pathlib import Path
from typing import Any

from . import client, identity, profile

PROBE = """(async () => {
  const fnv = (a) => { let h = 0x811c9dc5; for (let i = 0; i < a.length; i++) { h ^= a[i]; h = Math.imul(h, 0x01000193) >>> 0; } return h; };
  const render = (text) => {
    const c = document.createElement('canvas'); c.width = 240; c.height = 60;
    const x = c.getContext('2d');
    x.fillStyle = '#f60'; x.fillRect(10, 10, 100, 30);
    x.beginPath(); x.arc(170, 30, 20, 0, Math.PI * 2); x.fillStyle = '#069'; x.fill();
    if (text) { x.font = '18px sans-serif'; x.fillStyle = '#000'; x.fillText('Cwm fjord \\u4f60\\u597d \\ud83d\\ude00', 5, 50); }
    return fnv(x.getImageData(0, 0, 240, 60).data);
  };
  const gl = document.createElement('canvas').getContext('webgl');
  let glInfo = null;
  if (gl) {
    const ext = gl.getExtension('WEBGL_debug_renderer_info');
    glInfo = {
      vendor: ext ? gl.getParameter(ext.UNMASKED_VENDOR_WEBGL) : gl.getParameter(gl.VENDOR),
      renderer: ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER),
      maxTexture: gl.getParameter(gl.MAX_TEXTURE_SIZE),
      extensions: (gl.getSupportedExtensions() || []).length,
    };
  }
  let audio = null;
  try {
    const ctx = new OfflineAudioContext(1, 44100, 44100);
    const osc = ctx.createOscillator(); osc.type = 'triangle'; osc.frequency.value = 440;
    osc.connect(ctx.destination); osc.start(0);
    const buf = await ctx.startRendering();
    // A typed array from the page is Xray-wrapped here; copy into our own first.
    const data = new Float32Array(buf.length);
    buf.copyFromChannel(data, 0);
    let sum = 0; for (let i = 0; i < data.length; i++) sum += data[i] * data[i];
    audio = Math.round(Math.sqrt(sum / data.length) * 1e6);
  } catch (e) { audio = 'unsupported'; }
  const perms = {};
  for (const name of ['geolocation', 'notifications', 'camera', 'microphone']) {
    try { perms[name] = (await navigator.permissions.query({ name })).state; } catch (e) { perms[name] = 'n/a'; }
  }
  const measured = (families) => families.map((f) => {
    const c = document.createElement('canvas').getContext('2d');
    c.font = '16px "' + f + '", monospace';
    return Math.round(c.measureText('mmmmmmmmmmlliWW').width * 100) / 100;
  });
  return {
    ua: navigator.userAgent, platform: navigator.platform, oscpu: navigator.oscpu,
    lang: navigator.language, langs: navigator.languages,
    tz: Intl.DateTimeFormat().resolvedOptions().timeZone,
    offset: new Date(2026, 0, 15).getTimezoneOffset(),
    cores: navigator.hardwareConcurrency,
    screen: [screen.width, screen.height, screen.availWidth, screen.availHeight],
    dpr: devicePixelRatio,
    canvasGeo: render(false), canvasGeo2: render(false),
    canvasText: render(true), canvasText2: render(true),
    webgl: glInfo, audio,
    webdriver: navigator.webdriver === true,
    plugins: navigator.plugins.length, mimeTypes: navigator.mimeTypes.length,
    perms,
    fonts: measured(['Arial', 'Times New Roman', 'Courier New', 'Menlo', 'Georgia', 'Helvetica Neue']),
    storage: (() => { try { localStorage.setItem('atb-probe', '1'); const ok = localStorage.getItem('atb-probe') === '1'; localStorage.removeItem('atb-probe'); return ok; } catch (e) { return String(e); } })(),
  };
})()"""


HEADER_RULES = {
    "identity": ["user-agent", "accept-language"],
    "build": ["accept", "accept-encoding"],
    "universal": ["upgrade-insecure-requests", "sec-fetch-dest", "sec-fetch-mode", "sec-fetch-site", "sec-fetch-user"],
    "chromium_family": ["sec-ch-ua", "sec-ch-ua-mobile", "sec-ch-ua-platform"],
}
CH_PLATFORM = {"macos": "macOS", "windows": "Windows", "linux": "Linux"}

KNOWN_HEADERS = {
    "host": "request",
    "cookie": "origin", "referer": "origin", "origin": "origin",
    "if-none-match": "origin", "if-modified-since": "origin", "range": "origin",
    "cache-control": "origin", "pragma": "origin",
    "connection": "build", "priority": "build", "te": "build",
    "user-agent": "identity", "accept-language": "identity", "accept": "universal",
    "accept-encoding": "build", "upgrade-insecure-requests": "universal",
    "sec-fetch-dest": "universal", "sec-fetch-mode": "universal",
    "sec-fetch-site": "universal", "sec-fetch-user": "universal",
    "sec-ch-ua": "family", "sec-ch-ua-mobile": "family", "sec-ch-ua-platform": "family",
    "priority": "optional",
    "dnt": "build", "sec-gpc": "build",
}

PLATFORM_TOKENS = {
    "macos": ("Macintosh", "Mac OS X"),
    "windows": ("Windows NT",),
    "linux": ("X11; Linux", "Linux x86_64"),
}


def evaluate_headers(headers: dict[str, str], ident: dict[str, Any]) -> list[dict[str, Any]]:
    """Classify the headers a document request carried and judge each class.

    Three classes: identity-derived (must follow the environment), build-derived
    (must equal what this browser build really sends), universal (must be the
    canonical value every real user of that build sends).
    """
    lower = {key.lower(): value for key, value in headers.items()}
    os_name = str(ident.get("os") or "macos")
    locale = str(ident.get("locale") or "")
    rows: list[dict[str, Any]] = []

    def check(name: str, ok: bool, detail: str, klass: str) -> None:
        rows.append({"header": name, "class": klass, "result": "pass" if ok else "fail", "detail": detail})

    agent = lower.get("user-agent", "")
    tokens = PLATFORM_TOKENS.get(os_name, PLATFORM_TOKENS["macos"])
    family = "chromium" if "Chrome/" in agent else "firefox"
    check("user-agent", any(token in agent for token in tokens) and (family == "chromium" or "Firefox/" in agent),
          f"{agent[:80]}", "identity")
    check("user-agent:no-headless", "Headless" not in agent, "no Headless badge", "identity")

    languages = lower.get("accept-language", "")
    primary = languages.split(",")[0].split(";")[0].strip() if languages else ""
    check("accept-language", bool(primary) and primary.lower() == locale.lower(),
          f"{languages or '(none)'} locale={locale or '(unset)'}", "identity")

    encoding = lower.get("accept-encoding", "")
    check("accept-encoding", "gzip" in encoding and "br" in encoding, encoding or "(none)", "build")

    for name in HEADER_RULES["universal"]:
        check(name, bool(lower.get(name)), lower.get(name) or "(missing)", "universal")

    hints = {name: lower[name] for name in HEADER_RULES["chromium_family"] if name in lower}
    if family == "firefox":
        check("client-hints", not hints, "absent (Firefox family)" if not hints else f"present: {hints}", "family")
    else:
        missing = [name for name in HEADER_RULES["chromium_family"] if name not in hints]
        check("client-hints", not missing, f"missing: {missing}" if missing else "present (Chromium family)", "family")
        platform = hints.get("sec-ch-ua-platform", "").strip('"')
        expected = CH_PLATFORM.get(os_name, "macOS")
        check("sec-ch-ua-platform", platform == expected, f"{platform or '(missing)'} expected {expected}", "family")

    check("dnt", "dnt" not in lower, lower.get("dnt") or "absent", "build")
    check("sec-gpc", "sec-gpc" not in lower, lower.get("sec-gpc") or "absent", "build")

    # Every header must belong to a declared class; an unclassified one is a
    # default nobody has looked at yet.
    for name in sorted(set(lower) - set(KNOWN_HEADERS)):
        check(name, True, "unclassified - add it to KNOWN_HEADERS with an owner", "unknown")
    return rows


NAVIGATOR_JS = """JSON.stringify({
  language: navigator.language,
  languages: navigator.languages,
  platform: navigator.platform,
  ua: navigator.userAgent,
})"""

PLATFORM_OS = {"MacIntel": "macos", "Win32": "windows", "Linux armv8l": "linux", "Linux x86_64": "linux"}


def _identity_from_browser(name: str) -> dict[str, Any]:
    """An attached browser defines its own identity; read it instead of assuming."""
    data = client.call(name, "eval", {"js": NAVIGATOR_JS}, timeout=60).get("result") or "{}"
    try:
        parsed = json.loads(data)
    except ValueError:
        parsed = {}
    platform_name = str(parsed.get("platform") or "")
    return {
        "os": PLATFORM_OS.get(platform_name, "linux" if "Linux" in platform_name else "macos"),
        "locale": str(parsed.get("language") or ""),
        "source": "browser",
    }


def headers(name: str) -> dict[str, Any]:
    """What the browser really sent, labelled by class."""
    cfg = profile.require(name)
    info = client.call(name, "info", timeout=15)
    if str(info.get("url") or "").startswith("about:"):
        client.call(name, "goto", {"url": "https://example.com/"}, timeout=90)
    capture = client.call(name, "headers", timeout=30)
    requests = capture.get("requests") or []
    if not requests:
        return {"status": "unsupported", "environment": name, "checks": [], "verdict": "unsupported",
                "message": capture.get("reason") or "no document request captured"}
    last = requests[-1]
    if cfg.get("mode") == "attached":
        ident = _identity_from_browser(name)
    else:
        ident = dict(cfg.get("identity") or {})
        ident.setdefault("locale", ((cfg.get("network") or {}).get("egress") or {}).get("locale"))
    checks = evaluate_headers(last["headers"], ident)
    failures = [row for row in checks if row["result"] == "fail"]
    return {
        "status": "ok",
        "environment": name,
        "url": last["url"],
        "headers": last["headers"],
        "checks": checks,
        "failures": [row["header"] for row in failures],
        "verdict": "pass" if not failures else "fail",
    }


def local(name: str, screenshot: bool = True) -> dict[str, Any]:
    cfg = profile.require(name)
    info = client.call(name, "info", timeout=15)
    if str(info.get("url") or "").startswith("about:"):
        # An opaque origin cannot use localStorage; measure on a real origin.
        client.call(name, "goto", {"url": "https://example.com/"}, timeout=90)
    data = client.call(name, "eval", {"js": PROBE}, timeout=120)
    observed = data.get("result") or {}

    ident = cfg.get("identity") or {}
    network = cfg.get("network") or {}
    egress = network.get("egress") or {}
    resolved = ident.get("resolved") or {}
    expected_screen = [resolved.get("screen.width"), resolved.get("screen.height")]
    if not all(expected_screen):
        expected_screen = ident.get("screen") or []
    expected_cores = resolved.get("navigator.hardwareConcurrency", ident.get("cores"))
    expected_dpr = resolved.get("window.devicePixelRatio", ident.get("dpr"))

    checks: list[dict[str, Any]] = []

    def check(key: str, ok: bool | None, detail: str) -> None:
        checks.append({"check": key, "result": "pass" if ok else ("unknown" if ok is None else "fail"), "detail": detail})

    check("canvas_readback_stable", observed.get("canvasGeo") == observed.get("canvasGeo2")
          and observed.get("canvasText") == observed.get("canvasText2"),
          f"geo={observed.get('canvasGeo')} text={observed.get('canvasText')}")
    check("automation_flag_hidden", observed.get("webdriver") is False, f"navigator.webdriver={observed.get('webdriver')}")
    check("language_matches_egress", observed.get("lang") == egress.get("locale"),
          f"observed={observed.get('lang')} expected={egress.get('locale')}")
    check("timezone_matches_egress", observed.get("tz") == egress.get("timezone"),
          f"observed={observed.get('tz')} expected={egress.get('timezone')}")
    check("cores_match_identity", observed.get("cores") == expected_cores,
          f"observed={observed.get('cores')} expected={expected_cores}")
    screen_ok = bool(expected_screen) and list(observed.get("screen") or [])[:2] == list(expected_screen)[:2]
    check("screen_matches_identity", screen_ok, f"observed={observed.get('screen')} expected={expected_screen}")
    check("dpr_matches_identity", float(observed.get("dpr") or 0) == float(expected_dpr or 1),
          f"observed={observed.get('dpr')} expected={expected_dpr}")
    check("geolocation_denied_coherently",
          (observed.get("perms") or {}).get("geolocation") == "denied",
          f"permissions.geolocation={(observed.get('perms') or {}).get('geolocation')}")
    check("local_storage_writable", observed.get("storage") is True, f"storage={observed.get('storage')}")
    check("audio_renders", isinstance(observed.get("audio"), int), f"audio_rms={observed.get('audio')}")
    check("webgl_present", observed.get("webgl") is not None,
          f"renderer={(observed.get('webgl') or {}).get('renderer')}")

    result: dict[str, Any] = {
        "status": "ok",
        "environment": name,
        "egress_consistent": (profile.load_state(name) or {}).get("egress_consistent"),
        "observed": observed,
        "checks": checks,
        "failures": [c["check"] for c in checks if c["result"] == "fail"],
    }
    if screenshot:
        target = profile.profile_dir(name) / f"audit-local-{int(time.time())}.png"
        shot = client.call(name, "screenshot", {"file": str(target)}, timeout=60)
        result["screenshot"] = shot.get("file")
    state = profile.load_state(name) or {}
    warnings: list[str] = []
    if state.get("egress_consistent") is False:
        network = cfg.get("network") or {}
        stored = network.get("egress") or {}
        warnings.append(
            "exit geography differs from the pinned identity: observed "
            f"{stored.get('observed_country')}/{stored.get('observed_timezone') or stored.get('timezone')}, "
            f"identity {stored.get('timezone')}/{stored.get('locale')}; "
            "use a geographically stable proxy or create with --follow-egress"
        )
    result["warnings"] = warnings
    result["verdict"] = "pass" if not result["failures"] else "fail"
    return result


LEAK_PAGES = {
    "webrtc": "https://browserleaks.com/webrtc",
    "dns": "https://browserleaks.com/dns",
    "ip": "https://browserleaks.com/ip",
}
LEAK_KEYS = ("Local IP", "Public IP", "Leak", "DNS", "Remote", "IP Address", "Timezone", "Location")


def leaks(name: str, screenshot: bool = True) -> dict[str, Any]:
    cfg = profile.require(name)
    egress = (cfg.get("network") or {}).get("egress") or {}
    client.call(name, "goto", {"url": "https://api.ipify.org?format=json"}, timeout=90)
    body = client.call(name, "eval", {"js": "document.body.innerText"}, timeout=60).get("result") or ""
    try:
        observed_ip = json.loads(body).get("ip")
    except Exception:  # noqa: BLE001
        observed_ip = None

    report: dict[str, Any] = {
        "status": "ok",
        "environment": name,
        "expected_egress": egress.get("ip"),
        "observed_egress": observed_ip,
        "egress_matches": (observed_ip == egress.get("ip")) if egress.get("ip") else None,
        "pages": {},
    }
    for key, url in LEAK_PAGES.items():
        client.call(name, "goto", {"url": url}, timeout=120)
        client.call(name, "wait", {"ms": 3500}, timeout=30)
        text = client.call(name, "eval", {"js": "document.body.innerText"}, timeout=60).get("result") or ""
        lines = [line.strip() for line in text.splitlines() if any(k in line for k in LEAK_KEYS)]
        report["pages"][key] = {"url": url, "lines": lines[:14]}
        if screenshot:
            target = profile.profile_dir(name) / f"audit-{key}-{int(time.time())}.png"
            report["pages"][key]["screenshot"] = client.call(name, "screenshot", {"file": str(target)}, timeout=60).get("file")
    return report


def fingerprint_site(name: str, screenshot: bool = True) -> dict[str, Any]:
    client.call(name, "goto", {"url": "https://amiunique.org/fingerprint"}, timeout=120)
    client.call(name, "wait", {"ms": 8000}, timeout=60)
    text = client.call(name, "eval", {"js": "document.body.innerText"}, timeout=60).get("result") or ""
    report: dict[str, Any] = {
        "status": "ok",
        "environment": name,
        "url": "https://amiunique.org/fingerprint",
        "headline": [line.strip() for line in text.splitlines() if line.strip()][:30],
        "unique": "Unique" in text,
    }
    if screenshot:
        target = profile.profile_dir(name) / f"audit-amiunique-{int(time.time())}.png"
        report["screenshot"] = client.call(name, "screenshot", {"file": str(target)}, timeout=90).get("file")
    return report


def doctor() -> dict[str, Any]:
    from .engine import browser_path

    rows: list[dict[str, Any]] = []
    try:
        rows.append({"check": "browser", "result": "pass", "detail": browser_path()})
    except Exception as exc:  # noqa: BLE001
        rows.append({"check": "browser", "result": "warn", "detail": str(exc)})
    cache = identity.FONT_CACHE / f"{identity.host_os()}.json"
    rows.append({
        "check": "font_pool",
        "result": "pass" if cache.is_file() else "warn",
        "detail": str(cache) if cache.is_file() else "not calibrated; 'create --fonts subset:N' will calibrate",
    })
    rows.append({"check": "store", "result": "pass" if profile.store().parent.is_dir() else "warn", "detail": str(profile.store())})
    try:
        import camoufox
        from importlib.metadata import version
        rows.append({"check": "runtime", "result": "pass",
                     "detail": f"camoufox {version('camoufox')} playwright {version('playwright')}"})
    except Exception as exc:  # noqa: BLE001
        rows.append({"check": "runtime", "result": "fail", "detail": str(exc)})
    return {"status": "ok", "host_os": identity.host_os(), "checks": rows}
