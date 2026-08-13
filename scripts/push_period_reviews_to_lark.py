"""AURUM 平台日/月复盘的本地 Lark 推送工具（仅标准库）。"""
from __future__ import annotations

import argparse
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
import json
import ipaddress
import logging
import math
import os
from pathlib import Path
import re
import tempfile
import time
from typing import Any, Callable, Iterable, Mapping, Optional
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode, urlsplit
from urllib.request import HTTPRedirectHandler, Request, build_opener

ROOT = Path(__file__).resolve().parents[1]
DEFAULT_STATE = ROOT / ".local" / "lark-review-push-state.json"
PAGE_SIZE, MAX_ITEMS, MAX_PAGES, TIMEOUT, RETRIES = 100, 1000, 20, 10, 3
LOG = logging.getLogger("aurum.period_review_lark")


class ConfigError(ValueError):
    pass


class ApiError(RuntimeError):
    pass


class NetworkError(RuntimeError):
    pass


class StateError(RuntimeError):
    pass


class LarkSendError(RuntimeError):
    def __init__(self, message: str, *, unknown: bool = False):
        super().__init__(message)
        self.unknown = unknown


def parse_env_file(path: Path) -> dict[str, str]:
    try:
        lines = path.read_text(encoding="utf-8").splitlines()
    except OSError as exc:
        raise ConfigError("无法读取配置文件") from exc
    values = {}
    for line in lines:
        line = line.strip()
        if not line or line.startswith("#"):
            continue
        if line.startswith("export "):
            line = line[7:].lstrip()
        if "=" not in line:
            continue
        key, value = line.split("=", 1)
        key, value = key.strip(), value.strip()
        if not re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]*", key):
            continue
        if len(value) >= 2 and value[0] == value[-1] and value[0] in "'\"":
            value = value[1:-1]
        elif " #" in value:
            value = value.split(" #", 1)[0].rstrip()
        values[key] = value
    return values


def _validate_base(url: str) -> None:
    parsed = urlsplit(url)
    if parsed.scheme not in {"http", "https"} or not parsed.hostname:
        raise ConfigError("AURUM_BASE_URL 必须是有效的 HTTP(S) 地址")
    if parsed.username or parsed.password or parsed.query or parsed.fragment:
        raise ConfigError("AURUM_BASE_URL 不得包含凭据、查询参数或片段")
    if parsed.scheme == "http":
        host = parsed.hostname.lower()
        if host not in {"localhost", "127.0.0.1", "::1"}:
            try:
                address = ipaddress.ip_address(parsed.hostname)
            except ValueError as exc:
                raise ConfigError("非本机 AURUM_BASE_URL 必须使用 HTTPS") from exc
            if not (address.is_private or address.is_loopback):
                raise ConfigError("公网 AURUM_BASE_URL 必须使用 HTTPS")


def _validate_webhook(url: str) -> None:
    parsed = urlsplit(url)
    if parsed.scheme != "https" or parsed.hostname != "open.larksuite.com":
        raise ConfigError("LARK_REVIEW_WEBHOOK_URL 必须是 open.larksuite.com 的 HTTPS 地址")
    if parsed.username or parsed.password or parsed.query or parsed.fragment:
        raise ConfigError("LARK_REVIEW_WEBHOOK_URL 不得包含凭据、查询参数或片段")


def _integer(value: Any, name: str, *, zero: bool = False) -> int:
    try:
        result = int(str(value).strip())
    except (TypeError, ValueError) as exc:
        raise ConfigError(f"{name} 必须是整数") from exc
    if result < (0 if zero else 1):
        raise ConfigError(f"{name} 必须是{'非负' if zero else '正'}整数")
    return result


@dataclass(frozen=True)
class Config:
    base_url: str
    email: Optional[str]
    phone: Optional[str]
    password: str
    webhook_url: Optional[str]
    lookback_days: int = 7
    max_cards: int = 20
    state_file: Path = DEFAULT_STATE

    @classmethod
    def from_sources(cls, *, config_path: Optional[Path | str] = None,
                     environ: Optional[Mapping[str, str]] = None,
                     dry_run: bool = False, repo_root: Path = ROOT) -> "Config":
        env = dict(os.environ if environ is None else environ)
        explicit = config_path is not None
        path = Path(config_path) if config_path is not None else repo_root / ".env.lark-review.local"
        if not path.is_absolute():
            path = repo_root / path
        if path.exists():
            file_values = parse_env_file(path)
        elif explicit:
            raise ConfigError(f"配置文件不存在：{path}")
        else:
            file_values = {}
        keys = {"AURUM_BASE_URL", "AURUM_PUSH_EMAIL", "AURUM_PUSH_PHONE", "AURUM_PUSH_PASSWORD",
                "LARK_REVIEW_WEBHOOK_URL", "LARK_REVIEW_LOOKBACK_DAYS", "LARK_REVIEW_MAX_CARDS", "LARK_REVIEW_STATE_FILE"}
        values = {k: file_values[k] for k in keys if k in file_values}
        values.update({k: env[k] for k in keys if k in env})
        base = values.get("AURUM_BASE_URL", "").strip().rstrip("/")
        if not base:
            raise ConfigError("缺少 AURUM_BASE_URL")
        _validate_base(base)
        email, phone = values.get("AURUM_PUSH_EMAIL", "").strip() or None, values.get("AURUM_PUSH_PHONE", "").strip() or None
        password = values.get("AURUM_PUSH_PASSWORD", "")
        if not email and not phone:
            raise ConfigError("必须配置 AURUM_PUSH_EMAIL 或 AURUM_PUSH_PHONE")
        if not password:
            raise ConfigError("缺少 AURUM_PUSH_PASSWORD")
        webhook = values.get("LARK_REVIEW_WEBHOOK_URL", "").strip() or None
        if not dry_run and not webhook:
            raise ConfigError("正常模式必须配置 LARK_REVIEW_WEBHOOK_URL")
        if webhook:
            _validate_webhook(webhook)
        state = Path(values.get("LARK_REVIEW_STATE_FILE", "")) if values.get("LARK_REVIEW_STATE_FILE", "").strip() else repo_root / ".local" / "lark-review-push-state.json"
        if not state.is_absolute():
            state = repo_root / state
        return cls(base, email, phone, password, webhook,
                   _integer(values.get("LARK_REVIEW_LOOKBACK_DAYS", 7), "LARK_REVIEW_LOOKBACK_DAYS", zero=True),
                   _integer(values.get("LARK_REVIEW_MAX_CARDS", 20), "LARK_REVIEW_MAX_CARDS"), state)


