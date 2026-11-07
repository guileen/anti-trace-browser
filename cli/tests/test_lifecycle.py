"""Closing IPC does not release profile/process ownership."""
from __future__ import annotations

import argparse
import contextlib
import io
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

from anti_trace import cli, client
from mioa_core import profile


class LifecycleTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.previous_base = profile.BASE
        profile.BASE = Path(self.directory.name)
        profile.save_config("closing", {"name": "closing", "mode": "managed"})
        self.state = {"pid": os.getpid(), "status": "READY", "socket": str(profile.socket_path("closing"))}

    def tearDown(self):
        profile.BASE = self.previous_base
        self.directory.cleanup()

    def test_missing_socket_preserves_live_owner(self):
        profile.save_state("closing", self.state)
        self.assertIsNone(client.running("closing"))
        self.assertEqual(profile.load_state("closing"), self.state)

    def test_stopping_owner_is_not_reusable_ready_environment(self):
        profile.socket_path("closing").touch()
        self.state["status"] = "STOPPING"
        profile.save_state("closing", self.state)
        self.assertIsNone(client.running("closing"))
        self.assertEqual(profile.load_state("closing"), self.state)

    def test_stop_timeout_retains_live_process_state_and_lease(self):
        data = profile.profile_dir("closing") / "data"
        data.mkdir()
        marker = data / "durable"
        marker.write_text("kept")
        owner = """
import fcntl, json, os, pathlib, sys
root = pathlib.Path(sys.argv[1])
with (root / '.lock').open('a+') as lease:
    fcntl.flock(lease, fcntl.LOCK_EX)
    (root / 'state.json').write_text(json.dumps({'pid': os.getpid(), 'status': 'STOPPING'}))
    print('owned', flush=True)
    sys.stdin.readline()
"""
        proc = subprocess.Popen([sys.executable, "-c", owner, str(profile.profile_dir("closing"))],
                                stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        try:
            self.assertEqual(proc.stdout.readline().strip(), "owned")
            with contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
                result = cli.cmd_stop(argparse.Namespace(name="closing", timeout=.01, json=True))
                reset = cli.cmd_reset(argparse.Namespace(name="closing", json=True))
                remove = cli.cmd_rm(argparse.Namespace(name="closing", json=True, force=False))
            self.assertEqual(result, 1)
            self.assertEqual((reset, remove), (1, 1))
            self.assertEqual(marker.read_text(), "kept")
            self.assertIsNone(proc.poll())
            self.assertEqual(profile.load_state("closing")["pid"], proc.pid)
            with profile.exclusive("closing", timeout=0) as available:
                self.assertFalse(available)
        finally:
            proc.communicate(input="release\n", timeout=5)
        self.assertIsNone(client.running("closing"))
        self.assertEqual(profile.load_state("closing")["pid"], proc.pid)

    def test_reset_keeps_identity_and_lock_inodes(self):
        data = profile.profile_dir("closing") / "data"
        data.mkdir()
        marker = data / "old"
        marker.write_text("discarded")
        paths = [profile.profile_dir("closing") / name for name in (".lock", ".spawn")]
        for path in paths:
            path.touch()
        inodes = [path.stat().st_ino for path in paths]
        config = profile.load_config("closing")
        with contextlib.redirect_stdout(io.StringIO()):
            result = cli.cmd_reset(argparse.Namespace(name="closing", json=True))
        self.assertEqual(result, 0)
        self.assertFalse(marker.exists())
        self.assertEqual(profile.load_config("closing"), config)
        self.assertEqual([path.stat().st_ino for path in paths], inodes)


if __name__ == "__main__":
    unittest.main()
