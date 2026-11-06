"""Unit checks for the pure parts: proxy parsing, names, identity planning."""

from __future__ import annotations

import unittest

from anti_trace import identity, net, profile


class ProxyTests(unittest.TestCase):
    def test_direct(self) -> None:
        self.assertIsNone(net.parse_proxy(None))
        self.assertIsNone(net.parse_proxy("DIRECT"))

    def test_http_with_credentials(self) -> None:
        proxy = net.parse_proxy("http://user:p%40ss@proxy.local:3128")
        self.assertEqual(proxy, {"server": "http://proxy.local:3128", "username": "user", "password": "p@ss"})

    def test_default_port(self) -> None:
        self.assertEqual(net.parse_proxy("socks5://proxy.local")["server"], "socks5://proxy.local:1080")

    def test_socks_credentials_are_refused(self) -> None:
        with self.assertRaises(net.NetworkError):
            net.parse_proxy("socks5://user:pass@proxy.local:1080")

    def test_unknown_scheme(self) -> None:
        with self.assertRaises(net.NetworkError):
            net.parse_proxy("ftp://proxy.local:21")


class NameTests(unittest.TestCase):
    def test_sanitize_keeps_safe_characters(self) -> None:
        self.assertEqual(profile.sanitize("my-env_1"), "my-env_1")

    def test_sanitize_rejects_empty(self) -> None:
        with self.assertRaises(profile.ProfileError):
            profile.sanitize("///")

    def test_sanitize_strips_path_parts(self) -> None:
        self.assertNotIn("/", profile.sanitize("../../etc/passwd"))


class LocaleTests(unittest.TestCase):
    def test_primary_language_per_country(self) -> None:
        expected = {"US": "en-US", "GB": "en-GB", "JP": "ja-JP", "DE": "de-DE", "PL": "pl-PL", "CN": "zh-CN"}
        for country, tag in expected.items():
            self.assertEqual(identity.locale_for(country), tag)

    def test_unknown_country_falls_back(self) -> None:
        self.assertEqual(identity.locale_for("ZZ"), "en-US")


class DeviceTests(unittest.TestCase):
    def test_classes_are_distinct(self) -> None:
        classes = identity.device_classes("macos")
        screens = [tuple(item["screen"]) for item in classes]
        self.assertEqual(len(screens), len(set(screens)))

    def test_next_device_skips_used(self) -> None:
        classes = identity.device_classes("macos")
        taken = [classes[0]["name"], classes[1]["name"]]
        self.assertNotIn(identity.next_device("macos", taken)["name"], taken)

    def test_window_fits_inside_screen(self) -> None:
        window = identity.window_for([1512, 982])
        self.assertLess(window["outerWidth"], 1512)
        self.assertLess(window["outerHeight"], 982)

    def test_digest_is_stable_and_identity_sensitive(self) -> None:
        base = {"fingerprint": {"navigator": {"userAgent": "UA"}}, "cores": 8, "os": "macos",
                "screen": [1512, 982], "dpr": 2, "device": "mbp14", "fonts": None}
        self.assertEqual(identity.digest(base), identity.digest(dict(base)))
        other = dict(base, cores=12)
        self.assertNotEqual(identity.digest(base), identity.digest(other))


class FontTests(unittest.TestCase):
    POOL = ["Arial", "Times New Roman", "Menlo", "Avenir", "Zapfino", "Bodoni 72", "Chalkduster", "Didot"]

    def test_core_fonts_survive_a_small_subset(self) -> None:
        picked = identity.pick_fonts(self.POOL, {"screen": {"width": 1}}, 4, seed=1)
        self.assertEqual(len(picked), 4)
        self.assertIn("Arial", picked)
        self.assertIn("Menlo", picked)

    def test_same_inputs_same_subset(self) -> None:
        fingerprint = {"screen": {"width": 1512}, "navigator": {"userAgent": "UA"}}
        self.assertEqual(
            identity.pick_fonts(self.POOL, fingerprint, 6, seed=3),
            identity.pick_fonts(self.POOL, fingerprint, 6, seed=3),
        )

    def test_identities_get_different_subsets(self) -> None:
        a = identity.pick_fonts(self.POOL, {"screen": {"width": 1512}, "navigator": {"userAgent": "UA"}}, 6, seed=1)
        b = identity.pick_fonts(self.POOL, {"screen": {"width": 1728}, "navigator": {"userAgent": "UA"}}, 6, seed=2)
        self.assertNotEqual(a, b)


