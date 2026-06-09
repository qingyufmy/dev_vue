#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""AURUM Bridge - macOS Terminal Version"""
import sys
import os
import json
import time
import signal
import threading

# Check dependencies
try:
    import websocket  # websocket-client
except ImportError:
    print("[..] Installing websocket-client...")
    import subprocess
    subprocess.check_call([sys.executable, "-m", "pip", "install", "websocket-client", "-q"])
    import websocket

try:
    import requests
except ImportError:
    import subprocess
    subprocess.check_call([sys.executable, "-m", "pip", "install", "requests", "-q"])
    import requests

# Try MT5 (macOS usually doesn't support it natively)
HAS_MT5 = False
mt5 = None
try:
    import MetaTrader5 as _mt5
    if _mt5.initialize():
        mt5 = _mt5
        HAS_MT5 = True
        mt5.shutdown()
except:
    pass

# ===== Config =====
SERVER_URL = "http://127.0.0.1:3000"
TOKEN = ""

# 1. Try loading from config.json
for config_dir in [os.path.dirname(os.path.abspath(__file__)), os.getcwd()]:
    config_path = os.path.join(config_dir, "config.json")
    if os.path.exists(config_path):
        try:
            with open(config_path, "r") as cf:
                cfg = json.loads(cf.read())
                SERVER_URL = cfg.get("server_url", SERVER_URL)
                TOKEN = cfg.get("token", TOKEN)
            break
        except:
            pass

# 2. Command line args
i = 1
while i < len(sys.argv):
    if sys.argv[i] == '--server' and i + 1 < len(sys.argv):
        SERVER_URL = sys.argv[i + 1]; i += 2
    elif sys.argv[i] == '--token' and i + 1 < len(sys.argv):
        TOKEN = sys.argv[i + 1]; i += 2
    else:
        i += 1

# ===== Colors =====
class C:
    RESET = "\033[0m"
    BOLD = "\033[1m"
    DIM = "\033[2m"
    RED = "\033[31m"
    GREEN = "\033[32m"
    YELLOW = "\033[33m"
    BLUE = "\033[34m"
    CYAN = "\033[36m"
    WHITE = "\033[37m"
    BG_DARK = "\033[48;5;235m"

def clear():
    os.system("clear" if os.name != "nt" else "cls")

def print_banner():
    print(f"""
{C.CYAN}{C.BOLD}  ╔══════════════════════════════════════╗
  ║     ⚡ AURUM MT5 Bridge (macOS)     ║
  ╚══════════════════════════════════════╝{C.RESET}
""")

def log(msg, level="info"):
    ts = time.strftime("%H:%M:%S")
    prefix = {
        "info":    f"{C.DIM}[{ts}]{C.RESET}",
        "ok":      f"{C.GREEN}[{ts}] ✓{C.RESET}",
        "warn":    f"{C.YELLOW}[{ts}] ⚠{C.RESET}",
        "error":   f"{C.RED}[{ts}] ✗{C.RESET}",
        "cmd":     f"{C.CYAN}[{ts}] ▶{C.RESET}",
    }.get(level, f"[{ts}]")
    print(f"  {prefix} {msg}")

def print_status(connected, account_info=None):
    if connected and account_info:
        print(f"\r  {C.GREEN}● 已连接{C.RESET}  {account_info['login']} @ {account_info['server']}  "
              f"余额: ${account_info['balance']:,.2f}  权益: ${account_info['equity']:,.2f}", end="", flush=True)
    elif connected:
        print(f"\r  {C.YELLOW}● 连接中...{C.RESET}", end="", flush=True)
    else:
        print(f"\r  {C.RED}● 未连接{C.RESET}", end="", flush=True)


