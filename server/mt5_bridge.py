"""
MT5 Bridge Service - HTTP API for MetaTrader 5 operations
Runs on port 8766, provides REST API for the Node.js backend
"""

import json
import math
import os
import random
from datetime import datetime, timedelta, timezone
from http.server import HTTPServer, BaseHTTPRequestHandler
from urllib.parse import urlparse, parse_qs

try:
    import MetaTrader5 as mt5
except ImportError:
    mt5 = None

# Configuration
MT5_MODE = os.getenv("MT5_MODE", "mock").lower()
MT5_LOGIN = os.getenv("MT5_LOGIN")
MT5_PASSWORD = os.getenv("MT5_PASSWORD")
MT5_SERVER = os.getenv("MT5_SERVER")
MT5_TERMINAL_PATH = os.getenv("MT5_TERMINAL_PATH")
MT5_SERVER_UTC_OFFSET_HOURS = float(os.getenv("MT5_SERVER_UTC_OFFSET_HOURS", "3"))
ALLOW_LIVE_TRADING = os.getenv("ALLOW_LIVE_TRADING", "false").lower() in {"1", "true", "yes", "on"}

TIMEFRAME_MAP = {
    "M1": 1, "M5": 5, "M15": 15, "M30": 30,
    "H1": 60, "H4": 240, "D1": 1440,
}


def utc_now():
    return datetime.utcnow().isoformat(timespec="seconds")


def mt5_now():
    now = datetime.utcnow() + timedelta(hours=MT5_SERVER_UTC_OFFSET_HOURS)
    return now.isoformat(timespec="seconds")


def mt5_epoch_time(value):
    if not value:
        return None
    return datetime.fromtimestamp(int(value), timezone.utc).replace(tzinfo=None).isoformat(timespec="seconds")


def utc_to_mt5_time(value):
    if not value:
        return None
    try:
        text = str(value).replace("Z", "+00:00")
        parsed = datetime.fromisoformat(text)
        if parsed.tzinfo is not None:
            parsed = parsed.astimezone(timezone.utc).replace(tzinfo=None)
        shifted = parsed + timedelta(hours=MT5_SERVER_UTC_OFFSET_HOURS)
        return shifted.isoformat(timespec="seconds")
    except:
        return None


def should_use_live():
    return MT5_MODE == "live" and mt5 is not None


def connect_live():
    if mt5 is None:
        raise RuntimeError("MetaTrader5 package is not installed")
    kwargs = {}
    if MT5_TERMINAL_PATH:
        kwargs["path"] = MT5_TERMINAL_PATH
    if MT5_LOGIN and MT5_PASSWORD and MT5_SERVER:
        kwargs.update(login=int(MT5_LOGIN), password=MT5_PASSWORD, server=MT5_SERVER)
    if not mt5.initialize(**kwargs):
        raise RuntimeError(f"MT5 initialize failed: {mt5.last_error()}")


def resolve_live_symbol(symbol):
    requested = str(symbol or "").strip()
    if not requested:
        raise RuntimeError("Symbol is required")
    symbols = mt5.symbols_get()
    if symbols is None:
        raise RuntimeError(f"MT5 symbols_get failed: {mt5.last_error()}")
    for item in symbols:
        if item.name == requested:
            return item.name
    requested_upper = requested.upper()
    for item in symbols:
        if item.name.upper() == requested_upper:
            return item.name
    raise RuntimeError(f"Symbol not found in MT5: {requested}")


def get_status():
    data = {
        "mode": MT5_MODE,
        "live_trading_enabled": ALLOW_LIVE_TRADING,
        "mt5_package_available": mt5 is not None,
    }
    if should_use_live():
        try:
            connect_live()
            terminal = mt5.terminal_info()
            account = mt5.account_info()
            data.update({
                "terminal_trade_allowed": getattr(terminal, "trade_allowed", None) if terminal else None,
                "account_trade_allowed": getattr(account, "trade_allowed", None) if account else None,
                "account_trade_expert": getattr(account, "trade_expert", None) if account else None,
            })
        except Exception as exc:
            data["diagnostic_error"] = str(exc)
    return data


