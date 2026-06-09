#!/bin/bash
# AURUM MT5 Bridge - macOS
# Double-click to run

cd "$(dirname "$0")"
clear

echo "  ╔══════════════════════════════════════╗"
echo "  ║     ⚡ AURUM MT5 Bridge (macOS)     ║"
echo "  ╚══════════════════════════════════════╝"
echo ""

# Auto-detect Python
PYTHON=""
for cmd in python3 python; do
    if command -v "$cmd" &>/dev/null; then
        PYTHON="$cmd"
        break
    fi
done

if [ -z "$PYTHON" ]; then
    echo "[ERROR] Python not found."
    echo "  Install: brew install python3"
    read -p "Press Enter to exit..."
    exit 1
fi

echo "[OK] Python: $($PYTHON --version)"
echo "[..] Installing dependencies..."
$PYTHON -m pip install --quiet websocket-client requests 2>/dev/null
echo "[OK] Dependencies ready"
echo ""

# Write Python bridge script + config
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PYFILE="$SCRIPT_DIR/_aurum_bridge.py"

cat > "$PYFILE" << 'PYEOF'
import sys, os, json, time, signal, threading

try:
    import websocket
except ImportError:
    import subprocess
    subprocess.check_call([sys.executable, "-m", "pip", "install", "websocket-client", "-q"])
    import websocket

try:
    import requests
except ImportError:
    import subprocess
    subprocess.check_call([sys.executable, "-m", "pip", "install", "requests", "-q"])
    import requests

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

SERVER_URL = "http://127.0.0.1:3000"
TOKEN = ""
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

i = 1
while i < len(sys.argv):
    if sys.argv[i] == '--server' and i + 1 < len(sys.argv):
        SERVER_URL = sys.argv[i + 1]; i += 2
    elif sys.argv[i] == '--token' and i + 1 < len(sys.argv):
        TOKEN = sys.argv[i + 1]; i += 2
    else:
        i += 1

class C:
    RESET = "\033[0m"; BOLD = "\033[1m"; DIM = "\033[2m"
    RED = "\033[31m"; GREEN = "\033[32m"; YELLOW = "\033[33m"
    BLUE = "\033[34m"; CYAN = "\033[36m"

def log(msg, level="info"):
    ts = time.strftime("%H:%M:%S")
    p = {"info": f"{C.DIM}[{ts}]{C.RESET}", "ok": f"{C.GREEN}[{ts}] ✓{C.RESET}",
         "warn": f"{C.YELLOW}[{ts}] ⚠{C.RESET}", "error": f"{C.RED}[{ts}] ✗{C.RESET}",
         "cmd": f"{C.CYAN}[{ts}] ▶{C.RESET}"}.get(level, f"[{ts}]")
    print(f"  {p} {msg}")