# ===== MT5 Handler =====
class MT5Handler:
    def __init__(self):
        self.mt5 = mt5
        self.connected = False
        self._trade_enabled = False

    def connect(self):
        if not self.mt5:
            return False
        if self.mt5.initialize():
            self.connected = True
            return True
        return False

    def disconnect(self):
        if self.mt5 and self.connected:
            self.mt5.shutdown()
            self.connected = False

    def _resolve_symbol(self, symbol):
        requested = str(symbol or "").strip()
        if not requested:
            raise RuntimeError("Symbol is required")
        symbols = self.mt5.symbols_get()
        if symbols is None:
            raise RuntimeError("MT5 symbols_get failed")
        for item in symbols:
            if item.name == requested:
                return item.name
        requested_upper = requested.upper()
        for item in symbols:
            if item.name.upper() == requested_upper:
                return item.name
        fallbacks = [requested + ".s", requested + "m", requested + ".c", requested + "_", requested + ".micro"]
        for fb in fallbacks:
            for item in symbols:
                if item.name.upper() == fb.upper():
                    return item.name
        for item in symbols:
            if item.name.upper().startswith(requested_upper + ".") or item.name.upper().startswith(requested_upper + "_"):
                return item.name
        raise RuntimeError(f"Symbol not found: {requested}")

    def _get_filling_mode(self, symbol):
        info = self.mt5.symbol_info(symbol)
        if not info:
            return self.mt5.ORDER_FILLING_IOC
        filling_mode = int(getattr(info, "filling_mode", 0) or 0)
        candidates = []
        if filling_mode & 1:
            candidates.append(self.mt5.ORDER_FILLING_FOK)
        if filling_mode & 2:
            candidates.append(self.mt5.ORDER_FILLING_IOC)
        if not candidates:
            candidates = [self.mt5.ORDER_FILLING_RETURN, self.mt5.ORDER_FILLING_FOK, self.mt5.ORDER_FILLING_IOC]
        if self.mt5.ORDER_FILLING_FOK in candidates:
            return self.mt5.ORDER_FILLING_FOK
        return candidates[0]

    def process(self, cmd):
        action = cmd.get("action")
        params = cmd.get("params", {})
        try:
            if action == "open":
                symbol = self._resolve_symbol(params.get("symbol"))
                self.mt5.symbol_select(symbol, True)
                info = self.mt5.symbol_info(symbol)
                tick = self.mt5.symbol_info_tick(symbol)
                if not info:
                    return {"status": "error", "message": f"Symbol not available: {symbol}"}
                if not tick:
                    return {"status": "error", "message": f"No quote for {symbol}"}
                order_type = self.mt5.ORDER_TYPE_BUY if (params.get("type") or params.get("order_type") or "buy").lower() == "buy" else self.mt5.ORDER_TYPE_SELL
                req = {
                    "action": self.mt5.TRADE_ACTION_DEAL, "symbol": symbol,
                    "volume": float(params.get("lot") or params.get("volume") or 0.01),
                    "type": order_type, "magic": 234000,
                    "comment": params.get("comment", "AURUM"),
                    "type_time": self.mt5.ORDER_TIME_GTC,
                    "type_filling": self._get_filling_mode(symbol),
                }
                if params.get("sl"): req["sl"] = float(params["sl"])
                if params.get("tp"): req["tp"] = float(params["tp"])
                result = self.mt5.order_send(req)
                if result and result.retcode == self.mt5.TRADE_RETCODE_DONE:
                    return {"status": "success", "order": result.order, "price": result.price}
                return {"status": "error", "message": result.comment if result else "order_send failed"}

            elif action == "close":
                ticket = params.get("ticket")
                if ticket:
                    positions = self.mt5.positions_get(ticket=ticket)
                    if not positions:
                        return {"status": "error", "message": f"Position {ticket} not found"}
                    pos = positions[0]
                    close_type = self.mt5.ORDER_TYPE_SELL if pos.type == self.mt5.ORDER_TYPE_BUY else self.mt5.ORDER_TYPE_BUY
                    result = self.mt5.order_send({
                        "action": self.mt5.TRADE_ACTION_DEAL,
                        "position": pos.ticket, "symbol": pos.symbol,
                        "volume": pos.volume, "type": close_type,
                        "magic": 234000, "type_filling": self._get_filling_mode(pos.symbol),
                    })
                    if result and result.retcode == self.mt5.TRADE_RETCODE_DONE:
                        return {"status": "success", "ticket": pos.ticket}
                    return {"status": "error", "message": result.comment if result else "close failed"}
                else:
                    symbol = self._resolve_symbol(params.get("symbol")) if params.get("symbol") else None
                    positions = self.mt5.positions_get(symbol=symbol) if symbol else self.mt5.positions_get()
                    if not positions:
                        return {"status": "success", "message": "No positions"}
                    for pos in positions:
                        close_type = self.mt5.ORDER_TYPE_SELL if pos.type == self.mt5.ORDER_TYPE_BUY else self.mt5.ORDER_TYPE_BUY
                        self.mt5.order_send({
                            "action": self.mt5.TRADE_ACTION_DEAL,
                            "symbol": pos.symbol, "volume": pos.volume,
                            "type": close_type, "position": pos.ticket,
                            "magic": 234000, "type_filling": self._get_filling_mode(pos.symbol),
                        })
                    return {"status": "success", "closed": len(positions)}

            elif action == "close_all":
                positions = self.mt5.positions_get()
                if not positions:
                    return {"status": "success", "closed": 0}
                for pos in positions:
                    close_type = self.mt5.ORDER_TYPE_SELL if pos.type == self.mt5.ORDER_TYPE_BUY else self.mt5.ORDER_TYPE_BUY
                    self.mt5.order_send({
                        "action": self.mt5.TRADE_ACTION_DEAL,
                        "symbol": pos.symbol, "volume": pos.volume,
                        "type": close_type, "position": pos.ticket,
                        "magic": 234000, "type_filling": self._get_filling_mode(pos.symbol),
                    })
                return {"status": "success", "closed": len(positions)}

            elif action == "rates":
                symbol = self._resolve_symbol(params.get("symbol"))
                self.mt5.symbol_select(symbol, True)
                tf_map = {
                    "M1": self.mt5.TIMEFRAME_M1, "M5": self.mt5.TIMEFRAME_M5,
                    "M15": self.mt5.TIMEFRAME_M15, "M30": self.mt5.TIMEFRAME_M30,
                    "H1": self.mt5.TIMEFRAME_H1, "H4": self.mt5.TIMEFRAME_H4,
                    "D1": self.mt5.TIMEFRAME_D1,
                }
                tf = tf_map.get(params.get("timeframe", "M30"), self.mt5.TIMEFRAME_M30)
                count = int(params.get("count", 100))
                rates = self.mt5.copy_rates_from_pos(symbol, tf, 0, count)
                if rates is not None and len(rates) > 0:
                    out = []
                    for r in rates:
                        from datetime import datetime, timezone, timedelta
                        t = datetime.utcfromtimestamp(int(r[0])).strftime('%Y-%m-%d %H:%M:%S')
                        out.append({"time": t, "open": float(r[1]), "high": float(r[2]),
                                    "low": float(r[3]), "close": float(r[4]),
                                    "tick_volume": int(r[5]),
                                    "spread": int(r[6]) if len(r) > 6 else 0})
                    return {"status": "success", "symbol": symbol,
                            "timeframe": params.get("timeframe", "M30"),
                            "count": len(out), "rates": out, "source": "mt5"}
                return {"status": "success", "symbol": symbol, "rates": [], "source": "mt5"}

            elif action == "quote":
                symbol = self._resolve_symbol(params.get("symbol"))
                self.mt5.symbol_select(symbol, True)
                tick = self.mt5.symbol_info_tick(symbol)
                info = self.mt5.symbol_info(symbol)
                if not tick:
                    return {"status": "error", "message": f"No quote for {symbol}"}
                from datetime import datetime, timezone, timedelta
                time_str = datetime.utcfromtimestamp(int(tick.time)).strftime('%Y-%m-%d %H:%M:%S')
                return {
                    "status": "success", "symbol": symbol,
                    "bid": tick.bid, "ask": tick.ask,
                    "spread": round(info.spread * info.point, info.digits) if info else 0,
                    "time": time_str,
                    "digits": info.digits if info else 2,
                    "point": info.point if info else 0.01,
                    "source": "mt5",
                }

            elif action == "positions":
                symbol = params.get("symbol")
                if symbol:
                    symbol = self._resolve_symbol(symbol)
                    positions = self.mt5.positions_get(symbol=symbol)
                else:
                    positions = self.mt5.positions_get()
                if positions:
                    payload = []
                    for p in positions:
                        d = p._asdict()
                        from datetime import datetime
                        time_str = datetime.utcfromtimestamp(d.get("time", 0)).strftime('%Y-%m-%d %H:%M:%S') if d.get("time") else ""
                        payload.append({
                            "ticket": d["ticket"], "symbol": d["symbol"],
                            "type": "buy" if d["type"] == 0 else "sell",
                            "volume": d["volume"], "open_price": d["price_open"],
                            "price_open": d["price_open"], "price_current": d["price_current"],
                            "profit": d["profit"], "sl": d["sl"], "tp": d["tp"],
                            "swap": d["swap"], "magic": d["magic"], "comment": d["comment"],
                            "time": time_str, "source": "mt5",
                        })
                    return {"status": "success", "positions": payload, "count": len(payload), "source": "mt5"}
                return {"status": "success", "positions": [], "count": 0, "source": "mt5"}

            elif action == "account":
                acc = self.mt5.account_info()
                terminal = self.mt5.terminal_info()
                if acc:
                    return {
                        "status": "success",
                        "balance": acc.balance, "equity": acc.equity,
                        "margin": acc.margin, "margin_free": acc.margin_free,
                        "margin_level": getattr(acc, "margin_level", 0),
                        "profit": acc.profit, "currency": acc.currency,
                        "leverage": acc.leverage, "server": acc.server,
                        "company": getattr(acc, "company", ""),
                        "login": acc.login,
                        "trade_allowed": acc.trade_allowed,
                        "trade_expert": acc.trade_expert,
                        "terminal_build": terminal.build if terminal else 0,
                        "terminal_connected": terminal.connected if terminal else False,
                        "source": "mt5",
                    }
                return {"status": "error", "message": "no account info"}

            elif action == "status":
                acc = self.mt5.account_info()
                terminal = self.mt5.terminal_info()
                if acc:
                    return {
                        "mode": "live", "mt5_package_available": True,
                        "live_trading_enabled": self._trade_enabled,
                        "terminal_trade_allowed": terminal.trade_allowed if terminal else False,
                        "account_trade_allowed": acc.trade_allowed,
                        "account_trade_expert": acc.trade_expert,
                        "login": acc.login, "server": acc.server,
                        "balance": acc.balance, "equity": acc.equity,
                    }
                return {"mode": "mock", "mt5_package_available": True, "live_trading_enabled": False}

            elif action == "toggle_trade":
                enable = params.get("enable", False)
                self._trade_enabled = enable
                return {"status": "success", "live_trading_enabled": enable}

            elif action == "symbols":
                symbols = self.mt5.symbols_get()
                if symbols is None:
                    return {"status": "error", "message": "MT5 symbols_get failed"}
                payload = []
                for s in symbols:
                    d = s._asdict()
                    payload.append({
                        "name": d.get("name"), "description": d.get("description"),
                        "currency_base": d.get("currency_base"),
                        "currency_profit": d.get("currency_profit"),
                        "digits": d.get("digits"), "point": d.get("point"),
                    })
                return {"status": "success", "symbols": payload, "source": "mt5"}

            elif action == "history":
                import math
                from datetime import datetime, timedelta
                page = params.get("page", 1)
                page_size = params.get("page_size", 20)
                deposit = withdrawal = credit = 0.0
                date_to = datetime.utcnow() + timedelta(days=1)
                date_from = date_to - timedelta(days=31)
                deals = self.mt5.history_deals_get(date_from, date_to)
                if deals is None:
                    return {"status": "error", "message": f"history_deals_get failed: {self.mt5.last_error()}"}
                deal_rows = [d._asdict() for d in deals]
                deals_by_position = {}
                symbol_info_cache = {}
                balance_type = getattr(self.mt5, "DEAL_TYPE_BALANCE", 2)
                credit_type = getattr(self.mt5, "DEAL_TYPE_CREDIT", 3)
                for d in deal_rows:
                    if d.get("type") == balance_type:
                        amount = float(d.get("profit") or 0)
                        if amount >= 0: deposit += amount
                        else: withdrawal += abs(amount)
                    if d.get("type") == credit_type:
                        credit += float(d.get("profit") or 0)
                    key = d.get("position_id") or d.get("order") or d.get("ticket")
                    deals_by_position.setdefault(key, []).append(d)

                def symbol_point(symbol):
                    if not symbol: return None
                    if symbol not in symbol_info_cache:
                        symbol_info_cache[symbol] = self.mt5.symbol_info(symbol)
                    info = symbol_info_cache.get(symbol)
                    point = getattr(info, "point", None) if info else None
                    return float(point) if point else None

                rows = []
                entry_out = getattr(self.mt5, "DEAL_ENTRY_OUT", 1)
                entry_inout = getattr(self.mt5, "DEAL_ENTRY_INOUT", 2)
                entry_in = getattr(self.mt5, "DEAL_ENTRY_IN", 0)
                deal_type_buy = getattr(self.mt5, "DEAL_TYPE_BUY", 0)
                for d in deal_rows:
                    if d.get("entry") not in (entry_out, entry_inout):
                        continue
                    position_id = d.get("position_id") or d.get("order") or d.get("ticket")
                    group = deals_by_position.get(position_id, [])
                    entry_deal = next((item for item in group if item.get("entry") == entry_in), None)
                    side_deal = entry_deal or d
                    direction = "BUY" if side_deal.get("type") == deal_type_buy else "SELL"
                    symbol = d.get("symbol") or (entry_deal or {}).get("symbol")
                    entry_price = (entry_deal or {}).get("price")
                    exit_price = d.get("price")
                    point = symbol_point(symbol)
                    profit_points = None
                    if entry_price and exit_price and point:
                        if direction == "BUY":
                            profit_points = round((float(exit_price) - float(entry_price)) / point, 1)
                        else:
                            profit_points = round((float(entry_price) - float(exit_price)) / point, 1)
                    rows.append({
                        "ticket": (entry_deal or {}).get("order") or position_id,
                        "deal_ticket": d.get("ticket"),
                        "position_id": position_id,
                        "symbol": symbol, "type": direction,
                        "volume": d.get("volume"),
                        "entry_price": entry_price, "exit_price": exit_price,
                        "profit": d.get("profit"), "swap": d.get("swap"),
                        "commission": d.get("commission"),
                        "profit_points": profit_points,
                        "entry_time": datetime.utcfromtimestamp(int((entry_deal or {}).get("time") or 0)).strftime('%Y-%m-%d %H:%M:%S') if (entry_deal or {}).get("time") else None,
                        "close_time": datetime.utcfromtimestamp(int(d.get("time") or 0)).strftime('%Y-%m-%d %H:%M:%S') if d.get("time") else None,
                        "comment": d.get("comment"),
                    })
                rows.sort(key=lambda r: r.get("close_time") or r.get("entry_time") or "", reverse=True)
                total = len(rows)
                start_idx = max(page - 1, 0) * page_size
                page_rows = rows[start_idx : start_idx + page_size]
                total_profit = sum(float(r.get("profit") or 0) for r in rows)
                net_result = total_profit + credit + deposit - withdrawal
                account_balance = 10000.0
                try:
                    acc = self.mt5.account_info()
                    if acc: account_balance = float(acc.balance)
                except: pass
                return {
                    "status": "success", "orders": page_rows,
                    "statistics": {
                        "account_principal": round(account_balance - net_result, 2),
                        "account_balance": round(account_balance, 2),
                        "total_profit": round(total_profit, 2),
                        "credit": round(credit, 2), "deposit": round(deposit, 2),
                        "withdrawal": round(withdrawal, 2), "net_result": round(net_result, 2),
                        "trade_count": total,
                        "total_volume": round(sum(float(r.get("volume") or 0) for r in rows), 2),
                    },
                    "pagination": {"current_page": page, "page_size": page_size,
                                   "total_count": total,
                                   "total_pages": max(math.ceil(total / page_size), 1)},
                    "source": "mt5",
                }

            elif action == "diagnostics":
                acc = self.mt5.account_info()
                terminal = self.mt5.terminal_info()
                return {
                    "status": "success", "mt5_connected": True,
                    "account": {"login": acc.login, "server": acc.server, "balance": acc.balance} if acc else None,
                    "terminal": {"build": terminal.build, "connected": terminal.connected,
                                 "trade_allowed": terminal.trade_allowed} if terminal else None,
                }

            else:
                return {"status": "error", "message": f"unknown action: {action}"}
        except Exception as e:
            return {"status": "error", "message": str(e)}


