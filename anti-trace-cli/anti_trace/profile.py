"""Environment store: one directory per environment, self-describing."""

from __future__ import annotations

import fcntl
import json
import os
import shutil
import tarfile
import time
from contextlib import contextmanager
from pathlib import Path
from typing import Any, Iterator

SCHEMA = 2
BASE = Path(os.environ.get("ANTI_TRACE_HOME", Path.home() / ".anti-trace"))


def store() -> Path:
    """The profile root, resolved at call time so ANTI_TRACE_HOME and tests work."""
    return BASE / "profiles"


def _profiles() -> Path:
    return store()
TRANSIENT = {"engine.log", "engine.sock", ".lock", ".spawn", "state.json"}
LOCK_FILES = {"engine": ".lock", "spawn": ".spawn"}


class ProfileError(RuntimeError):
    pass


def sanitize(name: str) -> str:
    cleaned = "".join(c for c in name if c.isalnum() or c in "-_").strip("-_")
    if not cleaned:
        raise ProfileError(f"invalid environment name: {name!r}")
    return cleaned


def profile_dir(name: str) -> Path:
    return store() / sanitize(name)


def _read(path: Path) -> dict[str, Any] | None:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None


def _write(path: Path, data: Any, mode: int = 0o600) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(json.dumps(data, indent=2, ensure_ascii=False, sort_keys=False) + "\n", encoding="utf-8")
    os.chmod(tmp, mode)
    tmp.replace(path)


def load_config(name: str) -> dict[str, Any] | None:
    return _read(profile_dir(name) / "config.json")


def save_config(name: str, cfg: dict[str, Any]) -> None:
    _write(profile_dir(name) / "config.json", cfg)
    os.chmod(profile_dir(name), 0o700)


def load_state(name: str) -> dict[str, Any] | None:
    return _read(profile_dir(name) / "state.json")


def save_state(name: str, state: dict[str, Any]) -> None:
    _write(profile_dir(name) / "state.json", state, mode=0o600)


def clear_state(name: str) -> None:
    (profile_dir(name) / "state.json").unlink(missing_ok=True)


def socket_path(name: str) -> Path:
    return profile_dir(name) / "engine.sock"


def log_path(name: str) -> Path:
    return profile_dir(name) / "engine.log"


def exists(name: str) -> bool:
    return (profile_dir(name) / "config.json").is_file()


@contextmanager
def exclusive(name: str, timeout: float = 0.0, kind: str = "engine") -> Iterator[bool]:
    """Try to own one of the environment's locks. Yields True when acquired."""
    directory = profile_dir(name)
    directory.mkdir(parents=True, exist_ok=True)
    handle = open(directory / LOCK_FILES[kind], "a+", encoding="utf-8")
    acquired = False
    deadline = time.monotonic() + timeout
    try:
        while True:
            try:
                fcntl.flock(handle, fcntl.LOCK_EX | fcntl.LOCK_NB)
                acquired = True
                break
            except BlockingIOError:
                if time.monotonic() >= deadline:
                    break
                time.sleep(0.05)
        yield acquired
    finally:
        if acquired:
            fcntl.flock(handle, fcntl.LOCK_UN)
        handle.close()


def list_profiles() -> list[dict[str, Any]]:
    _profiles().mkdir(parents=True, exist_ok=True)
    rows: list[dict[str, Any]] = []
    for entry in sorted(_profiles().iterdir()):
        if not entry.is_dir() or not (entry / "config.json").is_file():
            continue
        cfg = load_config(entry.name) or {}
        state = load_state(entry.name) or {}
        attached = cfg.get("mode") == "attached"
        running = bool(state.get("pid")) and _alive(state["pid"])
        if not running:
            state = {}
        rows.append({
            "name": entry.name,
            "status": "ATTACHED" if attached else ("RUNNING" if running else "IDLE"),
            "mode": "attached" if attached else "managed",
            "cdp": cfg.get("cdp"),
            "pid": state.get("pid"),
            "socket": state.get("socket"),
            "proxy": (cfg.get("network") or {}).get("proxy") or "DIRECT",
            "egress_ip": (cfg.get("network") or {}).get("egress", {}).get("ip"),
            "timezone": (cfg.get("network") or {}).get("egress", {}).get("timezone"),
            "locale": (cfg.get("network") or {}).get("egress", {}).get("locale"),
            "fingerprint_id": (cfg.get("identity") or {}).get("id"),
            "created_at": cfg.get("created_at"),
            "started_at": state.get("started_at"),
            "url": state.get("url"),
        })
    return rows


def pid_alive(pid: int) -> bool:
    return _alive(pid)


def _alive(pid: int) -> bool:
    try:
        import psutil
        proc = psutil.Process(pid)
        return proc.is_running() and proc.status() != psutil.STATUS_ZOMBIE
    except Exception:
        return False


def require(name: str) -> dict[str, Any]:
    cfg = load_config(name)
    if cfg is None:
        raise ProfileError(f"environment {sanitize(name)!r} does not exist; create it first")
    return cfg


def reset_data(name: str) -> None:
    data = profile_dir(name) / "data"
    if data.is_dir():
        shutil.rmtree(data)
    data.mkdir(parents=True, exist_ok=True)
    for transient in TRANSIENT:
        (profile_dir(name) / transient).unlink(missing_ok=True)


def remove(name: str) -> None:
    shutil.rmtree(profile_dir(name))


def export(name: str, dest: Path | None = None) -> Path:
    directory = profile_dir(name)
    if not directory.is_dir():
        raise ProfileError(f"environment {sanitize(name)!r} does not exist")
    out = dest or Path.cwd() / f"{sanitize(name)}.atb.tar.gz"
    out.parent.mkdir(parents=True, exist_ok=True)
    state = load_state(name)

    def skip(info: tarfile.TarInfo) -> tarfile.TarInfo | None:
        base = Path(info.name).name
        if base in TRANSIENT:
            return None
        return info

    with tarfile.open(out, "w:gz") as tar:
        tar.add(directory, arcname=sanitize(name), filter=skip)
    return out.resolve()


def import_archive(archive: Path, rename: str | None = None) -> str:
    if not archive.is_file():
        raise ProfileError(f"archive not found: {archive}")
    _profiles().mkdir(parents=True, exist_ok=True)
    with tarfile.open(archive, "r:gz") as tar:
        members = [m for m in tar.getmembers() if m.name and not m.name.startswith("/")]
        if not members:
            raise ProfileError("archive is empty")
        root = Path(members[0].name).parts[0]
        dest_name = sanitize(rename or root)
        dest = _profiles() / dest_name
        if dest.exists():
            raise ProfileError(f"environment {dest_name!r} already exists")
        staging = _profiles() / f".import-{dest_name}-{int(time.time() * 1000)}"
        staging.mkdir(parents=True)
        try:
            tar.extractall(staging, members=members, filter="data")
            extracted = staging / root
            shutil.move(str(extracted if extracted.is_dir() else staging), str(dest))
        finally:
            shutil.rmtree(staging, ignore_errors=True)
    cfg = load_config(dest_name) or {}
    cfg["name"] = dest_name
    save_config(dest_name, cfg)
    for transient in TRANSIENT:
        (dest / transient).unlink(missing_ok=True)
    return dest_name
