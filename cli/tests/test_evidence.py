"""Evidence contracts: failures, authoritative receipts and request context."""
from __future__ import annotations

import asyncio
import json
import tempfile
import time
import unittest
from pathlib import Path
from unittest.mock import patch

from anti_trace import audit, field


class VisitEvidenceTests(unittest.IsolatedAsyncioTestCase):
    async def visit(self, *, response=None, failure=None):
        async def call(action, args):
            if action == failure:
                return {"status": "error", "message": "collector failed"}
            return {
                "goto": {"status": "ok", "http_status": 200, "url": "http://fixture.test/final"},
                "eval": {"status": "ok", "result": response},
                "screenshot": {"status": "ok"},
                "axtree": {"status": "ok", "elements": []},
            }[action]
        with tempfile.TemporaryDirectory() as directory:
            return await field._visit(call, {"host": "fixture.test", "url": "http://fixture.test/start", "vendor": "local"},
                                      Path(directory), 0, 1)

    async def test_navigation_success_alone_is_not_content_evidence(self):
        row = await self.visit()
        self.assertEqual(row["verdict"], "not_tested")
        self.assertEqual(row["http_status"], 200)

    async def test_completed_redirect_has_observation_not_clearance(self):
        row = await self.visit(response={"href": "http://fixture.test/final", "markers": [], "passive_markers": ["kasada"]})
        self.assertEqual(row["verdict"], "reached")
        self.assertEqual(row["passive_markers"], ["kasada"])
        self.assertNotEqual(row["settled_url"], row["url"])
        self.assertEqual(len(row["evidence_ids"]), 2)

    async def test_capture_error_is_not_reached_even_after_content(self):
        for stage in ("goto", "eval", "screenshot", "axtree"):
            row = await self.visit(response={"href": "http://fixture.test/final", "markers": []}, failure=stage)
            self.assertEqual(row["verdict"], "error", stage)
            self.assertIn("collector failed", row["error"])

    async def test_deadline_is_a_capture_error(self):
        async def call(action, args):
            await asyncio.sleep(1)
        with tempfile.TemporaryDirectory() as directory:
            row = await field._visit(call, {"host": "fixture.test", "url": "http://fixture.test/", "vendor": "local"},
                                     Path(directory), 0, .001)
        self.assertEqual(row["verdict"], "error")
        self.assertEqual(row["error"], "TimeoutError")

    def test_summary_keeps_every_status(self):
        with tempfile.TemporaryDirectory() as directory:
            rows = [{"verdict": status} for status in field.VERDICTS]
            report = field._report("fixture", rows, Path(directory), {})
            self.assertEqual(report["summary"], dict.fromkeys(field.VERDICTS, 1))