def get_account():
    if should_use_live():
        connect_live()
        info = mt5.account_info()
        if info is None:
            raise RuntimeError(f"MT5 account_info failed: {mt5.last_error()}")
        data = info._asdict()
        return {
            "status": "success",
            "balance": f"{data.get('balance', 0):.2f}",
            "equity": f"{data.get('equity', 0):.2f}",
            "margin": f"{data.get('margin', 0):.2f}",
            "margin_free": f"{data.get('margin_free', 0):.2f}",
            "margin_level": str(data.get("margin_level", 0)),
            "profit": f"{data.get('profit', 0):.2f}",
            "currency": data.get("currency", "USD"),
            "leverage": str(data.get("leverage", "")),
            "server": data.get("server", ""),
            "company": data.get("company", ""),
            "source": "mt5",
        }
    return {
        "status": "success",
        "balance": "10000.00", "equity": "10014.25", "margin": "0.00",
        "margin_free": "10014.25", "margin_level": "0", "profit": "14.25",
        "currency": "USD", "leverage": "500", "server": "MOCK-DEMO",
        "company": "Local Mock Gateway", "source": "mock",
    }


def get_symbols():
    if should_use_live():
        connect_live()
        symbols = mt5.symbols_get()
        if symbols is None:
            raise RuntimeError(f"MT5 symbols_get failed: {mt5.last_error()}")
        payload = []
        for s in symbols:
            d = s._asdict()
            payload.append({
                "name": d.get("name"), "description": d.get("description"),
                "currency_base": d.get("currency_base"), "currency_profit": d.get("currency_profit"),
                "currency_margin": d.get("currency_margin"), "digits": d.get("digits"),
                "trade_mode": d.get("trade_mode"), "trade_stops_level": d.get("trade_stops_level"),
                "point": d.get("point"),
            })
        return {"status": "success", "symbols": payload, "source": "mt5"}
    symbols = [
        ("XAUUSD", "Gold vs US Dollar", 2, 0.01),
        ("EURUSD", "Euro vs US Dollar", 5, 0.00001),
        ("GBPUSD", "Great Britain Pound vs US Dollar", 5, 0.00001),
        ("USDJPY", "US Dollar vs Japanese Yen", 3, 0.001),
        ("BTCUSD", "Bitcoin vs US Dollar", 2, 0.01),
    ]
    return {
        "status": "success",
        "symbols": [
            {"name": n, "description": d, "currency_base": n[:3], "currency_profit": n[3:],
             "currency_margin": "USD", "digits": dig, "trade_mode": 4, "trade_stops_level": 0, "point": p}
            for n, d, dig, p in symbols
        ],
        "source": "mock",
    }


def get_quote(symbol):
    if should_use_live():
        connect_live()
        symbol = resolve_live_symbol(symbol)
        mt5.symbol_select(symbol, True)
        tick = mt5.symbol_info_tick(symbol)
        info = mt5.symbol_info(symbol)
        if tick is None or info is None:
            raise RuntimeError(f"MT5 quote failed for {symbol}: {mt5.last_error()}")
        bid = float(tick.bid or getattr(info, "bid", 0.0) or 0.0)
        ask = float(tick.ask or getattr(info, "ask", 0.0) or 0.0)
        digits = int(info.digits)
        tick_time = int(tick.time or getattr(info, "time", 0) or 0)
        return {
            "status": "success", "symbol": symbol,
            "bid": f"{bid:.{digits}f}", "ask": f"{ask:.{digits}f}",
            "spread": f"{ask - bid:.{digits}f}", "time": mt5_epoch_time(tick_time),
            "volume": getattr(tick, "volume", 0), "source": "mt5",
        }
    symbol = symbol.upper()
    base = 4438.0 if symbol.startswith("XAUUSD") else 1.161 if symbol.endswith("USD") else 150.0
    wave = math.sin(datetime.utcnow().timestamp() / 60) * (3.5 if symbol == "XAUUSD" else 0.002)
    bid = base + wave
    spread = 0.37 if symbol == "XAUUSD" else 0.00009
    digits = 2 if symbol in {"XAUUSD", "BTCUSD"} else 5
    return {
        "status": "success", "symbol": symbol,
        "bid": f"{bid:.{digits}f}", "ask": f"{bid + spread:.{digits}f}",
        "spread": f"{spread:.{digits}f}", "time": mt5_now(),
        "volume": 0, "source": "mock",
    }