class MT5Handler:
    def __init__(self):
        self.mt5 = mt5; self.connected = False; self._trade_enabled = False

    def connect(self):
        if not self.mt5: return False
        if self.mt5.initialize(): self.connected = True; return True
        return False

    def disconnect(self):
        if self.mt5 and self.connected: self.mt5.shutdown(); self.connected = False

    def _resolve_symbol(self, symbol):
        requested = str(symbol or "").strip()
        if not requested: raise RuntimeError("Symbol is required")
        symbols = self.mt5.symbols_get()
        if symbols is None: raise RuntimeError("MT5 symbols_get failed")
        for item in symbols:
            if item.name == requested: return item.name
        ru = requested.upper()
        for item in symbols:
            if item.name.upper() == ru: return item.name
        for fb in [requested+".s", requested+"m", requested+".c", requested+"_", requested+".micro"]:
            for item in symbols:
                if item.name.upper() == fb.upper(): return item.name
        for item in symbols:
            if item.name.upper().startswith(ru+".") or item.name.upper().startswith(ru+"_"):
                return item.name
        raise RuntimeError(f"Symbol not found: {requested}")

    def _get_filling_mode(self, symbol):
        info = self.mt5.symbol_info(symbol)
        if not info: return self.mt5.ORDER_FILLING_IOC
        fm = int(getattr(info, "filling_mode", 0) or 0)
        cands = []
        if fm & 1: cands.append(self.mt5.ORDER_FILLING_FOK)
        if fm & 2: cands.append(self.mt5.ORDER_FILLING_IOC)
        if not cands: cands = [self.mt5.ORDER_FILLING_RETURN, self.mt5.ORDER_FILLING_FOK, self.mt5.ORDER_FILLING_IOC]
        return self.mt5.ORDER_FILLING_FOK if self.mt5.ORDER_FILLING_FOK in cands else cands[0]

    def process(self, cmd):
        action = cmd.get("action"); params = cmd.get("params", {})
        try:
            if action == "open":
                symbol = self._resolve_symbol(params.get("symbol"))
                self.mt5.symbol_select(symbol, True)
                info = self.mt5.symbol_info(symbol); tick = self.mt5.symbol_info_tick(symbol)
                if not info: return {"status": "error", "message": f"Symbol not available: {symbol}"}
                if not tick: return {"status": "error", "message": f"No quote for {symbol}"}
                ot = self.mt5.ORDER_TYPE_BUY if (params.get("type") or params.get("order_type") or "buy").lower() == "buy" else self.mt5.ORDER_TYPE_SELL
                req = {"action": self.mt5.TRADE_ACTION_DEAL, "symbol": symbol,
                       "volume": float(params.get("lot") or params.get("volume") or 0.01),
                       "type": ot, "magic": 234000, "comment": params.get("comment", "AURUM"),
                       "type_time": self.mt5.ORDER_TIME_GTC, "type_filling": self._get_filling_mode(symbol)}
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
                    if not positions: return {"status": "error", "message": f"Position {ticket} not found"}
                    pos = positions[0]
                    ct = self.mt5.ORDER_TYPE_SELL if pos.type == self.mt5.ORDER_TYPE_BUY else self.mt5.ORDER_TYPE_BUY
                    result = self.mt5.order_send({"action": self.mt5.TRADE_ACTION_DEAL, "position": pos.ticket,
                        "symbol": pos.symbol, "volume": pos.volume, "type": ct, "magic": 234000,
                        "type_filling": self._get_filling_mode(pos.symbol)})
                    if result and result.retcode == self.mt5.TRADE_RETCODE_DONE:
                        return {"status": "success", "ticket": pos.ticket}
                    return {"status": "error", "message": result.comment if result else "close failed"}
                else:
                    symbol = self._resolve_symbol(params.get("symbol")) if params.get("symbol") else None
                    positions = self.mt5.positions_get(symbol=symbol) if symbol else self.mt5.positions_get()
                    if not positions: return {"status": "success", "message": "No positions"}
                    for pos in positions:
                        ct = self.mt5.ORDER_TYPE_SELL if pos.type == self.mt5.ORDER_TYPE_BUY else self.mt5.ORDER_TYPE_BUY
                        self.mt5.order_send({"action": self.mt5.TRADE_ACTION_DEAL, "symbol": pos.symbol,
                            "volume": pos.volume, "type": ct, "position": pos.ticket,
                            "magic": 234000, "type_filling": self._get_filling_mode(pos.symbol)})
                    return {"status": "success", "closed": len(positions)}
            elif action == "close_all":
                positions = self.mt5.positions_get()
                if not positions: return {"status": "success", "closed": 0}
                for pos in positions:
                    ct = self.mt5.ORDER_TYPE_SELL if pos.type == self.mt5.ORDER_TYPE_BUY else self.mt5.ORDER_TYPE_BUY
                    self.mt5.order_send({"action": self.mt5.TRADE_ACTION_DEAL, "symbol": pos.symbol,
                        "volume": pos.volume, "type": ct, "position": pos.ticket,
                        "magic": 234000, "type_filling": self._get_filling_mode(pos.symbol)})
                return {"status": "success", "closed": len(positions)}
            elif action == "rates":
                symbol = self._resolve_symbol(params.get("symbol"))
                self.mt5.symbol_select(symbol, True)
                tf_map = {"M1": self.mt5.TIMEFRAME_M1, "M5": self.mt5.TIMEFRAME_M5,
                    "M15": self.mt5.TIMEFRAME_M15, "M30": self.mt5.TIMEFRAME_M30,
                    "H1": self.mt5.TIMEFRAME_H1, "H4": self.mt5.TIMEFRAME_H4, "D1": self.mt5.TIMEFRAME_D1}
                tf = tf_map.get(params.get("timeframe", "M30"), self.mt5.TIMEFRAME_M30)
                rates = self.mt5.copy_rates_from_pos(symbol, tf, 0, int(params.get("count", 100)))
                if rates is not None and len(rates) > 0:
                    from datetime import datetime
                    out = [{"time": datetime.utcfromtimestamp(int(r[0])).strftime('%Y-%m-%d %H:%M:%S'),
                            "open": float(r[1]), "high": float(r[2]), "low": float(r[3]),
                            "close": float(r[4]), "tick_volume": int(r[5]),
                            "spread": int(r[6]) if len(r) > 6 else 0} for r in rates]
                    return {"status": "success", "symbol": symbol, "timeframe": params.get("timeframe", "M30"),
                            "count": len(out), "rates": out, "source": "mt5"}
                return {"status": "success", "symbol": symbol, "rates": [], "source": "mt5"}
            elif action == "quote":
                symbol = self._resolve_symbol(params.get("symbol"))
                self.mt5.symbol_select(symbol, True)
                tick = self.mt5.symbol_info_tick(symbol); info = self.mt5.symbol_info(symbol)
                if not tick: return {"status": "error", "message": f"No quote for {symbol}"}
                from datetime import datetime
                return {"status": "success", "symbol": symbol, "bid": tick.bid, "ask": tick.ask,
                    "spread": round(info.spread * info.point, info.digits) if info else 0,
                    "time": datetime.utcfromtimestamp(int(tick.time)).strftime('%Y-%m-%d %H:%M:%S'),
                    "digits": info.digits if info else 2, "point": info.point if info else 0.01, "source": "mt5"}
            elif action == "positions":
                symbol = params.get("symbol")
                if symbol: symbol = self._resolve_symbol(symbol); positions = self.mt5.positions_get(symbol=symbol)
                else: positions = self.mt5.positions_get()
                if positions:
                    from datetime import datetime
                    payload = [{"ticket": p.ticket, "symbol": p.symbol, "type": "buy" if p.type == 0 else "sell",
                        "volume": p.volume, "open_price": p.price_open, "price_open": p.price_open,
                        "price_current": p.price_current, "profit": p.profit, "sl": p.sl, "tp": p.tp,
                        "swap": p.swap, "magic": p.magic, "comment": p.comment,
                        "time": datetime.utcfromtimestamp(p.time).strftime('%Y-%m-%d %H:%M:%S') if p.time else "",
                        "source": "mt5"} for p in positions]
                    return {"status": "success", "positions": payload, "count": len(payload), "source": "mt5"}
                return {"status": "success", "positions": [], "count": 0, "source": "mt5"}
            elif action == "account":
                acc = self.mt5.account_info(); terminal = self.mt5.terminal_info()
                if acc:
                    return {"status": "success", "balance": acc.balance, "equity": acc.equity,
                        "margin": acc.margin, "margin_free": acc.margin_free,
                        "margin_level": getattr(acc, "margin_level", 0), "profit": acc.profit,
                        "currency": acc.currency, "leverage": acc.leverage, "server": acc.server,
                        "company": getattr(acc, "company", ""), "login": acc.login,
                        "trade_allowed": acc.trade_allowed, "trade_expert": acc.trade_expert,
                        "terminal_build": terminal.build if terminal else 0,
                        "terminal_connected": terminal.connected if terminal else False, "source": "mt5"}
                return {"status": "error", "message": "no account info"}
            elif action == "status":
                acc = self.mt5.account_info(); terminal = self.mt5.terminal_info()
                if acc:
                    return {"mode": "live", "mt5_package_available": True,
                        "live_trading_enabled": self._trade_enabled,
                        "terminal_trade_allowed": terminal.trade_allowed if terminal else False,
                        "account_trade_allowed": acc.trade_allowed, "account_trade_expert": acc.trade_expert,
                        "login": acc.login, "server": acc.server, "balance": acc.balance, "equity": acc.equity}
                return {"mode": "mock", "mt5_package_available": True, "live_trading_enabled": False}
            elif action == "toggle_trade":
                self._trade_enabled = params.get("enable", False)
                return {"status": "success", "live_trading_enabled": self._trade_enabled}
            elif action == "symbols":
                symbols = self.mt5.symbols_get()
                if symbols is None: return {"status": "error", "message": "MT5 symbols_get failed"}
                return {"status": "success", "symbols": [{"name": s.name, "description": s.description,
                    "currency_base": s.currency_base, "digits": s.digits, "point": s.point} for s in symbols], "source": "mt5"}
            elif action == "diagnostics":
                acc = self.mt5.account_info(); terminal = self.mt5.terminal_info()
                return {"status": "success", "mt5_connected": True,
                    "account": {"login": acc.login, "server": acc.server, "balance": acc.balance} if acc else None,
                    "terminal": {"build": terminal.build, "connected": terminal.connected,
                        "trade_allowed": terminal.trade_allowed} if terminal else None}
            else:
                return {"status": "error", "message": f"unknown action: {action}"}
        except Exception as e:
            return {"status": "error", "message": str(e)}

