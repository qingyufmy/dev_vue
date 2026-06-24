# -*- coding: utf-8 -*-
"""
AURUM Updater - 独立更新器 (GUI版)
用法: aurum_updater.exe <server_url> <dst_exe> <old_pid>
"""
import sys
import ssl

def _get_ssl_context():
    """安全获取 SSL context，不使用 CERT_NONE 降级"""
    try:
        import certifi
        return ssl.create_default_context(cafile=certifi.where())
    except ImportError:
        pass
    try:
        return ssl.create_default_context()
    except Exception:
        pass
    raise RuntimeError("SSL 证书验证不可用，请安装 certifi (pip install certifi)")
import os
import time
import subprocess
import json
import shutil
import ssl
import urllib.request
import threading
import tkinter as tk
from tkinter import ttk

# ── Colors ──
BG = "#1e1e2e"
FG = "#cdd6f4"
ACCENT = "#f5c518"
RED = "#f38ba8"
GREEN = "#a6e3a1"
MUTED = "#6c7086"

class UpdaterGUI:
    def __init__(self):
        self.root = tk.Tk()
        self.root.title("AURUM 更新器")
        self.root.geometry("380x200")
        self.root.resizable(False, False)
        self.root.configure(bg=BG)
        # Center
        self.root.update_idletasks()
        w, h = 380, 200
        x = (self.root.winfo_screenwidth() - w) // 2
        y = (self.root.winfo_screenheight() - h) // 2
        self.root.geometry(f"{w}x{h}+{x}+{y}")

        # ── Title ──
        tk.Label(self.root, text="AURUM Bridge 更新", font=("Segoe UI", 14, "bold"),
                 bg=BG, fg=ACCENT).pack(pady=(20, 5))

        # ── Status ──
        self.lbl_status = tk.Label(self.root, text="准备中...", font=("Segoe UI", 10),
                                   bg=BG, fg=FG)
        self.lbl_status.pack(pady=(10, 5))

        # ── Progress ──
        style = ttk.Style()
        style.theme_use("default")
        style.configure("AURUM.Horizontal.TProgressbar",
                         troughcolor="#313244", background=ACCENT, thickness=12)
        self.progress = ttk.Progressbar(self.root, length=300, mode="determinate",
                                        style="AURUM.Horizontal.TProgressbar")
        self.progress.pack(pady=(5, 5))

        # ── Detail ──
        self.lbl_detail = tk.Label(self.root, text="", font=("Segoe UI", 9),
                                   bg=BG, fg=MUTED)
        self.lbl_detail.pack(pady=(0, 10))

    def set_status(self, text, color=FG):
        # 使用 after() 将 GUI 操作调度到主线程（Tkinter 不是线程安全的）
        self.root.after(0, lambda: self.lbl_status.config(text=text, fg=color))

    def set_progress(self, value):
        self.root.after(0, lambda v=value: self._set_progress_safe(v))

    def _set_progress_safe(self, value):
        self.progress["value"] = value

    def set_detail(self, text):
        self.root.after(0, lambda: self.lbl_detail.config(text=text))

    def run(self, task_fn):
        """Run task_fn in background thread, GUI stays responsive."""
        threading.Thread(target=task_fn, daemon=True).start()
        self.root.mainloop()


