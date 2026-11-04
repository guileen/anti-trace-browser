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

    def _results(self, **overrides):
        from anti_trace.audit import evaluate_headers

        headers = dict(self.GOOD)
        for key, value in overrides.items():
            if value is None:
                headers.pop(key, None)
            else:
                headers[key] = value
        return {row["header"]: row for row in evaluate_headers(headers, self.IDENT)}

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
        from anti_trace.audit import evaluate_headers

        rows = {row["header"]: row for row in evaluate_headers(dict(self.CHROME), self.IDENT)}
        self.assertEqual(rows["client-hints"]["result"], "pass")
        self.assertEqual(rows["sec-ch-ua-platform"]["result"], "pass")
        self.assertTrue(all(row["result"] == "pass" for row in rows.values()), rows)

    def test_chromium_platform_mismatch_is_caught(self):
        from anti_trace.audit import evaluate_headers

        headers = dict(self.CHROME, **{"sec-ch-ua-platform": '"Windows"'})
        rows = {row["header"]: row for row in evaluate_headers(headers, self.IDENT)}
        self.assertEqual(rows["sec-ch-ua-platform"]["result"], "fail")

    def test_firefox_identity_with_chromium_hints_fails(self):
        from anti_trace.audit import evaluate_headers

        headers = dict(self.GOOD, **{"sec-ch-ua": '"Chromium";v="156"'})
        rows = {row["header"]: row for row in evaluate_headers(headers, self.IDENT)}
        self.assertEqual(rows["client-hints"]["result"], "fail")

    def test_unclassified_header_is_reported(self):
        rows = self._results(**{"x-new-fingerprint": "1"})
        self.assertEqual(rows["x-new-fingerprint"]["class"], "unknown")


class ScriptParsingTest(unittest.TestCase):
    def test_line_to_step(self):
        from anti_trace.cli import step_from_line

        self.assertEqual(step_from_line("goto https://a.test/x"),
                         {"action": "goto", "args": {"url": "https://a.test/x"}})
        self.assertEqual(step_from_line("type @2 hello world"),
                         {"action": "type", "args": {"target": "@2", "text": "hello world"}})
        # Playwright selector quoting survives verbatim; only a fully quoted
        # argument is unquoted.
        self.assertEqual(step_from_line('click text="Log in"'),
                         {"action": "click", "args": {"target": 'text="Log in"'}})
        self.assertEqual(step_from_line("click 'Log in'"),
                         {"action": "click", "args": {"target": "Log in"}})
        self.assertEqual(step_from_line("wait --ms 500"),
                         {"action": "wait", "args": {"ms": 500}})

    def test_javascript_keeps_its_own_quotes(self):
        from anti_trace.cli import step_from_line

        line = "eval JSON.stringify({a:document.title.includes('x')})"
        self.assertEqual(step_from_line(line)["args"]["js"],
                         "JSON.stringify({a:document.title.includes('x')})")

    def test_script_skips_comments_and_detects_json(self):
        from anti_trace.cli import parse_script

        steps = parse_script("# note\ngoto https://a.test/\n\naxtree\n")
        self.assertEqual([step["action"] for step in steps], ["goto", "axtree"])
        self.assertEqual(parse_script('[{"action": "axtree", "args": {}}]')[0]["action"], "axtree")

    def test_script_reports_line_numbers(self):
        from anti_trace.cli import parse_script

        with self.assertRaisesRegex(ValueError, "line 2"):
            parse_script("goto https://a.test/\nfrobnicate x\n")
        with self.assertRaisesRegex(ValueError, "no steps"):
            parse_script("# only a comment\n")


class FieldVerdictTest(unittest.TestCase):
    def test_blocked_status_wins(self):
        from anti_trace.field import _verdict

        self.assertEqual(_verdict(403, ["px-captcha"]), "blocked")
        self.assertEqual(_verdict(500, []), "blocked")

    def test_solved_gate_is_cleared_not_blocked(self):
        from anti_trace.field import _verdict

        self.assertEqual(_verdict(403, [], moved=True), "cleared")
        self.assertEqual(_verdict(403, [], moved=False), "blocked")

    def test_challenge_markers(self):
        from anti_trace.field import _verdict

        self.assertEqual(_verdict(200, ["turnstile"]), "challenge")
        self.assertEqual(_verdict(200, ["captcha-text"]), "challenge")

    def test_reached_ignores_passive_vendor_markers(self):
        from anti_trace.field import _verdict

        self.assertEqual(_verdict(200, ["kasada", "datadome"]), "reached")
        self.assertEqual(_verdict(None, []), "reached")


if __name__ == "__main__":
    unittest.main()