class AurumBridge:
    def __init__(self):
        self.running = True; self.mt5h = MT5Handler() if HAS_MT5 else None; self.ws = None
        signal.signal(signal.SIGINT, lambda s,f: setattr(self, 'running', False) or print(f"\n{C.YELLOW}  正在断开...{C.RESET}"))
        signal.signal(signal.SIGTERM, lambda s,f: setattr(self, 'running', False))

    def run(self):
        os.system("clear")
        print(f"\n{C.CYAN}{C.BOLD}  ╔══════════════════════════════════════╗\n  ║     ⚡ AURUM MT5 Bridge (macOS)     ║\n  ╚══════════════════════════════════════╝{C.RESET}\n")
        log(f"服务器: {SERVER_URL or '(空)'}", "info")
        if not TOKEN:
            log("Token 为空！请下载 config.json 放到本目录", "error")
            print(); input("  按 Enter 退出..."); return
        log(f"Token: {TOKEN[:12]}...{TOKEN[-4:]}", "info")
        if HAS_MT5:
            log("MetaTrader5 已就绪 (完整交易模式)", "ok")
            if self.mt5h.connect():
                acc = self.mt5h.mt5.account_info()
                if acc: log(f"MT5 已连接: {acc.login} @ {acc.server}  余额: ${acc.balance:,.2f}", "ok")
                self.mt5h.disconnect()
        else:
            log("MetaTrader5 未安装 (仅中继模式)", "warn")
            log("如需完整交易，请在 Windows 上运行 AURUM_Bridge.exe", "info")
        print(f"\n  {C.DIM}按 Ctrl+C 断开{C.RESET}\n")
        server = SERVER_URL.replace("http://", "ws://").replace("https://", "wss://").rstrip("/")
        ws_url = f"{server}/aurum-api/bridge/ws?token={TOKEN}"
        while self.running:
            try:
                log(f"连接 {server}/aurum-api/bridge/ws ...")
                self.ws = websocket.create_connection(ws_url, timeout=10, header=["Origin: http://localhost"])
                log("WebSocket 已连接", "ok")
                if self.mt5h and not self.mt5h.connected:
                    if self.mt5h.connect():
                        acc = self.mt5h.mt5.account_info()
                        if acc: log(f"MT5 已连接: {acc.login} @ {acc.server}  余额: ${acc.balance:,.2f}", "ok")
                last_hb = 0
                while self.running:
                    now = time.time()
                    if now - last_hb > 10:
                        try:
                            hb = {"type": "heartbeat", "live_trading_enabled": False}
                            if self.mt5h and self.mt5h.connected:
                                acc = self.mt5h.mt5.account_info(); terminal = self.mt5h.mt5.terminal_info()
                                hb["account"] = {"login": acc.login, "balance": acc.balance, "equity": acc.equity, "server": acc.server} if acc else None
                                hb["terminal"] = {"build": terminal.build, "connected": terminal.connected} if terminal else None
                                hb["live_trading_enabled"] = self.mt5h._trade_enabled
                            self.ws.send(json.dumps(hb)); last_hb = now
                        except Exception as e: log(f"心跳错误: {e}", "error")
                    self.ws.settimeout(0.5)
                    try:
                        data = self.ws.recv()
                        if data:
                            msg = json.loads(data)
                            if msg.get("type") == "command":
                                action = msg.get("action", "?"); log(f"执行: {action}", "cmd")
                                resp = self.mt5h.process(msg) if self.mt5h and self.mt5h.connected else {"status": "error", "message": "MT5 not available on macOS"}
                                self.ws.send(json.dumps({"type": "result", "command_id": msg["command_id"], "result": resp}))
                                log(f"{'完成' if resp.get('status')=='success' else '失败'}: {json.dumps(resp, ensure_ascii=False)[:80]}", "ok" if resp.get("status")=="success" else "error")
                            elif msg.get("type") == "connected":
                                log(f"服务端确认: user {msg.get('userId')}", "ok")
                    except websocket.WebSocketTimeoutException: pass
                    except websocket.WebSocketConnectionClosedException:
                        log("WebSocket 断开，重连中...", "warn"); break
            except (websocket.WebSocketException, ConnectionRefusedError, OSError) as e:
                log(f"连接失败: {e}，3秒后重连...", "error")
                for _ in range(30):
                    if not self.running: break
                    time.sleep(0.1)
            except Exception as e:
                log(f"错误: {e}", "error"); time.sleep(3)
        if self.mt5h: self.mt5h.disconnect()
        if self.ws:
            try: self.ws.close()
            except: pass
        print(f"\n  {C.GREEN}桥接已停止{C.RESET}\n")

if __name__ == "__main__":
    AurumBridge().run()
PYEOF

# Write config
cat > "$SCRIPT_DIR/config.json" << CFGEOF
{
  "server_url": "{{SERVER_URL}}",
  "token": "{{TOKEN}}"
}
CFGEOF

echo "[OK] 配置已写入 config.json"
echo "[OK] 桥接脚本已准备"
echo ""
echo "========================================"
echo "  启动中...  Server: {{SERVER_URL}}"
echo "  按 Ctrl+C 停止"
echo "========================================"
echo ""

$PYTHON "$PYFILE"
rm -f "$PYFILE" 2>/dev/null

echo ""
echo "桥接已停止。"
read -p "按 Enter 退出..."