def get_positions(symbol=None):
    if should_use_live():
        connect_live()
        if symbol:
            symbol = resolve_live_symbol(symbol)
        positions = mt5.positions_get(symbol=symbol) if symbol else mt5.positions_get()
        if positions is None:
            raise RuntimeError(f"MT5 positions_get failed: {mt5.last_error()}")
        payload = []
        for p in positions:
            d = p._asdict()
            sym_info = mt5.symbol_info(d["symbol"])
            payload.append({
                "ticket": d["ticket"], "symbol": d["symbol"],
                "type": "buy" if d["type"] == mt5.POSITION_TYPE_BUY else "sell",
                "volume": d["volume"], "price_open": d["price_open"],
                "price_current": d["price_current"], "profit": d["profit"],
                "swap": d["swap"], "commission": d.get("commission", 0.0),
                "time": mt5_epoch_time(d["time"]), "sl": d["sl"], "tp": d["tp"],
                "digits": getattr(sym_info, "digits", 2) if sym_info else 2,
            })
        return {"status": "success", "positions": payload, "count": len(payload), "source": "mt5"}
    positions = []
    if symbol in (None, "", "XAUUSD"):
        positions.append({
            "ticket": 90000001, "symbol": "XAUUSD", "type": "buy", "volume": 0.01,
            "price_open": 4432.25, "price_current": float(get_quote("XAUUSD")["bid"]),
            "profit": 14.25, "swap": 0.0, "commission": 0.0, "time": mt5_now(),
            "sl": 4418.0, "tp": 4465.0, "digits": 2,
        })
    return {"status": "success", "positions": positions, "count": len(positions), "source": "mock"}


def get_rates(symbol, timeframe, count):
    timeframe = timeframe.upper()
    if should_use_live():
        connect_live()
        symbol = resolve_live_symbol(symbol)
        mt5.symbol_select(symbol, True)
        tf_const = {
            "M1": mt5.TIMEFRAME_M1, "M5": mt5.TIMEFRAME_M5, "M15": mt5.TIMEFRAME_M15,
            "M30": mt5.TIMEFRAME_M30, "H1": mt5.TIMEFRAME_H1, "H4": mt5.TIMEFRAME_H4,
            "D1": mt5.TIMEFRAME_D1,
        }.get(timeframe, mt5.TIMEFRAME_M30)
        rates = mt5.copy_rates_from_pos(symbol, tf_const, 0, count)
        if rates is None:
            raise RuntimeError(f"MT5 copy_rates failed: {mt5.last_error()}")
        return [
            {"time": mt5_epoch_time(int(r["time"])), "open": float(r["open"]),
             "high": float(r["high"]), "low": float(r["low"]),
             "close": float(r["close"]), "tick_volume": int(r["tick_volume"])}
            for r in rates
        ]
    # Mock data
    minutes = TIMEFRAME_MAP.get(timeframe, 30)
    now = datetime.utcnow().replace(second=0, microsecond=0)
    seed = sum(ord(c) for c in symbol + timeframe)
    rnd = random.Random(seed)
    base = 4438.0 if symbol.upper().startswith("XAUUSD") else 1.16
    rows = []
    price = base - count * 0.05
    for i in range(count):
        drift = math.sin((i + seed) / 7) * 1.4 + (i / count) * 6.0
        noise = rnd.uniform(-0.8, 0.8)
        close = price + drift + noise
        open_price = close + rnd.uniform(-0.9, 0.9)
        high = max(open_price, close) + rnd.uniform(0.2, 1.8)
        low = min(open_price, close) - rnd.uniform(0.2, 1.8)
        rows.append({
            "time": (now - timedelta(minutes=minutes * (count - i))).isoformat(timespec="seconds"),
            "open": round(open_price, 2), "high": round(high, 2),
            "low": round(low, 2), "close": round(close, 2),
            "tick_volume": rnd.randint(100, 1200),
        })
    return rows


