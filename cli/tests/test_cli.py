"""CLI/client contracts without launching runtimes or substituting browser evidence."""
from __future__ import annotations

import argparse
import contextlib
import hashlib
import io
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from anti_trace import cli, client, profile


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

if __name__ == "__main__":
    unittest.main()
