"""Verification: what the environment actually presents, and what leaks."""

from __future__ import annotations

import json
import time
from pathlib import Path
from typing import Any
from urllib.parse import urlsplit

from mioa_core import profile

from . import client, identity

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
    "chromium_family": ["sec-ch-ua", "sec-ch-ua-mobile", "sec-ch-ua-platform"],
}
CH_PLATFORM = {"macos": "macOS", "windows": "Windows", "linux": "Linux"}

KNOWN_HEADERS = {
    "host": "request",
    "cookie": "origin", "referer": "origin", "origin": "origin",
    "if-none-match": "origin", "if-modified-since": "origin", "range": "origin",
    "cache-control": "origin", "pragma": "origin",
    "connection": "protocol", "priority": "build", "te": "protocol",
    "user-agent": "identity", "accept-language": "identity", "accept": "request",
    "accept-encoding": "build", "upgrade-insecure-requests": "request",
    "sec-fetch-dest": "request", "sec-fetch-mode": "request",
    "sec-fetch-site": "request", "sec-fetch-user": "request",
    "sec-ch-ua": "family", "sec-ch-ua-mobile": "family", "sec-ch-ua-platform": "family",
    "dnt": "privacy", "sec-gpc": "privacy",
}

PLATFORM_TOKENS = {
    "macos": ("Macintosh", "Mac OS X"),
    "windows": ("Windows NT",),
    "linux": ("X11; Linux", "Linux x86_64"),
}