def get_history(page=1, page_size=20):
    deposit = withdrawal = credit = 0.0
    if should_use_live():
        connect_live()
        end = datetime.utcnow() + timedelta(days=1)
        start = end - timedelta(days=31)
        deals = mt5.history_deals_get(start, end)
        if deals is None:
            raise RuntimeError(f"MT5 history_deals_get failed: {mt5.last_error()}")
        rows = []
        deal_rows = [deal._asdict() for deal in deals]
        deals_by_position = {}
        symbol_info_cache = {}
        balance_type = getattr(mt5, "DEAL_TYPE_BALANCE", None)
        credit_type = getattr(mt5, "DEAL_TYPE_CREDIT", None)
        for d in deal_rows:
            if balance_type is not None and d.get("type") == balance_type:
                amount = float(d.get("profit") or 0)
                if amount >= 0: deposit += amount
                else: withdrawal += abs(amount)
            if credit_type is not None and d.get("type") == credit_type:
                credit += float(d.get("profit") or 0)
            key = d.get("position_id") or d.get("order") or d.get("ticket")
            deals_by_position.setdefault(key, []).append(d)

        for d in deal_rows:
            if d.get("entry") not in {mt5.DEAL_ENTRY_OUT, mt5.DEAL_ENTRY_INOUT}:
                continue
            position_id = d.get("position_id") or d.get("order") or d.get("ticket")
            group = deals_by_position.get(position_id, [])
            entry_deal = next((item for item in group if item.get("entry") == mt5.DEAL_ENTRY_IN), None)
            side_deal = entry_deal or d
            direction = "BUY" if side_deal.get("type") == mt5.DEAL_TYPE_BUY else "SELL"
            symbol = d.get("symbol") or (entry_deal or {}).get("symbol")
            entry_price = (entry_deal or {}).get("price")
            exit_price = d.get("price")
            rows.append({
                "ticket": (entry_deal or {}).get("order") or position_id,
                "deal_ticket": d.get("ticket"), "position_id": position_id,
                "symbol": symbol, "type": direction, "volume": d.get("volume"),
                "entry_price": entry_price, "exit_price": exit_price, "price": exit_price,
                "profit": d.get("profit"), "swap": d.get("swap"), "commission": d.get("commission"),
                "entry_time": mt5_epoch_time((entry_deal or {}).get("time")),
                "close_time": mt5_epoch_time(d.get("time")),
                "comment": d.get("comment"),
            })
    else:
        rows = [
            {"ticket": 80000000 + i, "position_id": 60000000 + i, "symbol": "XAUUSD",
             "type": "BUY" if i % 2 else "SELL", "volume": 0.01 + (i % 3) * 0.01,
             "entry_price": 4430 + i * 1.7, "exit_price": 4432 + i * 1.4,
             "profit": round(((-1) ** i) * (4.8 + i), 2),
             "entry_time": (datetime.utcnow() - timedelta(hours=i * 5 + 1)).isoformat(timespec="seconds"),
             "close_time": (datetime.utcnow() - timedelta(hours=i * 5)).isoformat(timespec="seconds"),
             "comment": "mock close"}
            for i in range(1, 18)
        ]

    total = len(rows)
    start_idx = max(page - 1, 0) * page_size
    page_rows = rows[start_idx:start_idx + page_size]
    total_profit = sum(float(r.get("profit") or 0) for r in rows)
    net_result = total_profit + credit + deposit - withdrawal
    account_balance = float(get_account().get("balance") or 10000.0)
    account_principal = round(account_balance - net_result, 2)

    return {
        "status": "success", "orders": page_rows,
        "statistics": {
            "account_principal": account_principal, "account_balance": round(account_balance, 2),
            "total_profit": round(total_profit, 2), "credit": round(credit, 2),
            "deposit": round(deposit, 2), "withdrawal": round(withdrawal, 2),
            "net_result": round(net_result, 2), "trade_count": total,
        },
        "pagination": {
            "current_page": page, "page_size": page_size,
            "total_count": total, "total_pages": max(math.ceil(total / page_size), 1),
        },
        "source": "mt5" if should_use_live() else "mock",
    }