class AttachTest(unittest.TestCase):
    def test_attach_requires_a_scheme_and_respects_managed(self):
        import tempfile
        from pathlib import Path

        from anti_trace import attached, profile

        with tempfile.TemporaryDirectory() as home:
            original = profile.BASE
            profile.BASE = (Path(home) / "store")
            try:
                with self.assertRaises(profile.ProfileError):
                    attached.attach("fury", "127.0.0.1:9222")

                profile.save_config("managed-one", {"schema": 2, "name": "managed-one", "mode": "managed"})
                with self.assertRaises(profile.ProfileError):
                    attached.attach("managed-one", "ws://127.0.0.1:9222/x")

                result = attached.attach("fury", "ws://127.0.0.1:9222/devtools/browser/abc")
                self.assertEqual(result["mode"], "attached")
                self.assertEqual(profile.load_config("fury")["cdp"], "ws://127.0.0.1:9222/devtools/browser/abc")
                self.assertEqual(profile.load_state("fury")["status"], "READY")
            finally:
                profile.BASE = original


class HeaderAuditTest(unittest.TestCase):
    GOOD = {
        "host": "example.com",
        "user-agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:158.0) Gecko/20100101 Firefox/158.0",
        "accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "accept-language": "en-US,en;q=0.9",
        "accept-encoding": "gzip, deflate, br, zstd",
        "connection": "keep-alive",
        "upgrade-insecure-requests": "1",
        "sec-fetch-dest": "document",
        "sec-fetch-mode": "navigate",
        "sec-fetch-site": "none",
        "sec-fetch-user": "?1",
        "priority": "u=0, i",
    }
    IDENT = {"os": "macos", "locale": "en-US"}
    CONTEXT = {"url": "https://example.com/", "resource_type": "document", "protocol": "HTTP/1.1",
               "user_activation": True, "fetch_site": "none"}
    POLICY = {"dnt": False, "gpc": False}

    def evaluate(self, headers):
        from anti_trace.audit import evaluate_headers

        baseline = self.CHROME if "Chrome/" in headers.get("user-agent", "") else self.GOOD
        context = dict(self.CONTEXT, expected_headers={key: baseline.get(key) for key in ("accept", "accept-encoding", "priority")})
        return evaluate_headers(headers, self.IDENT, context=context, privacy_policy=self.POLICY)

    def _results(self, **overrides):
        # Explicit policy/context distinguishes unreviewed defaults from failures.
        headers = dict(self.GOOD)
        for key, value in overrides.items():
            if value is None:
                headers.pop(key, None)
            else:
                headers[key] = value
        return {row["header"]: row for row in self.evaluate(headers)}

    def test_canonical_firefox_headers_pass(self):
        rows = self._results()
        self.assertTrue(all(row["result"] == "pass" for row in rows.values()), rows)

    def test_language_drift_is_caught(self):
        self.assertEqual(self._results(**{"accept-language": "ja-JP,ja;q=0.9"})["accept-language"]["result"], "fail")

    def test_chromium_ua_without_client_hints_is_caught(self):
        ua = self.GOOD["user-agent"].replace("rv:158.0", "Chrome/158.0.0.0")
        rows = self._results(**{"user-agent": ua})
        self.assertEqual(rows["client-hints"]["result"], "fail")

    def test_client_hints_break_a_firefox_identity(self):
        rows = self._results(**{"sec-ch-ua": '"(brave)";v="158"'})
        self.assertEqual(rows["client-hints"]["result"], "fail")

    CHROME = {
        "host": "example.com",
        "connection": "keep-alive",
        "sec-ch-ua": '"Chromium";v="156", "Google Chrome";v="156"',
        "sec-ch-ua-mobile": "?0",
        "sec-ch-ua-platform": '"macOS"',
        "upgrade-insecure-requests": "1",
        "user-agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "
                      "(KHTML, like Gecko) Chrome/156.0.0.0 Safari/537.36",
        "accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/jxl,*/*;q=0.8",
        "sec-fetch-site": "none", "sec-fetch-mode": "navigate", "sec-fetch-user": "?1",
        "sec-fetch-dest": "document",
        "accept-encoding": "gzip, deflate, br, zstd",
        "accept-language": "en-US,en;q=0.9",
    }

    def test_chromium_headers_are_judged_as_chromium(self):
        rows = {row["header"]: row for row in self.evaluate(dict(self.CHROME))}
        self.assertEqual(rows["client-hints"]["result"], "pass")
        self.assertEqual(rows["sec-ch-ua-platform"]["result"], "pass")
        self.assertTrue(all(row["result"] == "pass" for row in rows.values()), rows)

    def test_chromium_platform_mismatch_is_caught(self):
        headers = dict(self.CHROME, **{"sec-ch-ua-platform": '"Windows"'})
        rows = {row["header"]: row for row in self.evaluate(headers)}
        self.assertEqual(rows["sec-ch-ua-platform"]["result"], "fail")

    def test_firefox_identity_with_chromium_hints_fails(self):
        headers = dict(self.GOOD, **{"sec-ch-ua": '"Chromium";v="156"'})
        rows = {row["header"]: row for row in self.evaluate(headers)}
        self.assertEqual(rows["client-hints"]["result"], "fail")

    def test_unclassified_header_is_reported(self):
        rows = self._results(**{"x-new-fingerprint": "1"})
        self.assertEqual(rows["x-new-fingerprint"]["class"], "unknown")
        self.assertEqual(rows["x-new-fingerprint"]["result"], "review_required")


