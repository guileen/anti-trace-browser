"""ATB-owned Camoufox profile lifecycle for ``mioa_core.profile``.

Core owns managed storage, leases, archives, snapshots and the atomic config
commit. It deliberately owns no Camoufox identity or browser lookup. This module
is the explicit boundary: ``cli`` passes it as ``runtime_adapters`` to
``profile.export`` / ``import_archive`` / ``migrate``. Core never imports it.
"""

from __future__ import annotations

import copy
import hashlib
from pathlib import Path
from typing import Any

from mioa_core import profile

from . import identity


class CamoufoxProfileAdapter:
    """Camoufox validation and migration owned by ATB, not by core."""

    runtime_id = "camoufox"

    def validate(self, cfg: dict[str, Any], *, check_artifacts: bool = True) -> None:
        identity.validate_cfox_spec(cfg, check_artifacts=check_artifacts)

    def migrate(self, cfg: dict[str, Any], *, name: str, binary: str | Path | None,
                overrides: dict[str, Any] | None, inline_proxy: str | None) -> dict[str, Any]:
        from .engine import browser_path

        ident = cfg.get("identity", {})
        network = copy.deepcopy(cfg.get("network", {}))
        network.pop("proxy", None)
        if inline_proxy:
            network["proxy_ref"] = None
        result = identity.create_cfox_spec(
            name,
            seed=cfg.get("seed") or identity.normalize_seed(hashlib.sha256(
                profile.canonical_bytes(ident)).hexdigest()),
            os_name=ident.get("os", identity.host_os()),
            cores=None,
            font_count=ident.get("font_count", len(ident.get("fonts") or [])),
            overrides=overrides if overrides is not None else cfg.get("overrides", {}),
            network=network,
            binary=str(binary or cfg.get("runtime", {}).get("binary") or browser_path()),
            existing=[],
            environment_id=cfg.get("id"),
        )
        result.update(id=cfg.get("id") or result["id"],
                      revision=int(cfg.get("revision", 1)) + 1)
        return result


RUNTIME_ADAPTERS = {"camoufox": CamoufoxProfileAdapter()}