def live_trade_blocker():
    """Check MT5 terminal/account permissions before live trading."""
    terminal = mt5.terminal_info() if mt5 else None
    account = mt5.account_info() if mt5 else None
    diag = {
        "terminal_trade_allowed": getattr(terminal, "trade_allowed", None) if terminal else None,
        "account_trade_allowed": getattr(account, "trade_allowed", None) if account else None,
        "account_trade_expert": getattr(account, "trade_expert", None) if account else None,
    }
    if diag["terminal_trade_allowed"] is False:
        return {"status": "error", "dry_run": False, "message": "MT5 终端自动交易已关闭，请在 MT5 顶部打开 Algo Trading / 自动交易后重试。", "retcode": 10027, "reason": "mt5_terminal_autotrading_disabled", "diagnostic": diag}
    if diag["account_trade_allowed"] is False:
        return {"status": "error", "dry_run": False, "message": "当前 MT5 账户不允许交易，请检查账号权限或服务器状态。", "reason": "mt5_account_trade_disabled", "diagnostic": diag}
    if diag["account_trade_expert"] is False:
        return {"status": "error", "dry_run": False, "message": "当前 MT5 账户禁止 EA/脚本交易，请在账户或服务器权限中开启。", "reason": "mt5_account_expert_trading_disabled", "diagnostic": diag}
    return None

def open_position(request):
    if not should_use_live() or not ALLOW_LIVE_TRADING:
        return {
            "status": "success", "dry_run": True,
            "message": "Mock order accepted.",
            "request": request, "ticket": random.randint(91000000, 91999999),
        }
    connect_live()
    blocker = live_trade_blocker()
    if blocker:
        blocker["request"] = request
        return blocker
    symbol = resolve_live_symbol(request["symbol"])
    order_type = request["order_type"].lower()
    mt5.symbol_select(symbol, True)
    info = mt5.symbol_info(symbol)
    tick = mt5.symbol_info_tick(symbol)
    if info is None or tick is None:
        raise RuntimeError(f"Symbol not available: {symbol}")
    ask = float(tick.ask or getattr(info, "ask", 0.0) or 0.0)
    bid = float(tick.bid or getattr(info, "bid", 0.0) or 0.0)
    price = ask if order_type == "buy" else bid
    if price <= 0:
        raise RuntimeError(f"Invalid live quote for {symbol}")
    sl = request.get("sl")
    tp = request.get("tp")
    payload = {
        "action": mt5.TRADE_ACTION_DEAL, "symbol": symbol,
        "volume": float(request["volume"]),
        "type": mt5.ORDER_TYPE_BUY if order_type == "buy" else mt5.ORDER_TYPE_SELL,
        "price": price, "sl": float(sl or 0), "tp": float(tp or 0),
        "deviation": 20, "magic": 260605, "comment": "local_ai_mt5",
        "type_time": mt5.ORDER_TIME_GTC,
    }
    filling_mode = int(getattr(info, "filling_mode", 0) or 0)
    candidates = []
    if filling_mode & 1: candidates.append(mt5.ORDER_FILLING_FOK)
    if filling_mode & 2: candidates.append(mt5.ORDER_FILLING_IOC)
    for fallback in (mt5.ORDER_FILLING_RETURN, mt5.ORDER_FILLING_FOK, mt5.ORDER_FILLING_IOC):
        if fallback not in candidates: candidates.append(fallback)

    data = None
    for filling in candidates:
        attempt_payload = dict(payload)
        attempt_payload["type_filling"] = filling
        result = mt5.order_send(attempt_payload)
        if result is None:
            raise RuntimeError(f"MT5 order_send returned None: {mt5.last_error()}")
        data = result._asdict()
        if data.get("retcode") != 10030:
            break

    if data is None:
        raise RuntimeError("No MT5 filling mode candidates were available")
    ok = data.get("retcode") == mt5.TRADE_RETCODE_DONE
    return {
        "status": "success" if ok else "error", "dry_run": False,
        "message": data.get("comment") or ("MT5 order accepted" if ok else f"MT5 order rejected retcode={data.get('retcode')}"),
        "retcode": data.get("retcode"), "mt5_result": data,
    }