class ReceiptTests(unittest.TestCase):
    def receipt(self, **overrides):
        receipt = {"run_id": "run-one", "verified_at": time.time() - 1, "expires_at": time.time() + 120,
                   "hostname": "fixture.test", "action": "browser_check", "result": "passed",
                   "receipt_id": "receipt-one", "kind": "synthetic-pow"}
        receipt.update(overrides)
        return {"source": "server", "authority": "https://fixture.test", "receipt": receipt}

    def verdict(self, receipt):
        return field._verdict(403, [], observed=True, verification=receipt,
                              run_id="run-one", challenge_kind="synthetic-pow")

    def test_only_current_run_and_configured_kind_clear(self):
        self.assertEqual(self.verdict(self.receipt()), "cleared")
        for overrides in ({"run_id": "other-run"}, {"expires_at": time.time() - 1},
                          {"verified_at": time.time() + 10}, {"result": "rejected"},
                          {"kind": "turnstile-siteverify"}, {"action": "other"}, {"receipt_id": None}):
            self.assertEqual(self.verdict(self.receipt(**overrides)), "blocked", overrides)
        self.assertEqual(field._verdict(200, [], verification=self.receipt(), run_id="run-one"), "reached")

    def test_receipt_from_an_earlier_visit_cannot_be_reused(self):
        receipt = self.receipt()
        verdict = field._verdict(200, [], observed=True, verification=receipt, run_id="run-one",
                                 challenge_kind="synthetic-pow", visit_started_at=time.time())
        self.assertNotEqual(verdict, "cleared")

    def test_authoritative_verification_errors_are_not_content_success(self):
        self.assertEqual(self.verdict(self.receipt(result="error")), "error")
        verdict = field._verdict(200, [], verification=self.receipt(result="rejected"),
                                 run_id="run-one", challenge_kind="synthetic-pow")
        self.assertEqual(verdict, "blocked")

    def test_pending_or_expired_authority_is_not_content_success(self):
        for state in ("issued", "verifying"):
            self.assertEqual(self.verdict(self.receipt(result=state)), "challenge")
        self.assertEqual(self.verdict(self.receipt(result="expired")), "error")

    def test_page_json_is_not_an_authoritative_receipt(self):
        receipt = self.receipt()
        receipt["source"] = "browser"
        self.assertEqual(self.verdict(receipt), "blocked")
        self.assertEqual(self.verdict({"result": "passed", "run_id": "run-one"}), "blocked")

    def test_authority_and_exact_run_endpoint_checked_before_network(self):
        site = {"url": "https://fixture.test/check", "run_id": "run-one", "receipt_token": "local-test-token",
                "receipt_url": "https://fixture.test/attempts/run-one", "trusted_receipt_origin": "https://fixture.test"}
        for overrides in ({"trusted_receipt_origin": "https://other.test"},
                          {"receipt_url": "http://fixture.test/attempts/run-one", "trusted_receipt_origin": "http://fixture.test"},
                          {"receipt_url": "https://fixture.test/attempts/other-run"},
                          {"receipt_url": "https://fixture.test/attempts/run-one?token=secret"}, {"receipt_token": ""}):
            with self.assertRaises(ValueError):
                field._read_receipt(dict(site, **overrides), .1)


