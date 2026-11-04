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
    rows.append({"check": "store", "result": "pass" if profile.PROFILES.parent.is_dir() else "warn", "detail": str(profile.PROFILES)})
    try:
        import camoufox
        from importlib.metadata import version
        rows.append({"check": "runtime", "result": "pass",
                     "detail": f"camoufox {version('camoufox')} playwright {version('playwright')}"})
    except Exception as exc:  # noqa: BLE001
        rows.append({"check": "runtime", "result": "fail", "detail": str(exc)})
    return {"status": "ok", "host_os": identity.host_os(), "checks": rows}