def main():
    if len(sys.argv) < 4:
        tk.Tk().withdraw()
        from tkinter import messagebox
        messagebox.showerror("AURUM 更新器", "参数不足。\n用法: aurum_updater.exe <server_url> <dst_exe> <old_pid>")
        return

    server_url = sys.argv[1].rstrip("/")
    dst_exe = sys.argv[2]
    try:
        old_pid = int(sys.argv[3])
    except ValueError:
        tk.Tk().withdraw()
        from tkinter import messagebox
        messagebox.showerror("AURUM 更新器", f"无效的进程PID: {sys.argv[3]}")
        return

    gui = UpdaterGUI()

    def do_update():
        # --- SSL ---
        ctx = _get_ssl_context()

        # --- 1. Check version ---
        gui.set_status("正在检查版本...", MUTED)
        try:
            req = urllib.request.Request(f"{server_url}/aurum-api/bridge/version",
                                         headers={"User-Agent": "AURUM-Updater/1.0"})
            with urllib.request.urlopen(req, timeout=15, context=ctx) as resp:
                data = json.loads(resp.read().decode())
                download_url = data["download_url"]
                if download_url.startswith("/"):
                    download_url = f"{server_url}{download_url}"
                ver = data.get("version", "?")
                gui.set_detail(f"目标版本: {ver}")
        except Exception as e:
            gui.set_status(f"获取版本失败", RED)
            gui.set_detail(str(e))
            return

        # --- 2. Download ---
        gui.set_status("正在下载新版本...", FG)
        tmp_exe = dst_exe + ".new"
        try:
            req = urllib.request.Request(download_url, headers={"User-Agent": "AURUM-Updater/1.0"})
            with urllib.request.urlopen(req, timeout=300, context=ctx) as resp:
                total = int(resp.headers.get("Content-Length", 0))
                downloaded = 0
                last_pct = -1
                with open(tmp_exe, "wb") as f:
                    while True:
                        chunk = resp.read(65536)
                        if not chunk:
                            break
                        f.write(chunk)
                        downloaded += len(chunk)
                        if total > 0:
                            pct = int(downloaded * 100 / total)
                            gui.set_progress(pct)
                            if pct != last_pct:
                                mb = downloaded / 1048576
                                total_mb = total / 1048576
                                gui.set_detail(f"{mb:.1f} / {total_mb:.1f} MB")
                                last_pct = pct
            gui.set_detail(f"下载完成 ({downloaded // 1048576} MB)")
        except Exception as e:
            gui.set_status("下载失败", RED)
            gui.set_detail(str(e))
            _cleanup(tmp_exe)
            return

        # --- 3. Wait old process ---
        gui.set_status("等待旧进程退出...", FG)
        gui.set_detail(f"PID: {old_pid}")
        _wait_pid_exit(gui, old_pid, timeout=30)

        # --- 4. Replace ---
        gui.set_status("正在替换文件...", FG)
        gui.set_detail("")
        ok = False
        for attempt in range(15):
            try:
                shutil.copy2(tmp_exe, dst_exe)
                ok = True
                break
            except Exception:
                gui.set_detail(f"重试 {attempt + 1}/15...")
                time.sleep(2)

        _cleanup(tmp_exe)

        if not ok:
            gui.set_status("替换失败!", RED)
            gui.set_detail("请手动替换或关闭程序后重试")
            return

        gui.set_progress(100)

        # --- 5. Launch ---
        gui.set_status("正在启动新版本...", GREEN)
        try:
            subprocess.Popen([dst_exe], shell=False,
                             creationflags=subprocess.DETACHED_PROCESS | subprocess.CREATE_NO_WINDOW)
        except Exception as e:
            gui.set_status("启动失败", RED)
            gui.set_detail(str(e))
            return

        # --- 6. Exit cleanly (no self-delete, avoids _MEI race) ---
        time.sleep(1)
        gui.root.destroy()
        os._exit(0)

    gui.run(do_update)


def _wait_pid_exit(gui, pid, timeout=30):
    import ctypes
    import ctypes.wintypes
    kernel32 = ctypes.windll.kernel32
    for i in range(timeout):
        try:
            handle = kernel32.OpenProcess(0x1000, False, pid)
            if handle:
                exit_code = ctypes.wintypes.DWORD()
                kernel32.GetExitCodeProcess(handle, ctypes.byref(exit_code))
                kernel32.CloseHandle(handle)
                if exit_code.value != 259:
                    return True
            else:
                return True
        except Exception:
            return True
        gui.set_detail(f"等待中... {i + 1}s")
        time.sleep(1)

    gui.set_detail("超时，强制结束旧进程...")
    subprocess.run(f"taskkill /f /pid {pid}", shell=True,
                   stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    time.sleep(2)
    return True


def _cleanup(path):
    try:
        if os.path.exists(path):
            os.remove(path)
    except Exception:
        pass


def _self_delete():
    import tempfile
    me = sys.executable if getattr(sys, "frozen", False) else os.path.abspath(__file__)
    bat = os.path.join(tempfile.gettempdir(), f"aurum_del_{os.getpid()}.bat")
    with open(bat, "w", encoding="gbk") as f:
        f.write(f'@echo off\r\nchcp 936 >nul\r\ntimeout /t 3 /nobreak >nul\r\ndel "{me}" >nul 2>&1\r\ndel "{bat}"\r\n')
    subprocess.Popen(["cmd", "/c", bat], shell=False,
                     creationflags=subprocess.CREATE_NO_WINDOW)


if __name__ == "__main__":
    main()
