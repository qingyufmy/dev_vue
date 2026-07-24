# -*- coding: utf-8 -*-
import json
import os
import sys
import threading
import time
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, "public", "ai"))

from PySide6.QtCore import QCoreApplication, QEventLoop, QTimer  # noqa: E402
from aurum_bridge_gui import AsyncJsonRequest  # noqa: E402
from bridge_http_client import MAX_JSON_RESPONSE_BYTES  # noqa: E402


class _Handler(BaseHTTPRequestHandler):
    def log_message(self, *_args):
        pass

    def do_GET(self):
        if self.path == "/redirect":
            self.send_response(302)
            self.send_header("Location", "/ok")
            self.end_headers()
            return
        if self.path == "/large":
            payload = b'{"value":"' + (b"x" * MAX_JSON_RESPONSE_BYTES) + b'"}'
        elif self.path == "/slow":
            time.sleep(0.2)
            payload = b'{"ok":true}'
        else:
            payload = b'{"ok":true}'
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(payload)))
        self.end_headers()
        try:
            self.wfile.write(payload)
        except (BrokenPipeError, ConnectionResetError):
            pass

    def do_POST(self):
        length = int(self.headers.get("Content-Length") or 0)
        request = json.loads(self.rfile.read(length).decode("utf-8"))
        payload = json.dumps({"received": request}, separators=(",", ":")).encode("utf-8")
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)


class AsyncJsonRequestTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.app = QCoreApplication.instance() or QCoreApplication([])
        cls.server = ThreadingHTTPServer(("127.0.0.1", 0), _Handler)
        cls.thread = threading.Thread(target=cls.server.serve_forever, daemon=True)
        cls.thread.start()
        cls.base_url = f"http://127.0.0.1:{cls.server.server_port}"

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()
        cls.server.server_close()
        cls.thread.join(timeout=2)

    def request(self, path, data=None):
        loop = QEventLoop()
        result = []
        request = AsyncJsonRequest(f"{self.base_url}{path}", data=data, timeout=2)
        request.completed.connect(lambda status, body: (result.append((status, body)), loop.quit()))
        request.start()
        QTimer.singleShot(3000, loop.quit)
        loop.exec()
        self.assertTrue(result, "asynchronous request timed out")
        return result[0]

    def test_get_and_post_json_complete_without_blocking_start(self):
        loop = QEventLoop()
        result = []
        request = AsyncJsonRequest(f"{self.base_url}/slow", timeout=2)
        request.completed.connect(lambda status, body: (result.append((status, body)), loop.quit()))
        started = time.perf_counter()
        request.start()
        self.assertLess(time.perf_counter() - started, 0.1)
        QTimer.singleShot(3000, loop.quit)
        loop.exec()
        self.assertEqual(result, [(200, {"ok": True})])
        self.assertEqual(self.request("/echo", {"value": "交易"}), (200, {"received": {"value": "交易"}}))

    def test_redirect_is_not_followed(self):
        status, body = self.request("/redirect")
        self.assertEqual(status, 302)
        self.assertEqual(body["error"], "redirect_not_allowed")

    def test_oversized_response_is_aborted(self):
        status, body = self.request("/large")
        self.assertEqual(status, 0)
        self.assertIn("大小限制", body["error"])

    def test_invalid_or_oversized_requests_fail_without_network_io(self):
        loop = QEventLoop()
        results = []
        requests = [
            AsyncJsonRequest("http://example.com/api"),
            AsyncJsonRequest(f"{self.base_url}/echo", {"value": "x" * (256 * 1024)}),
        ]
        for request in requests:
            request.completed.connect(lambda status, body: results.append((status, body)))
            request.start()
        QTimer.singleShot(1000, loop.quit)
        QTimer.singleShot(10, loop.quit)
        loop.exec()
        self.assertEqual(len(results), 2)
        self.assertTrue(all(status == 0 for status, _body in results))
        self.assertIn("HTTPS", results[0][1]["error"])
        self.assertIn("大小限制", results[1][1]["error"])


if __name__ == "__main__":
    unittest.main()