# ===== Bridge Main Loop =====
class AurumBridge:
    def __init__(self):
        self.running = True
        self.mt5_handler = MT5Handler() if HAS_MT5 else None
        self.ws = None
        self._account_info = None

        signal.signal(signal.SIGINT, self._signal_handler)
        signal.signal(signal.SIGTERM, self._signal_handler)

    def _signal_handler(self, sig, frame):
        print(f"\n{C.YELLOW}  正在断开...{C.RESET}")
        self.running = False

    def run(self):
        clear()
        print_banner()

        # Validate config
        if not SERVER_URL or SERVER_URL == "http://127.0.0.1:3000":
            log("服务器地址: " + (SERVER_URL or "(空)"), "warn")
        else:
            log(f"服务器: {SERVER_URL}", "info")

        if not TOKEN:
            log("Token 为空！请填写 config.json 或使用 --token 参数", "error")
            log("从网站 AI 页面下载 config.json 放到本程序目录", "info")
            print()
            input("  按 Enter 退出...")
            return

        log(f"Token: {TOKEN[:12]}...{TOKEN[-4:]}", "info")

        # Check MT5
        if HAS_MT5:
            log("MetaTrader5 已就绪 (完整交易模式)", "ok")
            if self.mt5_handler.connect():
                acc = self.mt5_handler.mt5.account_info()
                if acc:
                    self._account_info = {"login": acc.login, "server": acc.server,
                                          "balance": acc.balance, "equity": acc.equity}
                    log(f"MT5 已连接: {acc.login} @ {acc.server}  余额: ${acc.balance:,.2f}", "ok")
                self.mt5_handler.disconnect()
        else:
            log("MetaTrader5 未安装 (仅中继模式，无法交易)", "warn")
            log("如需交易，请在 Windows 上运行 AURUM_Bridge.exe", "info")

        print(f"\n  {C.DIM}按 Ctrl+C 断开连接{C.RESET}\n")

        # WebSocket loop
        server = SERVER_URL.replace("http://", "ws://").replace("https://", "wss://").rstrip("/")
        ws_url = f"{server}/aurum-api/bridge/ws?token={TOKEN}"

        while self.running:
            try:
                log(f"连接 {server}/aurum-api/bridge/ws ...")
                self.ws = websocket.create_connection(ws_url, timeout=10,
                    header=["Origin: http://localhost"])
                log("WebSocket 已连接", "ok")

                # Initialize MT5 if available
                if self.mt5_handler and not self.mt5_handler.connected:
                    if self.mt5_handler.connect():
                        acc = self.mt5_handler.mt5.account_info()
                        if acc:
                            self._account_info = {"login": acc.login, "server": acc.server,
                                                  "balance": acc.balance, "equity": acc.equity}
                            log(f"MT5 已连接: {acc.login} @ {acc.server}  余额: ${acc.balance:,.2f}", "ok")

                last_hb = 0
                while self.running:
                    now = time.time()

                    # Heartbeat every 10s
                    if now - last_hb > 10:
                        try:
                            hb = {"type": "heartbeat", "live_trading_enabled": False}
                            if self.mt5_handler and self.mt5_handler.connected:
                                acc = self.mt5_handler.mt5.account_info()
                                terminal = self.mt5_handler.mt5.terminal_info()
                                hb["account"] = {
                                    "login": acc.login if acc else None,
                                    "balance": acc.balance if acc else None,
                                    "equity": acc.equity if acc else None,
                                    "server": acc.server if acc else None,
                                }
                                hb["terminal"] = {
                                    "build": terminal.build if terminal else None,
                                    "connected": terminal.connected if terminal else None,
                                }
                                hb["live_trading_enabled"] = self.mt5_handler._trade_enabled
                                if acc:
                                    self._account_info = {"login": acc.login, "server": acc.server,
                                                          "balance": acc.balance, "equity": acc.equity}
                            self.ws.send(json.dumps(hb))
                            last_hb = now
                        except Exception as e:
                            log(f"心跳错误: {e}", "error")

                    # Receive commands
                    self.ws.settimeout(0.5)
                    try:
                        data = self.ws.recv()
                        if data:
                            msg = json.loads(data)
                            if msg.get("type") == "command":
                                action = msg.get("action", "?")
                                log(f"执行: {action}", "cmd")
                                if self.mt5_handler and self.mt5_handler.connected:
                                    resp = self.mt5_handler.process(msg)
                                else:
                                    resp = {"status": "error", "message": "MT5 not available on macOS - use Windows bridge for trading"}
                                self.ws.send(json.dumps({
                                    "type": "result",
                                    "command_id": msg["command_id"],
                                    "result": resp,
                                }))
                                status = resp.get("status", "?")
                                if status == "success":
                                    log(f"完成: {json.dumps(resp, ensure_ascii=False)[:80]}", "ok")
                                else:
                                    log(f"失败: {resp.get('message', '?')[:80]}", "error")
                            elif msg.get("type") == "connected":
                                log(f"服务端确认: user {msg.get('userId')}", "ok")
                    except websocket.WebSocketTimeoutException:
                        pass
                    except websocket.WebSocketConnectionClosedException:
                        log("WebSocket 断开，重连中...", "warn")
                        break

            except (websocket.WebSocketException, ConnectionRefusedError, OSError) as e:
                log(f"连接失败: {e}，3秒后重连...", "error")
                for _ in range(30):
                    if not self.running: break
                    time.sleep(0.1)
            except Exception as e:
                log(f"错误: {e}", "error")
                time.sleep(3)

        # Cleanup
        if self.mt5_handler:
            self.mt5_handler.disconnect()
        if self.ws:
            try: self.ws.close()
            except: pass
        print(f"\n  {C.GREEN}桥接已停止{C.RESET}\n")


if __name__ == "__main__":
    app = AurumBridge()
    app.run()
