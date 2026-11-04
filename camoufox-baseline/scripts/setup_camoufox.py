#!/usr/bin/env python3
"""Fetch the wrapper-paired build without touching a user's Camoufox installation."""
from __future__ import annotations

import hashlib
import importlib.metadata
import json
import os
from pathlib import Path
import platform
import subprocess
import sys
import time
import traceback

ROOT = Path(__file__).resolve().parents[1]
RUNTIME = ROOT / ".local" / "runtimes" / "camoufox"


def isolated_environment() -> dict[str, str]:
    home = RUNTIME / "home"
    home.mkdir(parents=True, exist_ok=True)
    env = dict(os.environ, HOME=str(home), XDG_CACHE_HOME=str(home / ".cache"))
    # Do not inherit an unrelated browser/model override from the shell.
    for name in ("CAMOUFOX_EXECUTABLE_PATH", "FPGEN_MODEL_URL"):
        env.pop(name, None)
    return env


def main() -> int:
    RUNTIME.mkdir(parents=True, exist_ok=True)
    os.environ.update(isolated_environment())
    for name in ("CAMOUFOX_EXECUTABLE_PATH", "FPGEN_MODEL_URL"):
        os.environ.pop(name, None)
    evidence = {"schema_version": 1, "started_at": time.time(), "status": "error"}
    try:
        import requests
        from camoufox.pkgman import INSTALL_DIR, launch_path, camoufox_path
        from camoufox.fpgen_model import ensure_fpgen_model, PIN, is_pinned

        dist = importlib.metadata.distribution("camoufox")
        pin = json.loads(Path(dist.locate_file("camoufox/browser-pin.json")).read_text())
        os_name = {"Darwin": "mac", "Linux": "lin", "Windows": "win"}[platform.system()]
        arch = {"aarch64": "arm64", "AMD64": "x86_64"}.get(platform.machine(), platform.machine())
        name = f"camoufox-{pin['version']}-{pin['build']}-{os_name}.{arch}.zip"
        url = f"https://api.github.com/repos/{pin['repo']}/releases/tags/{pin['tag']}"
        headers = {"Accept": "application/vnd.github+json"}
        if os.environ.get("GITHUB_TOKEN"):
            headers["Authorization"] = "Bearer " + os.environ["GITHUB_TOKEN"]
        response = requests.get(url, headers=headers, timeout=(15, 45))
        response.raise_for_status()
        release = response.json()
        asset = next(a for a in release["assets"] if a["name"] == name)
        if not asset.get("digest", "").startswith("sha256:"):
            raise RuntimeError("Refusing a browser release without an upstream SHA-256 digest")
        evidence.update(wrapper=dist.version, paired_build=pin, release_url=release["html_url"],
                        asset={k: asset[k] for k in ("id", "name", "size", "digest", "browser_download_url")},
                        cache=str(INSTALL_DIR), model_pin=PIN)
        try:
            installed = camoufox_path(download_if_missing=False)
        except Exception:
            installed = None
        if installed is None:
            command = [sys.executable, "-m", "camoufox", "fetch"]
            evidence["fetch_command"] = command
            subprocess.run(command, env=isolated_environment(), check=True, timeout=1200)
        installed = camoufox_path(download_if_missing=False)
        metadata = json.loads((installed / "version.json").read_text())
        if metadata.get("sha256") != asset["digest"].split(":", 1)[1]:
            raise RuntimeError("Installed build metadata does not match the upstream asset digest")
        ensure_fpgen_model()
        if not is_pinned():
            raise RuntimeError("Fingerprint model did not match pinned SHA-256 values")
        executable = Path(launch_path(installed))
        digest = hashlib.sha256()
        with executable.open("rb") as stream:
            for block in iter(lambda: stream.read(1024 * 1024), b""):
                digest.update(block)
        evidence.update(status="ready", installed_metadata=metadata, executable=str(executable),
                        executable_sha256=digest.hexdigest(), model_verified=True,
                        versions={n: importlib.metadata.version(n) for n in ("camoufox", "playwright", "psutil", "fpgen")})
    except Exception as error:
        evidence.update(error={"type": type(error).__name__, "message": str(error), "traceback": traceback.format_exc()})
    evidence["finished_at"] = time.time()
    (RUNTIME / "setup.json").write_text(json.dumps(evidence, ensure_ascii=False, indent=2) + "\n")
    print(json.dumps(evidence, ensure_ascii=False, indent=2))
    return 0 if evidence["status"] == "ready" else 1


if __name__ == "__main__":
    raise SystemExit(main())