class FieldVerdictTest(unittest.TestCase):
    def test_denial_without_challenge_is_blocked(self):
        from anti_trace.field import _verdict

        self.assertEqual(_verdict(500, []), "blocked")

    def test_redirect_does_not_prove_clearance(self):
        from anti_trace.field import _verdict

        self.assertEqual(_verdict(200, [], moved=True), "reached")
        self.assertEqual(_verdict(403, [], moved=True), "blocked")

    def test_active_challenge_preserves_403_without_calling_it_blocked(self):
        from anti_trace.field import _verdict

        for status in (200, 403):
            for marker in ("turnstile", "captcha-text", "px-captcha"):
                self.assertEqual(_verdict(status, [marker]), "challenge")

    def test_passive_vendor_names_and_absent_observations_are_distinct(self):
        from anti_trace.field import _verdict

        self.assertEqual(_verdict(200, ["kasada", "datadome"]), "reached")
        self.assertEqual(_verdict(None, []), "not_tested")
        self.assertEqual(_verdict(200, [], observed=False), "not_tested")
        self.assertEqual(_verdict(200, [], error="capture timed out"), "error")


class ProfileSecurityTest(unittest.TestCase):
    def setUp(self):
        import tempfile
        from pathlib import Path
        self.temporary = tempfile.TemporaryDirectory()
        self.original = profile.BASE
        profile.BASE = Path(self.temporary.name) / "manager"
        self.cfg = {"schema": 3, "id": "immutable-environment", "name": "original", "mode": "managed",
                    "runtime": {"id": "obscura"}, "network": {"proxy_ref": None},
                    "storage": {"format_version": 1}, "assets": {}}

    def tearDown(self):
        profile.BASE = self.original
        self.temporary.cleanup()

    def test_owned_proxy_is_private_and_survives_rename(self):
        import json
        import stat
        from anti_trace.native_spec import resolve_proxy
        value = "http://user:private-password@proxy.example:3128"
        profile.configure_proxy(self.cfg, value)
        reference = self.cfg["network"]["proxy_ref"]
        self.assertNotIn("private-password", json.dumps(self.cfg))
        self.cfg["name"] = "renamed"
        self.assertEqual(resolve_proxy(self.cfg), value)
        path = profile._secret_path(self.cfg)
        self.assertEqual(stat.S_IMODE(path.stat().st_mode), 0o600)
        self.assertEqual(stat.S_IMODE(path.parent.stat().st_mode), 0o700)
        self.assertEqual(reference, self.cfg["network"]["proxy_ref"])
        profile.clear_proxy_secret(self.cfg)
        with self.assertRaisesRegex(Exception, "network_unavailable"):
            resolve_proxy(self.cfg)

    def test_environment_wins_without_being_overwritten(self):
        import os
        from unittest.mock import patch
        from anti_trace.native_spec import resolve_proxy
        profile.configure_proxy(self.cfg, "http://stored.example:3128")
        variable = self.cfg["network"]["proxy_ref"][4:]
        with patch.dict(os.environ, {variable: "http://environment.example:3128"}):
            self.assertEqual(resolve_proxy(self.cfg), "http://environment.example:3128")
            profile.configure_proxy(self.cfg, "http://new-store.example:3128")
            self.assertEqual(os.environ[variable], "http://environment.example:3128")
        self.assertEqual(resolve_proxy(self.cfg), "http://new-store.example:3128")

    def test_unowned_environment_reference_never_reads_private_store(self):
        from anti_trace.native_spec import resolve_proxy, NativeError
        from unittest.mock import patch
        import os
        profile.configure_proxy(self.cfg, "http://stored.example:3128")
        self.cfg["network"]["proxy_ref"] = "env:UNOWNED_PROXY"
        with patch.dict(os.environ, {}, clear=True):
            with self.assertRaises(NativeError):
                resolve_proxy(self.cfg)

    def test_insecure_secret_mode_is_rejected(self):
        profile.configure_proxy(self.cfg, "http://stored.example:3128")
        profile._secret_path(self.cfg).chmod(0o644)
        with self.assertRaises(profile.ProfileError) as caught:
            profile.read_proxy_secret(self.cfg)
        self.assertEqual(caught.exception.code, "unsafe_secret_store")

    def test_archive_credentials_are_explicit_and_scoped(self):
        import json
        import tarfile
        profile.configure_proxy(self.cfg, "http://user:private-password@proxy.example:3128")
        unrelated = dict(self.cfg, id="unrelated-environment", network={"proxy_ref": None})
        profile.configure_proxy(unrelated, "http://unrelated:other-password@other.example:3128")
        directory = profile.profile_dir(self.cfg["name"])
        directory.mkdir(parents=True)
        profile._write(directory / "config.json", self.cfg)
        for include in (False, True):
            archive = profile.BASE / f"archive-{include}.tar.gz"
            profile._archive(directory, self.cfg, archive, include_credentials=include)
            with tarfile.open(archive) as stream:
                names = stream.getnames()
                member = "original/.proxy-credentials.json"
                self.assertEqual(member in names, include)
                config = stream.extractfile("original/config.json").read()
                self.assertNotIn(b"private-password", config)
                if include:
                    credentials = json.load(stream.extractfile(member))
                    self.assertEqual(credentials["id"], self.cfg["id"])
                    self.assertNotIn("other-password", json.dumps(credentials))

    def test_archive_rejects_duplicate_and_link_entries(self):
        import io
        import tarfile
        from pathlib import Path
        for kind in ("duplicate", "symlink", "traversal"):
            archive = Path(self.temporary.name) / f"{kind}.tar.gz"
            with tarfile.open(archive, "w:gz") as stream:
                member = tarfile.TarInfo("root/file" if kind != "traversal" else "root/../outside")
                if kind == "symlink":
                    member.type, member.linkname = tarfile.SYMTYPE, "/etc/passwd"
                    stream.addfile(member)
                else:
                    member.size = 1
                    stream.addfile(member, io.BytesIO(b"x"))
                    if kind == "duplicate":
                        stream.addfile(member, io.BytesIO(b"x"))
            staging = Path(self.temporary.name) / f"extract-{kind}"
            staging.mkdir()
            with self.assertRaises(profile.ProfileError) as caught:
                profile._extract_archive(archive, staging)
            self.assertEqual(caught.exception.code, "unsafe_archive")

    def test_archive_detects_same_size_storage_tampering(self):
        import io
        import tarfile
        directory = profile.profile_dir("original")
        (directory / "data").mkdir(parents=True)
        profile._write(directory / "config.json", self.cfg)
        (directory / "data" / "storage").write_bytes(b"before")
        source, altered = profile.BASE / "source.tar.gz", profile.BASE / "altered.tar.gz"
        profile._archive(directory, self.cfg, source)
        with tarfile.open(source) as original, tarfile.open(altered, "w:gz") as output:
            for member in original.getmembers():
                if member.name == "original/data/storage":
                    output.addfile(member, io.BytesIO(b"after!"))
                else:
                    output.addfile(member, original.extractfile(member) if member.isfile() else None)
        staging = profile.BASE / "staging"
        staging.mkdir()
        with self.assertRaises(profile.ProfileError) as caught:
            profile._extract_archive(altered, staging)
        self.assertEqual(caught.exception.code, "archive_integrity")

    def test_cold_restore_rebinds_assets_through_symlinked_store(self):
        from pathlib import Path
        from anti_trace.native_spec import create_native_spec, validate_native_spec
        root = Path(self.temporary.name)
        real, alias = root / "real", root / "alias"
        real.mkdir(mode=0o700)
        alias.symlink_to(real,target_is_directory=True)
        profile.BASE = alias / "manager"
        binary, font = root / "runtime", root / "font.otf"
        binary.write_bytes(b"archive runtime fixture")
        binary.chmod(0o700)
        font.write_bytes(b"archive font fixture")
        cfg = create_native_spec("original",runtime="obscura",seed="ab"*32,
            storage_path=profile.profile_dir("original")/"data",binary=binary,
            asset_paths={"fonts":[str(font.resolve())]})
        profile.save_config("original",cfg)
        data = profile.profile_dir("original")/"data"
        data.mkdir()
        (data/"committed").write_bytes(b"durable bytes")
        archive = profile.export("original",root/"cold.tar.gz")
        profile.remove("original")
        self.assertEqual(profile.import_archive(archive,rename="restored"),"restored")
        restored = validate_native_spec(profile.require("restored"),name="restored")
        self.assertEqual(restored["id"],cfg["id"])
        self.assertEqual((profile.profile_dir("restored")/"data/committed").read_bytes(),b"durable bytes")
        self.assertEqual(Path(restored["asset_paths"]["fonts"][0]).read_bytes(),font.read_bytes())

    def test_private_snapshot_preserves_legacy_config_bytes_and_storage(self):
        import json
        import stat
        legacy = dict(self.cfg, schema=2, network={"proxy": "http://user:legacy-secret@proxy.example:3128"})
        directory = profile.profile_dir("original")
        (directory / "data").mkdir(parents=True)
        original_bytes = json.dumps(legacy, indent=4).encode()
        (directory / "config.json").write_bytes(original_bytes)
        (directory / "data" / "storage").write_bytes(b"persistent browser storage")
        snapshot = profile.BASE / "private-snapshots" / "revision-1.tar.gz"
        profile._archive(directory, legacy, snapshot, bundle_fonts=False, snapshot_identity=legacy["id"], include_credentials=True)
        staging = profile.BASE / "restore"
        staging.mkdir()
        extracted, restored, manifest = profile._extract_archive(snapshot, staging)
        self.assertEqual((extracted / "config.json").read_bytes(), original_bytes)
        self.assertEqual((extracted / "data" / "storage").read_bytes(), b"persistent browser storage")
        self.assertEqual(restored["network"], legacy["network"])
        self.assertEqual(manifest["snapshot_identity"], legacy["id"])
        self.assertEqual(stat.S_IMODE(snapshot.stat().st_mode), 0o600)
        self.assertEqual(stat.S_IMODE(snapshot.parent.stat().st_mode), 0o700)

    def test_migration_is_busy_under_engine_lease(self):
        profile.save_config("original", self.cfg)
        with profile.exclusive("original") as owned:
            self.assertTrue(owned)
            with self.assertRaises(profile.ProfileError) as caught:
                profile.migrate("original")
        self.assertEqual(caught.exception.code, "busy")

    def test_missing_process_start_never_proves_ownership(self):
        from unittest.mock import patch
        with patch.object(profile, "_alive", return_value=True):
            self.assertFalse(profile.owner_alive({"pid": 123}))

    def test_collision_uses_resolved_runtime_assets_not_seed(self):
        import copy
        from anti_trace.native_spec import check_identity_collision, NativeError
        base = {"schema": 3, "id": "one", "name": "one", "seed": "same",
                "storage": {"path": "/one"}, "runtime": {"id": "obscura", "version": "pinned", "artifact_sha256": "a"},
                "resolved": {"screen_width": 1280}, "assets": {"fonts_sha256": "fonts"}}
        candidate = copy.deepcopy(base)
        candidate.update(id="two", name="two", storage={"path": "/two"})
        with self.assertRaises(NativeError):
            check_identity_collision(candidate, [base])
        candidate["resolved"]["screen_width"] = 1440
        check_identity_collision(candidate, [base])
        candidate["resolved"] = copy.deepcopy(base["resolved"])
        candidate["assets"]["fonts_sha256"] = "different"
        check_identity_collision(candidate, [base])
        candidate["assets"] = copy.deepcopy(base["assets"])
        candidate["runtime"]["artifact_sha256"] = "b"
        check_identity_collision(candidate, [base])


if __name__ == "__main__":
    unittest.main()
