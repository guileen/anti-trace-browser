"""CLI/client contracts without launching runtimes or substituting browser evidence."""
from __future__ import annotations

import argparse
import contextlib
import hashlib
import io
import json
import os
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

from anti_trace import cli, client, engine
from mioa_core import native_spec, profile


class CLIContractsTest(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.base = patch.object(profile, "BASE", self.root)
        self.base.start()
        self.addCleanup(self.base.stop)
        self.script = self.root / "flow.py"
        self.script.write_text("async def main(page, context, tools):\n    return tools.args\n")
        profile.save_config("work", {"schema": 3, "mode": "managed", "name": "work"})

    def invoke(self, *argv):
        output, errors = io.StringIO(), io.StringIO()
        with contextlib.redirect_stdout(output), contextlib.redirect_stderr(errors):
            code = cli.main(list(argv))
        return code, json.loads(output.getvalue()), errors.getvalue()

    def test_inline_and_json_action_lists_never_dispatch(self):
        for source in ("goto https://example.com/", '[{"action":"axtree"}]', "-"):
            with self.subTest(source=source), patch.object(client, "call") as call:
                code, reply, _ = self.invoke("run", "work", source, "--json")
                self.assertEqual((code, reply["code"]), (1, "invalid_config"))
                call.assert_not_called()

    def test_info_binds_actual_files_and_redacts_network(self):
        binary = self.root / "browser"
        binary.write_bytes(b"actual executable bytes")
        cfg = {"schema": 3, "name": "work", "mode": "managed", "seed": "ab" * 32, "revision": 2,
               "runtime": {"id": "obscura", "version": "commit", "binary": str(binary), "artifact_sha256": "old"},
               "network": {"proxy": "http://user:secret@proxy.test:8080", "password": "secret",
                           "proxy_ref": "env:PRIVATE_PROXY"}, "resolved": {"locale": "en-US"}, "assets": {}}
        profile.save_config("work", cfg)
        with patch.object(client, "running", return_value=None):
            code, result, _ = self.invoke("info", "work", "--json")
        self.assertEqual(code, 0)
        self.assertEqual(result["configuration_sha256"], hashlib.sha256((profile.profile_dir("work") / "config.json").read_bytes()).hexdigest())
        self.assertEqual(result["runtime"]["artifact_sha256"], hashlib.sha256(binary.read_bytes()).hexdigest())
        self.assertEqual(result["runtime"]["executable"], str(binary))
        self.assertEqual(result["network"], {"proxy_ref": "env:PRIVATE_PROXY"})
        self.assertNotIn("secret", json.dumps(result))

    def test_engine_error_keeps_stable_code_without_credentials(self):
        with patch.object(client, "call", side_effect=client.EngineError("failed http://u:secret@proxy.test:80", code="paused")):
            code, reply, _ = self.invoke("control", "work", "resume", "--json")
        self.assertEqual((code, reply["code"]), (1, "paused"))
        self.assertNotIn("secret", reply["message"])

    def test_argument_errors_and_nonfinite_json_have_stable_codes(self):
        for argv in (("create", "new", "--runtime", "not-a-runtime", "--json"),
                     ("run", "work", str(self.script), "--args", '{"value":NaN}', "--json")):
            with self.subTest(argv=argv), patch.object(client, "call") as call:
                code, reply, _ = self.invoke(*argv)
                self.assertEqual((code, reply["status"], reply["code"]), (1, "error", "invalid_config"))
                call.assert_not_called()

    def test_strict_proxy_webrtc_blocks_udp_and_rejects_spoof(self):
        for proxy in ("http://proxy.test:8080", "env:PRIVATE_PROXY"):
            with self.subTest(proxy=proxy):
                self.assertEqual(cli._cfox_webrtc_policy(proxy, "strict", None), "block")
                self.assertEqual(cli._cfox_webrtc_policy(proxy, "strict", "block"), "block")
                self.assertEqual(cli._cfox_webrtc_policy(proxy, "observe", None), "spoof")
                self.assertEqual(cli._cfox_webrtc_policy(proxy, "observe", "spoof"), "spoof")
        self.assertEqual(cli._cfox_webrtc_policy("DIRECT", "strict", None), "spoof")
        self.assertEqual(cli._cfox_webrtc_policy(None, "strict", None), "spoof")
        code, result, _ = self.invoke("create", "new", "--proxy", "http://u:secret@127.0.0.1:9",
                                     "--egress-policy", "strict", "--webrtc", "spoof", "--json")
        self.assertEqual((code, result["code"]), (1, "capability_unavailable"))
        self.assertNotIn("secret", json.dumps(result))
        self.assertFalse(profile.exists("new"))

    def test_fresh_startup_error_keeps_typed_code_but_stale_error_does_not(self):
        previous = {"pid": 321, "process_start": 123.5, "status": "STARTING"}
        failed = {**previous, "status": "ERROR",
                  "error": {"code": "network_unavailable", "message": "failed http://u:secret@proxy.test:80"}}
        profile.save_state("work", failed)
        args = argparse.Namespace(json=True)
        output = io.StringIO()
        with contextlib.redirect_stdout(output):
            code = cli._startup_failure(args, "work", previous)
        result = json.loads(output.getvalue())
        self.assertEqual((code, result["code"]), (1, "network_unavailable"))
        self.assertNotIn("secret", result["message"])
        output = io.StringIO()
        with contextlib.redirect_stdout(output):
            code = cli._startup_failure(args, "work", failed)
        self.assertEqual((code, json.loads(output.getvalue())["code"]), (1, "startup_failed"))

class NativeBinaryResolutionTest(unittest.TestCase):
    ENV = "ANTI_TRACE_OBSCURA_BINARY"

    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name).resolve()
        self.saved = {key: value for key, value in os.environ.items()
                      if key.startswith("ANTI_TRACE_") and key.endswith("_BINARY")}
        self.addCleanup(self._restore_environment)
        for key in self.saved:
            os.environ.pop(key, None)
        previous = os.getcwd()
        self.addCleanup(os.chdir, previous)

    def _restore_environment(self):
        for key in [key for key in os.environ
                    if key.startswith("ANTI_TRACE_") and key.endswith("_BINARY") and key not in self.saved]:
            os.environ.pop(key, None)
        os.environ.update(self.saved)

    def checkout(self, name="checkout", product='name = "anti-trace"'):
        root = self.root / name
        (root / "cli").mkdir(parents=True)
        (root / "cli" / "pyproject.toml").write_text(f'[project]\n{product}\n', encoding="utf-8")
        return root

    @contextlib.contextmanager
    def installed(self, cwd, *, argv=("/usr/local/bin/anti-trace",), executable="/usr/local/bin/python3"):
        store = self.root / "venv" / "lib" / "python3.12" / "site-packages"
        module = store / "anti_trace" / "engine.py"
        module.parent.mkdir(parents=True, exist_ok=True)
        module.write_text("", encoding="utf-8")
        previous = os.getcwd()
        os.chdir(cwd)
        try:
            with patch.object(engine, "__file__", str(module)), \
                 patch.object(sys, "argv", list(argv)), \
                 patch.object(sys, "executable", executable):
                yield store
        finally:
            os.chdir(previous)

    def test_editable_install_uses_its_own_checkout(self):
        checkout = self.checkout()
        module = checkout / "cli" / "anti_trace" / "engine.py"
        module.parent.mkdir(parents=True)
        module.write_text("", encoding="utf-8")
        with patch.object(engine, "__file__", str(module)), \
             patch.object(sys, "argv", ["anti-trace"]), \
             patch.object(sys, "executable", "/usr/local/bin/python3"):
            self.assertEqual(engine.checkout_root(), checkout)
            self.assertEqual(Path(engine.native_binary("obscura")), checkout / native_spec.PINS["obscura"][1])
            self.assertEqual(Path(engine.native_binary("mioa")), checkout / native_spec.PINS["mioa"][1])

    def test_installed_cli_resolves_checkout_from_working_directory(self):
        checkout = self.checkout()
        work = checkout / "openspec" / "changes" / "evaluate-lightweight-runtime"
        work.mkdir(parents=True)
        with self.installed(work):
            self.assertEqual(engine.checkout_root(), checkout)
            self.assertEqual(Path(engine.native_binary("obscura")), checkout / native_spec.PINS["obscura"][1])

    def test_installed_cli_without_checkout_requests_explicit_binary(self):
        elsewhere = self.root / "elsewhere"
        elsewhere.mkdir()
        with self.installed(elsewhere) as store:
            self.assertIsNone(engine.checkout_root())
            with self.assertRaises(native_spec.NativeError) as caught:
                engine.native_binary("obscura")
        self.assertEqual(caught.exception.code, "capability_unavailable")
        self.assertIn("--native-binary", caught.exception.message)
        self.assertIn(self.ENV, caught.exception.message)
        self.assertNotIn(str(store), caught.exception.message)

    def test_installed_cli_rejects_unrelated_project_sentinel(self):
        impostor = self.root / "other-project"
        (impostor / "cli").mkdir(parents=True)
        (impostor / "cli" / "pyproject.toml").write_text('[project]\nname = "unrelated"\n', encoding="utf-8")
        work = impostor / "src"
        work.mkdir()
        with self.installed(work):
            self.assertIsNone(engine.checkout_root())
            with self.assertRaises(native_spec.NativeError) as caught:
                engine.native_binary("obscura")
        self.assertEqual(caught.exception.code, "capability_unavailable")

    def test_installed_cli_prefers_install_checkout_over_working_directory(self):
        install = self.checkout("install-checkout")
        working = self.checkout("cwd-checkout")
        python = install / "cli" / ".venv" / "bin" / "python3"
        python.parent.mkdir(parents=True)
        python.write_text("", encoding="utf-8")
        work = working / "work"
        work.mkdir()
        with self.installed(work, executable=str(python)):
            self.assertEqual(engine.checkout_root(), install)
            self.assertEqual(Path(engine.native_binary("obscura")), install / native_spec.PINS["obscura"][1])

    def test_explicit_then_environment_win_without_a_checkout(self):
        elsewhere = self.root / "elsewhere"
        elsewhere.mkdir()
        explicit = str(self.root / "explicit-binary")
        environment = str(self.root / "environment-binary")
        with self.installed(elsewhere):
            os.environ[self.ENV] = environment
            try:
                self.assertEqual(engine.native_binary("obscura"), environment)
                self.assertEqual(engine.native_binary("obscura", explicit), explicit)
            finally:
                os.environ.pop(self.ENV, None)

    def test_checkout_without_pinned_build_reports_capability_unavailable(self):
        checkout = self.checkout()
        module = checkout / "cli" / "anti_trace" / "engine.py"
        module.parent.mkdir(parents=True)
        module.write_text("", encoding="utf-8")
        with patch.object(engine, "__file__", str(module)), \
             patch.object(sys, "argv", ["anti-trace"]), \
             patch.object(sys, "executable", "/usr/local/bin/python3"):
            selected = engine.native_binary("obscura")
            with self.assertRaises(native_spec.NativeError) as caught:
                native_spec.resolve_binary("obscura", selected)
        self.assertEqual(caught.exception.code, "capability_unavailable")
        self.assertIn(str(selected), caught.exception.message)


if __name__ == "__main__":
    unittest.main()