def close_position(ticket):
    if not should_use_live() or not ALLOW_LIVE_TRADING:
        return {"status": "success", "dry_run": True, "message": "Mock close accepted.", "ticket": ticket}
    connect_live()
    blocker = live_trade_blocker()
    if blocker:
        blocker["ticket"] = ticket
        return blocker
    positions = mt5.positions_get(ticket=ticket)
    if not positions:
        raise RuntimeError(f"Position ticket not found: {ticket}")
    pos = positions[0]
    d = pos._asdict()
    info = mt5.symbol_info(d["symbol"])
    tick = mt5.symbol_info_tick(d["symbol"])
    if info is None or tick is None:
        raise RuntimeError(f"Quote unavailable for {d['symbol']}")
    close_type = mt5.ORDER_TYPE_SELL if d["type"] == mt5.POSITION_TYPE_BUY else mt5.ORDER_TYPE_BUY
    price = float(tick.bid if close_type == mt5.ORDER_TYPE_SELL else tick.ask)
    payload = {
        "action": mt5.TRADE_ACTION_DEAL, "position": ticket, "symbol": d["symbol"],
        "volume": d["volume"], "type": close_type, "price": price,
        "deviation": 20, "magic": 260605, "comment": "local_ai_mt5_close",
        "type_time": mt5.ORDER_TIME_GTC,
    }
    filling_mode = int(getattr(info, "filling_mode", 0) or 0)
    candidates = []
    if filling_mode & 1: candidates.append(mt5.ORDER_FILLING_FOK)
    if filling_mode & 2: candidates.append(mt5.ORDER_FILLING_IOC)
    for fallback in (mt5.ORDER_FILLING_RETURN, mt5.ORDER_FILLING_FOK, mt5.ORDER_FILLING_IOC):
        if fallback not in candidates: candidates.append(fallback)

    data = None
    for filling in candidates:
        attempt_payload = dict(payload)
        attempt_payload["type_filling"] = filling
        result = mt5.order_send(attempt_payload)
        if result is None:
            raise RuntimeError(f"MT5 order_send returned None: {mt5.last_error()}")
        data = result._asdict()
        if data.get("retcode") != 10030:
            break

    if data is None:
        raise RuntimeError("No MT5 filling mode candidates were available")
    ok = data.get("retcode") == mt5.TRADE_RETCODE_DONE
    return {
        "status": "success" if ok else "error", "dry_run": False,
        "message": data.get("comment") or ("MT5 close accepted" if ok else f"MT5 close rejected retcode={data.get('retcode')}"),
        "retcode": data.get("retcode"), "mt5_result": data,
    }


