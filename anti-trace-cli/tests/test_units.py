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


class ScriptParsingTest(unittest.TestCase):
    def test_line_to_step(self):
        from anti_trace.cli import step_from_line

        self.assertEqual(step_from_line("goto https://a.test/x"),
                         {"action": "goto", "args": {"url": "https://a.test/x"}})
        self.assertEqual(step_from_line("type @2 hello world"),
                         {"action": "type", "args": {"target": "@2", "text": "hello world"}})
        self.assertEqual(step_from_line('click text="Log in"'),
                         {"action": "click", "args": {"target": "text=Log in"}})
        self.assertEqual(step_from_line("wait --ms 500"),
                         {"action": "wait", "args": {"ms": 500}})

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
