# -*- coding: utf-8 -*-
"""AURUM Bridge - MT5 桥接桌面客户端"""
import sys
import os
import json
import time
import threading
import ssl
try:
    import websocket  # websocket-client
    HAS_WS = True
except ImportError:
    HAS_WS = False
import tkinter as tk
from tkinter import ttk, scrolledtext, messagebox

# ===== Config =====
SERVER_URL = "http://127.0.0.1:3000"
TOKEN = ""
CONFIG_FILE = ""

# 1. Try loading from config.json (same directory as .exe)
try:
    exe_dir = os.path.dirname(os.path.abspath(sys.executable if getattr(sys, 'frozen', False) else __file__))
    config_path = os.path.join(exe_dir, "config.json")
    if os.path.exists(config_path):
        with open(config_path, "r") as cf:
            cfg = json.loads(cf.read())
            SERVER_URL = cfg.get("server_url", SERVER_URL)
            TOKEN = cfg.get("token", TOKEN)
except:
    pass

# 2. Command line args override: --server URL --token TOKEN
i = 1
while i < len(sys.argv):
    if sys.argv[i] == '--server' and i + 1 < len(sys.argv):
        SERVER_URL = sys.argv[i + 1]
        i += 2
    elif sys.argv[i] == '--token' and i + 1 < len(sys.argv):
        TOKEN = sys.argv[i + 1]
        i += 2
    else:
        i += 1