class MT5Handler(BaseHTTPRequestHandler):
    def log_message(self, format, *args):
        pass  # Suppress default logging

    def send_json(self, data, status=200):
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Access-Control-Allow-Origin", "*")
        self.end_headers()
        self.wfile.write(json.dumps(data).encode())

    def do_OPTIONS(self):
        self.send_response(200)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.end_headers()

    def do_GET(self):
        parsed = urlparse(self.path)
        path = parsed.path
        params = parse_qs(parsed.query)

        try:
            if path == "/status":
                self.send_json(get_status())
            elif path == "/account":
                self.send_json(get_account())
            elif path == "/symbols":
                self.send_json(get_symbols())
            elif path.startswith("/quote/"):
                symbol = path.split("/quote/")[1]
                self.send_json(get_quote(symbol))
            elif path == "/positions":
                symbol = params.get("symbol", [None])[0]
                self.send_json(get_positions(symbol))
            elif path == "/rates":
                symbol = params.get("symbol", [None])[0]
                timeframe = params.get("timeframe", ["M30"])[0]
                count = int(params.get("count", [100])[0])
                if not symbol:
                    self.send_json({"status": "error", "message": "symbol required"}, 400)
                else:
                    self.send_json(get_rates(symbol, timeframe, count))
            elif path == "/history":
                page = int(params.get("page", [1])[0])
                page_size = int(params.get("page_size", [20])[0])
                self.send_json(get_history(page, page_size))
            elif path == "/diagnostics":
                self.send_json(get_status())
            else:
                self.send_json({"status": "error", "message": "Not found"}, 404)
        except Exception as e:
            self.send_json({"status": "error", "message": str(e)}, 500)

    def do_POST(self):
        parsed = urlparse(self.path)
        path = parsed.path
        content_length = int(self.headers.get("Content-Length", 0))
        body = json.loads(self.rfile.read(content_length)) if content_length > 0 else {}

        try:
            if path == "/open":
                self.send_json(open_position(body))
            elif path == "/close":
                ticket = body.get("ticket")
                if not ticket:
                    self.send_json({"status": "error", "message": "ticket required"}, 400)
                else:
                    self.send_json(close_position(ticket))
            elif path == "/connect":
                global MT5_MODE, ALLOW_LIVE_TRADING
                MT5_MODE = "live"
                ALLOW_LIVE_TRADING = True
                try:
                    connect_live()
                    terminal = mt5.terminal_info()
                    account = mt5.account_info()
                    self.send_json({
                        "status": "success",
                        "message": "MT5 connected",
                        "mode": "live",
                        "terminal_trade_allowed": terminal.trade_allowed if terminal else None,
                        "account_trade_allowed": account.trade_allowed if account else None,
                        "account_trade_expert": account.trade_expert if account else None,
                    })
                except Exception as exc:
                    MT5_MODE = "mock"
                    self.send_json({"status": "error", "message": str(exc)}, 500)
            elif path == "/disconnect":
                MT5_MODE = "mock"
                ALLOW_LIVE_TRADING = False
                try:
                    if mt5:
                        mt5.shutdown()
                except:
                    pass
                self.send_json({"status": "success", "message": "MT5 disconnected", "mode": "mock"})
            else:
                self.send_json({"status": "error", "message": "Not found"}, 404)
        except Exception as e:
            self.send_json({"status": "error", "message": str(e)}, 500)


def main():
    port = int(os.getenv("MT5_BRIDGE_PORT", "8766"))
    server = HTTPServer(("127.0.0.1", port), MT5Handler)
    print(f"MT5 Bridge running on http://127.0.0.1:{port}")
    print(f"Mode: {MT5_MODE}, Live trading: {ALLOW_LIVE_TRADING}")
    server.serve_forever()


if __name__ == "__main__":
    main()