@dataclass
class HttpResponse:
    status: int
    body: bytes
    headers: Any = None

    def __post_init__(self):
        if self.body is None:
            self.body = b""
        elif isinstance(self.body, str):
            self.body = self.body.encode("utf-8")
        elif isinstance(self.body, (dict, list)):
            self.body = json.dumps(self.body, ensure_ascii=False).encode("utf-8")

    def json(self) -> Any:
        return json.loads(self.body.decode("utf-8"))


class _Redirects(HTTPRedirectHandler):
    def __init__(self, host: str):
        self.host = host

    def redirect_request(self, req, fp, code, msg, headers, newurl):  # noqa: N802
        source, target = urlsplit(req.full_url), urlsplit(newurl)
        if target.hostname != self.host or target.scheme not in {"http", "https"} or (source.scheme == "https" and target.scheme != "https"):
            raise HTTPError(req.full_url, code, "unsafe_redirect", headers, fp)
        return super().redirect_request(req, fp, code, msg, headers, newurl)


class HttpClient:
    def __init__(self, *, timeout: float = TIMEOUT, transport: Optional[Callable[..., Any]] = None):
        self.timeout, self.transport = timeout, transport

    def request(self, method: str, url: str, *, payload: Any = None,
                headers: Optional[Mapping[str, str]] = None, allowed_host: Optional[str] = None) -> HttpResponse:
        parsed = urlsplit(url)
        if parsed.scheme not in {"http", "https"} or not parsed.hostname or (allowed_host and parsed.hostname != allowed_host):
            raise NetworkError("请求地址无效")
        body = None if payload is None else json.dumps(payload, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
        request_headers = {"Accept": "application/json", **dict(headers or {})}
        if body is not None:
            request_headers.setdefault("Content-Type", "application/json")
        if self.transport:
            try:
                result = self.transport(method, url, request_headers, body, self.timeout)
            except (TimeoutError, OSError, URLError) as exc:
                raise NetworkError("网络请求失败") from exc
            return _response(result)
        opener = build_opener(_Redirects(parsed.hostname))
        try:
            with opener.open(Request(url, data=body, headers=request_headers, method=method.upper()), timeout=self.timeout) as response:
                return HttpResponse(int(response.getcode()), response.read(), response.headers)
        except HTTPError as exc:
            try:
                body = exc.read()
            except Exception:
                body = b""
            return HttpResponse(int(exc.code), body, exc.headers)
        except (TimeoutError, OSError, URLError) as exc:
            raise NetworkError("网络请求失败") from exc


def _response(result: Any) -> HttpResponse:
    if isinstance(result, HttpResponse):
        return result
    if isinstance(result, tuple) and len(result) >= 2:
        status, body, headers = result[0], result[1], result[2] if len(result) > 2 else None
    elif isinstance(result, Mapping):
        status, body, headers = result.get("status", result.get("code", 200)), result.get("body", result.get("data", b"")), result.get("headers")
    else:
        raise NetworkError("网络响应格式无效")
    if isinstance(body, (dict, list)):
        body = json.dumps(body, ensure_ascii=False).encode("utf-8")
    elif isinstance(body, str):
        body = body.encode("utf-8")
    return HttpResponse(int(status), body or b"", headers)


def _json(response: HttpResponse, operation: str) -> dict[str, Any]:
    try:
        body = response.json()
    except (ValueError, UnicodeDecodeError) as exc:
        raise ApiError(f"{operation}响应不是有效 JSON") from exc
    if not isinstance(body, dict):
        raise ApiError(f"{operation}响应格式无效")
    return body


class AurumApi:
    def __init__(self, config: Config, *, http: Optional[HttpClient] = None):
        self.config, self.http, self.token = config, http or HttpClient(), None
        self.host = urlsplit(config.base_url).hostname

    def login(self) -> str:
        key, identity = ("email", self.config.email) if self.config.email else ("phone", self.config.phone)
        response = self.http.request("POST", f"{self.config.base_url}/api/login",
                                     payload={key: identity, "password": self.config.password, "method": "password"}, allowed_host=self.host)
        body = _json(response, "登录")
        if not 200 <= response.status < 300 or body.get("ok") is not True or not isinstance(body.get("token"), str) or not body["token"]:
            raise ApiError("登录失败")
        self.token = body["token"]
        return self.token

    def list_cases(self, period_type: str) -> list[dict[str, Any]]:
        if period_type not in {"daily", "monthly"}:
            raise ValueError("invalid_period_type")
        rows, offset, seen = [], 0, set()
        for _ in range(MAX_PAGES):
            if offset in seen:
                raise ApiError("复盘分页游标未推进")
            seen.add(offset)
            query = urlencode({"periodType": period_type, "limit": PAGE_SIZE, "offset": offset})
            response = self.http.request("GET", f"{self.config.base_url}/api/ai/period-reviews?{query}",
                                         headers={"Authorization": f"Bearer {self.token}"} if self.token else {}, allowed_host=self.host)
            body = _json(response, "读取复盘列表")
            if not 200 <= response.status < 300 or body.get("ok") is not True or not isinstance(body.get("cases"), list):
                raise ApiError("读取复盘列表失败")
            page = [dict(item) for item in body["cases"] if isinstance(item, Mapping)]
            rows.extend(page)
            if len(rows) >= MAX_ITEMS:
                return rows[:MAX_ITEMS]
            pagination = body.get("pagination") if isinstance(body.get("pagination"), Mapping) else {}
            more, next_offset = pagination.get("has_more", pagination.get("hasMore")), pagination.get("next_offset", pagination.get("nextOffset"))
            if more is False or not page or (more is not True and next_offset is None and len(page) < PAGE_SIZE):
                break
            try:
                next_offset = int(next_offset) if next_offset is not None else offset + len(page)
            except (TypeError, ValueError) as exc:
                raise ApiError("复盘分页游标无效") from exc
            if next_offset <= offset:
                raise ApiError("复盘分页游标未推进")
            offset = next_offset
        else:
            raise ApiError("复盘分页超过安全上限")
        return rows

    def get_case(self, case_id: Any) -> dict[str, Any]:
        response = self.http.request("GET", f"{self.config.base_url}/api/ai/period-reviews/{case_id}",
                                     headers={"Authorization": f"Bearer {self.token}"} if self.token else {}, allowed_host=self.host)
        body = _json(response, "读取复盘详情")
        if not 200 <= response.status < 300 or body.get("ok") is not True or not isinstance(body.get("review"), Mapping):
            raise ApiError("读取复盘详情失败")
        return dict(body["review"])


def parse_utc_datetime(value: Any) -> Optional[datetime]:
    if value in (None, ""):
        return None
    try:
        if isinstance(value, (int, float)) and not isinstance(value, bool):
            number = float(value) / (1000 if float(value) > 100_000_000_000 else 1)
            return datetime.fromtimestamp(number, timezone.utc)
        text = str(value).strip()
        if re.fullmatch(r"\d+(?:\.\d+)?", text):
            return parse_utc_datetime(float(text))
        parsed = datetime.fromisoformat(text.replace("/", "-").replace("Z", "+00:00"))
    except (TypeError, ValueError, OverflowError, OSError):
        for fmt in ("%Y-%m-%d %H:%M:%S", "%Y-%m-%d"):
            try:
                parsed = datetime.strptime(str(value).strip(), fmt)
                break
            except ValueError:
                parsed = None
        if parsed is None:
            return None
    return (parsed if parsed.tzinfo else parsed.replace(tzinfo=timezone.utc)).astimezone(timezone.utc)


def _date(case: Mapping[str, Any]) -> Optional[datetime]:
    for key in ("period_end_utc_msc", "period_end_utc_ms", "period_end_utc_msec", "period_end_utc"):
        if case.get(key) not in (None, "") and (value := parse_utc_datetime(case.get(key))):
            return value
    return parse_utc_datetime(case.get("updated_at")) or parse_utc_datetime(case.get("created_at"))


EXCLUDED = {"superseded", "needs_revision", "failed", "generating", "evidence_pending", "incomplete"}


def case_id(case: Mapping[str, Any]) -> Optional[str]:
    value = case.get("id", case.get("case_id", case.get("period_case_id")))
    return str(value) if value not in (None, "") else None


def current_version_id(case: Mapping[str, Any]) -> Optional[str]:
    value = case.get("current_version_id")
    return str(value) if value not in (None, "", 0, "0") else None


def select_candidates(cases: Iterable[Mapping[str, Any]], *, lookback_days: int,
                      now: Optional[datetime] = None) -> list[dict[str, Any]]:
    now = (now or datetime.now(timezone.utc)).astimezone(timezone.utc)
    cutoff, selected, seen = now - timedelta(days=lookback_days), [], set()
    for raw in cases:
        if not isinstance(raw, Mapping):
            continue
        item, cid, version = dict(raw), case_id(raw), current_version_id(raw)
        if not cid or not version or str(item.get("status", "")).strip().lower() in EXCLUDED or str(item.get("evidence_status", item.get("evidenceStatus", ""))).strip().lower() != "complete":
            continue
        if item.get("strategy_scope", item.get("strategyScope")) is not None and str(item.get("strategy_scope", item.get("strategyScope"))).strip().lower() != "platform":
            continue
        observed = _date(item)
        if str(item.get("period_type", item.get("periodType", ""))).strip().lower() not in {"daily", "monthly"} or observed is None or observed < cutoff:
            continue
        key = f"{cid}:{version}"
        if key in seen:
            continue
        seen.add(key)
        item["_push_key"] = key
        selected.append(item)
    return selected


def find_current_version(review: Mapping[str, Any], expected_version_id: Any = None) -> Optional[dict[str, Any]]:
    wanted = str(expected_version_id if expected_version_id not in (None, "") else review.get("current_version_id", ""))
    return next((dict(item) for item in review.get("versions", []) if isinstance(item, Mapping) and str(item.get("id")) == wanted), None) if isinstance(review.get("versions"), list) else None


def _detail_eligible(review: Mapping[str, Any], candidate: Mapping[str, Any]) -> bool:
    """Re-check mutable scope/status/evidence after reading the detail."""
    if case_id(review) != case_id(candidate) or not current_version_id(review):
        return False
    status = str(review.get("status", "")).strip().lower()
    evidence = str(review.get("evidence_status", review.get("evidenceStatus", ""))).strip().lower()
    scope = review.get("strategy_scope", review.get("strategyScope"))
    return bool(status and status not in EXCLUDED and evidence == "complete"
                and (scope is None or str(scope).strip().lower() == "platform"))


STATUS = {"approved": "已确认", "edited": "修订待确认", "draft": "待人工确认", "ready": "待人工确认",
          "needs_revision": "需要修订", "failed": "生成失败", "generating": "生成中",
          "evidence_pending": "证据待完成", "incomplete": "证据不完整", "superseded": "已替代"}
QUALITY = {"good": "良好", "mixed": "有亮点也有问题", "poor": "需要改进", "insufficient_evidence": "证据不足"}
CHAN_STATUS = {"normal": "正常", "suspected_issue": "疑似问题", "confirmed_issue": "确认问题", "insufficient_evidence": "证据不足"}
CHAN_SOURCE = {"data": "数据", "calculation": "计算", "confirmation_lag": "确认延迟", "ai_interpretation": "AI 解读", "strategy_rule": "策略规则", "none": "无", "unknown": "未知"}
CARD_SCHEMA_VERSION = 4
CARD_ITEM_LIMIT = 50
EMAIL = re.compile(r"\b[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}\b")
PHONE = re.compile(r"(?<!\d)(?:\+?\d[\d\s-]{7,}\d)(?!\d)")
ACCOUNT = re.compile(r"(?i)(账户|account|login)\s*[:：#]?\s*\d{4,}")


def safe_text(value: Any, max_length: int = 600) -> str:
    if value is None:
        return ""
    if isinstance(value, bool):
        text = "是" if value else "否"
    elif isinstance(value, (str, int, float)):
        text = str(value)
    elif isinstance(value, Mapping):
        value = next((value[k] for k in ("title", "text", "description", "content", "reason", "value") if k in value), "")
        text = safe_text(value, max_length)
    elif isinstance(value, (list, tuple)):
        text = "；".join(safe_text(item, max_length) for item in value if item not in (None, ""))
    else:
        text = str(value)
    text = EMAIL.sub("[已隐藏邮箱]", text)
    text = PHONE.sub(lambda m: m.group(0) if re.fullmatch(r"\d{4}-\d{2}-\d{2}", m.group(0)) else "[已隐藏联系方式]", text)
    text = ACCOUNT.sub(lambda m: f"{m.group(1)}[已隐藏]", text)
    text = re.sub(r"[\x00-\x08\x0b\x0c\x0e-\x1f]", "", text).strip()
    return text if len(text) <= max_length else text[:max_length - 1].rstrip() + "…"


def _items(value: Any) -> str:
    values = [part.strip() for part in value.splitlines() if part.strip()] if isinstance(value, str) else list(value or []) if isinstance(value, (list, tuple)) else ([] if value in (None, "") else [value])
    values = [safe_text(item, 300) for item in values if safe_text(item, 300)]
    visible = values[:CARD_ITEM_LIMIT]
    lines = [f"• {item}" for item in visible]
    if len(values) > CARD_ITEM_LIMIT:
        lines.append(f"• 另有{len(values) - CARD_ITEM_LIMIT}条未展示")
    return "\n".join(lines) or "暂无"


def _section(title: str, content: str) -> dict[str, Any]:
    return {"tag": "div", "text": {"tag": "lark_md", "content": f"**{title}**\n{content or '暂无'}"}}


def _evidence_statistics(review: Mapping[str, Any]) -> Mapping[str, Any]:
    evidence = review.get("evidence")
    if isinstance(evidence, str):
        try:
            evidence = json.loads(evidence)
        except (TypeError, ValueError):
            evidence = None
    if isinstance(evidence, Mapping) and isinstance(evidence.get("statistics"), Mapping):
        return evidence["statistics"]
    return {}


def _finite_number(value: Any) -> Optional[float]:
    try:
        number = float(value)
    except (TypeError, ValueError):
        return None
    return number if math.isfinite(number) else None


def _count(value: Any) -> Optional[int]:
    number = _finite_number(value)
    if number is None or number < 0 or not number.is_integer():
        return None
    return int(number)


def _metrics(review: Mapping[str, Any]) -> dict[str, Any]:
    stats = _evidence_statistics(review)
    monthly = str(review.get("period_type", review.get("periodType", ""))).strip().lower() == "monthly"
    trade_count = _count(stats.get("trade_count"))
    trading_days = _count(stats.get("trading_days"))
    wins, losses = _count(stats.get("wins")), _count(stats.get("losses"))
    net_profit = _finite_number(stats.get("net_profit"))
    rate = _finite_number(stats.get("win_rate"))
    if rate is None and trade_count and wins is not None:
        rate = wins / trade_count
    if rate is not None and 0 <= rate <= 1:
        rate_text = f"{rate * 100:.0f}%"
    elif rate is not None and 0 <= rate <= 100:
        rate_text = f"{rate:.0f}%"
    else:
        rate_text = "--"
    net_text = "--" if net_profit is None else "0.00" if net_profit == 0 else f"{'+' if net_profit > 0 else ''}{net_profit:.2f}"
    wins_text, losses_text = "--" if wins is None else str(wins), "--" if losses is None else str(losses)
    if trade_count is not None:
        trade_text = f"{trade_count}笔（胜{wins_text}·负{losses_text}"
        if trading_days is not None and monthly:
            trade_text += f"·{trading_days}交易日"
        trade_text += "）"
    elif trading_days is not None and monthly:
        trade_text = f"--（胜{wins_text}·负{losses_text}·{trading_days}交易日）"
    else:
        trade_text = f"--（胜{wins_text}·负{losses_text}）"
    return {"net_profit": net_text, "trade_count": trade_text, "win_rate": rate_text}


def _confidence(value: Any) -> str:
    try:
        number = float(value)
        return f"{number * 100:.0f}%" if 0 <= number <= 1 else f"{number:.0f}%" if 0 <= number <= 100 else "未知"
    except (TypeError, ValueError):
        return safe_text(value, 30) if value not in (None, "") else "未知"


def _card_context(review: Mapping[str, Any], version: Optional[Mapping[str, Any]] = None) -> dict[str, Any]:
    period_type = str(review.get("period_type", review.get("periodType", "daily"))).lower()
    monthly = period_type == "monthly"
    period_label, name = "月复盘" if monthly else "日复盘", safe_text(review.get("strategy_title") or review.get("strategy_name") or "未命名策略", 120)
    version = dict(version or find_current_version(review) or {})
    content = version.get("content", {})
    if isinstance(content, str):
        try:
            content = json.loads(content)
        except (ValueError, TypeError):
            content = {}
    content = content if isinstance(content, Mapping) else {}
    metrics = _metrics(review)
    try:
        version_no = int(version.get("version_no", 1) or 1)
    except (TypeError, ValueError):
        version_no = 1
    revision = "（修订版）" if version_no > 1 else ""
    quality, status = QUALITY.get(str(content.get("decision_quality", "")).lower(), "未知"), STATUS.get(str(review.get("status", "")).lower(), "未知")
    evidence = str(review.get("evidence_status", review.get("evidenceStatus", ""))).lower()
    details = (f"**复盘周期**：{safe_text(review.get('period_key') or review.get('periodKey') or '未知周期', 80)}\n"
               f"**策略**：{name}（策略 ID：{safe_text(review.get('strategy_id') or review.get('strategyId') or '未知', 60)}）\n"
               f"**策略版本**：{safe_text(review.get('strategy_version') or review.get('strategyVersion') or '未知', 60)}\n"
               f"**复盘版本**：v{version_no}{'，修订版' if revision else ''}\n"
               f"**状态**：{status}　**证据**：{'证据完整' if evidence == 'complete' else '证据未完整' if evidence else '未知'}\n"
               f"**净收益**：{metrics['net_profit']}　**交易**：{metrics['trade_count']}　**胜率**：{metrics['win_rate']}　"
               f"**综合判断**：{quality}　**置信度**：{_confidence(content.get('confidence'))}")
    return {"period_type": period_type, "monthly": monthly, "period_label": period_label, "name": name,
            "version": version, "content": content, "version_no": version_no, "revision": revision,
            "details": details, "status_raw": str(review.get("status", "")).strip().lower(), "quality": quality,
            "status": status, "evidence": evidence, "metrics": metrics}


def _assessment_text(item: Any, label: str) -> str:
    if not isinstance(item, Mapping):
        return safe_text(item, 400)
    quality = QUALITY.get(str(item.get("decision_quality", "")).lower(), "未知")
    summary = re.sub(r"\s+", " ", safe_text(item.get("summary") or item.get("description") or item.get("content"), 500)) or "暂无"
    return f"{label}：决策{quality}；总结：{summary}"


def _assessment_label(item: Any, index: int, unit: str) -> str:
    label = f"第{index}{unit}"
    if isinstance(item, Mapping):
        if unit == "笔" and item.get("outcome_id") not in (None, ""):
            label += f"（交易#{safe_text(item.get('outcome_id'), 40)}）"
        elif unit == "日" and item.get("period_key") not in (None, ""):
            label += f"（{safe_text(item.get('period_key'), 60)}）"
    return label


def _chan_detail(content: Mapping[str, Any]) -> str:
    period = content.get("period_chan_assessment")
    if not isinstance(period, Mapping):
        period = {}
    status = CHAN_STATUS.get(str(period.get("status", "")).lower(), "未知")
    source = CHAN_SOURCE.get(str(period.get("issue_source", "")).lower(), "未知")
    explanation = safe_text(period.get("explanation"), 500) or "暂无"
    confidence = _confidence(period.get("confidence"))
    diagnoses = content.get("chan_diagnoses") if isinstance(content.get("chan_diagnoses"), list) else []
    status_counts: dict[str, int] = {}
    source_counts: dict[str, int] = {}
    pairs: dict[tuple[str, str], int] = {}
    for item in diagnoses:
        if not isinstance(item, Mapping):
            continue
        raw_status, raw_source = str(item.get("status", "unknown")).lower(), str(item.get("issue_source", "unknown")).lower()
        status_counts[raw_status] = status_counts.get(raw_status, 0) + 1
        source_counts[raw_source] = source_counts.get(raw_source, 0) + 1
        pairs[(raw_status, raw_source)] = pairs.get((raw_status, raw_source), 0) + 1
    aggregate = [f"共 {len(diagnoses)} 条"]
    if status_counts:
        aggregate.append("状态：" + "、".join(f"{CHAN_STATUS.get(key, '未知')} {count}条" for key, count in status_counts.items()))
    if source_counts:
        aggregate.append("来源：" + "、".join(f"{CHAN_SOURCE.get(key, '未知')} {count}条" for key, count in source_counts.items()))
    anomalies: list[str] = []
    major_pair = max(pairs, key=pairs.get) if pairs else None
    if major_pair:
        for item in diagnoses:
            if not isinstance(item, Mapping):
                continue
            pair = (str(item.get("status", "unknown")).lower(), str(item.get("issue_source", "unknown")).lower())
            if pair == major_pair:
                continue
            anomalies.append(f"状态{CHAN_STATUS.get(pair[0], '未知')}、来源{CHAN_SOURCE.get(pair[1], '未知')}：{safe_text(item.get('explanation'), 300) or '暂无'}")
    if anomalies:
        aggregate.append("异常项：\n" + "\n".join(f"• {item}" for item in anomalies))
    return (f"状态：{status}　来源：{source}　说明：{explanation}　置信度：{confidence}\n"
            f"诊断聚合：{'；'.join(aggregate)}")


def _header_template(context: Mapping[str, Any]) -> str:
    status, quality = context["status_raw"], context["quality"]
    if status == "needs_revision":
        return "red"
    if status in {"draft", "ready", "edited"}:
        return "orange"
    if status == "approved":
        return "green" if quality == QUALITY["good"] else "blue"
    return "grey"


def _fields(context: Mapping[str, Any]) -> dict[str, Any]:
    review = context["review"]
    metrics = context["metrics"]
    fields = [
        ("复盘周期", review.get("period_key") or review.get("periodKey") or "未知周期"),
        ("策略", f"{context['name']}（ID：{review.get('strategy_id') or review.get('strategyId') or '未知'}）"),
        ("策略/复盘版本", f"{safe_text(review.get('strategy_version') or review.get('strategyVersion') or '未知', 40)} / v{context['version_no']}{'（修订版）' if context['revision'] else ''}"),
        ("净收益", metrics["net_profit"]),
        ("交易笔数", metrics["trade_count"]),
        ("胜率", metrics["win_rate"]),
        ("综合判断", context["quality"]),
        ("置信度", _confidence(context["content"].get("confidence"))),
    ]
    return {"tag": "div", "fields": [{"is_short": True, "text": {"tag": "lark_md", "content": f"**{safe_text(label, 30)}**\n{safe_text(value, 80)}"}} for label, value in fields]}


def _build_card(kind: str, context: Mapping[str, Any]) -> dict[str, Any]:
    monthly, content = context["monthly"], context["content"]
    issue_key, next_key = ("recurring_patterns", "next_month_actions") if monthly else ("repeated_issues", "daily_lessons")
    issue = _items(content.get(issue_key))
    action = _items(content.get(next_key))
    strengths = _items(content.get("strengths"))
    risk = _items(content.get("risk_observations"))
    if monthly:
        assessments = content.get("daily_assessments") if isinstance(content.get("daily_assessments"), list) else []
        detail = _items([_assessment_text(item, _assessment_label(item, index, "日")) for index, item in enumerate(assessments, 1)])
        extra = (f"冲突组：{len(content.get('conflict_groups') or []) if isinstance(content.get('conflict_groups'), list) else 0} 个；"
                 f"记忆候选：{len(content.get('memory_candidates') or []) if isinstance(content.get('memory_candidates'), list) else 0} 条（仅作候选，未表示已生效）")
        detail_title, detail_content = "📅 每日明细", f"{detail}\n\n**🧩 月度交叉信息**\n{extra}"
    else:
        assessments = content.get("trade_assessments") if isinstance(content.get("trade_assessments"), list) else []
        detail = _items([_assessment_text(item, _assessment_label(item, index, "笔")) for index, item in enumerate(assessments, 1)])
        detail_title, detail_content = "📊 逐笔明细", f"{detail}\n\n**🧭 缠论判断**\n{_chan_detail(content)}"
    icon = {"approved": "✅", "edited": "📝", "draft": "⏳", "ready": "⏳", "needs_revision": "⚠️"}.get(context["status_raw"], "ℹ️")
    evidence = "完整" if context["evidence"] == "complete" else "未完整" if context["evidence"] else "未知"
    status_line = f"**{icon} {context['status']} · 证据{evidence}**\n*成交指标：系统成交结果*"
    elements = [{"tag": "div", "text": {"tag": "lark_md", "content": status_line}}, _fields(context), {"tag": "hr"},
                _section("📝 核心结论", safe_text(content.get("period_summary"), 1000)),
                _section("⚠️ 问题与行动", f"**问题**\n{issue}\n\n**行动**\n{action}"),
                _section("✅ 优势与风控", f"**优势**\n{strengths}\n\n**风控**\n{risk}"),
                {"tag": "hr"}, _section(detail_title, detail_content)]
    title = f"{context['status']}｜{context['period_label']} · {context['name']}{context['revision']}"
    payload = {"msg_type": "interactive", "card": {"header": {"template": _header_template(context), "title": {"tag": "plain_text", "content": safe_text(title, 180)}}, "elements": elements}}
    json.dumps(payload, ensure_ascii=False, separators=(",", ":"))
    return payload


def build_lark_cards(review: Mapping[str, Any], version: Optional[Mapping[str, Any]] = None) -> list[tuple[str, dict[str, Any]]]:
    """Build one compact card while retaining every review data section."""
    context = _card_context(review, version)
    context["review"] = review
    return [("review", _build_card("review", context))]


def build_lark_card(review: Mapping[str, Any], version: Optional[Mapping[str, Any]] = None) -> dict[str, Any]:
    """Backward-compatible helper returning the merged review card."""
    return build_lark_cards(review, version)[0][1]


def card_state_key(case_value: Any, version_value: Any, kind: str, schema_version: int = CARD_SCHEMA_VERSION) -> str:
    return f"{case_value}:{version_value}:card-v{schema_version}:{kind}"


def case_state_key(case_value: Any) -> str:
    """Stable case-level ledger key; deliberately independent of version."""
    return f"case:{case_value}:review"


def _state_key_case_id(key: Any) -> Optional[str]:
    """Extract a case id from known ledger key shapes without prefix matches."""
    parts = str(key).split(":")
    if len(parts) >= 3 and parts[0] == "case":
        return parts[1] or None
    if len(parts) == 2 and parts[0] == "case":  # tolerate an earlier case-only key
        return parts[1] or None
    if len(parts) == 2 and parts[0]:  # legacy bare case:version key
        return parts[0]
    if len(parts) >= 4 and parts[0] and parts[2].startswith("card-v"):
        return parts[0]
    return None


class StateStore:
    def __init__(self, path: Path | str):
        self.path, self.data = Path(path), {"sent": {}, "unknown": {}}

    def load(self) -> dict[str, dict[str, Any]]:
        if not self.path.exists():
            return self.data
        try:
            parsed = json.loads(self.path.read_text(encoding="utf-8"))
        except (OSError, UnicodeDecodeError, ValueError) as exc:
            raise StateError("状态文件损坏，已安全停止且未覆盖原文件") from exc
        if (not isinstance(parsed, Mapping) or not isinstance(parsed.get("sent"), Mapping)
                or not isinstance(parsed.get("unknown"), Mapping)
                or any(not isinstance(k, str) or not isinstance(v, Mapping) for section in (parsed["sent"], parsed["unknown"]) for k, v in section.items())):
            raise StateError("状态文件结构无效，已安全停止且未覆盖原文件")
        self.data = {"sent": dict(parsed["sent"]), "unknown": dict(parsed["unknown"])}
        return self.data

    def contains(self, key: str) -> bool:
        return key in self.data["sent"] or key in self.data["unknown"]

    def has_case(self, case_value: Any) -> bool:
        target = str(case_value)
        for section in (self.data["sent"], self.data["unknown"]):
            for key, metadata in section.items():
                if _state_key_case_id(key) == target:
                    return True
                if isinstance(metadata, Mapping) and str(metadata.get("case_id", "")) == target:
                    return True
        return False

    def mark_sent(self, key: str, metadata: Optional[Mapping[str, Any]] = None) -> None:
        self.data["sent"][key] = {"sent_at": datetime.now(timezone.utc).isoformat(), **dict(metadata or {})}
        self.data["unknown"].pop(key, None)

    def mark_unknown(self, key: str, metadata: Optional[Mapping[str, Any]] = None) -> None:
        self.data["unknown"][key] = {"recorded_at": datetime.now(timezone.utc).isoformat(), **dict(metadata or {})}

    def save(self) -> None:
        temporary = None
        try:
            self.path.parent.mkdir(parents=True, exist_ok=True)
            fd, temporary = tempfile.mkstemp(prefix=f".{self.path.name}.", suffix=".tmp", dir=str(self.path.parent))
            with os.fdopen(fd, "w", encoding="utf-8", newline="\n") as handle:
                json.dump(self.data, handle, ensure_ascii=False, indent=2, sort_keys=True)
                handle.write("\n")
                handle.flush()
                os.fsync(handle.fileno())
            os.replace(temporary, self.path)
        except OSError as exc:
            raise StateError("状态文件无法安全写入") from exc
        finally:
            if temporary and os.path.exists(temporary):
                try:
                    os.unlink(temporary)
                except OSError:
                    pass


def _lark_ok(body: Any) -> bool:
    return isinstance(body, Mapping) and body.get("code") in (0, "0") or isinstance(body, Mapping) and body.get("StatusCode") in (0, "0")


class LarkSender:
    def __init__(self, webhook_url: str, *, http: Optional[HttpClient] = None,
                 sleep: Callable[[float], None] = time.sleep, max_retries: int = RETRIES):
        _validate_webhook(webhook_url)
        self.url, self.http, self.sleep, self.max_retries = webhook_url, http or HttpClient(), sleep, max(1, max_retries)

    def send(self, payload: Mapping[str, Any]) -> None:
        for attempt in range(1, self.max_retries + 1):
            try:
                response = self.http.request("POST", self.url, payload=payload, allowed_host="open.larksuite.com")
            except NetworkError as exc:
                if attempt < self.max_retries:
                    self.sleep(2 ** (attempt - 1))
                    continue
                raise LarkSendError("Lark 网络响应未知", unknown=True) from exc
            if 200 <= response.status < 300:
                try:
                    body = response.json()
                except (ValueError, UnicodeDecodeError) as exc:
                    raise LarkSendError("Lark 响应未知", unknown=True) from exc
                if _lark_ok(body):
                    return
                raise LarkSendError("Lark 业务响应失败")
            retryable = response.status == 429 or 500 <= response.status <= 599
            if retryable and attempt < self.max_retries:
                self.sleep(2 ** (attempt - 1))
                continue
            raise LarkSendError("Lark 网络响应未知" if retryable else f"Lark 请求失败（HTTP {response.status}）", unknown=retryable)


@dataclass
class RunSummary:
    read: int = 0
    candidates: int = 0
    skipped: int = 0
    sent: int = 0
    unknown: int = 0
    failed: int = 0
    dry_run: bool = False
    errors: list[str] = field(default_factory=list)


class PushRunner:
    def __init__(self, config: Config, *, api: Optional[AurumApi] = None,
                 sender: Optional[LarkSender] = None, now: Optional[Callable[[], datetime]] = None,
                 logger: Optional[logging.Logger] = None,
                 sleep: Callable[[float], None] = time.sleep):
        self.config, self.api, self.sender = config, api or AurumApi(config), sender
        self.now, self.logger, self.sleep = now or (lambda: datetime.now(timezone.utc)), logger or LOG, sleep

    def run(self, *, dry_run: bool = False) -> RunSummary:
        summary, store = RunSummary(dry_run=dry_run), StateStore(self.config.state_file)
        store.load()
        if not dry_run:
            # Probe the exact atomic write path before login/webhook work.  A
            # successful message must never be followed by an unrecorded key.
            store.save()
        if not dry_run and not self.sender:
            if not self.config.webhook_url:
                raise ConfigError("正常模式缺少 Lark Webhook")
            self.sender = LarkSender(self.config.webhook_url)
        try:
            self.api.login()
        except Exception:
            self.logger.error("AURUM 登录失败")
            summary.failed, summary.errors = 1, ["登录失败"]
            return summary
        all_cases = []
        for period in ("daily", "monthly"):
            try:
                page = self.api.list_cases(period)
                summary.read += len(page)
                all_cases.extend(page)
            except Exception:
                self.logger.error("读取%s复盘列表失败", "日" if period == "daily" else "月")
                summary.failed += 1
                summary.errors.append(f"读取{period}列表失败")
        candidates = select_candidates(all_cases, lookback_days=self.config.lookback_days, now=self.now())
        summary.candidates = len(candidates)
        pending = []
        pending_case_ids: set[str] = set()
        for item in candidates:
            try:
                item_case_id = case_id(item)
                if item_case_id and (store.has_case(item_case_id) or item_case_id in pending_case_ids):
                    summary.skipped += 1
                    continue
                review = self.api.get_case(item["id"])
                if not _detail_eligible(review, item):
                    summary.skipped += 1
                    continue
                detail_case_id = case_id(review)
                version_id = current_version_id(review)
                version = find_current_version(review, version_id)
                if not version_id or version is None:
                    raise ApiError("当前复盘版本不存在")
                if store.has_case(detail_case_id):
                    summary.skipped += 1
                    continue
                cards = build_lark_cards(review, version)
                for kind, payload in cards:
                    key = case_state_key(detail_case_id)
                    if store.contains(key):
                        summary.skipped += 1
                        continue
                    pending.append((item, review, version, key, kind, payload))
                    if detail_case_id:
                        pending_case_ids.add(detail_case_id)
                    if len(pending) >= self.config.max_cards:
                        break
            except Exception:
                self.logger.error("读取复盘详情失败（case=%s）", case_id(item) or "?")
                summary.failed += 1
            if len(pending) >= self.config.max_cards:
                break
        for index, (item, review, version, key, kind, payload) in enumerate(pending):
            try:
                if dry_run:
                    self.logger.info("预览卡片：%s", _preview(review, version, kind))
                    summary.sent += 1
                    continue
                assert self.sender is not None
                self.sender.send(payload)
                store.mark_sent(key, {"case_id": case_id(review), "version_id": str(version.get("id")),
                                      "card_kind": kind, "schema": CARD_SCHEMA_VERSION})
                store.save()
                summary.sent += 1
            except LarkSendError as exc:
                summary.failed += 1
                if exc.unknown:
                    summary.unknown += 1
                    try:
                        store.mark_unknown(key, {"case_id": case_id(review), "version_id": str(version.get("id")),
                                                 "card_kind": kind, "schema": CARD_SCHEMA_VERSION})
                        store.save()
                    except StateError:
                        self.logger.error("未知发送状态无法写入状态文件")
                self.logger.error("Lark 发送失败（case=%s）", case_id(item) or "?")
            except StateError:
                summary.failed += 1
                self.logger.error("状态文件写入失败（case=%s）", case_id(item) or "?")
            except Exception:
                summary.failed += 1
                self.logger.error("生成复盘卡片失败（case=%s）", case_id(item) or "?")
            finally:
                if not dry_run and index < len(pending) - 1:
                    self.sleep(1)
        return summary


def _preview(review: Mapping[str, Any], version: Mapping[str, Any], kind: str = "summary") -> str:
    period = "月" if str(review.get("period_type", "daily")) == "monthly" else "日"
    name = safe_text(review.get("strategy_title") or review.get("strategy_name") or "未命名策略", 80)
    return f"{period}复盘｜{name}｜{kind}｜版本 v{safe_text(version.get('version_no') or 1, 20)}｜case={case_id(review) or '?'}"


def main(argv: Optional[list[str]] = None) -> int:
    parser = argparse.ArgumentParser(description="推送 AURUM 日/月复盘到 Lark")
    parser.add_argument("--dry-run", action="store_true", help="只预览，不发送或写入状态")
    parser.add_argument("--config", type=Path, help="dotenv 配置文件路径")
    args = parser.parse_args(argv)
    logging.basicConfig(level=logging.INFO, format="%(message)s")
    try:
        config = Config.from_sources(config_path=args.config, dry_run=args.dry_run)
    except ConfigError as exc:
        print(f"配置错误：{exc}", file=os.sys.stderr)
        return 2
    try:
        summary = PushRunner(config).run(dry_run=args.dry_run)
    except (ConfigError, StateError) as exc:
        print(f"运行错误：{exc}", file=os.sys.stderr)
        return 1
    if summary.read == 0 and summary.sent == 0 and summary.failed == 0:
        print("没有新的复盘结果需要推送。")
    else:
        action = "预览" if args.dry_run else "发送成功"
        print(f"读取复盘 {summary.read} 条，符合条件 {summary.candidates} 条，{action} {summary.sent} 条，跳过 {summary.skipped} 条，未知 {summary.unknown} 条，失败 {summary.failed} 条。")
    return 1 if summary.failed else 0


if __name__ == "__main__":
    raise SystemExit(main())
