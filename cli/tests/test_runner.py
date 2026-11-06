"""Consumer contract checks using real imported subprocess scripts.

These verify runner supervision/protocol only, not browser/runtime acceptance.
The manager callback is deliberately small; real browser acceptance remains a
separate integration gate.
"""

from __future__ import annotations

import asyncio
import os
from pathlib import Path
import signal
import tempfile
import textwrap
import unittest

from anti_trace.runner import ScriptError, run_script


class ScriptRunnerTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="anti-trace-runner-")
        self.root = Path(self.temporary.name).resolve()

    async def asyncTearDown(self):
        self.temporary.cleanup()

    def script(self, source):
        path = self.root / "flow.py"
        path.write_text(textwrap.dedent(source).lstrip(), encoding="utf-8")
        return path

    async def describe(self, operation, args):
        self.assertEqual(operation, "session.describe")
        self.assertEqual(args, {})
        return {"page_id": "owned-page", "pages": [
            {"page_id": "owned-page", "url": "about:blank", "closed": False},
        ]}

    async def run_flow(self, source, execute, *, timeout=5, limit=65536, cancel=None, args=None):
        return await run_script(self.script(source), args or [], execute=execute,
                                timeout=timeout, max_output_bytes=limit, cancel=cancel)

    async def test_imports_async_main_arguments_loops_branches_and_serializes_gather(self):
        active = 0
        peak = 0
        calls = []

        async def execute(operation, args):
            nonlocal active, peak
            if operation == "session.describe":
                return await self.describe(operation, args)
            active += 1
            peak = max(peak, active)
            calls.append((operation, args))
            await asyncio.sleep(0.01)
            active -= 1
            return "actual callback result"

        report = await self.run_flow('''
            import asyncio
            async def main(page, context, tools):
                rows = []
                for item in tools.args:
                    if item:
                        rows.append(await page.title())
                rows.extend(await asyncio.gather(page.title(), page.title()))
                print("imported main")
                return {"rows": rows, "run_id": tools.run_id}
        ''', execute, args=[True, False, True])
        self.assertEqual(report["status"], "ok", report)
        self.assertEqual(report["result"]["rows"], ["actual callback result"] * 4)
        self.assertEqual(report["result"]["run_id"], report["run_id"])
        self.assertEqual(peak, 1)
        self.assertEqual(len(calls), 4)
        self.assertTrue(all(args["page_id"] == "owned-page" for _, args in calls))
        self.assertIn("imported main", report["stdout"])
        self.assertEqual([row["sequence"] for row in report["completed"]], [1, 2, 3, 4])
        self.assertTrue(all(row["source"]["path"] == str(self.root / "flow.py") for row in report["completed"]))

    async def test_typed_error_after_dispatch_is_uncertain_and_terminal_even_when_caught(self):
        calls = []

        async def execute(operation, args):
            if operation == "session.describe":
                return await self.describe(operation, args)
            calls.append(operation)
            if operation == "locator.click":
                raise ScriptError("capability_unavailable","activation unavailable after dispatch")
            return None

        report = await self.run_flow('''
            async def main(page, context, tools):
                await page.locator("#name").fill("private text")
                try:
                    await page.locator("#submit").click()
                except Exception:
                    pass
                await page.locator("#submit").click()
                return "must not complete"
        ''', execute)
        self.assertEqual(calls, ["locator.fill", "locator.click"])
        self.assertEqual(report["status"], "partial", report)
        self.assertEqual(report["error"]["code"],"capability_unavailable")
        self.assertEqual(report["failed_location"]["line"], 4)
        self.assertEqual(len(report["completed"]), 1)
        self.assertNotIn("private text", str(report["completed"]))
        self.assertEqual(report["side_effects"]["state"], "unknown")
        self.assertEqual(report["side_effects"]["completed_writes"], 1)

    async def test_human_boundary_wait_prevents_later_writes(self):
        entered = asyncio.Event()
        resume = asyncio.Event()
        calls = []

        async def execute(operation, args):
            if operation == "session.describe":
                return await self.describe(operation, args)
            calls.append(operation)
            if len(calls) == 1:
                entered.set()
                await resume.wait()
            return None

        task = asyncio.create_task(self.run_flow('''
            import asyncio
            async def main(page, context, tools):
                await asyncio.gather(page.locator("#a").fill("a"), page.locator("#b").fill("b"))
                return {"resumed": True}
        ''', execute))
        try:
            await asyncio.wait_for(entered.wait(), timeout=3)
            await asyncio.sleep(0.05)
            self.assertEqual(calls, ["locator.fill"])
        finally:
            resume.set()
        report = await task
        self.assertEqual(report["status"], "ok", report)
        self.assertEqual(calls, ["locator.fill", "locator.fill"])

    async def test_deadline_marks_inflight_side_effect_unknown_and_reaps_worker(self):
        entered = asyncio.Event()

        async def execute(operation, args):
            if operation == "session.describe":
                return await self.describe(operation, args)
            entered.set()
            await asyncio.Future()

        report = await self.run_flow('''
            async def main(page, context, tools):
                await page.evaluate("() => document.body.click()")
        ''', execute, timeout=0.5)
        self.assertTrue(entered.is_set())
        self.assertEqual(report["error"]["code"], "timeout", report)
        self.assertEqual(report["side_effects"]["state"], "unknown")
        self.assertIsNotNone(report["process"]["returncode"])
        with self.assertRaises(ProcessLookupError):
            os.kill(report["process"]["pid"], 0)

    async def test_event_cancellation_reaps_script_without_touching_external_process(self):
        import sys
        external = await asyncio.create_subprocess_exec(sys.executable, "-c", "import time; time.sleep(30)")
        cancel = asyncio.Event()
        entered = asyncio.Event()

        async def execute(operation, args):
            if operation == "session.describe":
                return await self.describe(operation, args)
            entered.set()
            await asyncio.Future()

        task = asyncio.create_task(self.run_flow('''
            async def main(page, context, tools):
                await page.title()
        ''', execute, cancel=cancel))
        try:
            await asyncio.wait_for(entered.wait(), timeout=3)
            cancel.set()
            report = await task
            self.assertEqual(report["status"], "cancelled", report)
            self.assertEqual(report["side_effects"]["state"], "none")
            self.assertIsNotNone(report["process"]["returncode"])
            os.kill(external.pid, 0)
        finally:
            external.send_signal(signal.SIGTERM)
            await external.wait()
            if not task.done():
                cancel.set()
                await task

    async def test_large_stdout_and_result_are_bounded_and_precise(self):
        report = await self.run_flow('''
            async def main(page, context, tools):
                print("x" * 1000000)
                return {"never": "accepted"}
        ''', self.describe, limit=4096)
        self.assertEqual(report["error"]["code"], "output_limit", report)
        self.assertLessEqual(len(report["stdout"].encode()) + len(report["stderr"].encode()), 4096)
        self.assertLessEqual(report["output_bytes"], 4096)
        report = await self.run_flow('''
            async def main(page, context, tools):
                return "x" * 1000000
        ''', self.describe, limit=4096)
        self.assertEqual(report["error"]["code"], "output_limit", report)
        self.assertIsNone(report["result"])

    async def test_json_observations_cannot_impersonate_binary_protocol_values(self):
        observation = {"__anti_trace_bytes__": "not base64", "nested": [{"value": 1}]}

        async def execute(operation, args):
            if operation == "session.describe":
                return await self.describe(operation, args)
            if operation == "page.screenshot":
                return b"binary protocol fixture"
            return observation

        report = await self.run_flow('''
            async def main(page, context, tools):
                value = await page.evaluate("() => ({value: 1})")
                image = await page.screenshot()
                return {"value": value, "image_bytes": len(image)}
        ''', execute)
        self.assertEqual(report["status"], "ok", report)
        self.assertEqual(report["result"]["value"], observation)
        self.assertEqual(report["result"]["image_bytes"], len(b"binary protocol fixture"))
        self.assertEqual(report["artifacts"][0]["bytes"], len(b"binary protocol fixture"))

    async def test_non_json_return_and_syntax_errors_keep_source_location(self):
        report = await self.run_flow('''
            async def main(page, context, tools):
                return {"not_json": object()}
        ''', self.describe)
        self.assertEqual(report["error"]["code"], "invalid_result", report)
        report = await self.run_flow('''
            async def main(page, context, tools):
                return (
        ''', self.describe)
        self.assertEqual(report["status"], "error", report)
        self.assertEqual(report["failed_location"]["path"], str(self.root / "flow.py"))
        self.assertEqual(report["failed_location"]["line"], 2)


if __name__ == "__main__":
    unittest.main()