class HeaderContextTests(unittest.TestCase):
    IDENT = {"os": "linux", "locale": "en-US"}
    UA = "Mozilla/5.0 (X11; Linux x86_64; rv:158.0) Gecko/20100101 Firefox/158.0"

    def rows(self, wire=None, **context):
        headers = {"user-agent": self.UA, "accept-language": "en-US", **(wire or {})}
        return {row["header"]: row for row in audit.evaluate_headers(headers, self.IDENT, context=context)}

    def test_insecure_http_does_not_require_secure_metadata_or_brotli(self):
        rows = self.rows({"accept-encoding": "gzip, deflate"}, url="http://fixture.test/", resource_type="document", protocol="HTTP/1.1")
        for name in ("sec-fetch-mode", "sec-fetch-dest", "sec-fetch-site", "sec-fetch-user", "client-hints"):
            self.assertEqual(rows[name]["result"], "pass", rows[name])
        self.assertNotEqual(rows["accept-encoding"]["result"], "fail")

    def test_secure_fetch_worker_subresources_are_not_navigation(self):
        for resource, dest, mode in (("fetch", "empty", "cors"), ("worker", "empty", "cors"),
                                     ("subresource", "image", "no-cors")):
            rows = self.rows({"sec-fetch-mode": mode, "sec-fetch-dest": dest, "sec-fetch-site": "same-origin"},
                             url="https://fixture.test/", resource_type=resource, destination=dest, mode=mode,
                             protocol="h2", fetch_site="same-origin")
            for name in ("sec-fetch-mode", "sec-fetch-dest", "sec-fetch-user", "upgrade-insecure-requests"):
                self.assertEqual(rows[name]["result"], "pass", (resource, rows[name]))

    def test_fetch_wire_empty_is_not_the_dom_empty_string(self):
        wire = {"sec-fetch-mode": "cors", "sec-fetch-dest": "empty", "sec-fetch-site": "same-origin"}
        for context in ({"scheme": "https", "request_type": "fetch"},
                        {"url": "https://fixture.test/", "resource_type": "fetch", "destination": ""}):
            rows = self.rows(wire, **context)
            self.assertEqual(rows["sec-fetch-dest"]["result"], "pass")
        self.assertEqual(self.rows({"sec-fetch-dest": ""}, scheme="https", resource_type="fetch")["sec-fetch-dest"]["result"], "fail")

    def test_redirect_without_activation_does_not_require_fetch_user(self):
        rows = self.rows({"sec-fetch-mode": "navigate", "sec-fetch-dest": "document", "sec-fetch-site": "same-site"},
                         url="https://fixture.test/final", resource_type="redirect", user_activation=False)
        self.assertEqual(rows["sec-fetch-user"]["result"], "pass")

    def test_http2_forbids_connection_and_non_trailers_te(self):
        for protocol in ("h2", "HTTP/2"):
            rows = self.rows({"connection": "keep-alive", "te": "gzip"}, protocol=protocol)
            self.assertEqual(rows["connection"]["result"], "fail")
            self.assertEqual(rows["te"]["result"], "fail")
        self.assertEqual(self.rows({"connection": "keep-alive"}, protocol="HTTP/1.1")["connection"]["result"], "pass")
        self.assertEqual(self.rows({"te": "trailers"}, protocol="h2")["te"]["result"], "pass")

    def test_missing_context_and_policy_are_pending(self):
        rows = self.rows()
        for name in ("connection", "dnt", "sec-gpc", "sec-fetch-dest", "priority"):
            self.assertEqual(rows[name]["result"], "review_required")
        self.assertEqual(audit._header_verdict(list(rows.values())), "review_required")

    def test_privacy_signals_follow_explicit_policy(self):
        for dnt, gpc in ((False, False), (True, True), ("0", "1")):
            wire = {"dnt": "1" if dnt is True else dnt, "sec-gpc": "1" if gpc is True else gpc}
            wire = {k: v for k, v in wire.items() if v is not False}
            rows = {row["header"]: row for row in audit.evaluate_headers(wire, {}, privacy_policy={"dnt": dnt, "gpc": gpc})}
            self.assertEqual(rows["dnt"]["result"], "pass")
            self.assertEqual(rows["sec-gpc"]["result"], "pass")
        rows = {row["header"]: row for row in audit.evaluate_headers({"sec-gpc": "1"}, {}, privacy_policy={"gpc": False})}
        self.assertEqual(rows["sec-gpc"]["result"], "fail")

    def test_unknown_is_pending_even_when_all_other_rows_pass(self):
        checks = [{"header": "known", "result": "pass"},
                  next(row for row in audit.evaluate_headers({"X-Unreviewed": "value"}, {}) if row["header"] == "x-unreviewed")]
        self.assertEqual(audit._header_verdict(checks), "review_required")
        self.assertEqual(audit._header_summary(checks)["review_required"], 1)

    def test_echo_survives_missing_cdp_and_compares_js_independently(self):
        wire = {"user-agent": self.UA, "accept-language": "en-US", "x-new": "1"}
        def call(name, action, args=None, **kwargs):
            if action == "headers":
                return {"status": "unsupported", "reason": "no CDP headers"}
            return {"result": {"echo": {"headers": wire, "url": "http://fixture.test/echo", "method": "GET", "protocol": "HTTP/1.1"},
                               "js": {"ua": self.UA, "language": "en-US"}}}
        with patch.object(audit.profile, "require", return_value={"identity": self.IDENT}), patch.object(audit.client, "call", side_effect=call):
            report = audit.headers("local", echo_url="http://fixture.test/echo")
        self.assertEqual(report["source"], "server")
        self.assertEqual(report["verdict"], "review_required")
        self.assertIn("x-new", report["pending"])
        self.assertEqual(report["observations"][0]["context"]["resource_type"], "fetch")
        self.assertEqual(report["capture_error"], "no CDP headers")

    def test_failed_echo_does_not_silently_fall_back_to_cdp(self):
        def call(name, action, args=None, **kwargs):
            if action == "headers":
                return {"requests": [{"url": "https://fixture.test", "headers": {"user-agent": self.UA}}]}
            raise TimeoutError("echo timeout")
        with patch.object(audit.profile, "require", return_value={"identity": self.IDENT}), patch.object(audit.client, "call", side_effect=call):
            report = audit.headers("local", echo_url="http://fixture.test/echo")
        self.assertEqual(report["verdict"], "error")
        self.assertIsNone(report["source"])
        self.assertEqual(len(report["observations"]), 1)


if __name__ == "__main__":
    unittest.main()
