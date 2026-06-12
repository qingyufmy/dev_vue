# -*- coding: utf-8 -*-
"""AURUM Bridge - MT5 桥接桌面客户端"""
import sys
import os
import json
import time
import threading
from datetime import datetime, timezone, timedelta

MAX_LOG_LINES = 500

def _mt5_time(ts):
    if not ts:
        return ''
    return datetime.utcfromtimestamp(int(ts)).strftime('%Y-%m-%d %H:%M:%S')

import ssl
try:
    import websocket
    HAS_WS = True
except ImportError:
    HAS_WS = False

import tkinter as tk
from tkinter import scrolledtext, messagebox

# Windows tray
try:
    import win32gui
    import win32con
    import win32api
    HAS_TRAY = True
except ImportError:
    HAS_TRAY = False

# ===== Config =====
SERVER_URL = "http://127.0.0.1:3000"
TOKEN = ""
CONFIG_FILE = ""

try:
    exe_dir = os.path.dirname(os.path.abspath(sys.executable if getattr(sys, 'frozen', False) else __file__))
    config_path = os.path.join(exe_dir, "config.json")
    CONFIG_FILE = config_path
    if os.path.exists(config_path):
        with open(config_path, "r") as cf:
            cfg = json.loads(cf.read())
            SERVER_URL = cfg.get("server_url", SERVER_URL)
            TOKEN = cfg.get("token", TOKEN)
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