def evaluate_headers(
    headers: dict[str, str], ident: dict[str, Any], *,
    context: dict[str, Any] | None = None, privacy_policy: dict[str, Any] | None = None,
) -> list[dict[str, Any]]:
    """Judge actual request context, not a universal desktop-navigation template.

    context: url/scheme, resource_type (document/fetch/subresource/worker/redirect),
    protocol, user_activation, mode, destination, fetch_site and expected_headers.
    privacy_policy: dnt/gpc (bool or wire string), client_hints (bool).
    Missing policy/build/context evidence is review_required, never a pass.
    """
    lower = {key.lower(): str(value) for key, value in headers.items()}
    ctx, policy = context or {}, privacy_policy or {}
    rows: list[dict[str, Any]] = []

    def check(name: str, ok: bool | None, detail: str, klass: str) -> None:
        rows.append({"header": name, "class": klass,
                     "result": "review_required" if ok is None else ("pass" if ok else "fail"), "detail": detail})

    agent = lower.get("user-agent", "")
    os_name, locale = str(ident.get("os") or ""), str(ident.get("locale") or "")
    expected_ua = (ident.get("resolved") or {}).get("navigator.userAgent") or ident.get("ua")
    tokens = PLATFORM_TOKENS.get(os_name)
    check("user-agent", agent == expected_ua if expected_ua else
          (bool(agent) and any(token in agent for token in tokens) if tokens else None),
          f"{agent[:100]} expected={expected_ua or os_name or '(unknown identity)'}", "identity")
    check("user-agent:no-headless", "Headless" not in agent if agent else None, "no Headless badge", "identity")
    primary = lower.get("accept-language", "").split(",")[0].split(";")[0].strip()
    check("accept-language", primary.lower() == locale.lower() if locale else None,
          f"{lower.get('accept-language', '(none)')} locale={locale or '(unset)'}", "identity")

    parsed = urlsplit(str(ctx.get("url") or ""))
    secure = ctx.get("secure_context")
    scheme = str(ctx.get("scheme") or parsed.scheme).lower()
    if secure is None and scheme:
        secure = scheme == "https" or parsed.hostname in {"localhost", "127.0.0.1", "::1"}
    resource = ctx.get("resource_type") or ctx.get("request_type")
    navigation = resource in {"document", "navigation", "redirect"}
    expected = {key.lower(): value for key, value in (ctx.get("expected_headers") or {}).items()}
    for name in ("accept", "accept-encoding", "priority"):
        check(name, (lower.get(name) == expected[name]) if name in expected else None,
              f"observed={lower.get(name, '(absent)')} expected={expected.get(name, '(build/request policy unavailable)')}",
              "build")
    # Fetch Metadata is a secure-context facility; Sec-Fetch-User denotes activation,
    # not every navigation, and is absent on fetch/subresource/Worker requests.
    metadata = {
        "sec-fetch-dest": ctx.get("destination", "document" if navigation else "empty" if resource in {"fetch", "worker"} else None),
        "sec-fetch-mode": ctx.get("mode", "navigate" if navigation else "cors" if resource == "fetch" else None),
        "sec-fetch-site": ctx.get("fetch_site"),
    }
    if metadata["sec-fetch-dest"] == "":
        # Request.destination is empty string; its Fetch Metadata wire token is "empty".
        metadata["sec-fetch-dest"] = "empty"
    for name, value in metadata.items():
        actual = lower.get(name)
        ok = None
        if secure is False:
            ok = actual is None
        elif secure is True and resource:
            ok = actual == value if value is not None else (
                actual in {"none", "same-origin", "same-site", "cross-site"} if name == "sec-fetch-site" else None)
        check(name, ok, f"observed={actual!r} expected={value!r} secure={secure}", "request")
    activation = ctx.get("user_activation")
    expected_user = "?1" if navigation and activation is True else None
    user_ok = None if secure is None or not resource or (navigation and activation is None) else lower.get("sec-fetch-user") == expected_user
    if secure is False:
        user_ok = "sec-fetch-user" not in lower
    check("sec-fetch-user", user_ok, f"observed={lower.get('sec-fetch-user')!r} activation={activation}", "request")
    upgrade = lower.get("upgrade-insecure-requests")
    check("upgrade-insecure-requests", (upgrade in {None, "1"} if navigation else upgrade is None) if resource else None,
          f"observed={upgrade!r} resource_type={resource}", "request")

    family = "chromium" if "Chrome/" in agent or "Chromium/" in agent else "firefox" if "Firefox/" in agent else None
    hints = {name: lower[name] for name in HEADER_RULES["chromium_family"] if name in lower}
    hints_enabled = policy.get("client_hints", family == "chromium")
    if family == "firefox" or secure is False or hints_enabled is False:
        hints_ok = not hints
    elif family == "chromium" and secure is True:
        hints_ok = all(name in hints for name in HEADER_RULES["chromium_family"])
    else:
        hints_ok = None
    check("client-hints", hints_ok, f"family={family} secure={secure} policy={hints_enabled} observed={hints}", "family")
    if "sec-ch-ua-platform" in hints:
        value = hints["sec-ch-ua-platform"].strip('"')
        check("sec-ch-ua-platform", value == CH_PLATFORM[os_name] if os_name in CH_PLATFORM else None,
              f"{value} expected={CH_PLATFORM.get(os_name)}", "identity")
    for name, key in (("dnt", "dnt"), ("sec-gpc", "gpc")):
        value = policy.get(key)
        wanted = "1" if value is True else None if value is False else str(value) if value is not None else None
        check(name, lower.get(name) == wanted if key in policy else None,
              f"observed={lower.get(name)!r} expected={wanted!r} policy_configured={key in policy}", "privacy")
    protocol = str(ctx.get("protocol") or "").lower()
    h2 = protocol in {"h2", "http/2", "http/2.0", "2", "h3", "http/3", "3"}
    h1 = protocol in {"h1", "http/1.0", "http/1.1", "1.0", "1.1"}
    check("connection", "connection" not in lower if h2 else True if h1 else None,
          f"protocol={protocol or '(unknown)'} observed={lower.get('connection')!r}", "protocol")
    if "te" in lower:
        check("te", lower["te"].lower() == "trailers" if h2 else True if h1 else None, lower["te"], "protocol")
    for name, value in expected.items():
        if name not in {"accept", "accept-encoding", "priority"}:
            check(name + ":configured", lower.get(name) == value,
                  f"observed={lower.get(name)!r} expected={value!r}", KNOWN_HEADERS.get(name, "unknown"))
    for name in sorted(set(lower) - set(KNOWN_HEADERS)):
        check(name, None, "unclassified header requires an owner and rule", "unknown")
    return rows


def _header_summary(checks: list[dict[str, Any]]) -> dict[str, int]:
    return {status: sum(row["result"] == status for row in checks)
            for status in ("pass", "fail", "unsupported", "error", "not_tested", "review_required")}


def _header_verdict(checks: list[dict[str, Any]]) -> str:
    statuses = {row["result"] for row in checks}
    return next((status for status in ("fail", "error", "review_required", "unsupported", "not_tested")
                 if status in statuses), "pass" if checks else "not_tested")


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


