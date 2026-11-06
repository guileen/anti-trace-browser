#!/usr/bin/env python3
"""Real loopback HTTP + installed Chromium + CLI evidence, without vendor traffic.

Run with the project interpreter: python tests/field_http_smoke.py --out .local/evidence-smoke
The synthetic server gate validates a one-use nonce; it is not Turnstile or WAF clearance.
"""
from __future__ import annotations

import argparse
import json
import os
import secrets
import socket
import subprocess
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.error import URLError
from urllib.parse import parse_qs, urlsplit
from urllib.request import Request, urlopen

from anti_trace.audit import evaluate_headers
from anti_trace.measure import chromium_executable


class Fixture(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    records: list[dict] = []
    attempts: dict[str, dict] = {}

    def log_message(self, *args):
        pass

    def send(self, status, body, *, content_type="text/html", extra=None):
        data = body.encode() if isinstance(body, str) else json.dumps(body).encode()
        self.records.append({"method": self.command, "url": "http://" + self.headers["Host"] + self.path,
                             "protocol": self.request_version, "status": status,
                             "headers": {key: value for key, value in self.headers.items() if key.lower() not in {"authorization", "cookie"}}})
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(data)))
        for key, value in (extra or {}).items():
            self.send_header(key, value)
        self.end_headers()
        try:
            self.wfile.write(data)
        except (BrokenPipeError, ConnectionResetError):
            pass

    def do_POST(self):
        run_id, nonce, access = secrets.token_hex(12), secrets.token_hex(16), secrets.token_hex(24)
        self.attempts[run_id] = {"nonce": nonce, "access": access, "passed": False}
        self.send(201, {"run_id": run_id, "nonce": nonce, "access_token": access}, content_type="application/json")

    def do_GET(self):
        parsed = urlsplit(self.path)
        if parsed.path == "/redirect":
            return self.send(302, "ordinary redirect", extra={"Location": "/content"})
        if parsed.path == "/challenge":
            return self.send(403, '<title>Local challenge</title><div id="challenge-stage"><button>Verify you are human</button></div>')
        if parsed.path == "/slow":
            time.sleep(2)
            return self.send(200, "slow completed")
        if parsed.path == "/gate":
            query = parse_qs(parsed.query)
            attempt = self.attempts.get(query.get("run_id", [""])[0])
            if not attempt or attempt["passed"] or query.get("nonce", [""])[0] != attempt["nonce"]:
                return self.send(403, "gate denied")
            attempt["passed"] = True
            attempt["verified_at"] = time.time()
            return self.send(200, "<title>Verified synthetic gate</title><p>One-use nonce accepted.</p>")
        if parsed.path.startswith("/attempts/"):
            run_id = parsed.path.split("/")[-1]
            attempt = self.attempts.get(run_id)
            if not attempt or self.headers.get("Authorization") != "Bearer " + attempt["access"]:
                return self.send(403, {"error": "unauthorized"}, content_type="application/json")
            if not attempt["passed"]:
                return self.send(200, {"run_id": run_id, "result": "issued"}, content_type="application/json")
            verified_at = attempt["verified_at"]
            return self.send(200, {"run_id": run_id, "verified_at": verified_at, "expires_at": verified_at + 300,
                                   "hostname": "127.0.0.1", "action": "browser_check", "result": "passed",
                                   "receipt_id": "local-" + run_id, "kind": "synthetic-fixture-gate"}, content_type="application/json")
        if parsed.path == "/echo":
            return self.send(200, {"headers": dict(self.headers), "method": self.command,
                                   "url": "http://" + self.headers["Host"] + self.path,
                                   "protocol": self.request_version}, content_type="application/json")
        if parsed.path == "/matrix-redirect":
            return self.send(302, "", extra={"Location": "/matrix"})
        if parsed.path == "/worker.js":
            return self.send(200, "fetch('/echo?via=worker').then(r=>r.json()).then(v=>postMessage(v.protocol));", content_type="text/javascript")
        if parsed.path == "/pixel.svg":
            return self.send(200, '<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"/>', content_type="image/svg+xml")
        if parsed.path == "/matrix":
            return self.send(200, """<title>Local HTTP matrix</title><img src="/pixel.svg"><script>
              Promise.all([fetch('/echo?via=fetch').then(r=>r.json()), new Promise(resolve=>{
                const w=new Worker('/worker.js'); w.onmessage=resolve;
              })]).then(()=>document.body.dataset.complete='yes');
            </script>""")
        return self.send(200, "<title>Local ordinary content</title><p>Passive vendor prose: Kasada DataDome hcaptcha recaptcha.</p>")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--out", type=Path, required=True)
    args = parser.parse_args()
    out = args.out.resolve()
    out.mkdir(parents=True, exist_ok=True)
    project = Path(__file__).resolve().parents[1]
    env = dict(os.environ, ANTI_TRACE_HOME=str(out / "store"))
    results = []

    def cli(label, arguments):
        command = [sys.executable, "-m", "anti_trace.cli", *arguments, "--json"]
        process = subprocess.run(command, cwd=project, env=env, capture_output=True, text=True, timeout=90)
        (out / (label + ".stdout.json")).write_text(process.stdout)
        (out / (label + ".stderr.txt")).write_text(process.stderr)
        result = json.loads(process.stdout)
        results.append({"case": label, "command": arguments, "exit_code": process.returncode,
                        "summary": result.get("summary"), "verdict": result.get("verdict")})
        return result, process.returncode

    server = ThreadingHTTPServer(("127.0.0.1", 0), Fixture)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    base = f"http://127.0.0.1:{server.server_port}"
    chrome = None
    tls_processes = []
    try:
        for case, route, expected, timeout in (("ordinary_redirect", "/redirect", "reached", "10"),
                                                ("active_403", "/challenge", "challenge", "10"),
                                                ("capture_timeout", "/slow", "error", "0.1")):
            report, code = cli(case, ["field", "--browser", "chromium", "--sites", base + route,
                                      "--settle", "0", "--timeout", timeout, "--out", str(out / case)])
            row = report["sites"][0]
            assert row["verdict"] == expected, row
            assert code == (0 if expected == "reached" else 1), (case, code)
            if case == "active_403":
                assert row["http_status"] == 403, row
            if case == "ordinary_redirect":
                assert row["passive_markers"] and not row["markers"], row
        with urlopen(Request(base + "/attempts", data=b"{}", method="POST")) as response:
            attempt = json.load(response)
        run_id = attempt["run_id"]
        site = {"host": "127.0.0.1", "vendor": "local synthetic gate", "url": base + "/gate?run_id=" + run_id + "&nonce=" + attempt["nonce"],
                "run_id": run_id, "challenge_kind": "synthetic-fixture-gate", "receipt_url": base + "/attempts/" + run_id,
                "trusted_receipt_origin": base, "receipt_token": attempt["access_token"]}
        private_config = out / "private-site-config.json"
        private_config.write_text(json.dumps([site]))
        private_config.chmod(0o600)
        report, code = cli("verified_gate", ["field", "--browser", "chromium", "--site-config", str(private_config),
                                            "--settle", "0", "--timeout", "10", "--out", str(out / "verified_gate")])
        assert report["sites"][0]["verdict"] == "cleared" and code == 0, report
        private_config.unlink()

        # Real attached CLI audit: browser transport and server echo remain independent.
        executable = chromium_executable()
        assert executable, "installed Chromium is required"
        with socket.socket() as sock:
            sock.bind(("127.0.0.1", 0))
            port = sock.getsockname()[1]
        with (out / "chromium.log").open("w") as log:
            chrome = subprocess.Popen([executable, "--headless=new", "--disable-background-networking", "--no-first-run",
                                       "--no-default-browser-check", "--ignore-certificate-errors", f"--remote-debugging-port={port}",
                                       "--user-data-dir=" + str(out / "chromium-profile"), base + "/content"], stdout=log, stderr=log)
            endpoint = f"http://127.0.0.1:{port}"
            deadline = time.monotonic() + 15
            while True:
                try:
                    with urlopen(endpoint + "/json/version", timeout=1) as response:
                        json.load(response)
                    break
                except (URLError, TimeoutError):
                    if time.monotonic() > deadline:
                        raise RuntimeError("Chromium CDP readiness timeout")
                    time.sleep(.1)
            _, code = cli("attach", ["attach", "fixture", "--cdp", endpoint])
            assert code == 0
            report, code = cli("server_echo", ["audit", "fixture", "--headers", "--echo-url", base + "/echo"])
            header_report = report.get("headers", report)
            assert header_report["source"] == "server", header_report
            assert any(row["source"] == "browser" for row in header_report["observations"]), header_report
            assert any(row["source"] == "server" for row in header_report["observations"]), header_report
            assert header_report["summary"]["review_required"] > 0, header_report
            assert header_report["verdict"] != "pass" and code == 1, header_report

            def matrix(label, origin, records):
                script = json.dumps([
                    {"action": "goto", "args": {"url": origin + ("/matrix-redirect" if label == "http_h1" else "/redirect")}},
                    {"action": "eval", "args": {"js": """(async()=>{
                      const deadline=Date.now()+10000;
                      while(document.body.dataset.complete!=='yes') {
                        if(Date.now()>deadline) throw new Error('matrix request completion timeout');
                        await new Promise(resolve=>setTimeout(resolve,25));
                      }
                      return {ua:navigator.userAgent, language:navigator.language};
                    })()"""}},
                ])
                report, code = cli(label, ["run", "fixture", script])
                assert code == 0 and report["status"] == "ok", report
                observed = records()
                relevant = [row for row in observed if urlsplit(row["url"]).path in
                            {"/matrix-redirect", "/redirect", "/matrix", "/pixel.svg", "/worker.js", "/echo"}]
                assert any("via=worker" in row["url"] for row in relevant), relevant
                assert any("via=fetch" in row["url"] for row in relevant), relevant
                assert any(urlsplit(row["url"]).path == "/pixel.svg" for row in relevant), relevant
                evaluated = []
                for row in relevant:
                    path, query = urlsplit(row["url"]).path, urlsplit(row["url"]).query
                    if path == "/echo":
                        kind, destination, mode = "worker" if "worker" in query else "fetch", "empty", "cors"
                    elif path == "/pixel.svg":
                        kind, destination, mode = "subresource", "image", "no-cors"
                    elif path == "/worker.js":
                        kind, destination, mode = "subresource", "worker", "same-origin"
                    else:
                        kind, destination, mode = "redirect" if path != "/matrix" else "document", "document", "navigate"
                    context = {"url": row["url"], "protocol": row["protocol"], "resource_type": kind,
                               "destination": destination, "mode": mode}
                    checks = evaluate_headers(row["headers"], {"os": "macos", "locale": "en-US"}, context=context)
                    selected = [check for check in checks if check["header"] in {"sec-fetch-mode", "sec-fetch-dest", "connection"}]
                    assert all(check["result"] == "pass" for check in selected), (label, row, selected)
                    evaluated.append({"source": "server", "observed": row, "context": context, "checks": checks})
                (out / (label + ".evaluated.json")).write_text(json.dumps(evaluated, indent=2))

            matrix("http_h1", base, lambda: list(Fixture.records))
            certificate, key = out / "localhost.crt", out / "localhost.key"
            generation = subprocess.run(["openssl", "req", "-x509", "-newkey", "rsa:2048", "-nodes",
                                         "-keyout", str(key), "-out", str(certificate), "-days", "1", "-subj", "/CN=localhost"],
                                        capture_output=True, text=True, timeout=30)
            (out / "certificate-generation.log").write_text(generation.stderr)
            assert generation.returncode == 0, generation.stderr
            key.chmod(0o600)
            for protocol in ("h1", "h2"):
                records_file = out / ("https_" + protocol + ".requests.json")
                process = subprocess.Popen(["node", str(project / "tests/header_https_fixture.mjs"), str(certificate), str(key),
                                            protocol, str(records_file)], stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
                tls_processes.append(process)
                tls_port = json.loads(process.stdout.readline())["port"]
                matrix("https_" + protocol, f"https://127.0.0.1:{tls_port}", lambda: json.loads(records_file.read_text()))
    finally:
        if chrome:
            chrome.terminate()
            chrome.wait(timeout=10)
        for process in tls_processes:
            process.terminate()
            process.wait(timeout=10)
        server.shutdown()
        server.server_close()
        (out / "requests.json").write_text(json.dumps(Fixture.records, indent=2))
        (out / "summary.json").write_text(json.dumps(results, indent=2))
    print(json.dumps({"status": "pass", "output": str(out), "cases": results}, indent=2))


if __name__ == "__main__":
    main()