class AurumBridge:
    # ===== Tray icon IDs =====
    TRAY_WM = win32con.WM_USER + 20 if HAS_TRAY else 0x0414
    MENU_OPEN = 1001
    MENU_START = 1002
    MENU_STOP = 1003
    MENU_QUIT = 1004

    def __init__(self):
        self.root = tk.Tk()
        self.root.title("AURUM MT5 Bridge")
        self.root.geometry("520x580")
        self.root.resizable(False, False)
        self.root.configure(bg="#0f172a")
        # Set window icon
        try:
            if getattr(sys, 'frozen', False):
                base = sys._MEIPASS
            else:
                base = os.path.dirname(os.path.abspath(__file__))
            icon_path = os.path.join(base, 'aurum_icon.ico')
            if os.path.exists(icon_path):
                self.root.iconbitmap(icon_path)
        except:
            pass

        self.mt5 = None
        self.running = False
        self.bridge_thread = None
        self._trade_enabled = False
        self._ws = None
        self._tray_hwnd = None
        self._is_minimized_to_tray = False

        self._build_ui()
        self._check_mt5()
        if HAS_TRAY:
            try:
                self._init_tray()
                self._show_tray()
                self._log(f"系统托盘已就绪 (hwnd={self._tray_hwnd})")
            except Exception as e:
                self._log(f"托盘初始化失败: {e}")
                self._tray_hwnd = None
        self.root.mainloop()

    # ============ UI ============

    def _build_ui(self):
        bg, card_bg, accent = "#0f172a", "#1e293b", "#3b82f6"
        text, muted = "#e2e8f0", "#94a3b8"

        tk.Label(self.root, text="⚡ AURUM MT5 Bridge", font=("Segoe UI", 16, "bold"),
                 bg=bg, fg=accent).pack(pady=(16, 4))

        card = tk.Frame(self.root, bg=card_bg, highlightbackground="#334155",
                        highlightthickness=1, padx=16, pady=12)
        card.pack(padx=16, pady=(12, 8), fill="x")

        tk.Label(card, text="服务器地址", font=("Segoe UI", 9), bg=card_bg, fg=muted).grid(
            row=0, column=0, sticky="w", pady=(0, 2))
        self.server_var = tk.StringVar(value=SERVER_URL)
        sf = tk.Frame(card, bg=card_bg); sf.grid(row=1, column=0, columnspan=2, sticky="ew", pady=(0, 8))
        card.columnconfigure(0, weight=1)
        tk.Entry(sf, textvariable=self.server_var, font=("Consolas", 10),
                 bg="#0f172a", fg=text, insertbackground=text, relief="flat", bd=4
                 ).pack(side="left", fill="x", expand=True)
        tk.Button(sf, text="📋", font=("Segoe UI", 8), bg="#334155", fg=text, relief="flat",
                  padx=6, command=lambda: self._copy(self.server_var.get())).pack(side="right", padx=(4,0))

        tk.Label(card, text="认证 Token", font=("Segoe UI", 9), bg=card_bg, fg=muted).grid(
            row=2, column=0, sticky="w", pady=(0, 2))
        tf = tk.Frame(card, bg=card_bg); tf.grid(row=3, column=0, columnspan=2, sticky="ew", pady=(0, 8))
        self.token_var = tk.StringVar(value=TOKEN)
        self.token_shown = False
        self.token_entry = tk.Entry(tf, textvariable=self.token_var, font=("Consolas", 10),
                                     bg="#0f172a", fg=text, insertbackground=text, relief="flat", bd=4, show="•")
        self.token_entry.pack(side="left", fill="x", expand=True)
        tk.Button(tf, text="👁", font=("Segoe UI", 9), bg="#334155", fg=text, relief="flat",
                  padx=4, command=self._toggle_token).pack(side="right", padx=(2,0))
        tk.Button(tf, text="📋", font=("Segoe UI", 8), bg="#334155", fg=text, relief="flat",
                  padx=6, command=lambda: self._copy(self.token_var.get())).pack(side="right", padx=(4,0))

        sf2 = tk.Frame(self.root, bg=bg); sf2.pack(padx=16, pady=(4,4), fill="x")
        self.status_dot = tk.Label(sf2, text="●", font=("Segoe UI", 14), bg=bg, fg=muted)
        self.status_dot.pack(side="left")
        self.status_label = tk.Label(sf2, text="未连接", font=("Segoe UI", 11, "bold"), bg=bg, fg=muted)
        self.status_label.pack(side="left", padx=(4,0))
        self.account_label = tk.Label(sf2, text="", font=("Segoe UI", 9), bg=bg, fg=muted)
        self.account_label.pack(side="right")

        bf = tk.Frame(self.root, bg=bg); bf.pack(padx=16, pady=(4,8), fill="x")
        self.start_btn = tk.Button(bf, text="▶  启动桥接", font=("Segoe UI", 12, "bold"),
                                    bg=accent, fg="white", relief="flat", padx=20, pady=8,
                                    activebackground="#2563eb", cursor="hand2", command=self._toggle_bridge)
        self.start_btn.pack(fill="x")

        tk.Label(self.root, text="运行日志", font=("Segoe UI", 9), bg=bg, fg=muted).pack(padx=16, anchor="w")
        self.log_area = scrolledtext.ScrolledText(self.root, height=14, font=("Consolas", 9),
                                                   bg="#0f172a", fg="#94a3b8", insertbackground=text,
                                                   relief="flat", bd=4, state="disabled", wrap="word")
        self.log_area.pack(padx=16, pady=(2,12), fill="both", expand=True)

        tk.Label(self.root, text="AURUM AI · wall-street-skill.com", font=("Segoe UI", 8),
                 bg=bg, fg="#475569").pack(pady=(0,8))

    # ============ System Tray (win32gui) ============

    def _init_tray(self):
        """Create hidden message-only window for tray icon."""
        hinst = win32api.GetModuleHandle(None)
        message_map = {
            win32con.WM_COMMAND: self._on_tray_command,
            self.TRAY_WM: self._on_tray_msg,
        }
        wc = win32gui.WNDCLASS()
        wc.hInstance = hinst
        wc.lpszClassName = "AurumBridgeTray"
        wc.lpfnWndProc = message_map
        try:
            win32gui.RegisterClass(wc)
        except win32gui.error:
            pass
        self._tray_hwnd = win32gui.CreateWindow(
            "AurumBridgeTray", "AurumBridgeTray", 0, 0, 0, 0, 0,
            0, 0, hinst, None)
        # Load icon from .ico file
        self._hicon = self._load_icon()

    def _load_icon(self):
        """Load the .ico file for tray and window."""
        if getattr(sys, 'frozen', False):
            base = sys._MEIPASS
        else:
            base = os.path.dirname(os.path.abspath(__file__))
        icon_path = os.path.join(base, 'aurum_icon.ico')
        if os.path.exists(icon_path):
            large, small = win32gui.ExtractIconEx(icon_path, 0, 1)
            if large:
                win32gui.DestroyIcon(large[0])
            return small[0] if small else win32gui.LoadIcon(0, win32con.IDI_APPLICATION)
        return win32gui.LoadIcon(0, win32con.IDI_APPLICATION)

    def _show_tray(self):
        """Add icon to system tray."""
        hicon = getattr(self, '_hicon', None) or win32gui.LoadIcon(0, win32con.IDI_APPLICATION)
        self._notify_data = (
            self._tray_hwnd, 0,
            win32gui.NIF_ICON | win32gui.NIF_TIP | win32gui.NIF_MESSAGE,
            self.TRAY_WM, hicon, "AURUM MT5 Bridge"
        )
        win32gui.Shell_NotifyIcon(win32gui.NIM_ADD, self._notify_data)
        # Also set the window icon
        try:
            win32gui.SendMessage(self.root.winfo_id(), win32con.WM_SETICON, win32con.ICON_SMALL, hicon)
            win32gui.SendMessage(self.root.winfo_id(), win32con.WM_SETICON, win32con.ICON_BIG, hicon)
        except:
            pass

    def _hide_tray(self):
        """Remove icon from system tray."""
        if hasattr(self, '_notify_data') and self._notify_data:
            try:
                win32gui.Shell_NotifyIcon(win32gui.NIM_DELETE, self._notify_data)
            except:
                pass
            self._notify_data = None

    def _update_tray_tip(self, tip):
        """Update tray tooltip text."""
        if hasattr(self, '_notify_data') and self._notify_data:
            d = self._notify_data
            self._notify_data = (d[0], d[1], d[2], d[3], d[4], tip)
            try:
                win32gui.Shell_NotifyIcon(win32gui.NIM_MODIFY, self._notify_data)
            except:
                pass

    def _on_tray_command(self, hwnd, msg, wparam, lparam):
        cmd = win32api.LOWORD(wparam)
        if cmd == self.MENU_OPEN:
            self.root.after(0, self._restore_from_tray)
        elif cmd == self.MENU_START:
            if not self.running:
                self.root.after(0, self._toggle_bridge)
        elif cmd == self.MENU_STOP:
            if self.running:
                self.root.after(0, self._toggle_bridge)
        elif cmd == self.MENU_QUIT:
            self.root.after(0, self._do_quit)

    def _on_tray_msg(self, hwnd, msg, wparam, lparam):
        """Handle custom tray callback message (WM_USER + 20)."""
        if lparam == win32con.WM_LBUTTONUP:
            self.root.after(0, self._restore_from_tray)
        elif lparam == win32con.WM_RBUTTONUP:
            self._on_tray_rbuttonup(hwnd, msg, wparam, lparam)

    def _on_tray_rbuttonup(self, hwnd, msg, wparam, lparam):
        """Right-click: show context menu."""
        menu = win32gui.CreatePopupMenu()
        win32gui.AppendMenu(menu, win32con.MF_STRING, self.MENU_OPEN, "打开界面")
        win32gui.AppendMenu(menu, win32con.MF_SEPARATOR, 0, "")
        s_flag = win32con.MF_GRAYED if self.running else win32con.MF_STRING
        p_flag = win32con.MF_STRING if self.running else win32con.MF_GRAYED
        win32gui.AppendMenu(menu, s_flag, self.MENU_START, "启动桥接")
        win32gui.AppendMenu(menu, p_flag, self.MENU_STOP, "关闭桥接")
        win32gui.AppendMenu(menu, win32con.MF_SEPARATOR, 0, "")
        win32gui.AppendMenu(menu, win32con.MF_STRING, self.MENU_QUIT, "退出")
        pt = win32api.GetCursorPos()
        win32gui.SetForegroundWindow(self._tray_hwnd)
        win32gui.TrackPopupMenu(menu, win32con.TPM_RIGHTBUTTON, pt[0], pt[1], 0, self._tray_hwnd, None)
        win32gui.PostMessage(self._tray_hwnd, 0, 0, 0)
        win32gui.DestroyMenu(menu)

    def _restore_from_tray(self):
        self._hide_tray()
        self.root.after(0, self._do_restore)

    def _do_restore(self):
        self.root.deiconify()
        self.root.lift()
        self.root.focus_force()
        self._is_minimized_to_tray = False

    # ============ Window Lifecycle ============

    def _on_close(self):
        if self._tray_hwnd:
            self._show_tray()
            self.root.withdraw()
            self._is_minimized_to_tray = True
            self._log("已最小化到系统托盘")
            self._poll_tray()
        else:
            self._do_quit()

    def _poll_tray(self):
        """Pump Windows messages for the tray hidden window."""
        if not self._is_minimized_to_tray or not self._tray_hwnd:
            return
        try:
            while True:
                msg = win32gui.PeekMessage(self._tray_hwnd, 0, 0, 1)  # PM_REMOVE
                if not msg:
                    break
                win32gui.TranslateMessage(msg)
                win32gui.DispatchMessage(msg)
        except:
            pass
        if self._is_minimized_to_tray:
            self.root.after(200, self._poll_tray)

    def _do_quit(self):
        self.running = False
        try:
            if self._ws and self._ws.connected:
                self._ws.send(json.dumps({"type": "disconnect", "reason": "user_close"}))
                self._ws.close()
        except:
            pass
        if self.mt5:
            try: self.mt5.shutdown()
            except: pass
        self._hide_tray()
        self.root.destroy()

    # ============ Utilities ============

    def _copy(self, text):
        self.root.clipboard_clear(); self.root.clipboard_append(text); self._log("已复制到剪贴板")

    def _toggle_token(self):
        self.token_shown = not self.token_shown
        self.token_entry.config(show="" if self.token_shown else "•")

    def _log(self, msg):
        self.log_area.config(state="normal")
        ts = time.strftime("%H:%M:%S")
        self.log_area.insert("end", f"[{ts}] {msg}\n")
        line_count = int(self.log_area.index("end-1c").split(".")[0])
        if line_count > MAX_LOG_LINES:
            self.log_area.delete("1.0", f"{line_count - MAX_LOG_LINES}.0")
        self.log_area.see("end"); self.log_area.config(state="disabled")

    def _set_status(self, text, color, account=""):
        self.status_dot.config(fg=color); self.status_label.config(fg=color, text=text)
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
        except Exception as e:
            self._log(f"MetaTrader5 加载失败: {e}")
            if not getattr(sys, 'frozen', False):
                threading.Thread(target=self._install_mt5, daemon=True).start()

    def _install_mt5(self):
        import subprocess
        try:
            subprocess.check_call([sys.executable, "-m", "pip", "install", "MetaTrader5", "-q"])
            import MetaTrader5 as mt5; self.mt5 = mt5; self._log("MetaTrader5 安装成功")
        except Exception as e:
            self._log(f"安装失败: {e}")

    def _toggle_bridge(self):
        if self.running:
            if not messagebox.askyesno("确认停止", "确定要断开 MT5 桥接连接吗？\n\n停止后将无法自动执行交易信号。", icon="warning"):
                return
            self.running = False
            self.start_btn.config(text="▶  启动桥接", bg="#3b82f6")
            self._set_status("已停止", "#ef4444"); self._log("桥接已停止")
            self._update_tray_tip("AURUM Bridge - 已停止")
        else:
            server, token = self.server_var.get().strip(), self.token_var.get().strip()
            if not server or not token:
                missing = []
                if not server: missing.append("服务器地址")
                if not token: missing.append("Token")
                messagebox.showwarning("信息不完整", f"{' 和 '.join(missing)} 为空！\n\n请手动填写，或从网站下载 config.json 放到本程序目录。")
                return
            self.running = True
            self.start_btn.config(text="■  停止桥接", bg="#ef4444")
            self._set_status("连接中...", "#f59e0b"); self._log("启动桥接...")
            self._update_tray_tip("AURUM Bridge - 运行中")
            self.bridge_thread = threading.Thread(target=self._bridge_loop, daemon=True)
            self.bridge_thread.start()

    def _resolve_symbol(self, symbol):
        requested = str(symbol or "").strip()
        if not requested: raise RuntimeError("Symbol is required")
        symbols = self.mt5.symbols_get()
        if symbols is None: raise RuntimeError("MT5 symbols_get failed")
        for item in symbols:
            if item.name == requested: return item.name
        for item in symbols:
            if item.name.upper() == requested.upper(): return item.name
        for fb in [requested+".s", requested+"m", requested+".c", requested+"_", requested+".micro"]:
            for item in symbols:
                if item.name.upper() == fb.upper(): return item.name
        for item in symbols:
            if item.name.upper().startswith(requested.upper()+".") or item.name.upper().startswith(requested.upper()+"_"):
                return item.name
        raise RuntimeError(f"Symbol not found in MT5: {requested}")

    def _get_filling_mode(self, symbol):
        info = self.mt5.symbol_info(symbol)
        if not info: return self.mt5.ORDER_FILLING_IOC
        fm = int(getattr(info, "filling_mode", 0) or 0)
        cands = []
        if fm & 1: cands.append(self.mt5.ORDER_FILLING_FOK)
        if fm & 2: cands.append(self.mt5.ORDER_FILLING_IOC)
        if not cands: cands = [self.mt5.ORDER_FILLING_RETURN, self.mt5.ORDER_FILLING_FOK, self.mt5.ORDER_FILLING_IOC]
        return self.mt5.ORDER_FILLING_FOK if self.mt5.ORDER_FILLING_FOK in cands else cands[0]

    def _process_command(self, cmd):
        action = cmd.get("action"); params = cmd.get("params", {})
        try:
            if action == "open":
                symbol = self._resolve_symbol(params.get("symbol"))
                self.mt5.symbol_select(symbol, True)
                info = self.mt5.symbol_info(symbol); tick = self.mt5.symbol_info_tick(symbol)
                if not info: return {"status": "error", "message": f"Symbol not available: {symbol}"}
                if not tick: return {"status": "error", "message": f"Invalid live quote for {symbol}"}
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
                    sym = self._resolve_symbol(params.get("symbol")) if params.get("symbol") else None
                    positions = self.mt5.positions_get(symbol=sym) if sym else self.mt5.positions_get()
                    if not positions: return {"status": "success", "message": "No positions"}
                    for pos in positions:
                        ct = self.mt5.ORDER_TYPE_SELL if pos.type == self.mt5.ORDER_TYPE_BUY else self.mt5.ORDER_TYPE_BUY
                        self.mt5.order_send({"action": self.mt5.TRADE_ACTION_DEAL, "symbol": pos.symbol,
                            "volume": pos.volume, "type": ct, "position": pos.ticket, "magic": 234000,
                            "type_filling": self._get_filling_mode(pos.symbol)})
                    return {"status": "success", "closed": len(positions)}

            elif action == "close_all":
                positions = self.mt5.positions_get()
                if not positions: return {"status": "success", "closed": 0}
                for pos in positions:
                    ct = self.mt5.ORDER_TYPE_SELL if pos.type == self.mt5.ORDER_TYPE_BUY else self.mt5.ORDER_TYPE_BUY
                    self.mt5.order_send({"action": self.mt5.TRADE_ACTION_DEAL, "symbol": pos.symbol,
                        "volume": pos.volume, "type": ct, "position": pos.ticket, "magic": 234000,
                        "type_filling": self._get_filling_mode(pos.symbol)})
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
                    out = [{"time": _mt5_time(int(r[0])), "open": float(r[1]), "high": float(r[2]),
                            "low": float(r[3]), "close": float(r[4]), "tick_volume": int(r[5]),
                            "spread": int(r[6]) if len(r) > 6 else 0} for r in rates]
                    return {"status": "success", "symbol": symbol, "timeframe": params.get("timeframe","M30"),
                            "count": len(out), "rates": out, "source": "mt5"}
                return {"status": "success", "symbol": symbol, "rates": [], "source": "mt5"}

            elif action == "quote":
                symbol = self._resolve_symbol(params.get("symbol"))
                self.mt5.symbol_select(symbol, True)
                tick = self.mt5.symbol_info_tick(symbol); info = self.mt5.symbol_info(symbol)
                if not tick: return {"status": "error", "message": f"MT5 quote failed for {symbol}"}
                return {"status": "success", "symbol": symbol, "bid": tick.bid, "ask": tick.ask,
                        "spread": round(info.spread * info.point, info.digits) if info else 0,
                        "time": _mt5_time(tick.time), "digits": info.digits if info else 2,
                        "point": info.point if info else 0.01, "source": "mt5"}

            elif action == "positions":
                sym = params.get("symbol")
                if sym: sym = self._resolve_symbol(sym)
                positions = self.mt5.positions_get(symbol=sym) if sym else self.mt5.positions_get()
                if positions:
                    payload = [{"ticket": p.ticket, "symbol": p.symbol, "type": "buy" if p.type==0 else "sell",
                        "volume": p.volume, "open_price": p.price_open, "price_open": p.price_open,
                        "price_current": p.price_current, "profit": p.profit, "sl": p.sl, "tp": p.tp,
                        "swap": p.swap, "magic": p.magic, "comment": p.comment,
                        "time": _mt5_time(getattr(p,'time',0)), "source": "mt5"} for p in positions]
                    return {"status": "success", "positions": payload, "count": len(payload), "source": "mt5"}
                return {"status": "success", "positions": [], "count": 0, "source": "mt5"}

            elif action == "symbols":
                symbols = self.mt5.symbols_get()
                if symbols is None: return {"status": "error", "message": "MT5 symbols_get failed"}
                payload = [{"name": s.name, "description": s.description, "currency_base": s.currency_base,
                    "currency_profit": s.currency_profit, "currency_margin": s.currency_margin,
                    "digits": s.digits, "trade_mode": s.trade_mode, "point": s.point} for s in symbols]
                return {"status": "success", "symbols": payload, "source": "mt5"}

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

            elif action == "history":
                import math
                page = params.get("page", 1); page_size = params.get("page_size", 20)
                deposit = withdrawal = credit = 0.0
                date_to = datetime.utcnow() + timedelta(days=1)
                date_from = date_to - timedelta(days=31)
                deals = self.mt5.history_deals_get(date_from, date_to)
                if deals is None: return {"status": "error", "message": f"MT5 history_deals_get failed: {self.mt5.last_error()}"}
                deal_rows = [d._asdict() for d in deals]
                deals_by_pos = {}
                balance_type = getattr(self.mt5, "DEAL_TYPE_BALANCE", 2)
                credit_type = getattr(self.mt5, "DEAL_TYPE_CREDIT", 3)
                for d in deal_rows:
                    if d.get("type") == balance_type:
                        amt = float(d.get("profit") or 0)
                        if amt >= 0: deposit += amt
                        else: withdrawal += abs(amt)
                    if d.get("type") == credit_type: credit += float(d.get("profit") or 0)
                    key = d.get("position_id") or d.get("order") or d.get("ticket")
                    deals_by_pos.setdefault(key, []).append(d)
                si_cache = {}
                def sp(sym):
                    if not sym: return None
                    if sym not in si_cache: si_cache[sym] = self.mt5.symbol_info(sym)
                    i = si_cache.get(sym); p = getattr(i, "point", None) if i else None
                    return float(p) if p else None
                rows = []
                entry_out = getattr(self.mt5, "DEAL_ENTRY_OUT", 1)
                entry_inout = getattr(self.mt5, "DEAL_ENTRY_INOUT", 2)
                entry_in = getattr(self.mt5, "DEAL_ENTRY_IN", 0)
                deal_type_buy = getattr(self.mt5, "DEAL_TYPE_BUY", 0)
                for d in deal_rows:
                    if d.get("entry") not in (entry_out, entry_inout): continue
                    pid = d.get("position_id") or d.get("order") or d.get("ticket")
                    grp = deals_by_pos.get(pid, [])
                    ed = next((i for i in grp if i.get("entry") == entry_in), None)
                    sd = ed or d
                    direction = "BUY" if sd.get("type") == deal_type_buy else "SELL"
                    sym = d.get("symbol") or (ed or {}).get("symbol")
                    ep = (ed or {}).get("price"); xp = d.get("price"); pt = sp(sym)
                    pp = None
                    if ep and xp and pt:
                        pp = round((float(xp)-float(ep))/pt, 1) if direction=="BUY" else round((float(ep)-float(xp))/pt, 1)
                    eo = (ed or {}).get("order") or pid
                    rows.append({"ticket": eo, "deal_ticket": d.get("ticket"), "order": eo,
                        "close_order": d.get("order"), "position_id": pid, "symbol": sym,
                        "type": direction, "volume": d.get("volume"), "entry_price": ep, "exit_price": xp,
                        "price": xp, "profit": d.get("profit"), "swap": d.get("swap"),
                        "commission": d.get("commission"), "profit_points": pp,
                        "entry_time": _mt5_time((ed or {}).get("time")),
                        "close_time": _mt5_time(d.get("time")), "time": _mt5_time(d.get("time")),
                        "comment": d.get("comment")})
                rows.sort(key=lambda r: r.get("close_time") or r.get("entry_time") or "", reverse=True)
                total = len(rows); si = max(page-1,0)*page_size
                pr = rows[si:si+page_size]
                tp = sum(float(r.get("profit") or 0) for r in rows)
                nr = tp+credit+deposit-withdrawal
                ab = 10000.0
                try:
                    acc = self.mt5.account_info()
                    if acc: ab = float(acc.balance)
                except: pass
                return {"status": "success", "orders": pr, "statistics": {
                    "account_principal": round(ab-nr,2), "account_balance": round(ab,2),
                    "total_profit": round(tp,2), "credit": round(credit,2), "deposit": round(deposit,2),
                    "withdrawal": round(withdrawal,2), "net_result": round(nr,2),
                    "trade_count": total, "total_volume": round(sum(float(r.get("volume") or 0) for r in rows),2)},
                    "pagination": {"current_page": page, "page_size": page_size,
                        "total_count": total, "total_pages": max(math.ceil(total/page_size),1)}, "source": "mt5"}

            elif action == "diagnostics":
                acc = self.mt5.account_info(); terminal = self.mt5.terminal_info()
                return {"status": "success", "mt5_connected": True,
                    "account": {"login": acc.login, "server": acc.server, "balance": acc.balance} if acc else None,
                    "terminal": {"build": terminal.build, "connected": terminal.connected,
                        "trade_allowed": terminal.trade_allowed} if terminal else None}

            elif action == "toggle_trade":
                self._trade_enabled = params.get("enable", False)
                return {"status": "success", "live_trading_enabled": self._trade_enabled}

            elif action == "set_quote_symbol":
                self._resolved_symbol = self._resolve_symbol(params.get("symbol", "XAUUSD"))
                return {"status": "success", "symbol": self._resolved_symbol}

            else:
                return {"status": "error", "message": f"unknown action: {action}"}
        except Exception as e:
            return {"status": "error", "message": str(e)}

    # ============ Bridge Loop with Auto-Reconnect ============

    def _bridge_loop(self):
        if not self.mt5:
            try:
                import MetaTrader5 as mt5; self.mt5 = mt5
            except:
                self.root.after(0, self._log, "错误: MetaTrader5 未安装")
                self.root.after(0, self._toggle_bridge); return

        if not self.mt5.initialize():
            self.root.after(0, self._log, f"MT5 初始化失败: {self.mt5.last_error()}")
            self.root.after(0, self._toggle_bridge); return

        info = self.mt5.account_info()
        if info:
            self.root.after(0, self._log, f"MT5 已连接: {info.login} @ {info.server}  余额: ${info.balance:,.2f}")

        if not HAS_WS:
            self.root.after(0, self._log, "错误: websocket-client 未安装")
            self.root.after(0, self._toggle_bridge); return

        server = self.server_var.get().replace("http://","ws://").replace("https://","wss://").rstrip("/")
        ws_url = f"{server}/aurum-api/bridge/ws?type=bridge&token={self.token_var.get()}"
        self.root.after(0, self._log, f"连接 WebSocket: {server}/aurum-api/bridge/ws")

        MAX_RETRY = 300; RETRY_INT = 5

        while self.running:
            retry_start = time.time(); connected = False

            while self.running:
                elapsed = time.time() - retry_start
                if elapsed >= MAX_RETRY:
                    self.root.after(0, self._log, "连接失败：已重试5分钟，停止自动重试")
                    self.root.after(0, self._set_status, "连接失败", "#ef4444", "")
                    self.root.after(0, self._toggle_bridge)
                    if self.mt5: self.mt5.shutdown()
                    return
                try:
                    ws = websocket.create_connection(ws_url, timeout=10, header=["Origin: http://localhost"])
                    self._ws = ws; connected = True
                    self.root.after(0, self._log, "WebSocket 已连接"); break
                except Exception as e:
                    rc = int(elapsed // RETRY_INT) + 1
                    self.root.after(0, self._log, f"连接失败 (第{rc}次): {e}，{RETRY_INT}秒后重试...")
                    self.root.after(0, self._set_status, f"重连中... ({rc})", "#f59e0b", "")
                    time.sleep(RETRY_INT)

            if not connected or not self.running: break

            self._resolved_symbol = self._resolve_symbol("XAUUSD") if self.mt5 else "XAUUSD"
            last_hb = 0; last_data = 0

            while self.running:
                now = time.time()
                if now - last_data >= 1.0:
                    try:
                        acc = self.mt5.account_info(); sym = getattr(self, '_resolved_symbol', 'XAUUSD')
                        tick = self.mt5.symbol_info_tick(sym); positions = self.mt5.positions_get() or []
                        dm = {"type": "data", "account": {
                            "login": acc.login if acc else None, "balance": round(acc.balance,2) if acc else None,
                            "equity": round(acc.equity,2) if acc else None, "margin": round(acc.margin,2) if acc else None,
                            "free_margin": round(acc.margin_free,2) if acc else None, "profit": round(acc.profit,2) if acc else None,
                            "server": acc.server if acc else None}, "quote": {"symbol": sym,
                            "bid": round(tick.bid,5) if tick else None, "ask": round(tick.ask,5) if tick else None,
                            "spread": round((tick.ask-tick.bid)/(0.01 if "JPY" not in sym else 0.001),1) if tick else None,
                            "time": _mt5_time(tick.time) if tick else time.strftime("%Y-%m-%d %H:%M:%S")},
                            "positions": [{"ticket": p.ticket, "symbol": p.symbol, "type": "buy" if p.type==0 else "sell",
                                "volume": p.volume, "open_price": p.price_open, "current_price": p.price_current,
                                "profit": round(p.profit,2), "sl": p.sl, "tp": p.tp,
                                "swap": p.swap, "commission": getattr(p,'commission',0)} for p in positions],
                            "live_trading_enabled": self._trade_enabled}
                        ws.send(json.dumps(dm))
                        if acc:
                            self.root.after(0, self._set_status, "MT5桥接-已连接", "#22c55e",
                                           f"{acc.login} @ {acc.server}  ${acc.balance:,.2f}")
                        last_data = now
                    except Exception as e:
                        self.root.after(0, self._log, f"数据推送错误: {e}")

                if now - last_hb > 10:
                    try: ws.send(json.dumps({"type": "hb"})); last_hb = now
                    except Exception as e: self.root.after(0, self._log, f"心跳错误: {e}")

                ws.settimeout(0.3)
                try:
                    data = ws.recv()
                    if data:
                        msg = json.loads(data)
                        if msg.get("type") == "command":
                            self.root.after(0, self._log, f"执行: {msg['action']}")
                            try: resp = self._process_command(msg)
                            except Exception as ce: resp = {"status": "error", "message": str(ce)}
                            ws.send(json.dumps({"type": "result", "command_id": msg["command_id"], "result": resp}))
                            self.root.after(0, self._log, f"完成: {json.dumps(resp, ensure_ascii=False)[:80]}")
                except websocket.WebSocketTimeoutException: pass
                except websocket.WebSocketConnectionClosedException:
                    self.root.after(0, self._log, "WebSocket 连接已断开"); break
                except Exception as e:
                    self.root.after(0, self._log, f"接收错误: {e}"); break

            try:
                if ws and ws.connected:
                    ws.send(json.dumps({"type": "disconnect", "reason": "client_reconnect"})); ws.close()
            except: pass
            self._ws = None
            if not self.running: break
            self.root.after(0, self._log, f"连接断开，{RETRY_INT}秒后自动重连...")
            self.root.after(0, self._set_status, "重连中...", "#f59e0b", "")
            time.sleep(RETRY_INT)

        if self.mt5: self.mt5.shutdown()
        self.root.after(0, self._log, "MT5 已断开")

    # ============ Entry ============

    def run(self):
        self.root.protocol("WM_DELETE_WINDOW", self._on_close)
        self.root.mainloop()


if __name__ == "__main__":
    app = AurumBridge()
    app.run()