def headers(
    name: str, *, echo_url: str | None = None, context: dict[str, Any] | None = None,
    privacy_policy: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """Keep CDP and server-echo observations independent; explicit echo is authoritative.

    Echo uses a browser fetch (and its real headers), never a Python HTTP request.
    It needs a same-origin endpoint or explicit CORS permission. No implicit
    external navigation is performed. Captured document requests are not treated
    as evidence for fetch/subresource/Worker traffic.
    """
    cfg = profile.require(name)
    ident = _identity_from_browser(name) if cfg.get("mode") == "attached" else dict(cfg.get("identity") or {})
    ident.setdefault("locale", ((cfg.get("network") or {}).get("egress") or {}).get("locale"))
    policy = privacy_policy if privacy_policy is not None else cfg.get("privacy_policy") or {}
    observations: list[dict[str, Any]] = []
    try:
        capture = client.call(name, "headers", timeout=30)
        capture_status = capture.get("status") or "not_tested"
        for request in capture.get("requests") or []:
            ctx = {**(context or {}), "url": request["url"], "resource_type": "document"}
            ctx.update({key: request[key] for key in ("protocol", "method") if key in request})
            checks = evaluate_headers(request["headers"], ident, context=ctx, privacy_policy=policy)
            observations.append({"source": "browser", **request, "context": ctx, "checks": checks,
                                 "verdict": _header_verdict(checks)})
        capture_error = capture.get("reason") if not observations else None
    except Exception as exc:  # noqa: BLE001 - server observation remains independently available
        capture_error = str(exc)
        capture_status = "error"
    echo_error = None
    if echo_url:
        try:
            js = """(async () => {
              const response = await fetch(URL_VALUE, {cache:'no-store'});
              if (!response.ok) throw new Error('echo HTTP ' + response.status);
              return {echo: await response.json(), js: {ua:navigator.userAgent, language:navigator.language}};
            })()""".replace("URL_VALUE", json.dumps(echo_url))
            reply = client.call(name, "eval", {"js": js}, timeout=30)
            if reply.get("status", "ok") != "ok":
                raise ValueError(reply.get("message") or "echo evaluation failed")
            result = reply.get("result") or {}
            echo = result.get("echo") or {}
            if not isinstance(echo.get("headers"), dict) or not all(echo.get(key) for key in ("url", "method", "protocol")):
                raise ValueError("echo must return headers, method, url and protocol")
            ctx = {**(context or {}), "resource_type": "fetch", "url": echo["url"],
                   "method": echo["method"], "protocol": echo["protocol"]}
            checks = evaluate_headers(echo["headers"], ident, context=ctx, privacy_policy=policy)
            js_values = result.get("js") or {}
            wire = {key.lower(): value for key, value in echo["headers"].items()}
            for key, js_key in (("user-agent", "ua"), ("accept-language", "language")):
                value = wire.get(key, "").split(",")[0].split(";")[0] if key == "accept-language" else wire.get(key)
                checks.append({"header": key + ":js", "class": "cross-observation",
                               "result": "pass" if value and value == js_values.get(js_key) else "fail",
                               "detail": f"server={value!r} js={js_values.get(js_key)!r}"})
            observations.append({"source": "server", **echo, "js": js_values, "context": ctx,
                                 "checks": checks, "verdict": _header_verdict(checks)})
        except Exception as exc:  # noqa: BLE001 - preserve CDP but never substitute it for echo
            echo_error = str(exc)
    chosen = next((row for row in reversed(observations) if row["source"] == ("server" if echo_url else "browser")), None)
    checks = list(chosen["checks"]) if chosen else []
    if echo_error or (not chosen and capture_status in {"error", "unsupported"}):
        checks.append({"header": "server-echo" if echo_url else "request-capture", "class": "observation",
                       "result": "error" if echo_error else capture_status,
                       "detail": echo_error or capture_error or "no request evidence"})
    verdict = _header_verdict(checks)
    return {
        "status": "error" if verdict == "error" else "ok" if chosen else verdict,
        "environment": name, "url": chosen["url"] if chosen else echo_url,
        "headers": chosen["headers"] if chosen else {}, "checks": checks,
        "source": chosen["source"] if chosen else None, "observations": observations,
        "capture_error": capture_error, "echo_error": echo_error,
        "failures": [row["header"] for row in checks if row["result"] == "fail"],
        "pending": [row["header"] for row in checks if row["result"] == "review_required"],
        "summary": _header_summary(checks), "verdict": verdict, "rules_version": 2,
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