class AurumBridge:
    def __init__(self):
        self.root = tk.Tk()
        self.root.title("AURUM MT5 Bridge")
        self.root.geometry("520x580")
        self.root.resizable(False, False)
        self.root.configure(bg="#0f172a")

        self.mt5 = None
        self.running = False
        self.bridge_thread = None

        self._build_ui()
        self._check_mt5()

    def _build_ui(self):
        bg = "#0f172a"
        card_bg = "#1e293b"
        accent = "#3b82f6"
        text = "#e2e8f0"
        muted = "#94a3b8"
        green = "#22c55e"
        red = "#ef4444"

        # Title
        tk.Label(self.root, text="⚡ AURUM MT5 Bridge", font=("Segoe UI", 16, "bold"),
                 bg=bg, fg=accent).pack(pady=(16, 4))
        tk.Label(self.root, text="双击运行 · 自动连接", font=("Segoe UI", 9),
                 bg=bg, fg=muted).pack()

        # Connection card
        card = tk.Frame(self.root, bg=card_bg, highlightbackground="#334155",
                        highlightthickness=1, padx=16, pady=12)
        card.pack(padx=16, pady=(12, 8), fill="x")

        # Server
        tk.Label(card, text="服务器地址", font=("Segoe UI", 9), bg=card_bg, fg=muted).grid(
            row=0, column=0, sticky="w", pady=(0, 2))
        self.server_var = tk.StringVar(value=SERVER_URL)
        server_frame = tk.Frame(card, bg=card_bg)
        server_frame.grid(row=1, column=0, columnspan=2, sticky="ew", pady=(0, 8))
        card.columnconfigure(0, weight=1)

        self.server_entry = tk.Entry(server_frame, textvariable=self.server_var,
                                      font=("Consolas", 10), bg="#0f172a", fg=text,
                                      insertbackground=text, relief="flat", bd=4)
        self.server_entry.pack(side="left", fill="x", expand=True)

        tk.Button(server_frame, text="📋 复制", font=("Segoe UI", 8),
                  bg="#334155", fg=text, relief="flat", padx=8,
                  activebackground="#475569", cursor="hand2",
                  command=lambda: self._copy(self.server_var.get())).pack(side="right", padx=(4, 0))

        # Token
        tk.Label(card, text="认证 Token", font=("Segoe UI", 9), bg=card_bg, fg=muted).grid(
            row=2, column=0, sticky="w", pady=(0, 2))
        token_frame = tk.Frame(card, bg=card_bg)
        token_frame.grid(row=3, column=0, columnspan=2, sticky="ew", pady=(0, 8))

        self.token_var = tk.StringVar(value=TOKEN)
        self.token_shown = False
        self.token_entry = tk.Entry(token_frame, textvariable=self.token_var,
                                     font=("Consolas", 10), bg="#0f172a", fg=text,
                                     insertbackground=text, relief="flat", bd=4, show="•")
        self.token_entry.pack(side="left", fill="x", expand=True)

        tk.Button(token_frame, text="👁", font=("Segoe UI", 9),
                  bg="#334155", fg=text, relief="flat", padx=4,
                  activebackground="#475569", cursor="hand2",
                  command=self._toggle_token).pack(side="right", padx=(2, 0))

        tk.Button(token_frame, text="📋 复制", font=("Segoe UI", 8),
                  bg="#334155", fg=text, relief="flat", padx=8,
                  activebackground="#475569", cursor="hand2",
                  command=lambda: self._copy(self.token_var.get())).pack(side="right", padx=(4, 0))

        # Status indicator
        status_frame = tk.Frame(self.root, bg=bg)
        status_frame.pack(padx=16, pady=(4, 4), fill="x")
        self.status_dot = tk.Label(status_frame, text="●", font=("Segoe UI", 14),
                                    bg=bg, fg=muted)
        self.status_dot.pack(side="left")
        self.status_label = tk.Label(status_frame, text="未连接", font=("Segoe UI", 11, "bold"),
                                      bg=bg, fg=muted)
        self.status_label.pack(side="left", padx=(4, 0))
        self.account_label = tk.Label(status_frame, text="", font=("Segoe UI", 9),
                                       bg=bg, fg=muted)
        self.account_label.pack(side="right")

        # Start/Stop button
        self.btn_frame = tk.Frame(self.root, bg=bg)
        self.btn_frame.pack(padx=16, pady=(4, 8), fill="x")

        self.start_btn = tk.Button(self.btn_frame, text="▶  启动桥接", font=("Segoe UI", 12, "bold"),
                                    bg=accent, fg="white", relief="flat", padx=20, pady=8,
                                    activebackground="#2563eb", cursor="hand2",
                                    command=self._toggle_bridge)
        self.start_btn.pack(fill="x")

        # Log area
        tk.Label(self.root, text="运行日志", font=("Segoe UI", 9), bg=bg, fg=muted).pack(
            padx=16, anchor="w")

        self.log_area = scrolledtext.ScrolledText(self.root, height=14, font=("Consolas", 9),
                                                   bg="#0f172a", fg="#94a3b8",
                                                   insertbackground=text, relief="flat",
                                                   bd=4, state="disabled", wrap="word")
        self.log_area.pack(padx=16, pady=(2, 12), fill="both", expand=True)

        # Footer
        tk.Label(self.root, text="AURUM AI · wall-street-skill.com", font=("Segoe UI", 8),
                 bg=bg, fg="#475569").pack(pady=(0, 8))

    def _copy(self, text):
        self.root.clipboard_clear()
        self.root.clipboard_append(text)
        self._log("已复制到剪贴板")

    def _toggle_token(self):
        self.token_shown = not self.token_shown
        self.token_entry.config(show="" if self.token_shown else "•")

    def _log(self, msg):
        self.log_area.config(state="normal")
        ts = time.strftime("%H:%M:%S")
        self.log_area.insert("end", f"[{ts}] {msg}\n")
        self.log_area.see("end")
        self.log_area.config(state="disabled")

    def _set_status(self, text, color, account=""):
        self.status_dot.config(fg=color)
        self.status_label.config(fg=color, text=text)
        self.account_label.config(text=account)

    def _check_mt5(self):
        try:
            import MetaTrader5 as mt5
            self.mt5 = mt5
            if mt5.initialize():
                info = mt5.account_info()
                if info:
                    self._log(f"MT5 已就绪: {info.login} @ {info.server}  余额: ${info.balance:,.2f}")
                else:
                    self._log("MT5 已初始化，请在终端中登录账户")
                mt5.shutdown()
            else:
                self._log(f"MT5 初始化失败: {mt5.last_error()}")
        except ImportError:
            if getattr(sys, 'frozen', False):
                self._log("错误: MetaTrader5 未安装。请先运行 Setup.bat 安装依赖，或手动执行:")
                self._log("  pip install MetaTrader5")
                messagebox.showerror("缺少依赖",
                    "MetaTrader5 未安装！\n\n"
                    "请先运行 Setup.bat 自动安装，\n"
                    "或手动执行: pip install MetaTrader5")
            else:
                self._log("MetaTrader5 未安装，正在安装...")
                threading.Thread(target=self._install_mt5, daemon=True).start()

    def _install_mt5(self):
        import subprocess
        try:
            subprocess.check_call([sys.executable, "-m", "pip", "install", "MetaTrader5", "-q"])
            import MetaTrader5 as mt5
            self.mt5 = mt5
            self._log("MetaTrader5 安装成功")
        except Exception as e:
            self._log(f"安装失败: {e}")


    def _toggle_bridge(self):
        if self.running:
            self.running = False
            self.start_btn.config(text="▶  启动桥接", bg="#3b82f6")
            self._set_status("已停止", "#ef4444")
            self._log("桥接已停止")
        else:
            self.running = True
            self.start_btn.config(text="■  停止桥接", bg="#ef4444")
            self._set_status("连接中...", "#f59e0b")
            self.bridge_thread = threading.Thread(target=self._bridge_loop, daemon=True)
            self.bridge_thread.start()

    def _resolve_symbol(self, symbol):
        """Find actual MT5 symbol name (matches old bridge resolve_live_symbol)"""
        requested = str(symbol or "").strip()
        if not requested:
            raise RuntimeError("Symbol is required")
        symbols = self.mt5.symbols_get()
        if symbols is None:
            raise RuntimeError(f"MT5 symbols_get failed")
        # Exact match
        for item in symbols:
            if item.name == requested:
                return item.name
        # Case-insensitive match
        requested_upper = requested.upper()
        for item in symbols:
            if item.name.upper() == requested_upper:
                return item.name
        # Fallback variants (XAUUSD -> XAUUSD.s, XAUUSDm, XAUUSD.c, etc.)
        fallbacks = [requested + ".s", requested + "m", requested + ".c", requested + "_", requested + ".micro"]
        for fb in fallbacks:
            for item in symbols:
                if item.name.upper() == fb.upper():
                    return item.name
        # Partial match (XAUUSD matches XAUUSD.s)
        for item in symbols:
            if item.name.upper().startswith(requested_upper + ".") or item.name.upper().startswith(requested_upper + "_"):
                return item.name
        raise RuntimeError(f"Symbol not found in MT5: {requested}")

    def _get_filling_mode(self, symbol):
        """Detect the correct filling mode for a symbol (same logic as mt5_bridge.py)"""
        info = self.mt5.symbol_info(symbol)
        if not info:
            return self.mt5.ORDER_FILLING_IOC
        filling_mode = int(getattr(info, "filling_mode", 0) or 0)
        # bit 1 = FOK, bit 2 = IOC
        candidates = []
        if filling_mode & 1:
            candidates.append(self.mt5.ORDER_FILLING_FOK)
        if filling_mode & 2:
            candidates.append(self.mt5.ORDER_FILLING_IOC)
        if not candidates:
            candidates = [self.mt5.ORDER_FILLING_RETURN, self.mt5.ORDER_FILLING_FOK, self.mt5.ORDER_FILLING_IOC]
        # Prefer FOK, then IOC, then RETURN
        if self.mt5.ORDER_FILLING_FOK in candidates:
            return self.mt5.ORDER_FILLING_FOK
        return candidates[0]

    def _process_command(self, cmd):
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
                    return {"status": "error", "message": f"Invalid live quote for {symbol}"}
                order_type = self.mt5.ORDER_TYPE_BUY if params.get("type", "buy") == "buy" else self.mt5.ORDER_TYPE_SELL
                req = {
                    "action": self.mt5.TRADE_ACTION_DEAL,
                    "symbol": symbol,
                    "volume": float(params.get("lot") or params.get("volume") or 0.01),
                    "type": order_type,
                    "magic": 234000,
                    "comment": params.get("comment", "AURUM"),
                    "type_time": self.mt5.ORDER_TIME_GTC,
                    "type_filling": self._get_filling_mode(symbol),
                }
                if params.get("sl"):
                    req["sl"] = float(params["sl"])
                if params.get("tp"):
                    req["tp"] = float(params["tp"])
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
                    import datetime
                    out = []
                    for r in rates:
                        t = datetime.datetime.fromtimestamp(int(r[0])).strftime("%Y-%m-%d %H:%M:%S")
                        out.append({"time": t, "open": float(r[1]), "high": float(r[2]),
                                    "low": float(r[3]), "close": float(r[4]), "tick_volume": int(r[5]), "spread": int(r[6]) if len(r) > 6 else 0})
                    return {"status": "success", "symbol": symbol, "timeframe": params.get("timeframe", "M30"),
                            "count": len(out), "rates": out, "source": "mt5"}
                return {"status": "success", "symbol": symbol, "rates": [], "source": "mt5"}

            elif action == "quote":
                symbol = self._resolve_symbol(params.get("symbol"))
                self.mt5.symbol_select(symbol, True)
                tick = self.mt5.symbol_info_tick(symbol)
                info = self.mt5.symbol_info(symbol)
                if not tick:
                    return {"status": "error", "message": f"MT5 quote failed for {symbol}"}
                return {
                    "status": "success", "symbol": symbol,
                    "bid": tick.bid, "ask": tick.ask,
                    "spread": round(info.spread * info.point, info.digits) if info else 0,
                    "time": tick.time,
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
                        sym_info = self.mt5.symbol_info(d["symbol"])
                        payload.append({
                            "ticket": d["ticket"], "symbol": d["symbol"],
                            "type": "buy" if d["type"] == 0 else "sell",
                            "volume": d["volume"], "open_price": d["price_open"],
                            "price_current": d["price_current"],
                            "profit": d["profit"], "sl": d["sl"], "tp": d["tp"],
                            "swap": d["swap"], "magic": d["magic"], "comment": d["comment"],
                            "source": "mt5",
                        })
                    return {"status": "success", "positions": payload, "count": len(payload), "source": "mt5"}
                return {"status": "success", "positions": [], "count": 0, "source": "mt5"}

            elif action == "symbols":
                symbols = self.mt5.symbols_get()
                if symbols is None:
                    return {"status": "error", "message": "MT5 symbols_get failed"}
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

            elif action == "account":
                acc = self.mt5.account_info()
                if acc:
                    terminal = self.mt5.terminal_info()
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
                        "live_trading_enabled": getattr(self, '_trade_enabled', True),
                        "terminal_trade_allowed": terminal.trade_allowed if terminal else False,
                        "account_trade_allowed": acc.trade_allowed,
                        "account_trade_expert": acc.trade_expert,
                        "login": acc.login, "server": acc.server,
                        "balance": acc.balance, "equity": acc.equity,
                    }
                return {"mode": "mock", "mt5_package_available": True, "live_trading_enabled": False}

            elif action == "history":
                page = params.get("page", 1)
                page_size = params.get("page_size", 20)
                deals = self.mt5.history_deals_get(0, 0) or []
                start = (page - 1) * page_size
                end = start + page_size
                items = []
                for d in deals[start:end]:
                    items.append({
                        "ticket": d.ticket, "order": d.order, "time": d.time,
                        "type": d.type, "entry": d.entry, "magic": d.magic,
                        "volume": d.volume, "price": d.price, "commission": d.commission,
                        "swap": d.swap, "profit": d.profit, "symbol": d.symbol, "comment": d.comment,
                    })
                return {"status": "success", "deals": items, "total": len(deals), "page": page, "page_size": page_size}

            elif action == "diagnostics":
                acc = self.mt5.account_info()
                terminal = self.mt5.terminal_info()
                return {
                    "status": "success",
                    "mt5_connected": True,
                    "account": {"login": acc.login, "server": acc.server, "balance": acc.balance} if acc else None,
                    "terminal": {"build": terminal.build, "connected": terminal.connected, "trade_allowed": terminal.trade_allowed} if terminal else None,
                }

            elif action == "toggle_trade":
                enable = params.get("enable", True)
                self._trade_enabled = enable
                return {"status": "success", "live_trading_enabled": enable}

            else:
                return {"status": "error", "message": f"unknown action: {action}"}
        except Exception as e:
            return {"status": "error", "message": str(e)}

    def _bridge_loop(self):
        # Initialize MT5
        if not self.mt5:
            try:
                import MetaTrader5 as mt5
                self.mt5 = mt5
            except:
                self.root.after(0, self._log, "错误: MetaTrader5 未安装")
                self.root.after(0, self._toggle_bridge)
                return

        if not self.mt5.initialize():
            self.root.after(0, self._log, f"MT5 初始化失败: {self.mt5.last_error()}")
            self.root.after(0, self._toggle_bridge)
            return

        info = self.mt5.account_info()
        if info:
            self.root.after(0, self._log, f"MT5 已连接: {info.login} @ {info.server}  余额: ${info.balance:,.2f}")

        if not HAS_WS:
            self.root.after(0, self._log, "错误: websocket-client 未安装，请运行: pip install websocket-client")
            self.root.after(0, self._toggle_bridge)
            return

        server = self.server_var.get().replace("http://", "ws://").replace("https://", "wss://").rstrip("/")
        ws_url = f"{server}/aurum-api/bridge/ws?token={self.token_var.get()}"
        self.root.after(0, self._log, f"连接 WebSocket: {server}/aurum-api/bridge/ws")

        while self.running:
            try:
                ws = websocket.create_connection(ws_url, timeout=10,
                    header=["Origin: http://localhost"])
                self.root.after(0, self._log, "WebSocket 已连接")
                last_hb = 0

                while self.running:
                    # Send heartbeat every 10s
                    now = time.time()
                    if now - last_hb > 10:
                        try:
                            account = self.mt5.account_info()
                            terminal = self.mt5.terminal_info()
                            ws.send(json.dumps({
                                "type": "heartbeat",
                                "account": {
                                    "login": account.login if account else None,
                                    "balance": account.balance if account else None,
                                    "equity": account.equity if account else None,
                                    "server": account.server if account else None,
                                },
                                "terminal": {
                                    "build": terminal.build if terminal else None,
                                    "connected": terminal.connected if terminal else None,
                                },
                            }))
                            if account:
                                self.root.after(0, self._set_status, "已连接", "#22c55e",
                                               f"{account.login} @ {account.server}  ${account.balance:,.2f}")
                            last_hb = now
                        except Exception as e:
                            self.root.after(0, self._log, f"心跳错误: {e}")

                    # Receive commands (non-blocking with short timeout)
                    ws.settimeout(0.5)
                    try:
                        data = ws.recv()
                        if data:
                            msg = json.loads(data)
                            if msg.get("type") == "command":
                                cmd = msg
                                self.root.after(0, self._log, f"执行: {cmd['action']}")
                                resp = self._process_command(cmd)
                                ws.send(json.dumps({
                                    "type": "result",
                                    "command_id": msg["command_id"],
                                    "result": resp,
                                }))
                                self.root.after(0, self._log, f"完成: {json.dumps(resp, ensure_ascii=False)[:80]}")
                            elif msg.get("type") == "connected":
                                self.root.after(0, self._log, f"服务端确认: user {msg.get('userId')}")
                    except websocket.WebSocketTimeoutException:
                        pass  # No data, loop back for heartbeat
                    except websocket.WebSocketConnectionClosedException:
                        self.root.after(0, self._log, "WebSocket 断开，重连中...")
                        break

            except (websocket.WebSocketException, ConnectionRefusedError, OSError) as e:
                self.root.after(0, self._log, f"WebSocket 连接失败: {e}，3秒后重连...")
                time.sleep(3)
            except Exception as e:
                self.root.after(0, self._log, f"错误: {e}")
                time.sleep(3)

        if self.mt5:
            self.mt5.shutdown()
        self.root.after(0, self._log, "MT5 已断开")

    def run(self):
        self.root.protocol("WM_DELETE_WINDOW", self._on_close)
        self.root.mainloop()

    def _on_close(self):
        self.running = False
        if self.mt5:
            try:
                self.mt5.shutdown()
            except:
                pass
        self.root.destroy()

if __name__ == "__main__":
    app = AurumBridge()
    app.run()
