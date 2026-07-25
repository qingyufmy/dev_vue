# -*- coding: utf-8 -*-
"""Bounded JSON HTTP client for Bridge authentication and health calls."""
import json
import urllib.error
import urllib.parse
import urllib.request


MAX_JSON_REQUEST_BYTES = 256 * 1024
MAX_JSON_RESPONSE_BYTES = 2 * 1024 * 1024


def validate_bridge_http_url(url):
    text = str(url or "").strip()
    if not text or any(ord(character) < 32 for character in text):
        raise ValueError("桥接服务器地址无效")
    parsed = urllib.parse.urlsplit(text)
    if parsed.username or parsed.password:
        raise ValueError("桥接服务器地址不能包含用户名或密码")
    if parsed.query or parsed.fragment:
        raise ValueError("桥接服务器地址不能包含查询参数或片段")
    try:
        parsed.port
    except ValueError as error:
        raise ValueError("桥接服务器端口无效") from error
    if parsed.scheme in {"http", "https"} and parsed.hostname:
        return
    raise ValueError("桥接服务器地址仅支持 HTTP 或 HTTPS")


def normalize_server_url(url):
    """Return one canonical base URL shared by HTTP and WebSocket callers."""
    text = str(url or "").strip()
    validate_bridge_http_url(text)
    parsed = urllib.parse.urlsplit(text)
    scheme = parsed.scheme.lower()
    host = (parsed.hostname or "").lower()
    host_text = f"[{host}]" if ":" in host else host
    port = parsed.port
    default_port = 443 if scheme == "https" else 80
    netloc = host_text if port in (None, default_port) else f"{host_text}:{port}"
    path = parsed.path.rstrip("/")
    return urllib.parse.urlunsplit((scheme, netloc, path, "", ""))


def _origin(url):
    parsed = urllib.parse.urlsplit(str(url or ""))
    scheme = parsed.scheme.lower()
    host = (parsed.hostname or "").lower()
    port = parsed.port or (443 if scheme == "https" else 80 if scheme == "http" else None)
    return scheme, host, port


class SameOriginRedirectHandler(urllib.request.HTTPRedirectHandler):
    """Never forward Bridge requests or credentials across origins."""

    def redirect_request(self, req, fp, code, msg, headers, newurl):
        target = urllib.parse.urljoin(req.full_url, newurl)
        try:
            validate_bridge_http_url(target)
        except ValueError as error:
            raise urllib.error.HTTPError(target, code, str(error), headers, fp) from error
        if _origin(req.full_url) != _origin(target):
            raise urllib.error.HTTPError(
                target, code, "cross-origin redirect blocked", headers, fp,
            )
        return super().redirect_request(req, fp, code, msg, headers, target)


def read_json_body(stream, limit=MAX_JSON_RESPONSE_BYTES):
    raw = stream.read(int(limit) + 1)
    if len(raw) > int(limit):
        raise ValueError("桥接服务器 JSON 响应超过大小限制")
    value = json.loads(raw.decode("utf-8"))
    if not isinstance(value, dict):
        raise ValueError("桥接服务器 JSON 响应必须是对象")
    return value


def encode_json_body(value, limit=MAX_JSON_REQUEST_BYTES):
    body = json.dumps(value, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    if len(body) > int(limit):
        raise ValueError("桥接服务器 JSON 请求超过大小限制")
    return body


def request_json(url, data=None, timeout=10, token=None, ssl_context=None):
    try:
        validate_bridge_http_url(url)
        body = None if data is None else encode_json_body(data)
        headers = {"User-Agent": "AURUM-Bridge/1.0"}
        if body is not None:
            headers["Content-Type"] = "application/json"
        if token:
            headers["Authorization"] = f"Bearer {token}"
        request = urllib.request.Request(url, data=body, headers=headers)
        handlers = [SameOriginRedirectHandler()]
        if ssl_context is not None:
            handlers.insert(0, urllib.request.HTTPSHandler(context=ssl_context))
        opener = urllib.request.build_opener(*handlers)
        with opener.open(request, timeout=timeout) as response:
            return response.status, read_json_body(response)
    except urllib.error.HTTPError as error:
        try:
            return error.code, read_json_body(error)
        except Exception:
            return error.code, {"error": str(error)}
    except Exception as error:
        return 0, {"error": str(error)}
