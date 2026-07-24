# -*- coding: utf-8 -*-
import io
import os
import sys
import unittest
import urllib.error
import urllib.request


AI_DIR = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "public", "ai"))
if AI_DIR not in sys.path:
    sys.path.insert(0, AI_DIR)

from bridge_http_client import (
    MAX_JSON_REQUEST_BYTES, MAX_JSON_RESPONSE_BYTES, SameOriginRedirectHandler,
    assert_secure_http_url, encode_json_body, normalize_server_url, read_json_body,
)


class BridgeHttpClientTests(unittest.TestCase):
    def test_rejects_plaintext_remote_and_url_credentials(self):
        with self.assertRaises(ValueError):
            assert_secure_http_url("http://example.com/api")
        with self.assertRaises(ValueError):
            assert_secure_http_url("https://user:secret@example.com/api")
        with self.assertRaises(ValueError):
            assert_secure_http_url("https://example.com/api?next=evil")
        with self.assertRaises(ValueError):
            assert_secure_http_url("https://example.com/api#fragment")
        assert_secure_http_url("http://localhost:3000/health")
        assert_secure_http_url("https://example.com/api")

    def test_normalizes_one_shared_server_base_url(self):
        self.assertEqual(
            normalize_server_url(" HTTPS://EXAMPLE.COM:443/base/ "),
            "https://example.com/base",
        )
        self.assertEqual(
            normalize_server_url("http://[::1]:3000/"),
            "http://[::1]:3000",
        )

    def test_blocks_cross_origin_and_https_downgrade_redirects(self):
        handler = SameOriginRedirectHandler()
        request = urllib.request.Request(
            "https://safe.example/api", headers={"Authorization": "Bearer secret"},
        )
        for target in ("https://evil.example/api", "http://safe.example/api"):
            with self.assertRaises(urllib.error.HTTPError):
                handler.redirect_request(request, None, 302, "Found", {}, target)

    def test_same_origin_redirect_keeps_the_request_on_the_same_origin(self):
        handler = SameOriginRedirectHandler()
        request = urllib.request.Request(
            "https://safe.example/api", headers={"Authorization": "Bearer secret"},
        )
        redirected = handler.redirect_request(request, None, 302, "Found", {}, "/v2/api")
        self.assertEqual(redirected.full_url, "https://safe.example/v2/api")
        self.assertEqual(redirected.get_header("Authorization"), "Bearer secret")

    def test_json_response_is_bounded(self):
        self.assertEqual(read_json_body(io.BytesIO(b'{"ok":true}')), {"ok": True})
        with self.assertRaisesRegex(ValueError, "必须是对象"):
            read_json_body(io.BytesIO(b"[]"))
        with self.assertRaisesRegex(ValueError, "超过大小限制"):
            read_json_body(io.BytesIO(b"x" * (MAX_JSON_RESPONSE_BYTES + 1)))

    def test_json_request_is_utf8_compact_and_bounded(self):
        self.assertEqual(encode_json_body({"value": "交易"}), b'{"value":"\xe4\xba\xa4\xe6\x98\x93"}')
        with self.assertRaisesRegex(ValueError, "请求超过大小限制"):
            encode_json_body({"value": "x" * MAX_JSON_REQUEST_BYTES})


if __name__ == "__main__":
    unittest.main()
