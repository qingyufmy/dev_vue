# -*- coding: utf-8 -*-
"""
AURUM Bridge - MT5 桥接桌面客户端 (PySide6)
功能：登录验证、MT5 数据桥接、自动重连
配置存储：%APPDATA%\\AURUM_Bridge\\config.json
"""
import sys
import os
import ssl
import json
import time
import math
import re
from bridge_order_result import (
    classify_deal_result, parse_required_order_volume,
    retryable_trade_retcodes,
)
from bridge_order_idempotency import lookup_existing_execution
import asyncio
import concurrent.futures
import threading
import ctypes
import ctypes.wintypes
from collections.abc import Mapping
from datetime import datetime, timezone, timedelta
from bridge_config_store import BridgeConfigStore
from bridge_http_client import (
    MAX_JSON_RESPONSE_BYTES, encode_json_body, validate_bridge_http_url,
    normalize_server_url, request_json,
)

# ── PySide6 ──
from PySide6.QtWidgets import (
    QApplication, QMainWindow, QWidget, QStackedWidget,
    QVBoxLayout, QHBoxLayout, QLabel, QLineEdit, QPushButton,
    QCheckBox, QTextEdit, QFrame, QSystemTrayIcon,
    QMenu, QMessageBox, QStyle, QComboBox, QFileDialog,
)
from PySide6.QtCore import Qt, Signal, QTimer, QThread, QObject, QUrl
from PySide6.QtGui import (
    QFont, QColor, QIcon, QAction, QPainter, QPen, QBrush, QPainterPath,
)
from PySide6.QtNetwork import QNetworkAccessManager, QNetworkReply, QNetworkRequest
from bridge_source_launcher import NewObserverSourceDialog, launch_bridge_profile
from bridge_profile_runtime import (
    acquire_instance_mutex, activate_profile_window, clear_profile_runtime,
    find_mt5_path_owner, find_source_account_owner, list_bridge_profiles,
    migrate_profile_config_secrets, normalize_profile, profile_config_dir, read_profile_runtime,
    register_bridge_profile, write_profile_config, write_profile_runtime,
)

APP_VERSION = "v2.4.8"
FULL_HISTORY_START = datetime(2000, 1, 1)
APP_NAME = "AI交易实验室"
MAX_LOG_LINES = 500
MAX_LOG_MESSAGE_CHARS = 1000
MT5_COLLECT_TIMEOUT_SEC = 3
SYSTEM_TRADE_MAGIC = 234000
DEFAULT_MT5_TIMEZONE_OFFSET_MINUTES = 180
MT5_CLOCK_FRESHNESS_TOLERANCE_MS = 30000
MT5_CLOCK_STALE_AFTER_SEC = 120
def _resolve_bridge_profile(argv=None):
    """Read Bridge-only flags without leaking them into Qt."""
    args = list(argv or sys.argv)
    cleaned = [args[0]] if args else []
    requested = os.environ.get("AURUM_BRIDGE_PROFILE", "default")
    index = 1
    while index < len(args):
        item = args[index]
        if item == "--profile" and index + 1 < len(args):
            requested = args[index + 1]
            index += 2
            continue
        if item.startswith("--profile="):
            requested = item.split("=", 1)[1]
            index += 1
            continue
        cleaned.append(item)
        index += 1
    return normalize_profile(requested), cleaned


BRIDGE_PROFILE, QT_ARGV = _resolve_bridge_profile()
CONFIG_ROOT = os.path.join(os.environ.get("APPDATA", os.path.expanduser("~")), "AURUM_Bridge")
# Keep the legacy directory for the default instance; named instances are
# completely isolated so multiple source accounts can run on one computer.
CONFIG_DIR = profile_config_dir(CONFIG_ROOT, BRIDGE_PROFILE)

# Bundle resource path — compatible with PyInstaller and Nuitka
if getattr(sys, 'frozen', False):
    if getattr(sys, '_MEIPASS', None):
        BUNDLE_DIR = sys._MEIPASS
    else:
        BUNDLE_DIR = os.path.dirname(sys.executable)
else:
    BUNDLE_DIR = os.path.dirname(os.path.abspath(__file__))

def resource_path(relative):
    return os.path.join(BUNDLE_DIR, relative)
CONFIG_PATH = os.path.join(CONFIG_DIR, "config.json")
_CONFIG_STORE = BridgeConfigStore(CONFIG_PATH)
DEFAULT_SERVER = "https://www.cnfxtrade.com/"

os.makedirs(CONFIG_DIR, exist_ok=True)
try:
    migration_report = migrate_profile_config_secrets(CONFIG_ROOT)
    migrated_profiles = migration_report.get("migrated", [])
    failed_profile_migrations = migration_report.get("failed", [])
    if migrated_profiles:
        print(f"[Bridge] 已安全迁移 {len(migrated_profiles)} 个配置档案的本机凭据")
    for failed_profile in failed_profile_migrations:
        print(f"[Bridge] 档案 {failed_profile['slug']} 的凭据无法迁移: {failed_profile['error']}")
except Exception as error:
    print(f"[Bridge] 配置凭据迁移失败: {error}")

# ══════════════════════════════════════════════════════════
#  Config helpers
# ══════════════════════════════════════════════════════════

def load_config():
    try:
        return _CONFIG_STORE.load()
    except Exception as e:
        print(f"[Bridge] 加载配置失败: {e}")
        return {}

def save_config(cfg):
    try:
        _CONFIG_STORE.save(cfg)
        return True
    except Exception as e:
        print(f"[Bridge] 保存配置失败: {e}")
        return False

def update_config(patch):
    try:
        _CONFIG_STORE.update(patch)
        return True
    except Exception as e:
        print(f"[Bridge] 更新配置失败: {e}")
        return False

import base64

# ══════════════════════════════════════════════════════════
#  File logging
# ══════════════════════════════════════════════════════════

LOG_DIR = os.path.join(CONFIG_DIR, "logs")
os.makedirs(LOG_DIR, exist_ok=True)
_LOG_LOCK = threading.RLock()


def _is_sensitive_log_key(key):
    normalized = str(key).strip().lower().replace("-", "_")
    return (
        normalized in {"authorization", "cookie", "set_cookie"}
        or any(marker in normalized for marker in ("token", "password", "secret", "api_key"))
    )


def _mask_log_text(value):
    if isinstance(value, Mapping):
        return str({
            str(key): "[已脱敏]" if _is_sensitive_log_key(key) else _mask_log_text(item)
            for key, item in value.items()
        })
    if isinstance(value, (list, tuple)):
        return str([_mask_log_text(item) for item in value])
    text = str(value)
    dict_pattern = r"""(?i)(['"]?(?:authorization|cookie|set-cookie|access_token|refresh_token|token|password|saved_password|secret|api_key)['"]?\s*:\s*['"])[^'"]+(['"])"""
    text = re.sub(dict_pattern, r"\1[已脱敏]\2", text)
    patterns = [
        (r"(?i)(authorization\s*[:=]\s*bearer\s+)[^\s,;]+", r"\1[已脱敏]"),
        (r"(?i)(authorization\s*[:=]\s*)[^\s,;]+", r"\1[已脱敏]"),
        (r"(?i)(cookie\s*[:=]\s*)[^,\n\r]+", r"\1[已脱敏]"),
        (r"(?i)((?:access_token|refresh_token|token|password|saved_password|secret|api_key)\s*[:=]\s*)[^&\s,;]+", r"\1[已脱敏]"),
        (r"(?i)([?&]ticket=)[^&\s,;]+", r"\1[已脱敏]"),
        (r"(?i)(bearer\s+)[^\s,;]+", r"\1[已脱敏]"),
    ]
    for pattern, replacement in patterns:
        text = re.sub(pattern, replacement, text)
    return text

def _get_log_file():
    today = datetime.now().strftime("%Y-%m-%d")
    return os.path.join(LOG_DIR, f"bridge_{today}.log")

def _cleanup_old_logs():
    """删除7天前的日志文件"""
    try:
        cutoff = datetime.now() - timedelta(days=7)
        for f in os.listdir(LOG_DIR):
            if f.startswith("bridge_") and f.endswith(".log"):
                date_str = f[7:-4]  # bridge_YYYY-MM-DD.log
                try:
                    file_date = datetime.strptime(date_str, "%Y-%m-%d")
                    if file_date < cutoff:
                        os.remove(os.path.join(LOG_DIR, f))
                except (ValueError, OSError):
                    pass
    except Exception:
        pass

def log_to_file(level, message):
    """写入日志文件"""
    try:
        timestamp = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
        safe_message = _mask_log_text(message)
        if len(safe_message) > 4000:
            safe_message = safe_message[:4000] + "...[日志过长，已截断]"
        line = f"[{timestamp}] [{level}] {safe_message}\n"
        with _LOG_LOCK:
            with open(_get_log_file(), "a", encoding="utf-8") as f:
                f.write(line)
    except Exception:
        pass

def log_error(message):
    safe_message = _mask_log_text(message)
    print(f"[Bridge] ERROR: {safe_message}")
    log_to_file("ERROR", safe_message)

def log_warn(message):
    safe_message = _mask_log_text(message)
    print(f"[Bridge] WARN: {safe_message}")
    log_to_file("WARN", safe_message)

_cleanup_old_logs()

# ══════════════════════════════════════════════════════════
#  HTTP helpers
# ══════════════════════════════════════════════════════════

import urllib.parse


def _get_ssl_context():
    """Create optimized SSL context for websockets (TLS 1.2+, modern ciphers)."""
    import ssl
    try:
        ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_CLIENT)
        ctx.minimum_version = ssl.TLSVersion.TLSv1_2
        ctx.set_ciphers('ECDHE+AESGCM:ECDHE+CHACHA20:DHE+AESGCM:ECDHE+AES')
        ctx.check_hostname = True
        ctx.verify_mode = ssl.CERT_REQUIRED
        try:
            import certifi
            ctx.load_verify_locations(cafile=certifi.where())
        except ImportError:
            ctx.load_default_certs()
        return ctx
    except Exception:
        # Fallback to system default
        try:
            return ssl.create_default_context()
        except Exception:
            raise RuntimeError(
                "SSL 证书验证不可用。请检查 Python 安装或安装 certifi 包 (pip install certifi)"
            )

def http_get_json(url, timeout=10, token=None):
    try:
        ssl_context = _get_ssl_context() if urllib.parse.urlsplit(str(url or "")).scheme == "https" else None
        return request_json(url, timeout=timeout, token=token, ssl_context=ssl_context)
    except Exception as error:
        return 0, {"error": str(error)}

def http_post_json(url, data, timeout=10, token=None):
    try:
        ssl_context = _get_ssl_context() if urllib.parse.urlsplit(str(url or "")).scheme == "https" else None
        return request_json(url, data=data, timeout=timeout, token=token, ssl_context=ssl_context)
    except Exception as error:
        return 0, {"error": str(error)}


class AsyncJsonRequest(QObject):
    """One bounded, redirect-free JSON request driven by the Qt event loop."""

    completed = Signal(int, object)

    def __init__(self, url, data=None, timeout=10, token=None, parent=None):
        super().__init__(parent)
        self.url = str(url)
        self.data = data
        self.timeout_ms = max(1, int(float(timeout) * 1000))
        self.token = str(token or "")
        self.manager = QNetworkAccessManager(self)
        self.reply = None
        self.body = bytearray()
        self.too_large = False

    def start(self):
        try:
            validate_bridge_http_url(self.url)
            body = None if self.data is None else encode_json_body(self.data)
        except (TypeError, ValueError) as error:
            QTimer.singleShot(0, lambda message=str(error): self._finish_without_reply(message))
            return
        request = QNetworkRequest(QUrl(self.url))
        request.setTransferTimeout(self.timeout_ms)
        request.setAttribute(QNetworkRequest.RedirectPolicyAttribute, QNetworkRequest.ManualRedirectPolicy)
        request.setRawHeader(b"User-Agent", b"AURUM-Bridge/1.0")
        if self.token:
            request.setRawHeader(b"Authorization", f"Bearer {self.token}".encode("utf-8"))
        if self.data is None:
            self.reply = self.manager.get(request)
        else:
            request.setRawHeader(b"Content-Type", b"application/json")
            self.reply = self.manager.post(request, body)
        self.reply.readyRead.connect(self._read_available)
        self.reply.finished.connect(self._finish)

    def _finish_without_reply(self, message):
        self.completed.emit(0, {"error": str(message)})
        self.deleteLater()

    def _read_available(self):
        if not self.reply or self.too_large:
            return
        self.body.extend(bytes(self.reply.readAll()))
        if len(self.body) > MAX_JSON_RESPONSE_BYTES:
            self.too_large = True
            self.body.clear()
            self.reply.abort()

    def _finish(self):
        reply = self.reply
        if reply is None:
            return
        self._read_available()
        status_value = reply.attribute(QNetworkRequest.HttpStatusCodeAttribute)
        status = int(status_value or 0)
        redirect = reply.attribute(QNetworkRequest.RedirectionTargetAttribute)
        if self.too_large:
            data = {"error": "桥接服务器 JSON 响应超过大小限制"}
            status = 0
        elif isinstance(redirect, QUrl) and redirect.isValid() and not redirect.isEmpty():
            data = {"error": "redirect_not_allowed"}
        else:
            try:
                data = json.loads(bytes(self.body).decode("utf-8"))
                if not isinstance(data, dict):
                    raise ValueError("JSON response must be an object")
            except (UnicodeError, ValueError, TypeError):
                no_error = QNetworkReply.NetworkError.NoError
                error_text = reply.errorString() if reply.error() != no_error else "invalid_json_response"
                data = {"error": error_text}
        self.completed.emit(status, data)
        reply.deleteLater()
        self.reply = None
        self.deleteLater()

# ══════════════════════════════════════════════════════════
#  Stylesheet
# ══════════════════════════════════════════════════════════

DARK_STYLE = """
QMainWindow, QWidget {
    background-color: #0f172a;
    color: #e2e8f0;
    font-family: "Segoe UI", "Microsoft YaHei", sans-serif;
    font-size: 13px;
}
QLabel { color: #e2e8f0; background: transparent; }
QLabel[muted="true"] { color: #94a3b8; background: transparent; }
QLabel[accent="true"] { color: #3b82f6; background: transparent; }
QLabel[error="true"] { color: #ef4444; }
QLabel[success="true"] { color: #22c55e; }
QLabel[warning="true"] { color: #f59e0b; }

QLineEdit {
    background-color: #1e293b;
    color: #e2e8f0;
    border: 1px solid #334155;
    border-radius: 6px;
    padding: 10px 12px;
    font-size: 13px;
    font-family: "Segoe UI", "Microsoft YaHei", sans-serif;
    selection-background-color: #3b82f6;
}
QLineEdit:focus { border-color: #3b82f6; }

QPushButton {
    background-color: #3b82f6;
    color: white;
    border: none;
    border-radius: 6px;
    padding: 10px 20px 12px;
    font-size: 13px;
    font-weight: bold;
    font-family: "Segoe UI", "Microsoft YaHei", sans-serif;
}
QPushButton:hover { background-color: #2563eb; }
QPushButton:pressed { background-color: #1d4ed8; }
QPushButton:disabled { background-color: #334155; color: #64748b; }

QPushButton[secondary="true"] {
    background-color: #334155;
    color: #e2e8f0;
}
QPushButton[secondary="true"]:hover { background-color: #475569; }

QPushButton[observerSources="true"] {
    padding: 0 14px;
    border: 1px solid #475569;
    border-radius: 7px;
    font-size: 13px;
}
QPushButton[observerSources="true"]:hover {
    border-color: #d4af37;
    color: #f8fafc;
}

QPushButton[danger="true"] {
    background-color: #ef4444;
}
QPushButton[danger="true"]:hover { background-color: #dc2626; }

QCheckBox {
    color: #94a3b8;
    spacing: 6px;
}
QCheckBox::indicator {
    width: 16px; height: 16px;
    border: 1px solid #475569;
    border-radius: 3px;
    background-color: #1e293b;
}
QCheckBox::indicator:checked {
    background-color: #3b82f6;
    border-color: #3b82f6;
}

QTextEdit {
    background-color: #0f172a;
    color: #94a3b8;
    border: 1px solid #1e293b;
    border-radius: 6px;
    padding: 8px;
    font-family: "Consolas", "Courier New", monospace;
    font-size: 12px;
}

QFrame[card="true"] {
    background-color: #1e293b;
    border: 1px solid #334155;
    border-radius: 8px;
    padding: 0px;
}

QProgressBar {
    background-color: #1e293b;
    border: 1px solid #334155;
    border-radius: 4px;
    text-align: center;
    color: #e2e8f0;
    height: 20px;
}
QProgressBar::chunk {
    background-color: #3b82f6;
    border-radius: 3px;
}

QMenu {
    background-color: #1e293b;
    color: #e2e8f0;
    border: 1px solid #334155;
    border-radius: 8px;
    padding: 7px;
}
QMenu::item { min-width: 220px; padding: 9px 14px; border-radius: 6px; }
QMenu::item:selected { background-color: #334155; color: #f8fafc; }
QMenu::item:disabled { color: #64748b; }
QMenu::separator { height: 1px; margin: 6px 8px; background: #334155; }
"""

# ══════════════════════════════════════════════════════════
#  Custom QPainter icon buttons
# ══════════════════════════════════════════════════════════

class EyeToggleButton(QPushButton):
    """密码可见性切换按钮 - QPainter 绘制眼睛图标"""
    def __init__(self, parent=None):
        super().__init__(parent)
        self.setFixedSize(36, 36)
        self.setCursor(Qt.PointingHandCursor)
        self._visible = False
        self.setToolTip("显示/隐藏密码")

    def set_password_visible(self, v):
        self._visible = v
        self.update()

    def paintEvent(self, event):
        p = QPainter(self)
        p.setRenderHint(QPainter.Antialiasing)
        pen = QPen(QColor("#94a3b8"), 2)
        p.setPen(pen)
        cx, cy = self.width() // 2, self.height() // 2
        # Eye shape
        path = QPainterPath()
        path.moveTo(cx - 12, cy)
        path.cubicTo(cx - 6, cy - 8, cx + 6, cy - 8, cx + 12, cy)
        path.cubicTo(cx + 6, cy + 8, cx - 6, cy + 8, cx - 12, cy)
        p.drawPath(path)
        # Pupil
        if self._visible:
            p.setBrush(QBrush(QColor("#94a3b8")))
        p.drawEllipse(cx - 4, cy - 4, 8, 8)
        # Slash when hidden
        if not self._visible:
            p.setPen(QPen(QColor("#ef4444"), 2))
            p.drawLine(cx - 10, cy + 10, cx + 10, cy - 10)
        p.end()


class GearButton(QPushButton):
    """设置按钮"""
    def __init__(self, parent=None):
        super().__init__("⚙ 设置", parent)
        self.setCursor(Qt.PointingHandCursor)
        self.setFixedHeight(32)
        self.setStyleSheet("""
            QPushButton {
                background: transparent; border: 1px solid #475569; border-radius: 6px;
                color: #94a3b8; font-size: 13px; padding: 0 12px;
            }
            QPushButton:hover { border-color: #3b82f6; color: #e2e8f0; }
        """)

# ══════════════════════════════════════════════════════════
#  Bridge Worker (QThread)
# ══════════════════════════════════════════════════════════

def find_mt5_terminal_executable(directory):
    """Return the terminal executable in an MT5 directory, if it is usable."""
    try:
        normalized = os.path.normpath(str(directory or "").strip())
    except (TypeError, ValueError):
        return None
    if not normalized or not os.path.isdir(normalized):
        return None
    for executable in ("terminal64.exe", "terminal.exe"):
        candidate = os.path.join(normalized, executable)
        if os.path.isfile(candidate):
            return candidate
    return None


def mt5_initialization_candidates(manual_path, installations):
    """Return safe MT5 initialize targets, preferring already-running terminals."""
    if manual_path:
        executable = find_mt5_terminal_executable(manual_path)
        return [executable] if executable else []

    discovered = []
    running = []
    seen = set()
    for directory, source in installations or []:
        executable = find_mt5_terminal_executable(directory)
        if not executable:
            continue
        key = os.path.normcase(os.path.realpath(executable))
        if key in seen:
            continue
        seen.add(key)
        discovered.append(executable)
        if source == "运行中进程":
            running.append(executable)

    # A running terminal is the least surprising account choice. When none is
    # running, preserve MetaTrader5's default discovery before trying installs.
    return running if running else [None, *discovered]


def version_is_newer(remote, local):
    """Compare numeric releases without treating v2.4 and v2.4.0 as different."""
    def parse(value):
        match = re.fullmatch(
            r"v?(\d+(?:\.\d+){0,3})(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?",
            str(value or "").strip(),
        )
        if not match:
            raise ValueError("invalid version")
        parts = [int(item) for item in match.group(1).split(".")]
        parts.extend([0] * (4 - len(parts)))
        return tuple(parts), 0 if match.group(2) else 1
    try:
        return parse(remote) > parse(local)
    except (TypeError, ValueError):
        return False


def running_mt5_process_directories():
    """Return MT5 terminal directories using native Win32 process snapshots."""
    if os.name != "nt":
        return []

    class ProcessEntry32W(ctypes.Structure):
        _fields_ = [
            ("dwSize", ctypes.wintypes.DWORD),
            ("cntUsage", ctypes.wintypes.DWORD),
            ("th32ProcessID", ctypes.wintypes.DWORD),
            ("th32DefaultHeapID", ctypes.c_size_t),
            ("th32ModuleID", ctypes.wintypes.DWORD),
            ("cntThreads", ctypes.wintypes.DWORD),
            ("th32ParentProcessID", ctypes.wintypes.DWORD),
            ("pcPriClassBase", ctypes.wintypes.LONG),
            ("dwFlags", ctypes.wintypes.DWORD),
            ("szExeFile", ctypes.wintypes.WCHAR * 260),
        ]

    kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
    kernel32.CreateToolhelp32Snapshot.argtypes = [ctypes.wintypes.DWORD, ctypes.wintypes.DWORD]
    kernel32.CreateToolhelp32Snapshot.restype = ctypes.wintypes.HANDLE
    kernel32.Process32FirstW.argtypes = [ctypes.wintypes.HANDLE, ctypes.POINTER(ProcessEntry32W)]
    kernel32.Process32FirstW.restype = ctypes.wintypes.BOOL
    kernel32.Process32NextW.argtypes = [ctypes.wintypes.HANDLE, ctypes.POINTER(ProcessEntry32W)]
    kernel32.Process32NextW.restype = ctypes.wintypes.BOOL
    kernel32.OpenProcess.argtypes = [ctypes.wintypes.DWORD, ctypes.wintypes.BOOL, ctypes.wintypes.DWORD]
    kernel32.OpenProcess.restype = ctypes.wintypes.HANDLE
    kernel32.QueryFullProcessImageNameW.argtypes = [
        ctypes.wintypes.HANDLE, ctypes.wintypes.DWORD,
        ctypes.wintypes.LPWSTR, ctypes.POINTER(ctypes.wintypes.DWORD),
    ]
    kernel32.QueryFullProcessImageNameW.restype = ctypes.wintypes.BOOL
    kernel32.CloseHandle.argtypes = [ctypes.wintypes.HANDLE]
    kernel32.CloseHandle.restype = ctypes.wintypes.BOOL

    snapshot = kernel32.CreateToolhelp32Snapshot(0x00000002, 0)
    invalid_handle = ctypes.c_void_p(-1).value
    if not snapshot or snapshot == invalid_handle:
        return []
    directories = set()
    try:
        entry = ProcessEntry32W()
        entry.dwSize = ctypes.sizeof(entry)
        has_entry = bool(kernel32.Process32FirstW(snapshot, ctypes.byref(entry)))
        while has_entry:
            if str(entry.szExeFile).casefold() in {"terminal64.exe", "terminal.exe"}:
                process = kernel32.OpenProcess(0x1000, False, entry.th32ProcessID)
                if process:
                    try:
                        size = ctypes.wintypes.DWORD(32768)
                        buffer = ctypes.create_unicode_buffer(size.value)
                        if kernel32.QueryFullProcessImageNameW(process, 0, buffer, ctypes.byref(size)):
                            directory = os.path.normpath(os.path.dirname(buffer.value))
                            if os.path.isdir(directory):
                                directories.add(directory)
                    finally:
                        kernel32.CloseHandle(process)
            has_entry = bool(kernel32.Process32NextW(snapshot, ctypes.byref(entry)))
    finally:
        kernel32.CloseHandle(snapshot)
    return sorted(directories, key=str.casefold)


class BridgeWorker(QThread):
    log_signal = Signal(str)
    status_signal = Signal(str, str, str)  # text, color, account
    plan_expired_signal = Signal(str)  # reason message

    def __init__(self, server_url, token, mt5_path=None, refresh_token=None):
        super().__init__()
        self.server_url = normalize_server_url(server_url)
        self.token = token
        self.refresh_token = refresh_token or ""
        self.running = True
        self._stop_event = threading.Event()
        self._async_stop_event = None
        self._trade_enabled = False
        self._resolved_symbol = "XAUUSD"
        self.mt5 = None
        self._ws = None
        self._mt5_executor = None
        self._mt5_owner_thread_id = None
        self._acc_lost_warned = False
        self._manual_mt5_path = mt5_path
        self.account_created_at = ""
        bridge_config = load_config()
        has_saved_offset = (bridge_config.get("mt5_timezone_offset_version") == 2
                            and "mt5_timezone_offset_minutes" in bridge_config)
        saved_offset = bridge_config.get("mt5_timezone_offset_minutes")
        try:
            saved_offset = int(saved_offset)
        except (TypeError, ValueError):
            saved_offset = DEFAULT_MT5_TIMEZONE_OFFSET_MINUTES
            has_saved_offset = False
        if not -720 <= saved_offset <= 840:
            saved_offset = DEFAULT_MT5_TIMEZONE_OFFSET_MINUTES
            has_saved_offset = False
        if not has_saved_offset:
            saved_offset = DEFAULT_MT5_TIMEZONE_OFFSET_MINUTES
        self._mt5_timezone_offset_minutes = saved_offset
        self._mt5_clock_status = "persisted" if has_saved_offset else "fallback"
        self._mt5_clock_residual_ms = None
        self._mt5_clock_checked_at = 0.0
        self._mt5_clock_last_raw_ms = None
        self._mt5_clock_last_raw_changed_at = 0.0
        self._mt5_clock_last_raw_host_ms = None
        # MetaTrader5's Python extension is not thread-safe. Command handling
        # and the one-second data publisher both use the executor, so all MT5
        # calls must share one lock.
        self._mt5_lock = threading.RLock()
        # A canceled asyncio task cannot stop an HTTP refresh already running in
        # an executor. Serialize refreshes so a reconnect cannot race that call.
        self._auth_lock = threading.RLock()
        self._history_deals_cache = None
        self._market_observations = {}
        self._last_market_state = None

    @staticmethod
    def _import_mt5_module():
        """Import MetaTrader5 on the same native thread that will own its IPC."""
        import MetaTrader5 as mt5
        return mt5

    def _mt5_call(self, function, *args, **kwargs):
        """Run every MT5 extension call on one stable native owner thread."""
        executor = self._mt5_executor
        if executor is None:
            raise RuntimeError("MT5 executor is not running")
        if threading.get_ident() == self._mt5_owner_thread_id:
            return function(*args, **kwargs)
        return executor.submit(self._invoke_mt5, function, args, kwargs).result()

    def _invoke_mt5(self, function, args, kwargs):
        self._mt5_owner_thread_id = threading.get_ident()
        return function(*args, **kwargs)

    def run(self):
        # MetaTrader5 maintains process-global IPC state and isn't safe when
        # initialize(), data reads and order commands hop between threads.
        self._mt5_executor = concurrent.futures.ThreadPoolExecutor(
            max_workers=1, thread_name_prefix="aurum-mt5",
        )
        try:
            self._run_bridge()
        except Exception as error:
            self.log_signal.emit(f"桥接异常退出: {self._short_text(error, 500)}")
            self.status_signal.emit("桥接异常", "#ef4444", "请停止后重试")
        finally:
            if self.mt5 is not None:
                try:
                    self._mt5_call(self.mt5.shutdown)
                except Exception as error:
                    self.log_signal.emit(f"MT5 关闭异常: {self._short_text(error, 300)}")
            executor = self._mt5_executor
            self._mt5_executor = None
            self._mt5_owner_thread_id = None
            if executor is not None:
                executor.shutdown(wait=False, cancel_futures=True)
            self.log_signal.emit("MT5 已断开")

    @staticmethod
    def _token_expires_within(token, seconds=86400):
        """Read JWT expiry locally only to decide when to refresh; server still verifies it."""
        try:
            payload = str(token).split('.')[1]
            payload += '=' * (-len(payload) % 4)
            exp = json.loads(base64.urlsafe_b64decode(payload.encode('ascii')).decode('utf-8')).get('exp')
            return not exp or float(exp) <= time.time() + seconds
        except Exception:
            return True

    def _save_auth_tokens(self):
        if not self.running:
            return False
        patch = {"token": self.token}
        if self.refresh_token:
            patch["refresh_token"] = self.refresh_token
        return update_config(patch)

    def _renew_access_token(self, force=False):
        """Refresh the short-lived access token without storing or resending a password."""
        with self._auth_lock:
            if not force and self.token and not self._token_expires_within(self.token):
                return True
            server = self.server_url.replace("ws://", "http://").replace("wss://", "https://").rstrip('/')
            if not self.refresh_token and self.token and not force:
                status, data = http_post_json(f"{server}/api/auth/bridge-session", {}, timeout=10, token=self.token)
                if status == 200 and data.get("refreshToken"):
                    self.refresh_token = data["refreshToken"]
                    if not self._save_auth_tokens() and self.running:
                        self.log_signal.emit("⚠️ 新的桥接续期凭证无法写入本机加密配置")
            if not self.refresh_token:
                return False
            status, data = http_post_json(f"{server}/api/auth/bridge-refresh", {
                "refreshToken": self.refresh_token
            }, timeout=10)
            if status == 200 and data.get("token"):
                self.token = data["token"]
                if data.get("refreshToken"):
                    self.refresh_token = data["refreshToken"]
                if not self._save_auth_tokens() and self.running:
                    self.log_signal.emit("⚠️ 已续期，但新的登录凭证无法写入本机加密配置")
                self.log_signal.emit("桥接登录凭证已自动续期")
                return True
            return False

    def _create_connection_ticket(self):
        """Exchange the access token over HTTP(S) for a short-lived one-use WS ticket."""
        server = self.server_url.replace("ws://", "http://").replace("wss://", "https://").rstrip('/')
        status, data = http_post_json(
            f"{server}/api/auth/bridge-ticket", {}, timeout=10, token=self.token,
        )
        if status == 401 and self._renew_access_token(force=True):
            status, data = http_post_json(
                f"{server}/api/auth/bridge-ticket", {}, timeout=10, token=self.token,
            )
        ticket = data.get("ticket") if isinstance(data, dict) else None
        if status != 200 or not ticket:
            detail = data.get("error", f"HTTP {status}") if isinstance(data, dict) else f"HTTP {status}"
            raise RuntimeError(f"无法创建桥接连接票据：{detail}")
        return ticket

    def check_plan(self):
        """Check plan status via auth/me. Returns (plan, expired, message)."""
        try:
            server = self.server_url.replace("ws://", "http://").replace("wss://", "https://").rstrip("/")
            url = f"{server}/api/profile"
            self._renew_access_token()
            status, data = http_get_json(url, timeout=10, token=self.token)
            if status == 401 and self._renew_access_token(force=True):
                status, data = http_get_json(url, timeout=10, token=self.token)
            if status == 401:
                return "unknown", True, "桥接登录已过期，请重新登录"
            if status == 403:
                return "unknown", True, data.get("error", "会员已过期或当前等级不能使用桥接软件")
            if status != 200:
                detail = data.get("error", f"HTTP {status}") if isinstance(data, dict) else f"HTTP {status}"
                return "unknown", False, f"会员状态暂时无法确认（{detail}），将继续连接并稍后重试"
            # Profile wraps user data: { ok: true, user: { plan: "pro", ... } }
            userData = data.get("user", {})
            plan = userData.get("plan", "free")
            expires_at = userData.get("planExpiresAt") or userData.get("plan_expires_at", "")
            self.account_created_at = (userData.get("accountCreatedAt")
                or userData.get("account_created_at") or userData.get("createdAt") or "")
            if plan in ("free", "plus"):
                return plan, True, f"当前会员等级: {plan.upper()}，桥接功能仅限 Pro 会员"
            if expires_at:
                exp = datetime.fromisoformat(expires_at.replace("Z", "+00:00"))
                if exp <= datetime.now(exp.tzinfo):
                    return plan, True, f"会员已过期({expires_at[:10]})，请续费后重试"
            return plan, False, ""
        except Exception as e:
            # The WebSocket handshake independently enforces membership. A
            # transient profile/network failure must not terminate a healthy Bridge.
            return "unknown", False, f"会员状态暂时无法确认，将继续连接并稍后重试: {e}"

    def _mt5_time(self, ts):
        if not ts: return ''
        return datetime.utcfromtimestamp(int(ts)).strftime('%Y-%m-%d %H:%M:%S')

    def _history_deals_for_range(self, date_from, date_to, force_refresh=False):
        """Reuse one exact MT5 deal range briefly for table, chart and paging."""
        key = (date_from.isoformat(), date_to.isoformat())
        now = time.monotonic()
        cached = self._history_deals_cache
        if cached and cached.get("key") == key:
            age = now - float(cached.get("created_at") or 0)
            if age <= 15.0 and (not force_refresh or age <= 1.0):
                return cached.get("deals"), True
        deals = self.mt5.history_deals_get(date_from, date_to)
        if deals is not None:
            self._history_deals_cache = {"key": key, "created_at": now, "deals": deals}
        return deals, False

    def _calibrate_mt5_clock(self, tick, force=False):
        now = time.time()
        was_verified = self._mt5_clock_status == "verified"
        raw_ms = int(getattr(tick, "time_msc", 0) or int(getattr(tick, "time", 0) or 0) * 1000)
        if raw_ms <= 0:
            self._mt5_clock_status = "unavailable"
            return
        host_ms = int(now * 1000)
        previous_raw_ms = self._mt5_clock_last_raw_ms
        previous_raw_host_ms = self._mt5_clock_last_raw_host_ms

        # A closed market keeps returning the final quote timestamp. Never use
        # that increasingly old timestamp to infer a new broker timezone.
        if previous_raw_ms == raw_ms:
            if now - self._mt5_clock_last_raw_changed_at >= MT5_CLOCK_STALE_AFTER_SEC:
                self._mt5_clock_status = "stale_or_unverified"
            return

        self._mt5_clock_last_raw_ms = raw_ms
        self._mt5_clock_last_raw_changed_at = now
        self._mt5_clock_last_raw_host_ms = host_ms

        # The first sample can only confirm the saved/default offset when the
        # quote is fresh. A different offset needs a second advancing sample so
        # a weekend's stale quote cannot masquerade as UTC-9, UTC-10, etc.
        current_offset = int(self._mt5_timezone_offset_minutes)
        current_residual = raw_ms - current_offset * 60000 - host_ms
        if abs(current_residual) <= MT5_CLOCK_FRESHNESS_TOLERANCE_MS:
            self._mt5_clock_residual_ms = int(current_residual)
            self._mt5_clock_status = "verified"
            self._mt5_clock_checked_at = now
            if not was_verified:
                update_config({"mt5_timezone_offset_minutes": current_offset, "mt5_timezone_offset_version": 2})
            return

        if previous_raw_ms is None or previous_raw_host_ms is None:
            self._mt5_clock_residual_ms = int(current_residual)
            self._mt5_clock_status = "stale_or_unverified"
            return

        raw_progress_ms = raw_ms - previous_raw_ms
        host_progress_ms = host_ms - previous_raw_host_ms
        if raw_progress_ms <= 0 or abs(raw_progress_ms - host_progress_ms) > MT5_CLOCK_FRESHNESS_TOLERANCE_MS:
            self._mt5_clock_residual_ms = int(current_residual)
            self._mt5_clock_status = "stale_or_unverified"
            return

        candidate = int(round((raw_ms - host_ms) / 900000.0) * 15)
        residual = raw_ms - candidate * 60000 - host_ms
        self._mt5_clock_residual_ms = int(residual)
        if -720 <= candidate <= 840 and abs(residual) <= MT5_CLOCK_FRESHNESS_TOLERANCE_MS:
            self._mt5_timezone_offset_minutes = candidate
            self._mt5_clock_status = "verified"
            self._mt5_clock_checked_at = now
            update_config({"mt5_timezone_offset_minutes": candidate, "mt5_timezone_offset_version": 2})
        else:
            self._mt5_clock_status = "stale_or_unverified"

    def _clock_fields(self, raw_time_msc):
        raw_ms = int(raw_time_msc or 0)
        offset = self._mt5_timezone_offset_minutes
        return {
            "time_msc": raw_ms or None,
            "time_utc_msc": raw_ms - offset * 60000 if raw_ms and offset is not None else None,
            "timezone_offset_minutes": offset,
            "clock_status": self._mt5_clock_status,
            "clock_residual_ms": self._mt5_clock_residual_ms,
            "captured_at_utc_msc": int(time.time() * 1000),
        }

    def _detect_market_state(self, symbol, info, tick, terminal_info=None):
        now_mono = time.monotonic()
        now_utc_ms = int(time.time() * 1000)
        raw_tick_ms = int(getattr(tick, "time_msc", 0) or int(getattr(tick, "time", 0) or 0) * 1000) if tick else 0
        trade_mode = int(getattr(info, "trade_mode", -1)) if info else -1
        observation = self._market_observations.setdefault(symbol, {
            "last_tick_msc": None, "last_change_monotonic": now_mono,
        })
        previous_tick_ms = observation.get("last_tick_msc")
        tick_progressing = bool(raw_tick_ms and previous_tick_ms is not None and raw_tick_ms != previous_tick_ms)
        if raw_tick_ms and raw_tick_ms != previous_tick_ms:
            observation["last_tick_msc"] = raw_tick_ms
            observation["last_change_monotonic"] = now_mono
            if previous_tick_ms is not None:
                observation["confirmed_open"] = True
        unchanged_seconds = max(0.0, now_mono - float(observation.get("last_change_monotonic") or now_mono))
        offset_minutes = int(self._mt5_timezone_offset_minutes or 0)
        tick_utc_ms = raw_tick_ms - offset_minutes * 60000 if raw_tick_ms else 0
        tick_age_seconds = max(0.0, (now_utc_ms - tick_utc_ms) / 1000.0) if tick_utc_ms else None
        terminal_connected = bool(terminal_info and getattr(terminal_info, "connected", False))
        bid = float(getattr(tick, "bid", 0) or 0) if tick else 0.0
        ask = float(getattr(tick, "ask", 0) or 0) if tick else 0.0

        if terminal_info is None or not terminal_connected:
            state, reason = "unknown", "terminal_disconnected"
        elif info is None:
            state, reason = "unknown", "symbol_info_unavailable"
        elif tick is None or raw_tick_ms <= 0:
            state, reason = "unknown", "tick_unavailable"
        elif trade_mode == 0:
            state, reason = "closed", "symbol_trade_disabled"
        elif trade_mode in (1, 2, 3):
            state, reason = "restricted", {1: "long_only", 2: "short_only", 3: "close_only"}[trade_mode]
        elif bid <= 0 or ask <= 0 or ask < bid:
            state, reason = "stale", "invalid_quote"
        elif tick_progressing:
            state, reason = "open", "tick_advancing"
        elif tick_age_seconds is not None and tick_age_seconds >= 120:
            state, reason = "closed", "tick_not_advancing"
        elif observation.get("confirmed_open") and unchanged_seconds < 60:
            state, reason = "open", "recent_tick_activity"
        elif unchanged_seconds >= 60:
            state, reason = "closed", "tick_not_advancing"
        else:
            state, reason = "unknown", "observing_tick"

        result = {
            "market_state_version": 1,
            "market_state": state,
            "market_reason": reason,
            "symbol_trade_mode": trade_mode,
            "terminal_connected": terminal_connected,
            "tick_progressing": tick_progressing,
            "tick_unchanged_seconds": round(unchanged_seconds, 3),
            "tick_age_seconds": round(tick_age_seconds, 3) if tick_age_seconds is not None else None,
            "market_checked_at_utc_msc": now_utc_ms,
        }
        if state in ("closed", "stale"):
            observation["confirmed_open"] = False
        self._last_market_state = {"symbol": symbol, **result}
        return result

    def _resolve_symbol(self, symbol):
        if symbol is None:
            raise RuntimeError("Symbol is required")
        requested = str(symbol).strip()
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

    _MAX_RETRY = 3
    _RETRY_DELAY = 0.15  # seconds

    def _retryable_retcodes(self):
        return retryable_trade_retcodes(self.mt5)

    def _get_filling_mode(self, symbol):
        info = self.mt5.symbol_info(symbol)
        if not info: return self.mt5.ORDER_FILLING_IOC
        fm = int(getattr(info, "filling_mode", 0) or 0)
        cands = []
        if fm & 2: cands.append(self.mt5.ORDER_FILLING_IOC)   # IOC 优先 — 容忍微小滑点
        if fm & 1: cands.append(self.mt5.ORDER_FILLING_FOK)   # FOK 备选
        if not cands: cands = [self.mt5.ORDER_FILLING_IOC, self.mt5.ORDER_FILLING_RETURN]
        return cands[0]

    @staticmethod
    def _validate_order_volume(info, volume):
        if not math.isfinite(volume) or volume <= 0:
            return "volume must be a positive finite number"
        volume_min = float(getattr(info, "volume_min", 0) or 0)
        volume_max = float(getattr(info, "volume_max", 0) or 0)
        volume_step = float(getattr(info, "volume_step", 0) or 0)
        epsilon = max(1e-9, volume_step * 1e-6)
        if volume_min > 0 and volume < volume_min - epsilon:
            return f"volume {volume} is below broker minimum {volume_min}"
        if volume_max > 0 and volume > volume_max + epsilon:
            return f"volume {volume} exceeds broker maximum {volume_max}"
        if volume_step > 0 and abs(round(volume / volume_step) * volume_step - volume) > epsilon:
            return f"volume {volume} does not match broker step {volume_step}"
        return None

    @staticmethod
    def _parse_order_price(value, field, required=False):
        if value is None or value == "":
            return (None, f"{field} is required") if required else (None, None)
        if isinstance(value, bool):
            return None, f"{field} must be a positive finite number"
        try:
            number = float(value)
        except (TypeError, ValueError, OverflowError):
            return None, f"{field} must be a positive finite number"
        if number == 0 and not required:
            return None, None
        if not math.isfinite(number) or number <= 0:
            return None, f"{field} must be a positive finite number"
        return number, None

    @staticmethod
    def _normalize_order_comment(value, fallback):
        text = str(value or fallback).replace("\r", " ").replace("\n", " ").strip()
        return text[:31] or str(fallback)[:31]

    def _order_send_with_retry(self, symbol, build_req_fn):
        """带价格刷新重试的 order_send 包装器。
        build_req_fn(tick) → dict: 根据当前 tick 构建 req，返回 (req, price_for_log)
        可重试码 (REQUOTE/PRICE_OFF/PRICE_CHANGED) 时刷新 tick 重试最多 _MAX_RETRY 次
        返回 (result_or_None, comment)
        """
        for attempt in range(self._MAX_RETRY + 1):
            tick = self.mt5.symbol_info_tick(symbol)
            if not tick:
                return None, "tick unavailable"
            req, log_price = build_req_fn(tick)
            req["price"] = log_price
            result = self.mt5.order_send(req)
            classification = classify_deal_result(result, self.mt5)
            if classification in ("success", "partial"):
                return result, None
            code = result.retcode if result else -1
            # A non-DONE ticket is only an acknowledgement. Do not retry it and
            # do not claim success until positions/orders/history confirm it.
            if classification == "uncertain":
                self.log_signal.emit(
                    f"⚠ 订单返回待确认状态 (retcode={code}, ticket={getattr(result, 'order', 0) or getattr(result, 'deal', 0)}) — 禁止自动重试"
                )
                return result, result.comment if result else "order_send failed"
            if code in self._retryable_retcodes() and attempt < self._MAX_RETRY:
                self.log_signal.emit(
                    f"报价已过期 (retcode={code})，尝试刷新价格重试 ({attempt+1}/{self._MAX_RETRY})..."
                )
                time.sleep(self._RETRY_DELAY)
                # Re-select symbol to keep it hot
                try:
                    self.mt5.symbol_select(req["symbol"], True)
                except Exception as exc:
                    self.log_signal.emit(f"[Order] Failed to re-select symbol {req['symbol']}: {exc}")
                continue
            return result, result.comment if result else "order_send failed"

    def _risk_snapshot(self, params):
        """Build a compact, incremental risk snapshot without exporting account history."""
        acc = self.mt5.account_info()
        if not acc:
            return {"status": "error", "message": "risk snapshot account_info failed"}
        tick = self.mt5.symbol_info_tick(params.get("symbol")) if params.get("symbol") else None
        if tick:
            self._calibrate_mt5_clock(tick)

        positions = self.mt5.positions_get()
        pending = self.mt5.orders_get()
        if positions is None:
            return {"status": "error", "message": f"risk snapshot positions_get failed: {self.mt5.last_error()}"}
        if pending is None:
            return {"status": "error", "message": f"risk snapshot orders_get failed: {self.mt5.last_error()}"}

        position_rows = [{
            "ticket": int(p.ticket), "identifier": int(getattr(p, "identifier", p.ticket) or p.ticket),
            "symbol": p.symbol, "type": "buy" if p.type == self.mt5.POSITION_TYPE_BUY else "sell",
            "volume": float(p.volume), "price_open": float(p.price_open),
            "price_current": float(p.price_current), "profit": float(p.profit),
            "swap": float(getattr(p, "swap", 0) or 0),
        } for p in positions]
        pending_type_names = {
            getattr(self.mt5, "ORDER_TYPE_BUY_LIMIT", 2): "buy_limit",
            getattr(self.mt5, "ORDER_TYPE_SELL_LIMIT", 3): "sell_limit",
            getattr(self.mt5, "ORDER_TYPE_BUY_STOP", 4): "buy_stop",
            getattr(self.mt5, "ORDER_TYPE_SELL_STOP", 5): "sell_stop",
            getattr(self.mt5, "ORDER_TYPE_BUY_STOP_LIMIT", 6): "buy_stop_limit",
            getattr(self.mt5, "ORDER_TYPE_SELL_STOP_LIMIT", 7): "sell_stop_limit",
        }
        pending_rows = [{
            "ticket": int(o.ticket), "symbol": o.symbol,
            "type": pending_type_names.get(o.type, str(o.type)),
            "volume": float(getattr(o, "volume_current", 0) or getattr(o, "volume_initial", 0) or 0),
            "volume_current": float(getattr(o, "volume_current", 0) or 0),
            "volume_initial": float(getattr(o, "volume_initial", 0) or 0),
            "price": float(getattr(o, "price_open", 0) or 0),
        } for o in pending]

        requested_cursor_ms = max(0, int(params.get("last_deal_time_msc") or 0))
        requested_cursor_ticket = max(0, int(params.get("last_deal_ticket") or 0))
        baseline_utc_ms = max(0, int(params.get("baseline_from_utc_msc") or 0))
        offset_minutes = int(self._mt5_timezone_offset_minutes or 0)
        if requested_cursor_ms:
            raw_start_ms = requested_cursor_ms
        elif baseline_utc_ms:
            raw_start_ms = baseline_utc_ms + offset_minutes * 60000
        else:
            raw_start_ms = int(time.time() * 1000) + offset_minutes * 60000
        # Query a small overlap, then apply the exact (time_msc, ticket) cursor locally.
        date_from = datetime.utcfromtimestamp(max(0, raw_start_ms - 300000) / 1000.0)
        date_to = datetime.utcnow() + timedelta(days=1)
        deals = self.mt5.history_deals_get(date_from, date_to)
        if deals is None:
            return {"status": "error", "message": f"risk snapshot history_deals_get failed: {self.mt5.last_error()}"}
        deal_rows = [d._asdict() for d in deals]
        deal_rows.sort(key=lambda d: (int(d.get("time_msc") or int(d.get("time") or 0) * 1000), int(d.get("ticket") or 0)))
        cursor_pair = (requested_cursor_ms or raw_start_ms, requested_cursor_ticket)
        new_deals = [d for d in deal_rows if (
            int(d.get("time_msc") or int(d.get("time") or 0) * 1000), int(d.get("ticket") or 0)
        ) > cursor_pair]

        buy_type = getattr(self.mt5, "DEAL_TYPE_BUY", 0)
        sell_type = getattr(self.mt5, "DEAL_TYPE_SELL", 1)
        trade_types = {buy_type, sell_type}
        capital_types = {
            getattr(self.mt5, "DEAL_TYPE_BALANCE", 2), getattr(self.mt5, "DEAL_TYPE_CREDIT", 3),
            getattr(self.mt5, "DEAL_TYPE_CORRECTION", 5), getattr(self.mt5, "DEAL_TYPE_BONUS", 6),
        }
        pnl_adjustment_types = {
            getattr(self.mt5, "DEAL_TYPE_CHARGE", 4), getattr(self.mt5, "DEAL_TYPE_COMMISSION", 7),
            getattr(self.mt5, "DEAL_TYPE_COMMISSION_DAILY", 8), getattr(self.mt5, "DEAL_TYPE_COMMISSION_MONTHLY", 9),
            getattr(self.mt5, "DEAL_TYPE_COMMISSION_AGENT_DAILY", 10), getattr(self.mt5, "DEAL_TYPE_COMMISSION_AGENT_MONTHLY", 11),
            getattr(self.mt5, "DEAL_TYPE_INTEREST", 12), getattr(self.mt5, "DEAL_TYPE_DIVIDEND", 15),
            getattr(self.mt5, "DEAL_TYPE_DIVIDEND_FRANKED", 16), getattr(self.mt5, "DEAL_TYPE_TAX", 17),
        }
        exit_entries = {
            getattr(self.mt5, "DEAL_ENTRY_OUT", 1), getattr(self.mt5, "DEAL_ENTRY_INOUT", 2),
            getattr(self.mt5, "DEAL_ENTRY_OUT_BY", 3),
        }
        active_position_ids = {int(getattr(p, "identifier", p.ticket) or p.ticket) for p in positions}
        closed_positions = []
        seen_positions = set()
        incomplete_reasons = []
        for d in new_deals:
            if d.get("type") not in trade_types or d.get("entry") not in exit_entries:
                continue
            position_id = int(d.get("position_id") or 0)
            if not position_id or position_id in active_position_ids or position_id in seen_positions:
                continue
            seen_positions.add(position_id)
            position_deals = self.mt5.history_deals_get(position=position_id)
            if position_deals is None:
                incomplete_reasons.append("position_history_unavailable")
                continue
            net = sum(float(getattr(item, "profit", 0) or 0) + float(getattr(item, "commission", 0) or 0)
                + float(getattr(item, "swap", 0) or 0) + float(getattr(item, "fee", 0) or 0) for item in position_deals)
            close_ms = int(d.get("time_msc") or int(d.get("time") or 0) * 1000)
            close_clock = self._clock_fields(close_ms)
            closed_positions.append({
                "position_id": position_id, "close_time_msc": close_ms,
                "close_time_utc_msc": close_clock.get("time_utc_msc"),
                "close_deal_ticket": int(d.get("ticket") or 0),
                "business_date": self._mt5_time(close_ms // 1000)[:10], "net": round(net, 8),
            })
        closed_positions.sort(key=lambda row: (row["close_time_msc"], row["close_deal_ticket"]))

        account_events = []
        known_nontrade = capital_types | pnl_adjustment_types
        for d in new_deals:
            deal_type = int(d.get("type") if d.get("type") is not None else -1)
            if deal_type in trade_types:
                continue
            amount = sum(float(d.get(key) or 0) for key in ("profit", "commission", "swap", "fee"))
            event_ms = int(d.get("time_msc") or int(d.get("time") or 0) * 1000)
            category = "capital" if deal_type in capital_types else "pnl_adjustment" if deal_type in pnl_adjustment_types else "unknown"
            if deal_type not in known_nontrade:
                incomplete_reasons.append(f"unknown_deal_type:{deal_type}")
            account_events.append({
                "ticket": int(d.get("ticket") or 0), "time_msc": event_ms,
                "business_date": self._mt5_time(event_ms // 1000)[:10],
                "deal_type": deal_type, "category": category, "amount": round(amount, 8),
            })

        relevant_symbols = {row["symbol"] for row in position_rows + pending_rows if row.get("symbol")}
        if params.get("symbol"):
            try: relevant_symbols.add(self._resolve_symbol(params.get("symbol")))
            except Exception: relevant_symbols.add(str(params.get("symbol")))
        instruments = {}
        for symbol in relevant_symbols:
            info = self.mt5.symbol_info(symbol)
            if not info:
                incomplete_reasons.append(f"symbol_info_unavailable:{symbol}")
                continue
            instruments[symbol] = {
                "name": info.name, "digits": int(info.digits), "trade_mode": int(info.trade_mode),
                "trade_calc_mode": int(getattr(info, "trade_calc_mode", 0) or 0),
                "point": float(info.point), "tick_size": float(getattr(info, "trade_tick_size", 0) or 0),
                "tick_value": float(getattr(info, "trade_tick_value", 0) or 0),
                "contract_size": float(getattr(info, "trade_contract_size", 0) or 0),
                "margin_initial": float(getattr(info, "margin_initial", 0) or 0),
                "volume_min": float(getattr(info, "volume_min", 0) or 0),
                "volume_max": float(getattr(info, "volume_max", 0) or 0),
                "volume_step": float(getattr(info, "volume_step", 0) or 0),
                "currency_profit": str(getattr(info, "currency_profit", "") or ""),
                "currency_margin": str(getattr(info, "currency_margin", "") or ""),
            }

        broker_calculation = None
        warnings = []
        proposed = params.get("proposed_order") or {}
        try:
            proposed_symbol = self._resolve_symbol(proposed.get("symbol"))
            side = str(proposed.get("order_type") or "").lower()
            order_type = self.mt5.ORDER_TYPE_BUY if side == "buy" else self.mt5.ORDER_TYPE_SELL
            volume = float(proposed.get("volume") or 0)
            entry = float(proposed.get("entry_price") or 0)
            stop_loss = float(proposed.get("sl") or 0)
            loss = self.mt5.order_calc_profit(order_type, proposed_symbol, volume, entry, stop_loss)
            margin = self.mt5.order_calc_margin(order_type, proposed_symbol, volume, entry)
            if loss is not None and margin is not None:
                broker_calculation = {
                    "symbol": proposed_symbol, "order_type": side, "volume": volume,
                    "entry_price": entry, "sl": stop_loss,
                    "loss_to_sl": round(abs(float(loss)), 8), "required_margin": round(float(margin), 8),
                }
        except Exception as exc:
            warnings.append(f"broker_calculation_unavailable:{type(exc).__name__}")

        through_ms, through_ticket = cursor_pair
        if new_deals:
            last = new_deals[-1]
            through_ms = int(last.get("time_msc") or int(last.get("time") or 0) * 1000)
            through_ticket = int(last.get("ticket") or 0)
        raw_now_ms = int(getattr(tick, "time_msc", 0) or (time.time() * 1000 + offset_minutes * 60000))
        return {
            "status": "success", "snapshot_version": 1,
            "complete": not incomplete_reasons, "incomplete_reasons": sorted(set(incomplete_reasons)),
            "warnings": sorted(set(warnings)),
            "business_date": self._mt5_time(raw_now_ms // 1000)[:10],
            "mt5_time_msc": raw_now_ms, **self._clock_fields(raw_now_ms),
            "account": {
                "login": int(acc.login), "server": acc.server, "currency": acc.currency,
                "balance": float(acc.balance), "equity": float(acc.equity), "credit": float(acc.credit),
                "profit": float(acc.profit), "margin": float(acc.margin), "margin_free": float(acc.margin_free),
                "margin_level": float(getattr(acc, "margin_level", 0) or 0),
                "leverage": int(getattr(acc, "leverage", 0) or 0),
                "margin_mode": int(getattr(acc, "margin_mode", 0) or 0),
                "margin_so_mode": int(getattr(acc, "margin_so_mode", 0) or 0),
                "margin_so_call": float(getattr(acc, "margin_so_call", 0) or 0),
                "margin_so_so": float(getattr(acc, "margin_so_so", 0) or 0),
            },
            "positions": position_rows, "pending": pending_rows, "instruments": instruments,
            "increment": {
                "requested_cursor": {"time_msc": requested_cursor_ms, "ticket": requested_cursor_ticket},
                "through_cursor": {"time_msc": through_ms, "ticket": through_ticket},
                "closed_positions": closed_positions, "account_events": account_events,
                "scanned_deal_count": len(deal_rows), "new_deal_count": len(new_deals),
            },
            "broker_calculation": broker_calculation,
        }
        return None, "max retry exceeded"

    def _performance_daily(self, params):
        """Aggregate a bounded MT5 deal range by broker business date.

        The server receives one compact row per day instead of the account's raw
        deal history. The requested end date is inclusive and each request is
        intentionally capped so a large account cannot monopolize the bridge.
        """
        import hashlib
        try:
            start_date = datetime.strptime(str(params.get("date_from") or "")[:10], "%Y-%m-%d")
            end_date = datetime.strptime(str(params.get("date_to") or "")[:10], "%Y-%m-%d")
        except (TypeError, ValueError):
            return {"status": "error", "message": "performance date range is required"}
        if end_date < start_date:
            return {"status": "error", "message": "performance date range is invalid"}
        if (end_date - start_date).days > 30:
            return {"status": "error", "message": "performance date range exceeds 31 days"}

        acc = self.mt5.account_info()
        if not acc:
            return {"status": "error", "message": "performance account_info failed"}
        # Query one broker-wall-clock day around the requested range and filter
        # locally. This tolerates Python/terminal timezone interpretation
        # differences while keeping the returned business dates exact.
        deals = self.mt5.history_deals_get(start_date - timedelta(days=1), end_date + timedelta(days=2))
        if deals is None:
            return {"status": "error", "message": f"performance history_deals_get failed: {self.mt5.last_error()}"}

        buy_type = getattr(self.mt5, "DEAL_TYPE_BUY", 0)
        sell_type = getattr(self.mt5, "DEAL_TYPE_SELL", 1)
        trade_types = {buy_type, sell_type}
        balance_type = getattr(self.mt5, "DEAL_TYPE_BALANCE", 2)
        credit_type = getattr(self.mt5, "DEAL_TYPE_CREDIT", 3)
        other_capital_types = {
            getattr(self.mt5, "DEAL_TYPE_CORRECTION", 5), getattr(self.mt5, "DEAL_TYPE_BONUS", 6),
        }
        pnl_adjustment_types = {
            getattr(self.mt5, "DEAL_TYPE_CHARGE", 4), getattr(self.mt5, "DEAL_TYPE_COMMISSION", 7),
            getattr(self.mt5, "DEAL_TYPE_COMMISSION_DAILY", 8), getattr(self.mt5, "DEAL_TYPE_COMMISSION_MONTHLY", 9),
            getattr(self.mt5, "DEAL_TYPE_COMMISSION_AGENT_DAILY", 10), getattr(self.mt5, "DEAL_TYPE_COMMISSION_AGENT_MONTHLY", 11),
            getattr(self.mt5, "DEAL_TYPE_INTEREST", 12), getattr(self.mt5, "DEAL_TYPE_DIVIDEND", 15),
            getattr(self.mt5, "DEAL_TYPE_DIVIDEND_FRANKED", 16), getattr(self.mt5, "DEAL_TYPE_TAX", 17),
        }
        exit_entries = {
            getattr(self.mt5, "DEAL_ENTRY_OUT", 1), getattr(self.mt5, "DEAL_ENTRY_INOUT", 2),
            getattr(self.mt5, "DEAL_ENTRY_OUT_BY", 3),
        }

        def empty_day(day):
            return {
                "business_date": day, "trade_profit": 0.0, "commission": 0.0, "swap": 0.0,
                "fee": 0.0, "pnl_adjustment": 0.0, "realized_net": 0.0,
                "deposit": 0.0, "withdrawal": 0.0, "credit_change": 0.0,
                "other_capital_change": 0.0, "exit_deal_count": 0,
                "closed_position_count": 0, "winning_exit_count": 0, "losing_exit_count": 0,
                "closed_volume": 0.0, "first_deal_time_msc": 0, "last_deal_time_msc": 0,
                "last_deal_ticket": 0, "data_complete": True, "data_issues": [], "_positions": set(),
            }

        daily = {}
        for item in deals:
            d = item._asdict()
            event_ms = int(d.get("time_msc") or int(d.get("time") or 0) * 1000)
            day = self._mt5_time(event_ms // 1000)[:10]
            if day < start_date.strftime("%Y-%m-%d") or day > end_date.strftime("%Y-%m-%d"):
                continue
            row = daily.setdefault(day, empty_day(day))
            ticket = int(d.get("ticket") or 0)
            pair = (event_ms, ticket)
            if not row["first_deal_time_msc"] or event_ms < row["first_deal_time_msc"]:
                row["first_deal_time_msc"] = event_ms
            if pair > (row["last_deal_time_msc"], row["last_deal_ticket"]):
                row["last_deal_time_msc"], row["last_deal_ticket"] = pair

            deal_type = int(d.get("type") if d.get("type") is not None else -1)
            profit = float(d.get("profit") or 0)
            commission = float(d.get("commission") or 0)
            swap = float(d.get("swap") or 0)
            fee = float(d.get("fee") or 0)
            net = profit + commission + swap + fee
            if deal_type in trade_types:
                row["trade_profit"] += profit
                row["commission"] += commission
                row["swap"] += swap
                row["fee"] += fee
                row["realized_net"] += net
                if d.get("entry") in exit_entries:
                    row["exit_deal_count"] += 1
                    row["closed_volume"] += float(d.get("volume") or 0)
                    position_id = int(d.get("position_id") or 0)
                    if position_id:
                        row["_positions"].add(position_id)
                    if net > 0: row["winning_exit_count"] += 1
                    elif net < 0: row["losing_exit_count"] += 1
            elif deal_type == balance_type:
                if net >= 0: row["deposit"] += net
                else: row["withdrawal"] += abs(net)
            elif deal_type == credit_type:
                row["credit_change"] += net
            elif deal_type in other_capital_types:
                row["other_capital_change"] += net
            elif deal_type in pnl_adjustment_types:
                row["pnl_adjustment"] += net
                row["realized_net"] += net
            else:
                row["data_complete"] = False
                row["data_issues"].append(f"unknown_deal_type:{deal_type}")

        rows = []
        numeric_fields = (
            "trade_profit", "commission", "swap", "fee", "pnl_adjustment", "realized_net",
            "deposit", "withdrawal", "credit_change", "other_capital_change", "closed_volume",
        )
        for day in sorted(daily):
            row = daily[day]
            row["closed_position_count"] = len(row.pop("_positions"))
            row["data_issues"] = sorted(set(row["data_issues"]))
            for field in numeric_fields:
                row[field] = round(float(row[field]), 8)
            digest_payload = json.dumps(row, sort_keys=True, separators=(",", ":"), ensure_ascii=True)
            row["source_hash"] = hashlib.sha256(digest_payload.encode("utf-8")).hexdigest()
            rows.append(row)

        return {
            "status": "success", "performance_version": 1,
            "date_from": start_date.strftime("%Y-%m-%d"), "date_to": end_date.strftime("%Y-%m-%d"),
            "timezone_offset_minutes": int(self._mt5_timezone_offset_minutes or 0),
            "clock_status": self._mt5_clock_status,
            "account": {"login": int(acc.login), "server": acc.server, "currency": acc.currency},
            "daily": rows, "scanned_deal_count": len(deals),
        }

    def _management_precondition_error(self, params, target, target_kind, required=False):
        expected = params.get("expected_state")
        if not isinstance(expected, dict):
            return "management_expected_state_required" if required else None
        if required and not str(expected.get("ticket") or "").strip():
            return "management_expected_ticket_required"
        if required and not str(expected.get("symbol") or "").strip():
            return "management_expected_symbol_required"
        if required and not str(expected.get("broker_server_key") or "").strip():
            return "management_expected_broker_server_required"
        if required and not str(expected.get("login_account") or "").strip():
            return "management_expected_login_account_required"
        if required and "magic" not in expected:
            return "management_expected_magic_required"
        if required and str(expected.get("direction") or "").strip().lower() not in ("buy", "sell"):
            return "management_expected_direction_invalid"
        if required:
            try:
                if not math.isfinite(float(expected.get("volume"))) or float(expected.get("volume")) <= 0:
                    return "management_expected_volume_invalid"
                int(expected.get("magic"))
            except (TypeError, ValueError, OverflowError):
                return "management_expected_state_invalid"
        account = self.mt5.account_info()
        if not account:
            return "management_account_unavailable"
        expected_server = str(expected.get("broker_server_key") or "").strip().upper()
        expected_login = str(expected.get("login_account") or "").strip()
        if expected_server and str(getattr(account, "server", "") or "").strip().upper() != expected_server:
            return "management_account_server_mismatch"
        if expected_login and str(getattr(account, "login", "") or "").strip() != expected_login:
            return "management_account_login_mismatch"
        expected_ticket = str(expected.get("ticket") or "").strip()
        actual_ticket = str(getattr(target, "ticket", "") or "").strip()
        if expected_ticket and actual_ticket != expected_ticket:
            return "management_ticket_mismatch"
        expected_symbol = str(expected.get("symbol") or "").strip()
        actual_symbol = str(getattr(target, "symbol", "") or "").strip()
        if expected_symbol and actual_symbol != expected_symbol:
            return "management_symbol_mismatch"
        expected_magic = expected.get("magic")
        if expected_magic is not None and int(getattr(target, "magic", 0) or 0) != int(expected_magic):
            return "management_magic_mismatch"
        expected_volume = expected.get("volume")
        actual_volume = getattr(target, "volume", None)
        if actual_volume is None:
            actual_volume = getattr(target, "volume_current", None)
        if target_kind == "pending" and float(actual_volume or 0) <= 0:
            actual_volume = getattr(target, "volume_initial", actual_volume)
        if expected_volume is not None and abs(float(actual_volume or 0) - float(expected_volume)) > 1e-8:
            return "management_volume_mismatch"
        expected_direction = str(expected.get("direction") or "").strip().lower()
        if expected_direction:
            if target_kind == "position":
                actual_direction = "buy" if int(getattr(target, "type", -1)) == self.mt5.ORDER_TYPE_BUY else "sell"
            else:
                buy_types = (self.mt5.ORDER_TYPE_BUY_LIMIT, self.mt5.ORDER_TYPE_BUY_STOP,
                             self.mt5.ORDER_TYPE_BUY_STOP_LIMIT)
                actual_direction = "buy" if int(getattr(target, "type", -1)) in buy_types else "sell"
            if actual_direction != expected_direction:
                return "management_direction_mismatch"
        return None

    def _preflight_new_order(self, params, expected_kind):
        """Fail closed or replay an existing MT5 execution before order_send."""
        command_ref = self._normalize_order_comment(params.get("comment"), "")
        if not command_ref.startswith("AI-"):
            return None
        lookup = lookup_existing_execution(
            self.mt5,
            {**params, "bridge_command_ref": command_ref, "expected_kind": expected_kind,
             "lookback_seconds": 7 * 24 * 60 * 60},
            SYSTEM_TRADE_MAGIC,
            self._resolve_symbol,
        )
        if lookup.get("status") != "success":
            return {
                "status": "uncertain",
                "message": lookup.get("message") or "order idempotency preflight failed",
                "idempotency_preflight_failed": True,
            }
        if not lookup.get("found"):
            return None
        replay = dict(lookup)
        replay["idempotent_replay"] = True
        if replay.get("kind") == "rejected":
            replay["status"] = "rejected"
            replay["message"] = "matching broker rejection already exists"
        else:
            replay["status"] = "success"
        return replay

    def _process_command(self, cmd):
        if not isinstance(cmd, dict):
            return {"status": "rejected", "message": "invalid_command"}
        raw_params = cmd.get("params", {})
        if not isinstance(raw_params, dict):
            return {"status": "rejected", "message": "invalid_command_params"}
        params = raw_params
        action = str(cmd.get("action") or "")
        if not action or len(action) > 64:
            return {"status": "rejected", "message": "invalid_command_action"}
        operation_id = str(params.get("operation_id") or "").strip()
        command_id = str(cmd.get("command_id") or "").strip()
        if len(operation_id) > 96:
            return {"status": "rejected", "message": "operation_id_too_long"}
        if len(command_id) > 128:
            return {"status": "rejected", "message": "command_id_too_long"}
        operation_signature = json.dumps({
            "action": action,
            "params": params,
        }, ensure_ascii=False, sort_keys=True, separators=(",", ":"), default=str)
        with self._mt5_lock:
            command_cache = getattr(self, "_command_results", None)
            if command_cache is None:
                command_cache = {}
                self._command_results = command_cache
            if command_id and command_id in command_cache:
                cached_command = command_cache[command_id]
                if (not isinstance(cached_command, dict)
                        or cached_command.get("signature") != operation_signature):
                    return {"status": "rejected", "message": "command_id_conflict",
                            "command_id": command_id}
                replay = dict(cached_command.get("result") or {})
                replay["idempotent_replay"] = True
                return replay
            cache = getattr(self, "_management_operation_results", None)
            if cache is None:
                cache = {}
                self._management_operation_results = cache
            if operation_id and operation_id in cache:
                cached = cache[operation_id]
                if not isinstance(cached, dict) or cached.get("signature") != operation_signature:
                    return {"status": "rejected", "message": "operation_id_conflict",
                            "operation_id": operation_id}
                replay = dict(cached.get("result") or {})
                replay["idempotent_replay"] = True
                if command_id:
                    command_cache[command_id] = {
                        "signature": operation_signature, "result": dict(replay),
                    }
                return replay
            result = self._process_command_locked(cmd)
            if isinstance(result, dict):
                result = dict(result)
                if operation_id:
                    result["operation_id"] = operation_id
                if command_id:
                    command_cache[command_id] = {
                        "signature": operation_signature, "result": dict(result),
                    }
                    while len(command_cache) > 500:
                        command_cache.pop(next(iter(command_cache)))
                if operation_id:
                    if cmd.get("action") in ("close", "cancel_pending", "close_system_position", "cancel_system_pending"):
                        cache[operation_id] = {"signature": operation_signature, "result": dict(result)}
                        while len(cache) > 500:
                            cache.pop(next(iter(cache)))
            return result

    def _process_command_locked(self, cmd):
        action = cmd.get("action"); params = cmd.get("params", {})
        try:
            if action == "open":
                replay = self._preflight_new_order(params, "trade")
                if replay is not None:
                    return replay
                if not self._trade_enabled:
                    return {"status": "rejected", "message": "trade sending is disabled"}
                symbol = self._resolve_symbol(params.get("symbol"))
                self.mt5.symbol_select(symbol, True)
                info = self.mt5.symbol_info(symbol)
                if not info: return {"status": "error", "message": f"Symbol not available: {symbol}"}
                tick0 = self.mt5.symbol_info_tick(symbol)
                if not tick0: return {"status": "error", "message": f"Invalid live quote for {symbol}"}
                dir_str = (params.get("type") or params.get("order_type") or "").strip().lower()
                if dir_str not in ("buy", "sell"):
                    return {"status": "error", "message": "order type is required (buy/sell)"}
                ot = self.mt5.ORDER_TYPE_BUY if dir_str == "buy" else self.mt5.ORDER_TYPE_SELL
                volume, volume_error = parse_required_order_volume(params)
                if volume_error: return {"status": "rejected", "message": volume_error}
                volume_error = self._validate_order_volume(info, volume)
                if volume_error: return {"status": "rejected", "message": volume_error}
                sl, price_error = self._parse_order_price(params.get("sl"), "stop loss")
                if price_error: return {"status": "rejected", "message": price_error}
                tp, price_error = self._parse_order_price(params.get("tp"), "take profit")
                if price_error: return {"status": "rejected", "message": price_error}
                base_req = {"action": self.mt5.TRADE_ACTION_DEAL, "symbol": symbol,
                            "volume": volume, "type": ot, "magic": SYSTEM_TRADE_MAGIC,
                            "comment": self._normalize_order_comment(params.get("comment"), "AI交易实验室"),
                            "type_time": self.mt5.ORDER_TIME_GTC,
                            "type_filling": self._get_filling_mode(symbol)}
                if params.get("deviation") is not None:
                    base_req["deviation"] = max(0, int(params.get("deviation") or 0))
                if sl: base_req["sl"] = sl
                if tp: base_req["tp"] = tp
                def _build(tick):
                    req = dict(base_req)
                    req["price"] = tick.ask if ot == self.mt5.ORDER_TYPE_BUY else tick.bid
                    return req, req["price"]
                result, comment = self._order_send_with_retry(symbol, _build)
                classification = classify_deal_result(result, self.mt5)
                if classification == "success":
                    position_id = getattr(result, "position", 0) or 0
                    deal_ticket = getattr(result, "deal", 0) or 0
                    if not position_id and deal_ticket:
                        try:
                            result_deals = self.mt5.history_deals_get(ticket=deal_ticket)
                            if result_deals: position_id = getattr(result_deals[0], "position_id", 0) or 0
                        except Exception as exc:
                            self.log_signal.emit(f"[Order] Failed to resolve position from deal {deal_ticket}: {exc}")
                    resp = {"status": "success", "order": result.order, "deal": deal_ticket,
                            "position_id": position_id or result.order, "price": result.price}
                    if comment: resp["warning"] = comment
                    return resp
                if classification in ("partial", "uncertain"):
                    return {"status": "uncertain", "message": "订单已受理，成交状态待 MT5 确认，系统不会自动重发",
                            "order": getattr(result, "order", 0) or 0,
                            "deal": getattr(result, "deal", 0) or 0,
                            "retcode": getattr(result, "retcode", -1)}
                if classification == "rejected":
                    return {"status": "rejected", "message": comment or "order_send rejected",
                            "retcode": getattr(result, "retcode", -1)}
                return {"status": "error", "message": comment or "order_send result unknown"}
            elif action == "close":
                ticket = params.get("ticket")
                if not ticket:
                    return {"status": "rejected", "message": "ticket is required"}
                if params.get("confirm") is not True:
                    return {"status": "rejected", "message": "manual_confirmation_required"}
                if ticket:
                    positions = self.mt5.positions_get(ticket=int(ticket))
                    if positions is None:
                        return {"status": "error", "message": f"positions_get failed: {self.mt5.last_error()}"}
                    if not positions:
                        return {"status": "rejected", "message": f"Position {ticket} not found"}
                    pos = positions[0]
                    precondition_error = self._management_precondition_error(params, pos, "position", required=True)
                    if precondition_error:
                        return {"status": "rejected", "message": precondition_error, "ticket": str(pos.ticket)}
                    ct = self.mt5.ORDER_TYPE_SELL if pos.type == self.mt5.ORDER_TYPE_BUY else self.mt5.ORDER_TYPE_BUY
                    self.mt5.symbol_select(pos.symbol, True)
                    sym = pos.symbol; vol = pos.volume; fill = self._get_filling_mode(sym)
                    def _close(tick):
                        price = tick.bid if ct == self.mt5.ORDER_TYPE_SELL else tick.ask
                        req = {"action": self.mt5.TRADE_ACTION_DEAL, "position": pos.ticket,
                               "symbol": sym, "volume": vol, "type": ct, "magic": SYSTEM_TRADE_MAGIC,
                               "type_filling": fill, "price": price}
                        return req, price
                    result, comment = self._order_send_with_retry(sym, _close)
                    remaining = self.mt5.positions_get(ticket=pos.ticket)
                    if remaining is None:
                        return {"status": "uncertain", "message": f"平仓结果无法复核: {self.mt5.last_error()}",
                                "ticket": pos.ticket, "retcode": getattr(result, "retcode", -1) if result else -1}
                    if len(remaining) == 0:
                        return {"status": "success", "ticket": pos.ticket,
                                "deal": getattr(result, "deal", 0) if result else 0,
                                "order": getattr(result, "order", 0) if result else 0}
                    remaining_volume = float(remaining[0].volume)
                    classification = classify_deal_result(result, self.mt5)
                    if remaining_volume < float(pos.volume):
                        return {"status": "partial", "message": "仅完成部分平仓", "ticket": pos.ticket,
                                "remaining_volume": remaining_volume,
                                "retcode": getattr(result, "retcode", -1) if result else -1}
                    if classification in ("partial", "uncertain", "unknown"):
                        return {"status": "uncertain", "message": comment or "平仓状态待 MT5 确认",
                                "ticket": pos.ticket, "remaining_volume": remaining_volume,
                                "retcode": getattr(result, "retcode", -1) if result else -1}
                    return {"status": "rejected", "message": comment or "close rejected", "ticket": pos.ticket,
                            "retcode": getattr(result, "retcode", -1) if result else -1}
            elif action == "rates":
                symbol = self._resolve_symbol(params.get("symbol"))
                self.mt5.symbol_select(symbol, True)
                tf_map = {"M1": self.mt5.TIMEFRAME_M1, "M5": self.mt5.TIMEFRAME_M5,
                          "M15": self.mt5.TIMEFRAME_M15, "M30": self.mt5.TIMEFRAME_M30,
                          "H1": self.mt5.TIMEFRAME_H1, "H4": self.mt5.TIMEFRAME_H4, "D1": self.mt5.TIMEFRAME_D1}
                tf = tf_map.get(params.get("timeframe", "M30"), self.mt5.TIMEFRAME_M30)
                count = min(5000, max(2, int(params.get("count", 100))))
                start_utc_msc = int(params.get("start_utc_msc") or 0)
                end_utc_msc = int(params.get("end_utc_msc") or 0)
                range_complete = bool(start_utc_msc > 0 and end_utc_msc > start_utc_msc)
                if range_complete:
                    # This broker exposes MT5 epoch values shifted by the
                    # calibrated server offset. Query the matching raw range,
                    # then _clock_fields normalizes every returned bar to UTC.
                    offset_msc = int(self._mt5_timezone_offset_minutes or 0) * 60000
                    raw_start = datetime.fromtimestamp((start_utc_msc + offset_msc) / 1000.0, timezone.utc)
                    raw_end = datetime.fromtimestamp((end_utc_msc + offset_msc) / 1000.0, timezone.utc)
                    rates = self.mt5.copy_rates_range(symbol, tf, raw_start, raw_end)
                    if rates is not None and len(rates) > count:
                        rates = rates[-count:]
                else:
                    rates = self.mt5.copy_rates_from_pos(symbol, tf, 0, count)
                if rates is not None and len(rates) > 0:
                    tick = self.mt5.symbol_info_tick(symbol)
                    if tick: self._calibrate_mt5_clock(tick)
                    out = [{"time": self._mt5_time(int(r[0])), **self._clock_fields(int(r[0]) * 1000), "open": float(r[1]), "high": float(r[2]),
                            "low": float(r[3]), "close": float(r[4]), "tick_volume": int(r[5]),
                            "spread": int(r[6]) if len(r) > 6 else 0} for r in rates]
                    return {"status": "success", "symbol": symbol, "timeframe": params.get("timeframe","M30"),
                            "count": len(out), "rates": out, "source": "mt5", "range_complete": range_complete,
                            "range_start_utc_msc": start_utc_msc or None, "range_end_utc_msc": end_utc_msc or None}
                return {"status": "success", "symbol": symbol, "rates": [], "source": "mt5"}
            elif action == "quote":
                symbol = self._resolve_symbol(params.get("symbol"))
                self.mt5.symbol_select(symbol, True)
                tick = self.mt5.symbol_info_tick(symbol); info = self.mt5.symbol_info(symbol)
                if not tick: return {"status": "error", "message": f"MT5 quote failed for {symbol}"}
                self._calibrate_mt5_clock(tick)
                return {"status": "success", "symbol": symbol, "bid": tick.bid, "ask": tick.ask,
                        "spread": round(info.spread * info.point, info.digits) if info else 0,
                        "time": self._mt5_time(tick.time), **self._clock_fields(getattr(tick, "time_msc", tick.time * 1000)),
                        "digits": info.digits if info else 2,
                        "point": info.point if info else 0.01, "source": "mt5"}
            elif action == "positions":
                sym = params.get("symbol")
                if sym: sym = self._resolve_symbol(sym)
                positions = self.mt5.positions_get(symbol=sym) if sym else self.mt5.positions_get()
                if positions:
                    payload = [{"ticket": str(p.ticket), "position_id": str(getattr(p, "identifier", p.ticket)),
                        "identifier": str(getattr(p, "identifier", p.ticket)), "symbol": p.symbol, "type": "buy" if p.type==0 else "sell",
                        "volume": p.volume, "open_price": p.price_open, "price_open": p.price_open,
                        "price_current": p.price_current, "profit": p.profit, "sl": p.sl, "tp": p.tp,
                        "swap": p.swap, "magic": p.magic, "comment": p.comment,
                        "time": self._mt5_time(getattr(p,'time',0)), "source": "mt5"} for p in positions]
                    return {"status": "success", "positions": payload, "count": len(payload), "source": "mt5"}
                return {"status": "success", "positions": [], "count": 0, "source": "mt5"}
            elif action == "system_trade_inventory":
                acc = self.mt5.account_info()
                if not acc:
                    return {"status": "error", "message": "no account info"}
                positions = self.mt5.positions_get()
                orders = self.mt5.orders_get()
                if positions is None:
                    return {"status": "error", "message": f"positions_get failed: {self.mt5.last_error()}"}
                if orders is None:
                    return {"status": "error", "message": f"orders_get failed: {self.mt5.last_error()}"}
                pending_type_map = {
                    self.mt5.ORDER_TYPE_BUY_LIMIT: "buy_limit",
                    self.mt5.ORDER_TYPE_SELL_LIMIT: "sell_limit",
                    self.mt5.ORDER_TYPE_BUY_STOP: "buy_stop",
                    self.mt5.ORDER_TYPE_SELL_STOP: "sell_stop",
                    self.mt5.ORDER_TYPE_BUY_STOP_LIMIT: "buy_stop_limit",
                    self.mt5.ORDER_TYPE_SELL_STOP_LIMIT: "sell_stop_limit",
                }
                pending_buy_types = (self.mt5.ORDER_TYPE_BUY_LIMIT, self.mt5.ORDER_TYPE_BUY_STOP,
                                     self.mt5.ORDER_TYPE_BUY_STOP_LIMIT)
                system_positions = [{
                    "ticket": str(p.ticket), "symbol": p.symbol,
                    "type": "buy" if p.type == self.mt5.ORDER_TYPE_BUY else "sell",
                    "volume": p.volume, "price_open": p.price_open,
                    "price_current": p.price_current, "profit": p.profit,
                    "sl": p.sl, "tp": p.tp,
                    "magic": p.magic, "comment": p.comment,
                } for p in positions if int(getattr(p, "magic", 0) or 0) == SYSTEM_TRADE_MAGIC]
                system_pending = [{
                    "ticket": str(o.ticket), "symbol": o.symbol,
                    "type": pending_type_map.get(o.type, "unknown"),
                    "side": "buy" if o.type in pending_buy_types else "sell",
                    "volume": o.volume_current, "price": o.price_open,
                    "magic": o.magic, "comment": o.comment,
                } for o in orders if int(getattr(o, "magic", 0) or 0) == SYSTEM_TRADE_MAGIC]
                raw_margin_mode = getattr(acc, "margin_mode", None)
                margin_mode = int(raw_margin_mode) if raw_margin_mode is not None else -1
                hedging_mode = int(getattr(self.mt5, "ACCOUNT_MARGIN_MODE_RETAIL_HEDGING", 2))
                return {
                    "status": "success",
                    "account": {"login": str(acc.login), "server": acc.server,
                                "margin_mode": margin_mode, "is_hedging": margin_mode == hedging_mode},
                    "magic": SYSTEM_TRADE_MAGIC,
                    "positions": system_positions,
                    "pending_orders": system_pending,
                }
            elif action == "close_system_position":
                ticket = params.get("ticket")
                if not ticket:
                    return {"status": "error", "message": "ticket is required"}
                positions = self.mt5.positions_get(ticket=int(ticket))
                if positions is None:
                    return {"status": "error", "message": f"positions_get failed: {self.mt5.last_error()}"}
                if not positions:
                    return {"status": "success", "ticket": int(ticket), "already_absent": True}
                pos = positions[0]
                precondition_error = self._management_precondition_error(params, pos, "position", required=True)
                if precondition_error:
                    return {"status": "rejected", "message": precondition_error, "ticket": pos.ticket}
                if int(getattr(pos, "magic", 0) or 0) != SYSTEM_TRADE_MAGIC:
                    return {"status": "rejected", "message": "position_magic_mismatch", "ticket": pos.ticket}
                close_type = self.mt5.ORDER_TYPE_SELL if pos.type == self.mt5.ORDER_TYPE_BUY else self.mt5.ORDER_TYPE_BUY
                self.mt5.symbol_select(pos.symbol, True)
                fill = self._get_filling_mode(pos.symbol)
                def _close_system(tick):
                    price = tick.bid if close_type == self.mt5.ORDER_TYPE_SELL else tick.ask
                    return ({"action": self.mt5.TRADE_ACTION_DEAL, "position": pos.ticket,
                             "symbol": pos.symbol, "volume": pos.volume, "type": close_type,
                             "magic": SYSTEM_TRADE_MAGIC,
                             "comment": str(params.get("comment") or "AI持仓管理退出")[:31],
                             "type_filling": fill, "price": price}, price)
                result, comment = self._order_send_with_retry(pos.symbol, _close_system)
                remaining = self.mt5.positions_get(ticket=pos.ticket)
                if remaining is None:
                    return {"status": "uncertain", "message": f"close verification failed: {self.mt5.last_error()}",
                            "ticket": pos.ticket,
                            "retcode": getattr(result, "retcode", -1) if result else -1}
                if len(remaining) == 0:
                    return {"status": "success", "ticket": pos.ticket,
                            "deal": getattr(result, "deal", 0) if result else 0,
                            "order": getattr(result, "order", 0) if result else 0,
                            "price": getattr(result, "price", 0) if result else 0,
                            "warning": comment}
                remaining_volume = float(remaining[0].volume)
                retcode = getattr(result, "retcode", -1) if result else -1
                classification = classify_deal_result(result, self.mt5)
                unresolved = classification in ("partial", "uncertain", "unknown")
                return {"status": "partial" if remaining_volume < float(pos.volume) else ("uncertain" if unresolved else "rejected"),
                        "message": comment or "position still exists after close",
                        "ticket": pos.ticket, "retcode": retcode,
                        "remaining_volume": remaining_volume}
            elif action == "cancel_system_pending":
                ticket = params.get("ticket")
                if not ticket:
                    return {"status": "error", "message": "ticket is required"}
                orders = self.mt5.orders_get(ticket=int(ticket))
                if orders is None:
                    return {"status": "error", "message": f"orders_get failed: {self.mt5.last_error()}"}
                if not orders:
                    return {"status": "success", "ticket": int(ticket), "already_absent": True}
                order = orders[0]
                precondition_error = self._management_precondition_error(params, order, "pending", required=True)
                if precondition_error:
                    return {"status": "rejected", "message": precondition_error, "ticket": order.ticket}
                if int(getattr(order, "magic", 0) or 0) != SYSTEM_TRADE_MAGIC:
                    return {"status": "rejected", "message": "pending_magic_mismatch", "ticket": order.ticket}
                result = self.mt5.order_send({"action": self.mt5.TRADE_ACTION_REMOVE, "order": order.ticket})
                remaining = self.mt5.orders_get(ticket=order.ticket)
                if remaining is None:
                    return {"status": "uncertain", "message": f"cancel verification failed: {self.mt5.last_error()}",
                            "ticket": order.ticket,
                            "retcode": getattr(result, "retcode", -1) if result else -1}
                if len(remaining) == 0:
                    return {"status": "success", "ticket": order.ticket,
                            "warning": result.comment if result and result.retcode != self.mt5.TRADE_RETCODE_DONE else None}
                retcode = getattr(result, "retcode", -1) if result else -1
                unresolved = result is None or retcode in (
                    self.mt5.TRADE_RETCODE_DONE,
                    getattr(self.mt5, "TRADE_RETCODE_TIMEOUT", 10012),
                )
                return {"status": "uncertain" if unresolved else "rejected",
                        "message": result.comment if result else "pending order still exists after cancel",
                        "ticket": order.ticket, "retcode": getattr(result, "retcode", -1) if result else -1}
            elif action == "pending_order_state":
                ticket = params.get("ticket")
                if not ticket:
                    return {"status": "error", "message": "ticket is required"}
                ticket = int(ticket)
                account = self.mt5.account_info()
                if not account:
                    return {"status": "error", "message": "no account info"}
                buy_types = (self.mt5.ORDER_TYPE_BUY_LIMIT, self.mt5.ORDER_TYPE_BUY_STOP,
                             self.mt5.ORDER_TYPE_BUY_STOP_LIMIT)
                def _pending_state_row(order):
                    return {
                        "ticket": order.ticket, "position_id": getattr(order, "position_id", 0) or None,
                        "symbol": order.symbol,
                        "side": "buy" if int(getattr(order, "type", -1)) in buy_types else "sell",
                        "type": int(getattr(order, "type", -1)),
                        "state": int(getattr(order, "state", -1)),
                        "volume_initial": float(getattr(order, "volume_initial", 0) or 0),
                        "volume": float(getattr(order, "volume_current", 0) or 0),
                        "price": float(getattr(order, "price_open", 0) or 0),
                        "magic": int(getattr(order, "magic", 0) or 0),
                        "comment": str(getattr(order, "comment", "") or ""),
                    }
                current = self.mt5.orders_get(ticket=ticket)
                if current is None:
                    return {"status": "error", "message": f"orders_get failed: {self.mt5.last_error()}"}
                account_row = {"login": account.login, "server": account.server}
                if current:
                    order_row = _pending_state_row(current[0])
                    precondition_error = self._management_precondition_error(params, current[0], "pending")
                    if precondition_error:
                        return {"status": "success", "account": account_row,
                                "current_state": "identity_changed", "final_state": "unknown",
                                "order": order_row, "precondition_error": precondition_error}
                    return {"status": "success", "account": account_row,
                            "current_state": "pending", "final_state": None, "order": order_row}
                history = self.mt5.history_orders_get(ticket=ticket)
                if history is None:
                    return {"status": "error", "message": f"history_orders_get failed: {self.mt5.last_error()}"}
                if not history:
                    return {"status": "success", "account": account_row,
                            "current_state": "absent", "final_state": "unknown", "order": None}
                historical = history[-1]
                order_row = _pending_state_row(historical)
                precondition_error = self._management_precondition_error(params, historical, "pending")
                if precondition_error:
                    return {"status": "success", "account": account_row,
                            "current_state": "history", "final_state": "unknown",
                            "order": order_row, "precondition_error": precondition_error}
                state = int(getattr(historical, "state", -1))
                if state == getattr(self.mt5, "ORDER_STATE_FILLED", 4):
                    final_state = "filled"
                elif state == getattr(self.mt5, "ORDER_STATE_PARTIAL", 3):
                    final_state = "partially_filled"
                elif state == getattr(self.mt5, "ORDER_STATE_CANCELED", 2):
                    final_state = "cancelled"
                elif state == getattr(self.mt5, "ORDER_STATE_EXPIRED", 6):
                    final_state = "expired"
                elif state == getattr(self.mt5, "ORDER_STATE_REJECTED", 5):
                    final_state = "rejected"
                else:
                    final_state = "unknown"
                return {"status": "success", "account": account_row,
                        "current_state": "history", "final_state": final_state,
                        "position_id": order_row.get("position_id"), "order": order_row}
            elif action == "symbols":
                symbols = self.mt5.symbols_get()
                if symbols is None: return {"status": "error", "message": "MT5 symbols_get failed"}
                payload = [{"name": s.name, "description": s.description, "digits": s.digits,
                    "trade_mode": s.trade_mode, "point": s.point,
                    "tick_size": float(getattr(s, "trade_tick_size", 0) or 0),
                    "tick_value": float(getattr(s, "trade_tick_value", 0) or 0),
                    "contract_size": float(getattr(s, "trade_contract_size", 0) or 0),
                    "volume_min": float(getattr(s, "volume_min", 0) or 0),
                    "volume_max": float(getattr(s, "volume_max", 0) or 0),
                    "volume_step": float(getattr(s, "volume_step", 0) or 0)} for s in symbols]
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
            elif action == "symbol_snapshot":
                # Lightweight contract/account metadata for historical account
                # simulation. It deliberately avoids positions, orders and
                # account history so model comparison does not consume excess
                # bridge bandwidth.
                symbol = self._resolve_symbol(params.get("symbol"))
                self.mt5.symbol_select(symbol, True)
                info = self.mt5.symbol_info(symbol)
                acc = self.mt5.account_info()
                if not info:
                    return {"status": "error", "message": f"symbol_info unavailable: {symbol}"}
                if not acc:
                    return {"status": "error", "message": "account_info unavailable"}
                tick = self.mt5.symbol_info_tick(symbol)
                reference_buy = float(getattr(tick, "ask", 0) or 0) if tick else 0.0
                reference_sell = float(getattr(tick, "bid", 0) or 0) if tick else 0.0
                volume_min = float(getattr(info, "volume_min", 0) or 0)
                volume_max = float(getattr(info, "volume_max", 0) or 0)
                volume_step = float(getattr(info, "volume_step", 0) or 0)
                margin_probe_volume = max(volume_min, min(1.0, volume_max)) if volume_max > 0 else 1.0
                if volume_step > 0:
                    margin_probe_volume = round(margin_probe_volume / volume_step) * volume_step
                    margin_probe_volume = max(volume_min, min(margin_probe_volume, volume_max))

                def margin_per_lot(order_type, price):
                    if price <= 0 or margin_probe_volume <= 0:
                        return None
                    try:
                        value = self.mt5.order_calc_margin(
                            order_type, symbol, margin_probe_volume, price)
                        return (float(value) / margin_probe_volume
                                if value is not None and float(value) >= 0 else None)
                    except (AttributeError, TypeError, ValueError, RuntimeError):
                        return None

                margin_buy = margin_per_lot(self.mt5.ORDER_TYPE_BUY, reference_buy)
                margin_sell = margin_per_lot(self.mt5.ORDER_TYPE_SELL, reference_sell)
                return {
                    "status": "success",
                    "symbol": symbol,
                    "account": {
                        "currency": str(acc.currency or ""),
                        "balance": float(acc.balance),
                        "equity": float(acc.equity),
                        "leverage": int(acc.leverage),
                        "margin_mode": int(getattr(acc, "margin_mode", 0) or 0),
                        "margin_so_mode": int(getattr(acc, "margin_so_mode", 0) or 0),
                        "margin_so_call": float(getattr(acc, "margin_so_call", 0) or 0),
                        "margin_so_so": float(getattr(acc, "margin_so_so", 0) or 0),
                    },
                    "instrument": {
                        "name": info.name, "digits": int(info.digits), "trade_mode": int(info.trade_mode),
                        "trade_calc_mode": int(getattr(info, "trade_calc_mode", 0) or 0),
                        "trade_exemode": int(getattr(info, "trade_exemode", 0) or 0),
                        "trade_stops_level": int(getattr(info, "trade_stops_level", 0) or 0),
                        "trade_freeze_level": int(getattr(info, "trade_freeze_level", 0) or 0),
                        "filling_mode": int(getattr(info, "filling_mode", 0) or 0),
                        "order_mode": int(getattr(info, "order_mode", 0) or 0),
                        "point": float(info.point),
                        "spread": int(getattr(info, "spread", 0) or 0),
                        "spread_float": bool(getattr(info, "spread_float", False)),
                        "tick_size": float(getattr(info, "trade_tick_size", 0) or 0),
                        "tick_value": float(getattr(info, "trade_tick_value", 0) or 0),
                        "contract_size": float(getattr(info, "trade_contract_size", 0) or 0),
                        "margin_initial": float(getattr(info, "margin_initial", 0) or 0),
                        "margin_maintenance": float(getattr(info, "margin_maintenance", 0) or 0),
                        "margin_hedged": float(getattr(info, "margin_hedged", 0) or 0),
                        "margin_per_lot_buy": margin_buy,
                        "margin_per_lot_sell": margin_sell,
                        "margin_reference_price_buy": reference_buy if reference_buy > 0 else None,
                        "margin_reference_price_sell": reference_sell if reference_sell > 0 else None,
                        "margin_profile_currency": str(acc.currency or ""),
                        "margin_profile_volume": margin_probe_volume,
                        "volume_min": volume_min,
                        "volume_max": volume_max,
                        "volume_step": volume_step,
                        "volume_limit": float(getattr(info, "volume_limit", 0) or 0),
                        "swap_mode": int(getattr(info, "swap_mode", 0) or 0),
                        "swap_rollover3days": int(getattr(info, "swap_rollover3days", 0) or 0),
                        "swap_long": float(getattr(info, "swap_long", 0) or 0),
                        "swap_short": float(getattr(info, "swap_short", 0) or 0),
                        "swap_sunday": float(info.swap_sunday) if hasattr(info, "swap_sunday") else None,
                        "swap_monday": float(info.swap_monday) if hasattr(info, "swap_monday") else None,
                        "swap_tuesday": float(info.swap_tuesday) if hasattr(info, "swap_tuesday") else None,
                        "swap_wednesday": float(info.swap_wednesday) if hasattr(info, "swap_wednesday") else None,
                        "swap_thursday": float(info.swap_thursday) if hasattr(info, "swap_thursday") else None,
                        "swap_friday": float(info.swap_friday) if hasattr(info, "swap_friday") else None,
                        "swap_saturday": float(info.swap_saturday) if hasattr(info, "swap_saturday") else None,
                        "currency_base": str(getattr(info, "currency_base", "") or ""),
                        "currency_profit": str(getattr(info, "currency_profit", "") or ""),
                        "currency_margin": str(getattr(info, "currency_margin", "") or ""),
                    },
                }
            elif action == "order_lookup":
                # Only one compact match crosses the WebSocket; complete MT5
                # positions/orders/deals remain local to the Bridge process.
                return lookup_existing_execution(
                    self.mt5, params, SYSTEM_TRADE_MAGIC, self._resolve_symbol,
                )
            elif action == "risk_snapshot":
                return self._risk_snapshot(params)
            elif action == "performance_daily":
                return self._performance_daily(params)
            elif action == "history":
                import math
                self.log_signal.emit(f"[History] called with params={params}")
                try:
                    page = int(params.get("page", 1))
                    page_size = int(params.get("page_size", 20))
                except (ValueError, TypeError):
                    page, page_size = 1, 20
                if page < 1: page = 1
                if page_size < 1: page_size = 20
                page = min(page, 1_000_000)
                page_size = min(page_size, 10_000)
                deposit = withdrawal = credit = 0.0
                if "date_to" in params:
                    try: date_to = datetime.strptime(params["date_to"][:10], "%Y-%m-%d") + timedelta(days=1)
                    except (ValueError, KeyError, TypeError): date_to = datetime.utcnow() + timedelta(days=1)
                else:
                    date_to = datetime.utcnow() + timedelta(days=1)
                if "date_from" in params:
                    try: date_from = datetime.strptime(params["date_from"][:10], "%Y-%m-%d")
                    except (ValueError, KeyError, TypeError): date_from = FULL_HISTORY_START
                else:
                    # Empty UI filters mean complete account history. A rolling
                    # default would undercount deposits, withdrawals and profit.
                    date_from = FULL_HISTORY_START
                self.log_signal.emit(f"[History] date_from={date_from}, date_to={date_to}")
                deals, history_cache_hit = self._history_deals_for_range(
                    date_from, date_to, bool(params.get("force_refresh", False)))
                self.log_signal.emit(f"[History] deals={len(deals) if deals else 'None'}, cache_hit={history_cache_hit}")
                if deals is None: return {"status": "error", "message": f"MT5 history_deals_get failed: {self.mt5.last_error()}"}
                deal_rows = [d._asdict() for d in deals]
                order_lookup = {}
                history_order_rows = []
                include_deals = bool(params.get("include_deals", False))
                orders = self.mt5.history_orders_get(date_from, date_to) if include_deals else None
                if orders:
                    for o in orders:
                        od = o._asdict()
                        ticket = od.get("ticket")
                        if ticket is None: continue
                        tp = getattr(o, "tp", 0) or od.get("tp") or 0
                        sl = getattr(o, "sl", 0) or od.get("sl") or 0
                        order_lookup[int(ticket)] = {**od, "tp": tp, "sl": sl}
                        history_order_rows.append({
                            "ticket": ticket, "position_id": od.get("position_id"), "symbol": od.get("symbol"),
                            "type": od.get("type"), "state": od.get("state"), "magic": od.get("magic"),
                            "reason": od.get("reason"), "comment": od.get("comment"),
                            "volume_initial": od.get("volume_initial"), "volume_current": od.get("volume_current"),
                            "price_open": od.get("price_open"), "price_current": od.get("price_current"),
                            "sl": sl, "tp": tp, "time_setup": self._mt5_time(od.get("time_setup")),
                            "time_done": self._mt5_time(od.get("time_done"))})
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
                entry_out = getattr(self.mt5, "DEAL_ENTRY_OUT", 1)
                entry_inout = getattr(self.mt5, "DEAL_ENTRY_INOUT", 2)
                entry_in = getattr(self.mt5, "DEAL_ENTRY_IN", 0)
                deal_type_buy = getattr(self.mt5, "DEAL_TYPE_BUY", 0)
                compact = params.get("compact", False)
                if compact:
                    compact_rows = []
                    for d in deal_rows:
                        if d.get("entry") not in (entry_out, entry_inout): continue
                        pid = d.get("position_id") or d.get("order") or d.get("ticket") or ""
                        sd = next((i for i in deals_by_pos.get(pid, []) if i.get("entry") == entry_in), d)
                        compact_rows.append({"t": self._mt5_time(d.get("time")), "p": float(d.get("profit") or 0), "y": "BUY" if sd.get("type") == deal_type_buy else "SELL"})
                    compact_rows.sort(key=lambda r: r.get("t") or "", reverse=True)
                    return {"status": "success", "orders": compact_rows, "total_count": len(compact_rows)}
                rows = []
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
                    ord_info = order_lookup.get(eo, {})
                    rows.append({"ticket": eo, "deal_ticket": d.get("ticket"), "order": eo,
                        "position_id": pid, "symbol": sym, "type": direction, "volume": d.get("volume"),
                        "entry_price": ep, "exit_price": xp, "price": xp, "profit": d.get("profit"),
                        "swap": d.get("swap"), "commission": d.get("commission"), "fee": d.get("fee"),
                        "net_profit": float(d.get("profit") or 0) + float(d.get("swap") or 0) + float(d.get("commission") or 0) + float(d.get("fee") or 0),
                        "profit_points": pp,
                        "entry_time": self._mt5_time((ed or {}).get("time")),
                        "close_time": self._mt5_time(d.get("time")), "time": self._mt5_time(d.get("time")),
                        "comment": d.get("comment"),
                        "take_profit": ord_info.get("tp"), "stop_loss": ord_info.get("sl")})
                rows.sort(key=lambda r: r.get("close_time") or r.get("entry_time") or "", reverse=True)
                # Apply direction/profit filters before pagination
                direction_filter = params.get("direction", "")
                profit_filter = params.get("profit_filter", "")
                if direction_filter:
                    rows = [r for r in rows if r.get("type") == direction_filter]
                if profit_filter == "profit":
                    rows = [r for r in rows if float(r.get("profit") or 0) > 0]
                elif profit_filter == "loss":
                    rows = [r for r in rows if float(r.get("profit") or 0) < 0]
                entry_from = str(params.get("entry_from") or "")[:10]
                entry_to = str(params.get("entry_to") or "")[:10]
                if entry_from:
                    rows = [r for r in rows if str(r.get("entry_time") or "")[:10] >= entry_from]
                if entry_to:
                    rows = [r for r in rows if str(r.get("entry_time") or "")[:10] <= entry_to]
                total = len(rows); si = max(page-1,0)*page_size
                pr = rows[si:si+page_size]
                if not include_deals:
                    # SL/TP is only rendered for the visible page. Large
                    # accounts no longer load every historical order per page.
                    for row in pr:
                        try:
                            page_orders = self.mt5.history_orders_get(ticket=int(row.get("ticket") or 0))
                        except (TypeError, ValueError):
                            page_orders = None
                        if not page_orders: continue
                        page_order = page_orders[-1]
                        row["take_profit"] = float(getattr(page_order, "tp", 0) or 0)
                        row["stop_loss"] = float(getattr(page_order, "sl", 0) or 0)
                tp = sum(float(r.get("net_profit") or 0) for r in rows)
                nr = tp+credit+deposit-withdrawal
                ab = 10000.0
                try:
                    acc = self.mt5.account_info()
                    if acc: ab = float(acc.balance)
                except Exception as e:
                    self.log_signal.emit(f"获取账户余额失败: {e}")
                raw_deals = []
                if include_deals:
                    for d in deal_rows:
                        raw_deals.append({"deal_ticket": d.get("ticket"), "ticket": d.get("ticket"),
                            "order": d.get("order"), "position_id": d.get("position_id"), "symbol": d.get("symbol"),
                            "type": d.get("type"), "entry": d.get("entry"), "magic": d.get("magic"),
                            "reason": d.get("reason"), "comment": d.get("comment"), "volume": d.get("volume"),
                            "price": d.get("price"), "profit": d.get("profit"), "commission": d.get("commission"),
                            "swap": d.get("swap"), "fee": d.get("fee"), "sl": d.get("sl"), "tp": d.get("tp"),
                            "time": self._mt5_time(d.get("time")), "time_msc": d.get("time_msc")})
                return {"status": "success", "orders": pr,
                    "deals": raw_deals, "history_orders": history_order_rows if include_deals else [],
                    "statistics": {
                    "account_principal": round(ab-nr,2), "account_balance": round(ab,2),
                    "total_profit": round(tp,2), "credit": round(credit,2), "deposit": round(deposit,2),
                    "withdrawal": round(withdrawal,2), "net_result": round(nr,2),
                    "trade_count": total, "total_volume": round(sum(float(r.get("volume") or 0) for r in rows),2)},
                    "pagination": {"current_page": page, "page_size": page_size,
                        "total_count": total, "total_pages": max(math.ceil(total/page_size),1)}, "source": "mt5"}
                self.log_signal.emit(f"[History] returned {total} trades, {len(rows)} rows")
            elif action == "chart_data":
                # Chart aggregation: returns daily stats, cumulative, drawdown
                import math
                # Date range
                if "date_to" in params:
                    try: date_to = datetime.strptime(params["date_to"][:10], "%Y-%m-%d") + timedelta(days=1)
                    except (ValueError, KeyError, TypeError): date_to = datetime.utcnow() + timedelta(days=1)
                else:
                    date_to = datetime.utcnow() + timedelta(days=1)
                if "date_from" in params:
                    try: date_from = datetime.strptime(params["date_from"][:10], "%Y-%m-%d")
                    except (ValueError, KeyError, TypeError): date_from = FULL_HISTORY_START
                else:
                    # Keep chart totals consistent with the history table: an
                    # empty UI filter means the complete account history.
                    date_from = FULL_HISTORY_START
                # Optional filters
                direction_filter = params.get("direction", "")
                profit_filter = params.get("profit_filter", "")
                # Fetch deals
                deals, history_cache_hit = self._history_deals_for_range(
                    date_from, date_to, bool(params.get("force_refresh", False)))
                if deals is None:
                    return {"status": "error", "message": f"MT5 history_deals_get failed: {self.mt5.last_error()}"}
                deal_rows = [d._asdict() for d in deals]
                # Group by position
                entry_out = getattr(self.mt5, "DEAL_ENTRY_OUT", 1)
                entry_inout = getattr(self.mt5, "DEAL_ENTRY_INOUT", 2)
                entry_in = getattr(self.mt5, "DEAL_ENTRY_IN", 0)
                deal_type_buy = getattr(self.mt5, "DEAL_TYPE_BUY", 0)
                deals_by_pos = {}
                for d in deal_rows:
                    key = d.get("position_id") or d.get("order") or d.get("ticket")
                    deals_by_pos.setdefault(key, []).append(d)
                # Build orders list
                orders = []
                for d in deal_rows:
                    if d.get("entry") not in (entry_out, entry_inout): continue
                    pid = d.get("position_id") or d.get("order") or d.get("ticket")
                    grp = deals_by_pos.get(pid, [])
                    ed = next((i for i in grp if i.get("entry") == entry_in), None)
                    direction = "BUY" if (ed or d).get("type") == deal_type_buy else "SELL"
                    profit = (float(d.get("profit") or 0) + float(d.get("swap") or 0)
                        + float(d.get("commission") or 0) + float(d.get("fee") or 0))
                    close_time = self._mt5_time(d.get("time"))
                    orders.append({"type": direction, "profit": profit, "close_time": close_time})
                # Apply direction/profit filters
                if direction_filter:
                    orders = [o for o in orders if o["type"] == direction_filter]
                if profit_filter == "profit":
                    orders = [o for o in orders if o["profit"] > 0]
                elif profit_filter == "loss":
                    orders = [o for o in orders if o["profit"] < 0]
                # Sort by close_time
                orders.sort(key=lambda o: o.get("close_time") or "")
                # Daily aggregation
                daily_map = {}
                for o in orders:
                    d = (o.get("close_time") or "")[:10]
                    if not d: continue
                    if d not in daily_map:
                        daily_map[d] = {"date": d, "profit": 0, "trade_count": 0, "wins": 0, "losses": 0}
                    p = o["profit"]
                    daily_map[d]["profit"] += p
                    daily_map[d]["trade_count"] += 1
                    if p > 0: daily_map[d]["wins"] += 1
                    elif p < 0: daily_map[d]["losses"] += 1
                # Round profits
                for v in daily_map.values():
                    v["profit"] = round(v["profit"] * 100) / 100
                daily = sorted(daily_map.values(), key=lambda x: x["date"])
                # Cumulative + drawdown
                acc = self.mt5.account_info()
                balance = float(acc.balance) if acc else 10000.0
                total_profit = sum(o["profit"] for o in orders)
                init_capital = max(0, balance - total_profit)
                cumulative = []
                drawdown = []
                cum = 0
                peak = init_capital
                max_dd = 0
                for day in daily:
                    cum += day["profit"]
                    cum = round(cum * 100) / 100
                    cumulative.append(cum)
                    equity = init_capital + cum
                    if equity > peak: peak = equity
                    dd = round((1 - equity / peak) * 10000) / 100 if peak > 0 else 0
                    drawdown.append(dd)
                    if dd > max_dd: max_dd = dd
                # Win/loss stats
                wins = [o for o in orders if o["profit"] > 0]
                losses = [o for o in orders if o["profit"] < 0]
                gross_profit = sum(o["profit"] for o in wins)
                gross_loss = abs(sum(o["profit"] for o in losses))
                avg_win = gross_profit / len(wins) if wins else 0
                avg_loss = gross_loss / len(losses) if losses else 0
                return {"status": "success", "daily": daily, "cumulative": cumulative,
                    "drawdown": drawdown, "history_cache_hit": history_cache_hit, "stats": {
                    "total_trades": len(orders),
                    "win_rate": round(len(wins) / len(orders) * 10000) / 100 if orders else 0,
                    "profit_factor": round(avg_win / avg_loss * 100) / 100 if avg_loss > 0 else (999 if avg_win > 0 else 0),
                    "max_drawdown": max_dd,
                    "gross_profit": round(gross_profit * 100) / 100,
                    "gross_loss": round(gross_loss * 100) / 100
                }}
            elif action == "diagnostics":
                acc = self.mt5.account_info(); terminal = self.mt5.terminal_info()
                return {"status": "success", "mt5_connected": True,
                    "account": {"login": acc.login, "server": acc.server, "balance": acc.balance} if acc else None,
                    "terminal": {"build": terminal.build, "connected": terminal.connected,
                        "trade_allowed": terminal.trade_allowed} if terminal else None}
            elif action == "toggle_trade":
                if not isinstance(params.get("enable"), bool):
                    return {"status": "rejected", "message": "trade_toggle_boolean_required"}
                self._trade_enabled = params["enable"]
                return {"status": "success", "live_trading_enabled": self._trade_enabled}
            elif action == "set_quote_symbol":
                self._resolved_symbol = self._resolve_symbol(params.get("symbol", "XAUUSD"))
                return {"status": "success", "symbol": self._resolved_symbol}

            elif action == "market_state":
                symbol = self._resolve_symbol(params.get("symbol", "XAUUSD"))
                self.mt5.symbol_select(symbol, True)
                info = self.mt5.symbol_info(symbol)
                tick = self.mt5.symbol_info_tick(symbol)
                terminal = self.mt5.terminal_info()
                return {"status": "success", "symbol": symbol,
                    **self._detect_market_state(symbol, info, tick, terminal)}

            elif action == "pending":
                replay = self._preflight_new_order(params, "pending")
                if replay is not None:
                    return replay
                if not self._trade_enabled:
                    return {"status": "rejected", "message": "trade sending is disabled"}
                symbol = self._resolve_symbol(params.get("symbol"))
                self.mt5.symbol_select(symbol, True)
                info = self.mt5.symbol_info(symbol)
                if not info: return {"status": "error", "message": f"Symbol not available: {symbol}"}

                dir_str = (params.get("type") or params.get("order_type") or "").strip().lower()
                price, price_error = self._parse_order_price(params.get("price"), "price", required=True)
                if price_error: return {"status": "rejected", "message": price_error}
                volume, volume_error = parse_required_order_volume(params)
                if volume_error: return {"status": "rejected", "message": volume_error}
                volume_error = self._validate_order_volume(info, volume)
                if volume_error: return {"status": "rejected", "message": volume_error}
                sl, price_error = self._parse_order_price(params.get("sl"), "stop loss")
                if price_error: return {"status": "rejected", "message": price_error}
                tp, price_error = self._parse_order_price(params.get("tp"), "take profit")
                if price_error: return {"status": "rejected", "message": price_error}

                if dir_str not in ("buy_limit", "sell_limit", "buy_stop", "sell_stop", "buy_stop_limit", "sell_stop_limit"):
                    return {"status": "error", "message": f"Invalid pending type: {dir_str}"}

                ot_map = {
                    "buy_limit": self.mt5.ORDER_TYPE_BUY_LIMIT,
                    "sell_limit": self.mt5.ORDER_TYPE_SELL_LIMIT,
                    "buy_stop": self.mt5.ORDER_TYPE_BUY_STOP,
                    "sell_stop": self.mt5.ORDER_TYPE_SELL_STOP,
                    "buy_stop_limit": self.mt5.ORDER_TYPE_BUY_STOP_LIMIT,
                    "sell_stop_limit": self.mt5.ORDER_TYPE_SELL_STOP_LIMIT,
                }
                ot = ot_map[dir_str]
                fill = self._get_filling_mode(symbol)

                # Expiration: Unix timestamp (int) or datetime string
                expiration_val = params.get("expiration") or params.get("valid_until")
                exp_ts = 0
                type_time = self.mt5.ORDER_TIME_GTC
                if expiration_val:
                    try:
                        n = float(expiration_val)
                        if not math.isfinite(n) or n <= 1000000000:
                            raise ValueError("invalid pending order expiration")
                        exp_ts = int(n)
                        type_time = self.mt5.ORDER_TIME_SPECIFIED
                    except (ValueError, TypeError, OverflowError):
                        try:
                            exp_dt = datetime.strptime(str(expiration_val)[:19], "%Y-%m-%d %H:%M:%S")
                            exp_ts = int(exp_dt.timestamp())
                            type_time = self.mt5.ORDER_TIME_SPECIFIED
                        except (ValueError, TypeError, OverflowError, OSError):
                            return {"status": "error", "message": "invalid pending order expiration"}

                req = {
                    "action": self.mt5.TRADE_ACTION_PENDING,
                    "symbol": symbol, "volume": volume, "type": ot,
                    "price": price, "magic": SYSTEM_TRADE_MAGIC,
                    "comment": self._normalize_order_comment(params.get("comment"), "AI挂单"),
                    "type_filling": self.mt5.ORDER_FILLING_RETURN,
                    "type_time": type_time,
                    "expiration": exp_ts,
                }
                if sl: req["sl"] = sl
                if tp: req["tp"] = tp
                if params.get("deviation") is not None:
                    req["deviation"] = max(0, int(params.get("deviation") or 0))
                stoplimit_price = params.get("stoplimit_price")
                if ot in (self.mt5.ORDER_TYPE_BUY_STOP_LIMIT, self.mt5.ORDER_TYPE_SELL_STOP_LIMIT):
                    stoplimit_price, price_error = self._parse_order_price(
                        stoplimit_price, "stoplimit price", required=True,
                    )
                    if price_error: return {"status": "rejected", "message": price_error}
                    req["stoplimit"] = stoplimit_price

                self.log_signal.emit(f"[Pending] type_filling=RETURN type_time={type_time} exp_ts={exp_ts}")
                check = self.mt5.order_check(req)
                if check is None:
                    err = self.mt5.last_error()
                    self.log_signal.emit(f"[Pending] order_check returned None, last_error={err}")
                    return {"status": "rejected", "message": f"pending order check failed: {err}", "retcode": -1}
                check_retcode = int(getattr(check, "retcode", -1))
                if check_retcode not in (0, self.mt5.TRADE_RETCODE_DONE, getattr(self.mt5, "TRADE_RETCODE_PLACED", 10008)):
                    check_comment = getattr(check, "comment", "pending order check failed")
                    self.log_signal.emit(f"[Pending] order_check rejected: retcode={check_retcode} comment={check_comment}")
                    return {"status": "rejected", "message": check_comment, "retcode": check_retcode}
                result = self.mt5.order_send(req)
                if result is None:
                    err = self.mt5.last_error()
                    self.log_signal.emit(f"[Pending] order_send returned None, last_error={err}")
                    return {"status": "error", "message": f"pending order failed: {err}"}
                self.log_signal.emit(f"[Pending] retcode={result.retcode} comment={result.comment} order={result.order}")
                if result.retcode in (self.mt5.TRADE_RETCODE_DONE, getattr(self.mt5, "TRADE_RETCODE_PLACED", 10008)) and result.order:
                    return {"status": "success", "order": result.order, "price": result.price, "retcode": result.retcode}
                if result.retcode == getattr(self.mt5, "TRADE_RETCODE_TIMEOUT", 10012):
                    return {"status": "uncertain", "message": result.comment or "pending order result uncertain", "retcode": result.retcode}
                return {"status": "rejected", "message": result.comment if result else "pending order failed", "retcode": result.retcode}

            elif action == "cancel_pending":
                ticket = params.get("ticket")
                if not ticket: return {"status": "rejected", "message": "ticket is required"}
                ticket = int(ticket)  # Ensure integer type
                self.log_signal.emit(f"[CancelPending] Looking for ticket={ticket}")

                # Try to find the pending order
                orders = self.mt5.orders_get(ticket=ticket)
                if orders is None:
                    return {"status": "error", "message": f"orders_get failed: {self.mt5.last_error()}"}
                if len(orders) == 0:
                    self.log_signal.emit(f"[CancelPending] Order {ticket} not found, might be filled/cancelled")
                    return {"status": "rejected", "message": f"挂单 {ticket} 已不存在（可能已成交或已取消）"}

                precondition_error = self._management_precondition_error(params, orders[0], "pending", required=True)
                if precondition_error:
                    return {"status": "rejected", "message": precondition_error, "ticket": ticket}

                self.log_signal.emit(f"[CancelPending] Found order: {orders[0].ticket} {orders[0].symbol} type={orders[0].type}")

                # Cancel using TRADE_ACTION_REMOVE
                req = {
                    "action": self.mt5.TRADE_ACTION_REMOVE,
                    "order": ticket,
                }
                result = self.mt5.order_send(req)
                self.log_signal.emit(f"[CancelPending] order_send result: retcode={result.retcode if result else 'None'} comment={result.comment if result else 'None'}")
                remaining = self.mt5.orders_get(ticket=ticket)
                retcode = getattr(result, "retcode", -1) if result else -1
                if remaining is None:
                    return {"status": "uncertain", "message": f"cancel verification failed: {self.mt5.last_error()}",
                            "ticket": ticket, "retcode": retcode}
                if len(remaining) == 0:
                    response = {"status": "success", "ticket": ticket, "retcode": retcode}
                    if not result or retcode != self.mt5.TRADE_RETCODE_DONE:
                        response["warning"] = getattr(result, "comment", "cancel reconciled after uncertain response") if result else "cancel reconciled after missing response"
                    return response
                unresolved = result is None or retcode in (
                    self.mt5.TRADE_RETCODE_DONE,
                    getattr(self.mt5, "TRADE_RETCODE_TIMEOUT", 10012),
                )
                return {"status": "uncertain" if unresolved else "rejected",
                        "message": getattr(result, "comment", "pending order still exists after cancel") if result else "pending order still exists after cancel",
                        "ticket": ticket, "retcode": retcode}

            elif action == "pending_list":
                symbol = self._resolve_symbol(params.get("symbol")) if params.get("symbol") else None
                orders = self.mt5.orders_get(symbol=symbol) if symbol else self.mt5.orders_get()
                if orders is None:
                    return {"status": "error", "message": f"orders_get failed: {self.mt5.last_error()}"}

                type_map = {
                    self.mt5.ORDER_TYPE_BUY_LIMIT: "buy_limit",
                    self.mt5.ORDER_TYPE_SELL_LIMIT: "sell_limit",
                    self.mt5.ORDER_TYPE_BUY_STOP: "buy_stop",
                    self.mt5.ORDER_TYPE_SELL_STOP: "sell_stop",
                    self.mt5.ORDER_TYPE_BUY_STOP_LIMIT: "buy_stop_limit",
                    self.mt5.ORDER_TYPE_SELL_STOP_LIMIT: "sell_stop_limit",
                }
                side_map = {
                    self.mt5.ORDER_TYPE_BUY_LIMIT: "buy",
                    self.mt5.ORDER_TYPE_SELL_LIMIT: "sell",
                    self.mt5.ORDER_TYPE_BUY_STOP: "buy",
                    self.mt5.ORDER_TYPE_SELL_STOP: "sell",
                    self.mt5.ORDER_TYPE_BUY_STOP_LIMIT: "buy",
                    self.mt5.ORDER_TYPE_SELL_STOP_LIMIT: "sell",
                }
                def _fmt_time(val):
                    if not val: return None
                    try:
                        n = float(val)
                        if n == 0: return None
                        if n > 1000000000:
                            from datetime import datetime as _dt
                            return _dt.utcfromtimestamp(n).strftime("%Y-%m-%d %H:%M:%S")
                        s = str(val)
                        if s == "0" or s == "None": return None
                        return s
                    except (TypeError, ValueError, OverflowError, OSError):
                        return None

                result_orders = []
                for o in orders:
                    entry = {
                        "ticket": o.ticket,
                        "symbol": o.symbol,
                        "side": side_map.get(o.type, "buy"),
                        "pending_type": type_map.get(o.type, str(o.type)),
                        "price": o.price_open,
                        "volume": o.volume_current,
                        "sl": o.sl,
                        "tp": o.tp,
                        "magic": o.magic,
                        "comment": o.comment,
                        "valid_until": _fmt_time(o.time_expiration),
                        "created_at": _fmt_time(o.time_setup),
                        "mt5_ticket": str(o.ticket),
                        "state": "pending",
                    }
                    self.log_signal.emit(f"[PendingList] ticket={o.ticket} symbol={o.symbol} type={entry['pending_type']} created={entry['created_at']} valid={entry['valid_until']}")
                    result_orders.append(entry)
                return {"status": "success", "orders": result_orders}

            elif action == "modify_system_position_protection":
                ticket = params.get("ticket")
                if not ticket:
                    return {"status": "error", "message": "ticket_required"}
                positions = self.mt5.positions_get(ticket=int(ticket))
                if positions is None:
                    return {"status": "error", "message": "positions_get_failed"}
                if not positions:
                    return {"status": "rejected", "message": "system_position_not_found", "ticket": str(ticket)}
                pos = positions[0]
                precondition_error = self._management_precondition_error(params, pos, "position", required=True)
                if precondition_error:
                    return {"status": "rejected", "message": precondition_error, "ticket": str(pos.ticket)}
                if int(getattr(pos, "magic", 0) or 0) != SYSTEM_TRADE_MAGIC:
                    return {"status": "rejected", "message": "position_magic_mismatch", "ticket": str(pos.ticket)}

                expected = params.get("expected_state") if isinstance(params.get("expected_state"), dict) else {}
                info = self.mt5.symbol_info(pos.symbol)
                tick = self.mt5.symbol_info_tick(pos.symbol)
                if not info or not tick:
                    return {"status": "error", "message": "position_symbol_quote_unavailable", "ticket": str(pos.ticket)}
                point = float(getattr(info, "point", 0) or 0)
                tick_size = float(getattr(info, "trade_tick_size", 0) or point or 0.00000001)
                digits = max(0, int(getattr(info, "digits", 0) or 0))
                tolerance = max(point / 2.0, tick_size / 2.0, 0.00000001)
                expected_sl = expected.get("stop_loss")
                expected_tp = expected.get("take_profit")
                if expected_sl is not None:
                    expected_sl_number = float(expected_sl or 0)
                    if not math.isfinite(expected_sl_number) or expected_sl_number < 0:
                        return {"status": "rejected", "message": "position_expected_stop_loss_invalid", "ticket": str(pos.ticket)}
                else:
                    expected_sl_number = None
                if expected_tp is not None:
                    expected_tp_number = float(expected_tp or 0)
                    if not math.isfinite(expected_tp_number) or expected_tp_number < 0:
                        return {"status": "rejected", "message": "position_expected_take_profit_invalid", "ticket": str(pos.ticket)}
                else:
                    expected_tp_number = None
                if expected_sl_number is not None and abs(float(pos.sl or 0) - expected_sl_number) > tolerance:
                    return {"status": "rejected", "message": "position_stop_loss_changed", "ticket": str(pos.ticket)}
                if expected_tp_number is not None and abs(float(pos.tp or 0) - expected_tp_number) > tolerance:
                    return {"status": "rejected", "message": "position_take_profit_changed", "ticket": str(pos.ticket)}

                requested_sl = params.get("stop_loss")
                requested_tp = params.get("take_profit")
                if requested_sl is None and requested_tp is None:
                    return {"status": "rejected", "message": "protection_price_required", "ticket": str(pos.ticket)}

                def _normalize_protection_price(value, current):
                    if value is None:
                        return float(current or 0)
                    number = float(value)
                    if not math.isfinite(number) or number <= 0:
                        raise ValueError("protection_price_invalid")
                    normalized = round(round(number / tick_size) * tick_size, digits)
                    if normalized <= 0:
                        raise ValueError("protection_price_invalid")
                    return normalized

                next_sl = _normalize_protection_price(requested_sl, pos.sl)
                next_tp = _normalize_protection_price(requested_tp, pos.tp)
                min_points = max(int(getattr(info, "trade_stops_level", 0) or 0),
                                 int(getattr(info, "trade_freeze_level", 0) or 0))
                min_distance = min_points * point
                is_buy = int(pos.type) == self.mt5.ORDER_TYPE_BUY
                if requested_sl is not None:
                    valid_sl = next_sl < float(tick.bid) - min_distance if is_buy else next_sl > float(tick.ask) + min_distance
                    if not valid_sl:
                        return {"status": "rejected", "message": "stop_loss_direction_or_distance_invalid", "ticket": str(pos.ticket)}
                if requested_tp is not None:
                    valid_tp = next_tp > float(tick.ask) + min_distance if is_buy else next_tp < float(tick.bid) - min_distance
                    if not valid_tp:
                        return {"status": "rejected", "message": "take_profit_direction_or_distance_invalid", "ticket": str(pos.ticket)}

                already_applied = abs(float(pos.sl or 0) - next_sl) <= tolerance and abs(float(pos.tp or 0) - next_tp) <= tolerance
                if already_applied:
                    return {"status": "success", "ticket": str(pos.ticket), "stop_loss": next_sl,
                            "take_profit": next_tp, "already_applied": True}

                request = {"action": self.mt5.TRADE_ACTION_SLTP, "position": pos.ticket,
                           "symbol": pos.symbol, "sl": next_sl, "tp": next_tp,
                           "magic": SYSTEM_TRADE_MAGIC}
                result = self.mt5.order_send(request)
                verified = self.mt5.positions_get(ticket=pos.ticket)
                if verified is None:
                    return {"status": "uncertain", "message": "position_protection_verify_failed",
                            "ticket": str(pos.ticket), "retcode": getattr(result, "retcode", -1) if result else -1}
                if not verified:
                    return {"status": "rejected", "message": "position_closed_during_protection_update", "ticket": str(pos.ticket)}
                current = verified[0]
                applied = abs(float(current.sl or 0) - next_sl) <= tolerance and abs(float(current.tp or 0) - next_tp) <= tolerance
                if applied:
                    return {"status": "success", "ticket": str(current.ticket),
                            "stop_loss": float(current.sl or 0), "take_profit": float(current.tp or 0),
                            "retcode": getattr(result, "retcode", -1) if result else -1,
                            "reconciled": not bool(result and result.retcode == self.mt5.TRADE_RETCODE_DONE)}
                return {"status": "rejected", "message": getattr(result, "comment", "position_protection_not_applied") if result else "position_protection_not_applied",
                        "ticket": str(pos.ticket), "retcode": getattr(result, "retcode", -1) if result else -1}

            else:
                return {"status": "rejected", "message": "unknown_bridge_action"}
        except Exception as e:
            self.log_signal.emit(
                f"命令 {action or 'unknown'} 异常: {BridgeWorker._short_text(e, 500)}"
            )
            return {"status": "error", "message": "bridge_command_failed"}

    @staticmethod
    def _find_mt5_installations():
        """4级降级探测: 注册表HKCU → 进程 → 注册表HKLM → 文件系统glob
        返回 [(绝对路径, 来源), ...] 列表，去重且按优先级排序
        """
        import glob
        found = {}  # normalized path key -> (path, source_label)

        def add_installation(path, source):
            try:
                normalized = os.path.normpath(str(path or "").strip())
            except (TypeError, ValueError):
                return
            if not find_mt5_terminal_executable(normalized):
                return
            key = os.path.normcase(os.path.realpath(normalized))
            if key not in found:
                found[key] = (normalized, source)

        # ── 1. 注册表 HKCU: Software\MetaQuotes\Terminal\{INSTANCE}\InstallPath ──
        try:
            import winreg
            with winreg.OpenKey(winreg.HKEY_CURRENT_USER, r"Software\MetaQuotes\Terminal") as key:
                i = 0
                while True:
                    try:
                        subkey_name = winreg.EnumKey(key, i)
                    except OSError:
                        break
                    i += 1
                    try:
                        with winreg.OpenKey(key, subkey_name) as inst:
                            install_path, _ = winreg.QueryValueEx(inst, "InstallPath")
                    except OSError:
                        continue
                    add_installation(install_path, "注册表(HKCU)")
        except OSError:
            pass

        # ── 2. 进程检测 terminal64.exe / terminal.exe ──
        try:
            for directory in running_mt5_process_directories():
                add_installation(directory, "运行中进程")
        except Exception as e:
            print(f"[Bridge] 进程检测失败: {e}")

        # ── 3. 注册表 HKLM (64-bit view) ──
        try:
            import winreg
            try:
                with winreg.OpenKey(
                    winreg.HKEY_LOCAL_MACHINE,
                    r"Software\MetaQuotes\Terminal",
                    0, winreg.KEY_READ | winreg.KEY_WOW64_64KEY,
                ) as key:
                    i = 0
                    while True:
                        try:
                            subkey_name = winreg.EnumKey(key, i)
                        except OSError:
                            break
                        i += 1
                        try:
                            with winreg.OpenKey(key, subkey_name) as inst:
                                install_path, _ = winreg.QueryValueEx(inst, "InstallPath")
                        except OSError:
                            continue
                        add_installation(install_path, "注册表(HKLM)")
            except OSError as e:
                print(f"[Bridge] 注册表读取失败: {e}")
        except Exception as e:
            print(f"[Bridge] 注册表检测失败: {e}")

        # ── 4. 文件系统 glob（增强: 覆盖券商定制目录名） ──
        glob_patterns = [
            "MetaTrader*", "*MT5*", "*MetaTrader*5*", "*MetaQuotes*"
        ]
        scan_bases = [
            os.environ.get("ProgramFiles", "C:\\Program Files"),
            os.environ.get("ProgramFiles(x86)", "C:\\Program Files (x86)"),
            "C:\\", "D:\\",
        ]
        for base in scan_bases:
            for pattern in glob_patterns:
                try:
                    for d in glob.glob(os.path.join(base, pattern)):
                        add_installation(d, "文件系统")
                except Exception:
                    pass

        # 返回按优先级排序的列表
        priority_order = {"运行中进程": 0, "注册表(HKCU)": 1, "注册表(HKLM)": 2, "文件系统": 3}
        result = sorted(found.values(), key=lambda x: (priority_order.get(x[1], 99), x[0].casefold()))
        return result

    def _run_bridge(self):
        # ── 尝试探测 MT5 安装目录，加入 DLL 搜索路径 ──
        import traceback

        # 优先使用用户手动指定的路径
        mt5_dirs = []
        installations = []
        manual_path = getattr(self, '_manual_mt5_path', None)
        if manual_path and os.path.isdir(manual_path):
            mt5_dirs = [manual_path]

        if not mt5_dirs:
            installations = BridgeWorker._find_mt5_installations()
            for path, source in installations:
                mt5_dirs.append(path)
                self.log_signal.emit(f"[探测] {source}: {path}")

        if not mt5_dirs:
            self.log_signal.emit("[探测] 未找到任何 MT5 安装目录")

        # ⚠️  CRITICAL: NEVER add MT5 directories to DLL search path or PATH
        #    before importing MetaTrader5/numpy. MT5 installations bundle their own
        #    openblas.dll / msvcp140.dll which conflict with PyInstaller-bundled versions
        #    that numpy 2.5+ requires, causing:
        #      ImportError: numpy._core.multiarray failed to import
        #    PyInstaller already bundles all needed DLLs. mt5.initialize() connects to
        #    the running terminal via IPC — it does NOT need MT5's install dir DLLs.

        # Import MT5 — PyInstaller resolves all DLLs from its own bundle
        try:
            self.mt5 = self._mt5_call(self._import_mt5_module)
        except Exception as e:
            full_tb = traceback.format_exc().strip()
            self.log_signal.emit(f"错误: MetaTrader5 导入失败")
            tb_lines = full_tb.split("\n")
            for line in tb_lines[-5:]:
                if line.strip():
                    self.log_signal.emit(f"  {line.strip()}")
            self.log_signal.emit(f"请确认 MT5 终端已安装。下载: https://www.metatrader5.com/")
            if mt5_dirs:
                self.log_signal.emit(f"已探测到目录: {', '.join(mt5_dirs)}")
            self.status_signal.emit("MT5 未安装", "#ef4444", "请安装MT5终端后重试")
            return

        initialization_candidates = mt5_initialization_candidates(manual_path, installations)
        if manual_path and not initialization_candidates:
            self.log_signal.emit("MT5 初始化失败: 指定目录中未找到 terminal64.exe 或 terminal.exe")
            self.status_signal.emit("MT5 路径无效", "#ef4444", "请重新选择独立 MT5 安装目录")
            return
        portable = bool(load_config().get("mt5_portable", False))
        initialized = False
        terminal_path = None
        for candidate in initialization_candidates:
            if candidate:
                self.log_signal.emit(f"[探测] 尝试连接终端: {candidate}")
                initialized = bool(self._mt5_call(self.mt5.initialize, candidate, portable=portable))
            else:
                initialized = bool(self._mt5_call(self.mt5.initialize))
            if initialized:
                terminal_path = candidate
                break
            try:
                self._mt5_call(self.mt5.shutdown)
            except Exception:
                pass
        if not initialized:
            self.log_signal.emit(f"MT5 初始化失败: {self._mt5_call(self.mt5.last_error)}")
            self.status_signal.emit("未检测到MT5", "#ef4444", "请先运行MT5并登录交易账户")
            return

        info = self._mt5_call(self.mt5.account_info)
        if not info:
            self.log_signal.emit("MT5 未登录，请在终端中登录账户")
            self.status_signal.emit("MT5未登录", "#ef4444", "请在MT5中登录交易账户后重试")
            return

        self.log_signal.emit(f"MT5 已连接: {info.login} @ {info.server}  余额: ${info.balance:,.2f}")

        terminal = self._mt5_call(self.mt5.terminal_info)
        if terminal and not terminal.trade_allowed:
            self.log_signal.emit("⚠️ 算法交易未开启：MT5 → 工具 → 选项 → EA交易 → 允许算法交易")

        try:
            import websockets
        except ImportError:
            self.log_signal.emit("错误: websockets 未安装")
            return

        # Check plan status before connecting
        self.log_signal.emit("检查会员状态...")
        plan, expired, reason = self.check_plan()
        if expired:
            self.log_signal.emit(f"❌ {reason}")
            self.plan_expired_signal.emit(reason)
            return
        if reason:
            self.log_signal.emit(f"⚠️ {reason}")
        else:
            self.log_signal.emit(f"会员等级: {plan.upper()}，开始连接...")
        if self.account_created_at:
            self.log_signal.emit(f"账户创建时间: {self.account_created_at[:10]}")

        try:
            self._resolved_symbol = self._mt5_call(self._resolve_symbol, "XAUUSD")
        except Exception:
            self._resolved_symbol = "XAUUSD"

        # Run async event loop in this thread
        try:
            import asyncio
            self._loop = asyncio.new_event_loop()
            asyncio.set_event_loop(self._loop)
            try:
                self._loop.run_until_complete(self._run_async())
            finally:
                self._loop.close()
                self._loop = None
        except Exception as e:
            self.log_signal.emit(f"桥接异常退出: {self._short_text(e, 500)}")

    # ── Async core (websockets) ──────────────────────────────

    @staticmethod
    def _is_sensitive_key(key):
        """Check if a dict key represents sensitive data."""
        return _is_sensitive_log_key(key)

    @staticmethod
    def _mask_sensitive_text(value):
        """Mask sensitive fields (token/Authorization/Cookie) before logging. Supports dict/Mapping."""
        return _mask_log_text(value)

    @staticmethod
    def _short_text(value, limit=200):
        """Mask sensitive content first, then truncate to limit chars."""
        s = BridgeWorker._mask_sensitive_text(value)
        if len(s) > limit:
            s = s[:limit] + '...'
        return s

    @staticmethod
    def _format_ws_error(e):
        """Format WebSocket exception for logging — Chinese-friendly, no token, max ~800 chars."""
        parts = []
        parts.append(type(e).__name__)
        msg = str(e) or '无详细信息'
        parts.append(BridgeWorker._short_text(msg, 200))
        # Extract websockets-specific fields (safe truncation)
        for attr in ('status_code', 'status', 'code', 'reason'):
            val = getattr(e, attr, None)
            if val is not None:
                parts.append(f'{attr}={BridgeWorker._short_text(val, 150)}')
        for attr in ('headers', 'response'):
            val = getattr(e, attr, None)
            if val is not None:
                parts.append(f'{attr}={BridgeWorker._short_text(val, 150)}')
        result = BridgeWorker._mask_sensitive_text('; '.join(parts))
        return result[:800] if len(result) > 800 else result

    @staticmethod
    def _brief_ws_error(e):
        """Return brief error type name for noise-reduced logging."""
        return type(e).__name__ or 'UnknownError'

    async def _run_async(self):
        """Main async loop: connect → session → reconnect with progressive backoff."""
        import websockets

        self._async_stop_event = asyncio.Event()
        if self._stop_event.is_set():
            self._async_stop_event.set()

        server = self.server_url.replace("http://", "ws://").replace("https://", "wss://").rstrip("/")
        http_base = self.server_url.rstrip("/")
        self.log_signal.emit(f"连接 WebSocket: {server}/aurum-api/bridge/ws")

        ssl_ctx = _get_ssl_context() if server.startswith('wss://') else None
        MAX_RAPID_FAILS = 5
        rapid_fails = 0
        retry_count = 0

        def get_backoff_delay():
            """Progressive backoff: 5s → 10s → 30s, max 60s."""
            if retry_count <= 12:
                return 5
            elif retry_count <= 60:
                return 10
            else:
                return 30

        def should_health_check():
            if retry_count == 1 or retry_count == 3 or retry_count == 10:
                return True
            if retry_count > 10 and retry_count % 10 == 0:
                return True
            return False

        def should_rebuild_ssl():
            return retry_count in (1, 10, 30, 60) or (retry_count > 60 and retry_count % 30 == 0)

        last_health_ok = False
        last_health_check_retry = 0

        while self.running:
            retry_start = time.time()
            ws = None
            retry_count = 0

            # ── Connection retry loop ──
            while self.running:
                elapsed = time.time() - retry_start
                retry_count += 1
                delay = get_backoff_delay()

                if elapsed >= 300 and retry_count % 6 == 0:
                    self.log_signal.emit(f"已连续重连 {int(elapsed/60)} 分钟，仍在继续尝试。请检查服务器或反向代理状态。")

                # SSL context rebuild
                if server.startswith('wss://') and should_rebuild_ssl():
                    ssl_ctx = _get_ssl_context()
                    self.log_signal.emit("已重建 SSL 上下文，继续尝试连接 WebSocket。")

                # HTTP health check (throttled, uses sync http_get_json via executor)
                if should_health_check():
                    try:
                        loop = asyncio.get_running_loop()
                        status_code, data = await loop.run_in_executor(
                            None, lambda: http_get_json(f"{http_base}/health", timeout=5)
                        )
                        if status_code != 200:
                            last_health_ok = False
                            self.log_signal.emit(f"服务器健康检查失败：HTTP {status_code}")
                        else:
                            last_health_ok = True
                            last_health_check_retry = retry_count
                    except Exception as he:
                        last_health_ok = False
                        self.log_signal.emit(f"服务器健康检查失败：{BridgeWorker._brief_ws_error(he)}")

                try:
                    loop = asyncio.get_running_loop()
                    await loop.run_in_executor(None, self._renew_access_token)
                    ticket = await loop.run_in_executor(None, self._create_connection_ticket)
                    encoded_ticket = urllib.parse.quote(ticket, safe='')
                    ws_url = f"{server}/aurum-api/bridge/ws?type=bridge&ticket={encoded_ticket}"
                    ws = await asyncio.wait_for(
                        websockets.connect(ws_url, ssl=ssl_ctx, additional_headers={"Origin": "http://localhost"},
                                           ping_interval=None, max_size=2**20, close_timeout=3),
                        timeout=10
                    )
                    self._ws = ws
                    self.log_signal.emit("WebSocket 已连接")
                    break
                except Exception as e:
                    err_str = str(e)
                    if '4003' in err_str:
                        if '会员' in err_str or '过期' in err_str or 'Pro' in err_str:
                            self.log_signal.emit(f"连接失败: {err_str}")
                            self.status_signal.emit("会员等级不足", "#ef4444", "")
                            return
                    elif '会员' in err_str or 'Pro' in err_str:
                        self.log_signal.emit(f"连接失败: {err_str}")
                        self.status_signal.emit("会员等级不足", "#ef4444", "")
                        return
                    if retry_count <= 3 or retry_count % 10 == 0:
                        self.log_signal.emit(f"连接失败（第{retry_count}次）：{self._format_ws_error(e)}，{delay}秒后重试...")
                    else:
                        self.log_signal.emit(f"连接失败（第{retry_count}次）：{self._brief_ws_error(e)}，{delay}秒后重试...")
                    # Hint: HTTP OK but WSS failed — likely Nginx WebSocket proxy issue
                    if last_health_ok and last_health_check_retry == retry_count:
                        self.log_signal.emit("HTTP 健康检查正常，但 WebSocket 连接失败，优先检查 Nginx WebSocket 反代。")
                    self.status_signal.emit(f"重连中...（第{retry_count}次）", "#f59e0b", "")
                    await self._sleep_or_stop(delay)

            if not ws or not self.running:
                break

            # ── Session: run send + recv + heartbeat concurrently ──
            session_start = time.time()
            tasks = [
                asyncio.create_task(self._async_send_loop(ws)),
                asyncio.create_task(self._async_recv_loop(ws)),
                asyncio.create_task(self._async_heartbeat_loop(ws)),
            ]
            try:
                async with ws:
                    done, pending = await asyncio.wait(tasks, return_when=asyncio.FIRST_COMPLETED)
                    for t in pending:
                        t.cancel()
                    await asyncio.gather(*pending, return_exceptions=True)
                    # Check if any task raised an unexpected exception
                    for t in done:
                        if t.exception() and not isinstance(t.exception(), (websockets.ConnectionClosed, ssl.SSLError, OSError, ConnectionResetError)):
                            raise t.exception()
            except websockets.ConnectionClosed as e:
                if e.code == 4004:
                    reason = e.reason or "MT5账户已由另一个平台账号连接"
                    self.log_signal.emit(f"连接已停止: {reason}")
                    self.status_signal.emit("MT5账户已切换", "#f59e0b", "请确认当前登录的平台账号")
                    return
                if e.code == 4003:
                    reason = e.reason or ''
                    if '会员' in reason or '过期' in reason or 'Pro' in reason:
                        self.log_signal.emit(f"连接被服务器拒绝: {reason}")
                        self.status_signal.emit("会员等级不足", "#ef4444", "")
                        return
                    self.log_signal.emit(f"连接被服务器关闭: {reason}")
                elif e.code == 4002:
                    loop = asyncio.get_running_loop()
                    renewed = await loop.run_in_executor(None, lambda: self._renew_access_token(force=True))
                    if renewed:
                        self.log_signal.emit("登录凭证已续期，正在重新连接")
                        continue
                    else:
                        self.log_signal.emit("桥接登录已过期，请重新登录")
                        self.status_signal.emit("登录已过期", "#ef4444", "请重新登录桥接软件")
                        return
                else:
                    self.log_signal.emit(f"WebSocket 连接已断开 (code={e.code})")
            except (ssl.SSLError, OSError, ConnectionResetError) as e:
                self.log_signal.emit(f"连接错误: {self._format_ws_error(e)}")
            except Exception as e:
                self.log_signal.emit(f"会话异常: {self._format_ws_error(e)}")

            if getattr(ws, "close_code", None) == 4004:
                reason = getattr(ws, "close_reason", "") or "MT5账户已由另一个平台账号连接"
                self.log_signal.emit(f"连接已停止: {reason}")
                self.status_signal.emit("MT5账户已切换", "#f59e0b", "请确认当前登录的平台账号")
                return
            if getattr(ws, "close_code", None) == 4002:
                loop = asyncio.get_running_loop()
                renewed = await loop.run_in_executor(None, lambda: self._renew_access_token(force=True))
                if not renewed:
                    self.log_signal.emit("桥接登录已过期，请重新登录")
                    self.status_signal.emit("登录已过期", "#ef4444", "请重新登录桥接软件")
                    return
            self._ws = None
            if not self.running:
                break

            # ── Circuit breaker: extend backoff, never stop ──
            session_duration = time.time() - session_start
            if session_duration < 10:
                rapid_fails += 1
                self.log_signal.emit(f"快速断开 (第{rapid_fails}/{MAX_RAPID_FAILS}次，持续{session_duration:.0f}秒)")
                if rapid_fails >= MAX_RAPID_FAILS:
                    self.log_signal.emit(f"连续多次快速断开，已延长重连间隔，仍会继续自动重连。")
            else:
                rapid_fails = 0

            retry_delay = get_backoff_delay()
            if rapid_fails >= MAX_RAPID_FAILS:
                retry_delay = min(60, max(retry_delay, 30 + (rapid_fails - MAX_RAPID_FAILS) * 5))
            self.log_signal.emit(f"连接断开，{retry_delay}秒后自动重连...")
            self.status_signal.emit("重连中...", "#f59e0b", "")
            await self._sleep_or_stop(retry_delay)

    async def _sleep_or_stop(self, seconds):
        """Interrupt reconnect/heartbeat delays as soon as the GUI requests stop."""
        if not self.running or self._stop_event.is_set():
            return False
        stop_event = self._async_stop_event
        if stop_event is None:
            await asyncio.sleep(seconds)
            return self.running
        try:
            await asyncio.wait_for(stop_event.wait(), timeout=max(0.0, float(seconds)))
            return False
        except asyncio.TimeoutError:
            return self.running

    async def _async_send_loop(self, ws):
        """Send MT5 data every 1s with deduplication, force send every 5s for market status detection."""
        import websockets
        last_payload = None
        last_quote_time = None
        last_plan_check = time.time()
        last_send_time = time.time()
        mt5_timeout_count = 0
        mt5_was_slow = False
        mt5_future = None

        while self.running:
            try:
                # Hourly plan check
                now = time.time()
                if now - last_plan_check > 3600:
                    last_plan_check = now
                    loop = asyncio.get_running_loop()
                    plan, expired, reason = await loop.run_in_executor(None, self.check_plan)
                    if expired:
                        self.log_signal.emit(f"❌ {reason}")
                        self.plan_expired_signal.emit(reason)
                        break
                    if reason:
                        self.log_signal.emit(f"⚠️ {reason}")

                # Collect MT5 data with timeout protection (asyncio.shield prevents cancel)
                loop = asyncio.get_running_loop()
                if mt5_future is None:
                    mt5_future = loop.run_in_executor(self._mt5_executor, self._collect_mt5_data)
                try:
                    dm = await asyncio.wait_for(asyncio.shield(mt5_future), timeout=MT5_COLLECT_TIMEOUT_SEC)
                    mt5_future = None
                except asyncio.TimeoutError:
                    mt5_timeout_count += 1
                    self._mt5_timeout_count = mt5_timeout_count
                    mt5_was_slow = True
                    if mt5_timeout_count <= 3 or mt5_timeout_count % 10 == 0:
                        self.log_signal.emit(f"MT5 数据采集超时（第 {mt5_timeout_count} 次），本轮跳过发送。")
                    if mt5_timeout_count >= 10:
                        self.status_signal.emit("MT5响应慢", "#f59e0b", "")
                    await self._sleep_or_stop(1)
                    continue
                except Exception:
                    mt5_future = None
                    raise

                # MT5 recovered
                if mt5_was_slow:
                    self.log_signal.emit("MT5 数据采集已恢复。")
                mt5_timeout_count = 0
                self._mt5_timeout_count = 0
                mt5_was_slow = False

                if dm is None:
                    await self._sleep_or_stop(1)
                    continue

                # Dedup: hash the data, skip if unchanged (but force send every 5s for market status detection)
                payload = json.dumps(dm, sort_keys=True, default=str, ensure_ascii=False, separators=(',', ':'))
                quote_time = dm.get("quote", {}).get("time", "")
                force_send = (time.time() - last_send_time) >= 5
                time_changed = quote_time != last_quote_time
                if payload == last_payload and not force_send and not time_changed:
                    await self._sleep_or_stop(1)
                    continue
                last_payload = payload
                last_quote_time = quote_time
                last_send_time = time.time()
                self._last_data_sent_at = last_send_time
                self._last_quote_time = quote_time
                self._mt5_timeout_count = mt5_timeout_count

                await ws.send(payload)

                # Update status
                acc_login = dm.get("account", {}).get("login")
                acc_server = dm.get("account", {}).get("server")
                acc_balance = dm.get("account", {}).get("balance")
                if acc_login:
                    self.status_signal.emit("MT5桥接-已连接", "#22c55e",
                                           f"{acc_login} @ {acc_server}  ${acc_balance:,.2f}")

                await self._sleep_or_stop(1)
            except websockets.ConnectionClosed:
                break  # Normal disconnect — handled by _run_async
            except (ssl.SSLError, OSError, ConnectionResetError, BrokenPipeError) as e:
                self.log_signal.emit(f"数据推送错误: {e}")
                break
            except Exception as e:
                self.log_signal.emit(f"数据推送错误: {e}")
                break

    def _collect_mt5_data(self):
        with self._mt5_lock:
            return self._collect_mt5_data_locked()

    def _collect_mt5_data_locked(self):
        """Collect MT5 data (synchronous, called from executor)."""
        acc = self.mt5.account_info()
        sym = self._resolved_symbol
        if not acc and not self._acc_lost_warned:
            self._acc_lost_warned = True
            self.log_signal.emit("⚠️ MT5账户已断开，请重新登录后重启桥接")
        if acc and self._acc_lost_warned:
            self._acc_lost_warned = False
            self.log_signal.emit("MT5账户已恢复")
        if not acc:
            return None
        terminal = self.mt5.terminal_info()
        info = self.mt5.symbol_info(sym)
        tick = self.mt5.symbol_info_tick(sym)
        if tick: self._calibrate_mt5_clock(tick)
        positions = self.mt5.positions_get() or []
        bar_vol = 0
        try:
            rates = self.mt5.copy_rates_from_pos(sym, self.mt5.TIMEFRAME_M1, 0, 1)
            if rates is not None and len(rates) > 0:
                bar_vol = int(rates[0][5])
        except Exception:
            pass
        clock_fields = self._clock_fields(getattr(tick, "time_msc", tick.time * 1000)) if tick else self._clock_fields(0)
        market_fields = self._detect_market_state(sym, info, tick, terminal)
        return {"type": "data", "account": {
            "login": acc.login, "balance": round(acc.balance, 2),
            "equity": round(acc.equity, 2), "margin": round(acc.margin, 2),
            "free_margin": round(acc.margin_free, 2), "profit": round(acc.profit, 2),
            "leverage": acc.leverage, "server": acc.server}, "quote": {"symbol": sym,
            "bid": round(tick.bid, 5) if tick else None, "ask": round(tick.ask, 5) if tick else None,
            "spread": round((tick.ask - tick.bid) / (0.01 if "JPY" not in sym else 0.001), 1) if tick else None,
            "time": self._mt5_time(tick.time) if tick else time.strftime("%Y-%m-%d %H:%M:%S"),
            "volume": bar_vol, **clock_fields, **market_fields},
            "positions": [{"ticket": p.ticket, "symbol": p.symbol, "type": "buy" if p.type == 0 else "sell",
                "volume": p.volume, "price_open": p.price_open, "price_current": p.price_current,
                "time": self._mt5_time(p.time) if p.time else '', "time_update": self._mt5_time(p.time_update) if getattr(p, 'time_update', None) else '',
                "profit": round(p.profit, 2), "sl": p.sl, "tp": p.tp,
                "digits": getattr(p, 'digits', 2),
                "swap": p.swap, "commission": getattr(p, 'commission', 0),
                "magic": p.magic, "comment": p.comment} for p in positions],
            "live_trading_enabled": self._trade_enabled}

    async def _async_recv_loop(self, ws):
        """Receive commands from server and process them."""
        async for raw_msg in ws:
            if not self.running:
                break
            try:
                msg = json.loads(raw_msg)
            except Exception:
                continue
            if not isinstance(msg, dict):
                self.log_signal.emit("⚠️ 收到非对象 WebSocket 消息，已跳过")
                continue

            if msg.get("type") == "ping":
                try:
                    await ws.send(json.dumps({"type": "pong", "ts": msg.get("ts", 0)}))
                except Exception:
                    break
            elif msg.get("type") == "command":
                action = msg.get("action")
                cmd_id = msg.get("command_id")
                if not action or cmd_id is None:
                    self.log_signal.emit(f"⚠️ 收到格式错误的命令消息，已跳过")
                    continue
                self.log_signal.emit(f"执行: {action}")
                loop = asyncio.get_running_loop()
                try:
                    resp = await loop.run_in_executor(self._mt5_executor, self._process_command, msg)
                except Exception as ce:
                    self.log_signal.emit(
                        f"命令执行器异常: {BridgeWorker._short_text(ce, 500)}"
                    )
                    resp = {"status": "error", "message": "bridge_command_failed"}
                try:
                    await ws.send(json.dumps({"type": "result", "command_id": cmd_id, "result": resp}))
                except Exception:
                    break
                self.log_signal.emit(f"完成: {json.dumps(resp, ensure_ascii=False)[:80]}")

    async def _async_heartbeat_loop(self, ws):
        """Send client heartbeat every 15s with status summary."""
        import websockets
        while self.running:
            if not await self._sleep_or_stop(15):
                break
            try:
                hb = {
                    "type": "hb",
                    "ts": int(time.time() * 1000),
                    "client_version": APP_VERSION,
                    "mt5_collect_timeout_count": getattr(self, '_mt5_timeout_count', 0),
                    "last_data_sent_age_sec": int(time.time() - getattr(self, '_last_data_sent_at', 0)) if getattr(self, '_last_data_sent_at', 0) else -1,
                    "last_quote_time": getattr(self, '_last_quote_time', None),
                    "timezone_offset_minutes": self._mt5_timezone_offset_minutes,
                    "clock_status": self._mt5_clock_status,
                    "clock_residual_ms": self._mt5_clock_residual_ms,
                    **(self._last_market_state or {}),
                }
                await ws.send(json.dumps(hb))
            except (websockets.ConnectionClosed, OSError):
                break
            except Exception:
                break

    def stop(self):
        self.running = False
        self._stop_event.set()
        loop = getattr(self, '_loop', None)
        async_stop_event = self._async_stop_event
        if loop and not loop.is_closed() and async_stop_event is not None:
            try:
                loop.call_soon_threadsafe(async_stop_event.set)
            except RuntimeError:
                pass
        ws = self._ws
        if ws:
            try:
                if loop and not loop.is_closed():
                    asyncio.run_coroutine_threadsafe(ws.close(), loop)
            except Exception:
                pass

# ══════════════════════════════════════════════════════════
#  Login Page
# ══════════════════════════════════════════════════════════

class LoginPage(QWidget):
    login_success = Signal(str, str)  # (email, token)

    def __init__(self):
        super().__init__()
        self._login_request = None
        self._init_ui()

    def _init_ui(self):
        layout = QVBoxLayout(self)
        layout.setAlignment(Qt.AlignCenter)
        layout.setSpacing(12)

        # Title
        title = QLabel("AI交易实验室 · MT5 Bridge")
        title.setFont(QFont("Segoe UI", 20, QFont.Bold))
        title.setAlignment(Qt.AlignCenter)
        title.setStyleSheet("color: #3b82f6; background: transparent;")
        layout.addWidget(title)

        layout.addSpacing(20)

        # Card
        card = QFrame()
        card.setProperty("card", True)
        card_layout = QVBoxLayout(card)
        card_layout.setSpacing(14)
        card_layout.setContentsMargins(16, 16, 16, 16)

        # Server
        lbl_server = QLabel("服务器地址")
        lbl_server.setProperty("muted", True)
        card_layout.addWidget(lbl_server)
        self.input_server = QLineEdit()
        self.input_server.setPlaceholderText("http://你的服务器:3000")
        card_layout.addWidget(self.input_server)

        # Account (email or phone)
        lbl_account = QLabel("账号")
        lbl_account.setProperty("muted", True)
        card_layout.addWidget(lbl_account)
        self.input_email = QLineEdit()
        self.input_email.setPlaceholderText("手机号或邮箱")
        card_layout.addWidget(self.input_email)

        # Password
        lbl_pwd = QLabel("密码")
        lbl_pwd.setProperty("muted", True)
        card_layout.addWidget(lbl_pwd)
        pwd_row = QHBoxLayout()
        self.input_password = QLineEdit()
        self.input_password.setPlaceholderText("输入密码")
        self.input_password.setEchoMode(QLineEdit.Password)
        pwd_row.addWidget(self.input_password)
        self.btn_toggle_pwd = EyeToggleButton()
        self.btn_toggle_pwd.clicked.connect(self._toggle_password)
        pwd_row.addWidget(self.btn_toggle_pwd)
        card_layout.addLayout(pwd_row)

        # Remember + auto-login
        check_row = QHBoxLayout()
        self.chk_remember = QCheckBox("记住密码")
        self.chk_auto_login = QCheckBox("自动登录")
        check_row.addWidget(self.chk_remember)
        check_row.addStretch()
        check_row.addWidget(self.chk_auto_login)
        card_layout.addLayout(check_row)

        # Login button
        self.btn_login = QPushButton("登录并连接")
        self.btn_login.setFixedHeight(42)
        self.btn_login.clicked.connect(self._do_login)
        card_layout.addWidget(self.btn_login)

        # Status
        self.lbl_status = QLabel("")
        self.lbl_status.setAlignment(Qt.AlignCenter)
        self.lbl_status.setWordWrap(True)
        card_layout.addWidget(self.lbl_status)

        layout.addWidget(card)

        # Hint
        hint = QLabel("⚠️ 请确保 MT5 已运行并登录交易账户")
        hint.setProperty("muted", True)
        hint.setAlignment(Qt.AlignCenter)
        layout.addWidget(hint)

        layout.addStretch()

        # Footer
        footer = QLabel(f"AI交易实验室 · www.cnfxtrade.com · {APP_VERSION}")
        footer.setProperty("muted", True)
        footer.setAlignment(Qt.AlignCenter)
        layout.addWidget(footer)

        self.input_password.returnPressed.connect(self._do_login)
        self.input_email.returnPressed.connect(self._do_login)

    def _toggle_password(self):
        if self.input_password.echoMode() == QLineEdit.Password:
            self.input_password.setEchoMode(QLineEdit.Normal)
            self.btn_toggle_pwd.set_password_visible(True)
        else:
            self.input_password.setEchoMode(QLineEdit.Password)
            self.btn_toggle_pwd.set_password_visible(False)

    def load_config(self):
        cfg = load_config()
        self.input_server.setText(cfg.get("server_url", DEFAULT_SERVER))
        self.input_email.setText(cfg.get("email", ""))
        self.chk_remember.setChecked(cfg.get("remember", False))
        self.chk_auto_login.setChecked(cfg.get("auto_login", False))
        if cfg.get("remember") and cfg.get("saved_password"):
            self.input_password.setText(cfg["saved_password"])

    def _do_login(self):
        if self._login_request is not None:
            return
        server = self.input_server.text().strip()
        email = self.input_email.text().strip()
        password = self.input_password.text().strip()

        if not server or not email or not password:
            self.lbl_status.setText("请填写所有字段")
            self.lbl_status.setProperty("error", True)
            self.lbl_status.style().polish(self.lbl_status)
            return

        try:
            server = normalize_server_url(server)
        except ValueError as error:
            self.lbl_status.setText(f"❌ {error}")
            self.lbl_status.setProperty("success", False)
            self.lbl_status.setProperty("error", True)
            self.lbl_status.style().polish(self.lbl_status)
            return

        self.btn_login.setEnabled(False)
        self.btn_login.setText("登录中...")
        self.lbl_status.setText("正在连接服务器...")
        self.lbl_status.setProperty("muted", True)
        self.lbl_status.style().polish(self.lbl_status)
        QApplication.processEvents()

        url = f"{server.rstrip('/')}/api/login"
        is_phone = email.isdigit() and 7 <= len(email) <= 15
        payload = {"phone": email, "password": password, "client": "bridge"} if is_phone else {
            "email": email, "password": password, "client": "bridge"
        }
        remember = self.chk_remember.isChecked()
        auto_login = self.chk_auto_login.isChecked()
        request = AsyncJsonRequest(url, payload, timeout=10, parent=self)
        self._login_request = request
        request.completed.connect(
            lambda status_code, data: self._finish_login(
                status_code, data, server, email, password, remember, auto_login,
            )
        )
        request.start()

    def _finish_login(self, status_code, data, server, email, password, remember, auto_login):
        self._login_request = None

        self.btn_login.setEnabled(True)
        self.btn_login.setText("登录并连接")

        if status_code == 200 and data.get("token"):
            token = data["token"]
            self.lbl_status.setText("✅ 登录成功")
            self.lbl_status.setProperty("success", True)
            self.lbl_status.style().polish(self.lbl_status)

            # Save config
            cfg = load_config()
            cfg["server_url"] = server
            cfg["email"] = email
            cfg["token"] = token
            if data.get("refreshToken"):
                cfg["refresh_token"] = data["refreshToken"]
            cfg["remember"] = remember
            cfg["auto_login"] = auto_login
            if remember:
                cfg["saved_password"] = password
            else:
                cfg.pop("saved_password", None)
            cfg["plan"] = data.get("user", {}).get("plan", "free")
            cfg["role"] = data.get("user", {}).get("role", "user")
            cfg["plan_source"] = data.get("user", {}).get("planSource") or data.get("user", {}).get("plan_source")
            if not save_config(cfg):
                self.lbl_status.setText("登录成功，但本机加密配置保存失败；桥接尚未启动")
                self.lbl_status.setProperty("error", True)
                self.lbl_status.style().polish(self.lbl_status)
                return

            self.login_success.emit(email, token)
        else:
            err = data.get("error", data.get("message", f"HTTP {status_code}"))
            self.lbl_status.setText(f"❌ 登录失败: {err}")
            self.lbl_status.setProperty("error", True)
            self.lbl_status.style().polish(self.lbl_status)

# ══════════════════════════════════════════════════════════
#  Bridge Page (Main)
# ══════════════════════════════════════════════════════════

class BridgePage(QWidget):
    request_settings = Signal()
    request_observer_sources = Signal()
    worker_stopped = Signal()

    def __init__(self):
        super().__init__()
        self._worker = None
        self._init_ui()

    def _init_ui(self):
        layout = QVBoxLayout(self)
        layout.setSpacing(10)

        # Top row
        top_row = QHBoxLayout()
        title = QLabel("⚡ AI交易实验室 · MT5 Bridge")
        title.setFont(QFont("Segoe UI", 16, QFont.Bold))
        title.setStyleSheet("color: #3b82f6; background: transparent;")
        top_row.addWidget(title)
        top_row.addStretch()
        self.btn_observer_sources = QPushButton("观摩源 ▾")
        self.btn_observer_sources.setProperty("secondary", True)
        self.btn_observer_sources.setProperty("observerSources", True)
        self.btn_observer_sources.setMinimumWidth(112)
        self.btn_observer_sources.setFixedHeight(36)
        self.btn_observer_sources.setVisible(False)
        self.btn_observer_sources.setToolTip("打开已保存的观摩源，或新增观摩源")
        self.btn_observer_sources.clicked.connect(self.request_observer_sources.emit)
        top_row.addWidget(self.btn_observer_sources)
        self.btn_settings = GearButton()
        self.btn_settings.clicked.connect(self.request_settings.emit)
        top_row.addWidget(self.btn_settings)
        layout.addLayout(top_row)

        # Status card
        status_card = QFrame()
        status_card.setProperty("card", True)
        sc_layout = QVBoxLayout(status_card)
        sc_layout.setContentsMargins(16, 12, 16, 12)

        status_row = QHBoxLayout()
        self.lbl_status_dot = QLabel("●")
        self.lbl_status_dot.setStyleSheet("color: #64748b; font-size: 18px; background: transparent;")
        status_row.addWidget(self.lbl_status_dot)
        self.lbl_status = QLabel("未连接")
        self.lbl_status.setFont(QFont("Segoe UI", 11, QFont.Bold))
        self.lbl_status.setStyleSheet("color: #64748b; background: transparent;")
        status_row.addWidget(self.lbl_status)
        status_row.addStretch()
        self.lbl_account = QLabel("")
        self.lbl_account.setProperty("muted", True)
        status_row.addWidget(self.lbl_account)
        sc_layout.addLayout(status_row)

        # 登录用户信息行
        user_row = QHBoxLayout()
        self.lbl_login_user = QLabel("")
        self.lbl_login_user.setProperty("muted", True)
        self.lbl_login_user.setStyleSheet("font-size: 12px; background: transparent;")
        user_row.addWidget(self.lbl_login_user)
        user_row.addStretch()
        sc_layout.addLayout(user_row)

        layout.addWidget(status_card)

        # 更新提示（默认隐藏）
        self.lbl_update_hint = QLabel("")
        self.lbl_update_hint.setStyleSheet(
            "color: #f59e0b; background-color: #1e293b; border: 1px solid #334155; "
            "border-radius: 6px; padding: 8px 12px; font-size: 12px;")
        self.lbl_update_hint.setVisible(False)
        self.lbl_update_hint.setCursor(Qt.PointingHandCursor)
        self.lbl_update_hint.mousePressEvent = lambda _: self.request_settings.emit()
        layout.addWidget(self.lbl_update_hint)

        # Start button
        self.btn_start = QPushButton("▶  启动桥接")
        self.btn_start.setFixedHeight(48)
        self.btn_start.setFont(QFont("Segoe UI", 13, QFont.Bold))
        self.btn_start.clicked.connect(self._toggle_bridge)
        layout.addWidget(self.btn_start)

        # Log
        lbl_log = QLabel("运行日志")
        lbl_log.setProperty("muted", True)
        layout.addWidget(lbl_log)

        self.log_area = QTextEdit()
        self.log_area.setReadOnly(True)
        layout.addWidget(self.log_area, 1)

        # Footer
        footer = QLabel(f"AI交易实验室 · www.cnfxtrade.com · {APP_VERSION}")
        footer.setProperty("muted", True)
        footer.setStyleSheet("color: #475569; font-size: 11px; background: transparent;")
        footer.setAlignment(Qt.AlignCenter)
        layout.addWidget(footer)

    def _log(self, msg):
        ts = time.strftime("%H:%M:%S")
        # Mask sensitive content and limit message length
        msg = BridgeWorker._mask_sensitive_text(str(msg))
        if len(msg) > MAX_LOG_MESSAGE_CHARS:
            msg = msg[:MAX_LOG_MESSAGE_CHARS] + "...[日志过长，已截断]"
        # 检查滚动条是否在底部（在添加新内容之前）
        sb = self.log_area.verticalScrollBar()
        was_at_bottom = sb.value() >= sb.maximum() - 5
        # 添加日志
        self.log_area.append(f"[{ts}] {msg}")
        # 限制日志行数
        doc = self.log_area.document()
        if doc.blockCount() > MAX_LOG_LINES:
            cursor = self.log_area.textCursor()
            cursor.movePosition(cursor.Start)
            cursor.movePosition(cursor.Down, cursor.KeepAnchor, doc.blockCount() - MAX_LOG_LINES)
            cursor.removeSelectedText()
        # 仅当之前在底部时才自动滚动
        if was_at_bottom:
            sb.setValue(sb.maximum())

    def _set_status(self, text, color, account=""):
        self.lbl_status.setText(text)
        self.lbl_status.setStyleSheet(f"color: {color}; background: transparent;")
        self.lbl_status_dot.setStyleSheet(f"color: {color}; font-size: 18px; background: transparent;")
        self.lbl_account.setText(account)

    def _on_plan_expired(self, reason):
        """Called when plan check detects expiry during bridge operation."""
        title = "登录已过期" if "登录" in str(reason) else "会员状态异常"
        QMessageBox.warning(self, title, reason)
        self._reset_bridge_ui()

    def _on_worker_finished(self):
        """Called when BridgeWorker thread exits (normal stop or early exit)."""
        worker = self.sender()
        if worker is not None and worker is not self._worker:
            worker.deleteLater()
            return
        if worker is not None:
            worker.deleteLater()
        self._worker = None
        self.btn_start.setEnabled(True)
        self.btn_start.setText("▶  启动桥接")
        self.btn_start.setStyleSheet("background-color: #3b82f6;")
        self._set_status("已断开", "#6b7280")
        self.worker_stopped.emit()

    def _reset_bridge_ui(self):
        if self._worker and self._worker.isRunning():
            self.stop_bridge()
            return
        self.btn_start.setText("▶  启动桥接")
        self.btn_start.setStyleSheet("background-color: #3b82f6;")
        self._set_status("已断开", "#6b7280")

    def _toggle_bridge(self):
        if self._worker and self._worker.isRunning():
            self.stop_bridge()
        else:
            cfg = load_config()
            server = cfg.get("server_url", DEFAULT_SERVER)
            token = cfg.get("token", "")
            if not server or not token:
                QMessageBox.warning(self, "信息不完整", "请先登录或配置服务器地址和Token。")
                return
            try:
                server = normalize_server_url(server)
            except ValueError as error:
                QMessageBox.warning(self, "服务器地址无效", str(error))
                return
            mt5_path = cfg.get("mt5_path", "")
            if find_mt5_terminal_executable(mt5_path):
                self._log(f"MT5 路径: {mt5_path}")
            else:
                if mt5_path:
                    self._log("已忽略失效的 MT5 路径，将重新自动探测")
                mt5_path = None
            self._worker = BridgeWorker(server, token, mt5_path, cfg.get("refresh_token", ""))
            self._worker.log_signal.connect(self._log)
            self._worker.status_signal.connect(self._set_status)
            self._worker.plan_expired_signal.connect(self._on_plan_expired)
            self._worker.finished.connect(self._on_worker_finished)
            self._worker.start()
            self.btn_start.setText("■  停止桥接")
            self.btn_start.setStyleSheet("background-color: #ef4444;")
            self._set_status("连接中...", "#f59e0b")
            self._log("启动桥接...")

    def stop_bridge(self):
        if self._worker and self._worker.isRunning():
            self._worker.stop()
            self.btn_start.setEnabled(False)
            self.btn_start.setText("正在安全停止...")
            self._set_status("正在停止...", "#f59e0b")
            self._log("正在等待网络与 MT5 操作安全结束...")
            return False
        self.btn_start.setText("▶  启动桥接")
        self.btn_start.setStyleSheet("background-color: #3b82f6;")
        self._set_status("已断开", "#6b7280")
        return True

    def start_bridge(self):
        if not self._worker or not self._worker.isRunning():
            self._toggle_bridge()

# ══════════════════════════════════════════════════════════
#  Settings Page
# ══════════════════════════════════════════════════════════

class SettingsPage(QWidget):
    request_back = Signal()
    logout_signal = Signal()

    def __init__(self):
        super().__init__()
        self._mt5_installations = []
        self._manual_mt5_path = None
        self._mt5_loaded = False
        self._update_request = None
        self._test_request = None
        self._logout_request = None
        self._init_ui()

    def _init_ui(self):
        layout = QVBoxLayout(self)
        layout.setSpacing(10)

        # Top row
        top_row = QHBoxLayout()
        title = QLabel("⚙ 设置")
        title.setFont(QFont("Segoe UI Emoji", 16, QFont.Bold))
        title.setStyleSheet("color: #3b82f6; background: transparent;")
        top_row.addWidget(title)
        top_row.addStretch()
        btn_back = QPushButton("< 返回主页")
        btn_back.setProperty("secondary", "true")
        btn_back.setFixedHeight(36)
        btn_back.setFont(QFont("Segoe UI", 10))
        btn_back.clicked.connect(self.request_back.emit)
        top_row.addWidget(btn_back)
        layout.addLayout(top_row)

        # ── 服务器配置卡片 ──
        server_card = QFrame()
        server_card.setProperty("card", True)
        server_layout = QVBoxLayout(server_card)
        server_layout.setSpacing(8)
        server_layout.setContentsMargins(16, 12, 16, 12)

        # 标题 + 测试结果同行
        header_row = QHBoxLayout()
        lbl_s = QLabel("服务器配置")
        lbl_s.setFont(QFont("Segoe UI", 11, QFont.Bold))
        header_row.addWidget(lbl_s)
        header_row.addStretch()
        self.lbl_test_result = QLabel("")
        self.lbl_test_result.setProperty("muted", True)
        self.lbl_test_result.setAlignment(Qt.AlignRight | Qt.AlignVCenter)
        header_row.addWidget(self.lbl_test_result)
        server_layout.addLayout(header_row)

        # 地址输入
        row_svr = QHBoxLayout()
        lbl_url = QLabel("地址:")
        lbl_url.setProperty("muted", True)
        row_svr.addWidget(lbl_url)
        self.input_server = QLineEdit()
        self.input_server.setPlaceholderText("http://server:3000")
        row_svr.addWidget(self.input_server, 1)
        server_layout.addLayout(row_svr)

        # 测试 + 保存按钮（紧凑并排）
        btn_row = QHBoxLayout()
        btn_row.setSpacing(8)
        self.btn_test = QPushButton("测试连接")
        self.btn_test.setProperty("secondary", True)
        self.btn_test.clicked.connect(self._test_connection)
        btn_row.addWidget(self.btn_test)
        self.btn_save_server = QPushButton("保存服务器地址")
        self.btn_save_server.clicked.connect(self._save_server)
        btn_row.addWidget(self.btn_save_server)
        server_layout.addLayout(btn_row)

        layout.addWidget(server_card)

        # ── 账户信息 + 退出 ──
        account_card = QFrame()
        account_card.setProperty("card", True)
        account_layout = QVBoxLayout(account_card)
        account_layout.setSpacing(10)
        account_layout.setContentsMargins(16, 12, 16, 12)

        # 用户信息 + 退出按钮同行
        acct_row = QHBoxLayout()
        lbl_a = QLabel("账户信息")
        lbl_a.setFont(QFont("Segoe UI", 11, QFont.Bold))
        acct_row.addWidget(lbl_a)
        self.lbl_user = QLabel("未登录")
        self.lbl_user.setProperty("muted", True)
        acct_row.addWidget(self.lbl_user, 1)
        btn_logout = QPushButton("退出登录")
        btn_logout.setProperty("danger", "true")
        self.btn_logout = btn_logout
        btn_logout.clicked.connect(self._logout)
        acct_row.addWidget(btn_logout)
        account_layout.addLayout(acct_row)

        layout.addWidget(account_card)

        # ── MT5 安装路径 ──
        mt5_path_card = QFrame()
        mt5_path_card.setProperty("card", True)
        mt5_path_layout = QVBoxLayout(mt5_path_card)
        mt5_path_layout.setSpacing(8)
        mt5_path_layout.setContentsMargins(16, 12, 16, 12)

        mt5_path_header = QHBoxLayout()
        lbl_mt5 = QLabel("MT5 安装路径")
        lbl_mt5.setFont(QFont("Segoe UI", 11, QFont.Bold))
        mt5_path_header.addWidget(lbl_mt5)
        mt5_path_header.addStretch()
        self.lbl_mt5_source = QLabel("")
        self.lbl_mt5_source.setProperty("muted", True)
        self.lbl_mt5_source.setStyleSheet("font-size: 11px; background: transparent;")
        mt5_path_header.addWidget(self.lbl_mt5_source)
        mt5_path_layout.addLayout(mt5_path_header)

        mt5_row = QHBoxLayout()
        mt5_row.setSpacing(6)
        self.combo_mt5 = QComboBox()
        self.combo_mt5.setEditable(True)
        self.combo_mt5.setInsertPolicy(QComboBox.NoInsert)
        self.combo_mt5.setStyleSheet(
            "QComboBox{background:#1e293b;color:#e2e8f0;border:1px solid #334155;"
            "border-radius:6px;padding:8px 12px;font-size:12px;font-family:Consolas,'Microsoft YaHei',sans-serif;}"
            "QComboBox:focus{border-color:#3b82f6;}"
            "QComboBox QAbstractItemView{background:#1e293b;color:#e2e8f0;border:1px solid #334155;"
            "selection-background-color:#3b82f6;padding:4px;}"
            "QComboBox::drop-down{border:none;width:24px;}"
        )
        self.combo_mt5.currentIndexChanged.connect(self._on_mt5_path_changed)
        mt5_row.addWidget(self.combo_mt5, 1)
        btn_browse = QPushButton("浏览")
        btn_browse.setProperty("secondary", True)
        btn_browse.setFixedWidth(80)
        btn_browse.clicked.connect(self._browse_mt5_path)
        mt5_row.addWidget(btn_browse)
        mt5_path_layout.addLayout(mt5_row)
        layout.addWidget(mt5_path_card)

        # ── 版本信息（紧凑单行） ──
        version_card = QFrame()
        version_card.setProperty("card", True)
        version_layout = QVBoxLayout(version_card)
        version_layout.setSpacing(8)
        version_layout.setContentsMargins(16, 10, 16, 10)

        # 版本号 + 检查更新按钮同行
        ver_row = QHBoxLayout()
        lbl_v = QLabel("版本信息")
        lbl_v.setFont(QFont("Segoe UI", 11, QFont.Bold))
        ver_row.addWidget(lbl_v)
        self.lbl_version = QLabel(APP_VERSION)
        self.lbl_version.setProperty("muted", True)
        self.lbl_version.setStyleSheet("color: #64748b; font-size: 12px; background: transparent; padding-left: 4px;")
        ver_row.addWidget(self.lbl_version)
        ver_row.addStretch()
        self.btn_check_update = QPushButton("检查更新")
        self.btn_check_update.setProperty("secondary", True)
        self.btn_check_update.clicked.connect(self._check_update)
        ver_row.addWidget(self.btn_check_update)
        version_layout.addLayout(ver_row)

        # 更新状态（默认隐藏，点击后显示）
        self.lbl_update_status = QLabel("")
        self.lbl_update_status.setProperty("muted", True)
        self.lbl_update_status.setWordWrap(True)
        self.lbl_update_status.setVisible(False)
        version_layout.addWidget(self.lbl_update_status)

        layout.addWidget(version_card)
        layout.addStretch()

    def showEvent(self, event):
        super().showEvent(event)
        self.lbl_test_result.setText("")
        self.lbl_test_result.setProperty("muted", True)
        self.lbl_test_result.style().polish(self.lbl_test_result)
        self.lbl_update_status.setVisible(False)
        self.lbl_update_status.setText("")
        # Reset button to default state
        self.btn_check_update.setText("检查更新")
        self.btn_check_update.setEnabled(True)
        self.btn_check_update.setProperty("secondary", True)
        self.btn_check_update.style().polish(self.btn_check_update)
        try: self.btn_check_update.clicked.disconnect()
        except (TypeError, RuntimeError):
            pass
        self.btn_check_update.clicked.connect(self._check_update)

    def load_settings(self):
        cfg = load_config()
        self.input_server.setText(cfg.get("server_url", DEFAULT_SERVER))
        email = cfg.get("email", "")
        if email and "@" in email:
            parts = email.split("@")
            name = parts[0]
            if len(name) > 2:
                masked = name[:2] + "***@" + parts[1]
            else:
                masked = email
            self.lbl_user.setText(f"当前用户: {masked}")
            self.lbl_user.setProperty("success", True)
            self.lbl_user.style().polish(self.lbl_user)
        elif email and email.isdigit():
            if len(email) > 7:
                masked = email[:3] + "***" + email[-4:]
            else:
                masked = email
            self.lbl_user.setText(f"当前用户: {masked}")
            self.lbl_user.setProperty("success", True)
            self.lbl_user.style().polish(self.lbl_user)
        elif email:
            self.lbl_user.setText(f"当前用户: {email}")
        else:
            self.lbl_user.setText("未登录")

        # 首次进入设置页时探测 MT5
        if not self._mt5_loaded:
            self._mt5_loaded = True
            QTimer.singleShot(50, self._refresh_mt5_paths)

    def _test_connection(self):
        if self._test_request is not None:
            return
        server = self.input_server.text().strip()
        if not server:
            self.lbl_test_result.setText("请输入服务器地址")
            return
        try:
            server = normalize_server_url(server)
        except ValueError as error:
            self.lbl_test_result.setText(f"❌ {error}")
            self.lbl_test_result.setProperty("success", False)
            self.lbl_test_result.setProperty("error", True)
            self.lbl_test_result.style().polish(self.lbl_test_result)
            return
        self.btn_test.setEnabled(False)
        self.btn_test.setText("测试中...")
        QApplication.processEvents()

        request = AsyncJsonRequest(f"{server.rstrip('/')}/api/auth/me", timeout=5, parent=self)
        self._test_request = request
        request.completed.connect(self._finish_test_connection)
        request.start()

    def _finish_test_connection(self, status_code, data):
        self._test_request = None
        self.btn_test.setEnabled(True)
        self.btn_test.setText("测试连接")

        if status_code in (200, 401, 403):
            self.lbl_test_result.setText("✅ 连接正常")
            self.lbl_test_result.setProperty("success", True)
            self.lbl_test_result.setProperty("error", False)
        else:
            self.lbl_test_result.setText(f"❌ 连接失败: {data.get('error', f'HTTP {status_code}')}")
            self.lbl_test_result.setProperty("success", False)
            self.lbl_test_result.setProperty("error", True)
        self.lbl_test_result.style().polish(self.lbl_test_result)

    def _save_server(self):
        server = self.input_server.text().strip()
        if not server: return
        try:
            server = normalize_server_url(server)
        except ValueError as error:
            self.lbl_test_result.setText(f"❌ {error}")
            self.lbl_test_result.setProperty("success", False)
            self.lbl_test_result.setProperty("error", True)
            self.lbl_test_result.style().polish(self.lbl_test_result)
            return
        saved = update_config({"server_url": server})
        self.lbl_test_result.setText("✅ 已保存" if saved else "❌ 本机配置保存失败")
        self.lbl_test_result.setProperty("success", saved)
        self.lbl_test_result.setProperty("error", not saved)
        self.lbl_test_result.style().polish(self.lbl_test_result)

    def _logout(self):
        if self._logout_request is not None:
            return
        cfg = load_config()
        token = cfg.get("token", "")
        if not token:
            self._finish_logout(0, {})
            return
        try:
            server = normalize_server_url(cfg.get("server_url", DEFAULT_SERVER))
        except ValueError:
            self._finish_logout(0, {})
            return
        self.btn_logout.setEnabled(False)
        request = AsyncJsonRequest(
            f"{server.rstrip('/')}/api/auth/bridge-revoke", {},
            timeout=5, token=token, parent=self,
        )
        self._logout_request = request
        request.completed.connect(self._finish_logout)
        request.start()

    def _finish_logout(self, _status_code, _data):
        self._logout_request = None
        self.btn_logout.setEnabled(True)
        self._clear_local_auth()
        self.logout_signal.emit()

    def _clear_local_auth(self):
        cfg = load_config()
        cfg.pop("token", None)
        cfg.pop("refresh_token", None)
        cfg.pop("saved_password", None)
        cfg["auto_login"] = False
        return save_config(cfg)

    # ── MT5 路径选择 ──

    def _refresh_mt5_paths(self):
        """探测所有 MT5 安装并填充下拉列表"""
        self._mt5_installations = BridgeWorker._find_mt5_installations()
        self.combo_mt5.blockSignals(True)
        self.combo_mt5.clear()
        if not self._mt5_installations:
            self.combo_mt5.addItem("未检测到MT5，请手动选择")
            self.combo_mt5.setCurrentIndex(0)
            self.lbl_mt5_source.setText("未找到")
        else:
            for path, source in self._mt5_installations:
                label = f"{source} — {path}"
                self.combo_mt5.addItem(label, path)
            self.combo_mt5.setCurrentIndex(0)
            first_source = self._mt5_installations[0][1]
            self.lbl_mt5_source.setText(first_source)
        self.combo_mt5.blockSignals(False)
        # 恢复手动选择的路径（从 config 读取）
        saved_path = load_config().get("mt5_path", "")
        if saved_path and os.path.isdir(saved_path):
            self._set_mt5_manual(saved_path)
        elif self._manual_mt5_path:
            self._set_mt5_manual(self._manual_mt5_path)

    def _on_mt5_path_changed(self, idx):
        """Combo 切换时更新来源标签并持久化到 config"""
        if idx >= 0 and idx < len(self._mt5_installations):
            path, source = self._mt5_installations[idx]
            self.lbl_mt5_source.setText(source)
            self._manual_mt5_path = None
            update_config({"mt5_path": path})

    def _browse_mt5_path(self):
        """手动浏览 MT5 目录"""
        dlg = QFileDialog(self, "选择 MT5 安装目录（包含 terminal64.exe 的文件夹）")
        dlg.setFileMode(QFileDialog.Directory)
        dlg.setOption(QFileDialog.ShowDirsOnly, True)
        start_dir = self._get_selected_mt5_path()
        if start_dir and os.path.isdir(start_dir):
            dlg.setDirectory(start_dir)
        elif self._mt5_installations:
            dlg.setDirectory(self._mt5_installations[0][0])
        else:
            dlg.setDirectory("C:\\")
        if dlg.exec():
            selected = dlg.selectedFiles()
            if selected:
                path = os.path.normpath(selected[0])
                if not find_mt5_terminal_executable(path):
                    QMessageBox.warning(self, "MT5 路径无效", "所选目录中没有 terminal64.exe 或 terminal.exe。")
                    return
                self._set_mt5_manual(path)

    def _set_mt5_manual(self, path):
        """将手动指定的路径加入下拉列表并选中，同时持久化到 config"""
        if not find_mt5_terminal_executable(path):
            return False
        self._manual_mt5_path = path
        self.combo_mt5.blockSignals(True)
        found_idx = -1
        for i in range(self.combo_mt5.count()):
            if self.combo_mt5.itemData(i) == path:
                found_idx = i
                break
        if found_idx < 0:
            self.combo_mt5.insertItem(0, f"手动指定 — {path}", path)
            found_idx = 0
        self.combo_mt5.setCurrentIndex(found_idx)
        self.lbl_mt5_source.setText("手动指定")
        self.combo_mt5.blockSignals(False)
        return update_config({"mt5_path": path})

    def _get_selected_mt5_path(self):
        """返回当前选中的 MT5 路径，或 None"""
        idx = self.combo_mt5.currentIndex()
        if idx >= 0:
            path = self.combo_mt5.itemData(idx)
            if find_mt5_terminal_executable(path):
                return path
        return None

    def _check_update(self):
        if self._update_request is not None:
            return
        cfg = load_config()
        server = cfg.get("server_url", DEFAULT_SERVER)
        self.btn_check_update.setEnabled(False)
        self.btn_check_update.setText("检查中...")
        self.lbl_update_status.setVisible(True)
        self.lbl_update_status.setText("正在连接服务器...")
        self.lbl_update_status.setProperty("muted", True)
        QApplication.processEvents()

        try:
            server = normalize_server_url(server)
        except ValueError as error:
            self._finish_update_check(0, {"error": str(error)})
            return
        url = f"{server.rstrip('/')}/api/bridge/version"
        request = AsyncJsonRequest(url, timeout=10, parent=self)
        self._update_request = request
        request.completed.connect(self._finish_update_check)
        request.start()

    def _finish_update_check(self, status_code, data):
        self._update_request = None

        self.btn_check_update.setEnabled(True)

        if status_code == 200 and data.get("version"):
            remote_ver = data["version"]
            if self._version_newer(remote_ver, APP_VERSION):
                self.lbl_update_status.setText(
                    f"发现新版本 {remote_ver}；自动更新暂时停用，请等待带数字签名和 SHA-256 校验的安装包"
                )
                self.lbl_update_status.setProperty("warning", True)
                self.lbl_update_status.style().polish(self.lbl_update_status)
                self.btn_check_update.setText("检查更新")
                self.btn_check_update.setProperty("secondary", True)
            else:
                self.lbl_update_status.setText("✅ 已是最新版本")
                self.lbl_update_status.setProperty("success", True)
                self.lbl_update_status.style().polish(self.lbl_update_status)
                self.btn_check_update.setText("检查更新")
                self.btn_check_update.setProperty("secondary", True)
                self.btn_check_update.style().polish(self.btn_check_update)
        else:
            self.lbl_update_status.setText(f"❌ 检查失败: {data.get('error', f'HTTP {status_code}')}")
            self.lbl_update_status.setProperty("error", True)
            self.lbl_update_status.style().polish(self.lbl_update_status)
            self.btn_check_update.setText("检查更新")
            self.btn_check_update.setProperty("secondary", True)
            self.btn_check_update.style().polish(self.btn_check_update)

    def _version_newer(self, remote, local):
        return version_is_newer(remote, local)

# ══════════════════════════════════════════════════════════
#  Main Window
# ══════════════════════════════════════════════════════════

class MainWindow(QMainWindow):
    def __init__(self):
        super().__init__()
        self.setWindowTitle(APP_NAME if BRIDGE_PROFILE == "default" else f"{APP_NAME} · {BRIDGE_PROFILE}")
        self.setFixedSize(520, 600)
        self._pending_update_data = None
        self._auto_update_request = None
        self._auto_login_request = None
        self._observer_login_request = None
        self._quit_requested = False
        self._runtime_started_at = datetime.now(timezone.utc).isoformat(timespec="seconds")

        ico_path = resource_path("aurum_icon.ico")
        if os.path.exists(ico_path):
            self.setWindowIcon(QIcon(ico_path))
        elif getattr(sys, 'frozen', False):
            self.setWindowIcon(QIcon(sys.executable))

        self._update_timer = QTimer(self)
        self._update_timer.timeout.connect(self._auto_check_update)

        self.stack = QStackedWidget()
        self.setCentralWidget(self.stack)

        self.login_page = LoginPage()
        self.login_page.login_success.connect(self._on_login_success)
        self.stack.addWidget(self.login_page)

        self.bridge_page = BridgePage()
        self.bridge_page.request_settings.connect(self._show_settings)
        self.bridge_page.request_observer_sources.connect(self._show_observer_sources_menu)
        self.bridge_page.worker_stopped.connect(self._finish_quit_if_ready)
        self.stack.addWidget(self.bridge_page)

        self.settings_page = SettingsPage()
        self.settings_page.request_back.connect(lambda: self.stack.setCurrentIndex(1))
        self.settings_page.logout_signal.connect(self._on_logout)
        self.stack.addWidget(self.settings_page)

        self._init_tray()

        self._runtime_timer = QTimer(self)
        self._runtime_timer.timeout.connect(self._refresh_runtime_heartbeat)
        self._runtime_timer.start(5000)
        self._refresh_runtime_heartbeat()

        cfg = load_config()
        if cfg.get("auto_login") and cfg.get("token"):
            self.stack.setCurrentIndex(0)
            QTimer.singleShot(500, self._auto_login)
        else:
            self.login_page.load_config()
            self.stack.setCurrentIndex(0)

    def _auto_login(self):
        if self._auto_login_request is not None:
            return
        cfg = load_config()
        if not cfg.get("auto_login") or self.stack.currentIndex() != 0:
            return
        server = cfg.get("server_url", DEFAULT_SERVER)
        token = cfg.get("token", "")
        email = cfg.get("email", "")
        if not server or not email:
            self.login_page.load_config()
            return
        try:
            normalized_server = normalize_server_url(server)
        except ValueError as error:
            self.login_page.lbl_status.setText(f"自动登录已停止：{error}")
            self.login_page.lbl_status.setProperty("warning", False)
            self.login_page.lbl_status.setProperty("error", True)
            self.login_page.lbl_status.style().polish(self.login_page.lbl_status)
            self.login_page.load_config()
            return
        if normalized_server != server:
            server = normalized_server
            cfg["server_url"] = server
            if not save_config(cfg):
                self.login_page.lbl_status.setText("自动登录已停止：服务器地址规范化后无法保存")
                self.login_page.lbl_status.setProperty("error", True)
                self.login_page.lbl_status.style().polish(self.login_page.lbl_status)
                return

        self.login_page.input_server.setText(server)
        self.login_page.input_email.setText(email)
        self.login_page.lbl_status.setText("自动登录中...")
        self.login_page.lbl_status.setProperty("muted", True)
        self.login_page.lbl_status.style().polish(self.login_page.lbl_status)

        if not token:
            self._show_auto_login_expired()
            return
        request = AsyncJsonRequest(
            f"{server.rstrip('/')}/api/auth/me", timeout=5, token=token, parent=self,
        )
        self._auto_login_request = request
        request.completed.connect(
            lambda status, data: self._finish_auto_login_me(status, data, server, email, token, cfg)
        )
        request.start()

    def _finish_auto_login_me(self, status, data, server, email, token, cfg):
        self._auto_login_request = None
        if status == 401 and cfg.get("refresh_token"):
            request = AsyncJsonRequest(
                f"{server.rstrip('/')}/api/auth/bridge-refresh",
                {"refreshToken": cfg["refresh_token"]}, timeout=10, parent=self,
            )
            self._auto_login_request = request
            request.completed.connect(
                lambda refresh_status, refresh_data: self._finish_auto_login_refresh(
                    refresh_status, refresh_data, server, email, cfg,
                )
            )
            request.start()
            return
        self._complete_auto_login_me(status, data, server, email, token, cfg)

    def _finish_auto_login_refresh(self, status, data, server, email, cfg):
        self._auto_login_request = None
        token = data.get("token") if status == 200 else None
        if not token:
            self._complete_auto_login_me(status, data, server, email, "", cfg)
            return
        cfg["token"] = token
        if data.get("refreshToken"):
            cfg["refresh_token"] = data["refreshToken"]
        if not save_config(cfg):
            self.login_page.lbl_status.setText("自动登录已停止：登录凭据无法安全保存")
            self.login_page.lbl_status.setProperty("error", True)
            self.login_page.lbl_status.style().polish(self.login_page.lbl_status)
            return
        request = AsyncJsonRequest(
            f"{server.rstrip('/')}/api/auth/me", timeout=5, token=token, parent=self,
        )
        self._auto_login_request = request
        request.completed.connect(
            lambda me_status, me_data: self._complete_auto_login_me(
                me_status, me_data, server, email, token, cfg,
            )
        )
        request.start()

    def _complete_auto_login_me(self, status, data, server, email, token, cfg):
        self._auto_login_request = None
        if status == 200 and token:
            user = data.get("user", data)
            cfg["plan"] = user.get("plan", "free")
            cfg["role"] = user.get("role", "user")
            cfg["plan_source"] = user.get("planSource") or user.get("plan_source")
            if not cfg.get("refresh_token"):
                request = AsyncJsonRequest(
                    f"{server.rstrip('/')}/api/auth/bridge-session", {},
                    timeout=10, token=token, parent=self,
                )
                self._auto_login_request = request
                request.completed.connect(
                    lambda session_status, session_data: self._finish_auto_login_session(
                        session_status, session_data, email, token, cfg,
                    )
                )
                request.start()
                return
            self._finish_auto_login_session(200, {}, email, token, cfg)
            return
        if status == 0 or status in (408, 425, 429) or status >= 500:
            self.login_page.lbl_status.setText("服务器暂时无法连接，15 秒后自动重试")
            self.login_page.lbl_status.setProperty("warning", True)
            self.login_page.lbl_status.style().polish(self.login_page.lbl_status)
            QTimer.singleShot(15000, self._auto_login)
            return
        self._show_auto_login_expired()

    def _finish_auto_login_session(self, status, data, email, token, cfg):
        self._auto_login_request = None
        if status == 200 and data.get("refreshToken"):
            cfg["refresh_token"] = data["refreshToken"]
        if not save_config(cfg):
            self.login_page.lbl_status.setText("自动登录已停止：本机加密配置保存失败")
            self.login_page.lbl_status.setProperty("error", True)
            self.login_page.lbl_status.style().polish(self.login_page.lbl_status)
            return
        self._on_login_success(email, token)

    def _show_auto_login_expired(self):
        cfg = load_config()
        cfg["auto_login"] = False
        cfg.pop("token", None)
        cfg.pop("refresh_token", None)
        save_config(cfg)
        self.login_page.lbl_status.setText("登录已过期，请重新登录")
        self.login_page.lbl_status.setProperty("warning", True)
        self.login_page.lbl_status.style().polish(self.login_page.lbl_status)
        self.login_page.load_config()

    def _on_login_success(self, email, token):
        # 🔧 先切换页面，再操作桥接页控件——防止控件操作异常导致页面不跳转
        self.stack.setCurrentIndex(1)
        QApplication.processEvents()
        try:
            self.bridge_page._log(f"登录成功: {email}")
            self.bridge_page.lbl_login_user.setText(f"当前登录: {email}")
            self.bridge_page.btn_start.setText("▶  启动桥接")
            self.bridge_page.btn_start.setStyleSheet("background-color: #3b82f6;")
            self.bridge_page._set_status("已断开", "#6b7280")
            self.bridge_page.lbl_update_hint.setVisible(False)
            cfg = load_config()
            is_admin_main = cfg.get("role") == "admin" and BRIDGE_PROFILE == "default"
            self.bridge_page.btn_observer_sources.setVisible(is_admin_main)
            if is_admin_main:
                self._refresh_observer_sources_button()
            if cfg.get("auto_start_bridge"):
                QTimer.singleShot(700, self.bridge_page.start_bridge)
        except Exception as error:
            log_error(f"登录成功后的界面初始化失败: {BridgeWorker._short_text(error, 500)}")
            QMessageBox.warning(self, "界面初始化异常", "登录已成功，但桥接界面初始化不完整，请重启桥接软件。")
        # 启动后 3 秒自动检查更新，之后每 30 分钟检查一次
        QTimer.singleShot(3000, self._auto_check_update)
        self._update_timer.start(30 * 60 * 1000)

    def _auto_check_update(self):
        """静默检查更新，有新版本时在主页显示提示条"""
        if self._auto_update_request is not None:
            return
        cfg = load_config()
        server = cfg.get("server_url", DEFAULT_SERVER)
        try:
            server = normalize_server_url(server)
        except ValueError:
            return
        request = AsyncJsonRequest(
            f"{server.rstrip('/')}/api/bridge/version", timeout=8, parent=self,
        )
        self._auto_update_request = request
        request.completed.connect(self._finish_auto_update_check)
        request.start()

    def _finish_auto_update_check(self, status_code, data):
        self._auto_update_request = None
        if status_code == 200 and data.get("version"):
            remote_ver = data["version"]
            if self.settings_page._version_newer(remote_ver, APP_VERSION):
                if not self._pending_update_data:
                    self._pending_update_data = data
                    self.bridge_page._log(f"发现新版本 {remote_ver}；自动更新等待签名安装包")
                    self.bridge_page.lbl_update_hint.setText(f"新版本 {remote_ver} 可用 — 自动更新暂时停用")
                    self.bridge_page.lbl_update_hint.setVisible(True)

    def _show_settings(self):
        self.settings_page.load_settings()
        self.stack.setCurrentIndex(2)

    def _observer_source_profiles(self):
        return [profile for profile in list_bridge_profiles(CONFIG_ROOT) if profile["slug"] != "default"]

    def _refresh_observer_sources_button(self):
        count = len(self._observer_source_profiles())
        suffix = f" · {count}" if count else ""
        self.bridge_page.btn_observer_sources.setText(f"观摩源{suffix} ▾")

    def _show_observer_sources_menu(self):
        if load_config().get("role") != "admin" or BRIDGE_PROFILE != "default":
            QMessageBox.warning(self, "权限不足", "只有管理员主桥接可以管理观摩源。")
            return
        profiles = self._observer_source_profiles()
        menu = QMenu(self)
        menu.setObjectName("observerSourcesMenu")
        if profiles:
            section = menu.addSection("已保存的观摩源")
            section.setEnabled(False)
            for profile in profiles:
                runtime = read_profile_runtime(CONFIG_ROOT, profile["slug"])
                running = bool(runtime.get("running"))
                state_text = "无响应" if runtime.get("state") == "unresponsive" else ("运行中" if running else "已停止")
                action = menu.addAction(f"{profile['name']}   ·   {state_text}")
                action.setToolTip("桥接心跳已超时，点击尝试切换窗口" if runtime.get("state") == "unresponsive" else ("切换到桥接窗口" if running else "启动并自动登录"))
                action.triggered.connect(
                    lambda checked=False, slug=profile["slug"]: self._open_saved_observer_source(slug)
                )
            menu.addSeparator()
        else:
            empty = menu.addAction("尚未保存观摩源")
            empty.setEnabled(False)
            menu.addSeparator()
        add_action = menu.addAction("＋ 新增观摩源")
        add_action.triggered.connect(self._open_new_observer_source)
        button = self.bridge_page.btn_observer_sources
        menu.exec(button.mapToGlobal(button.rect().bottomLeft()))

    def _open_saved_observer_source(self, slug):
        runtime = read_profile_runtime(CONFIG_ROOT, slug)
        if runtime.get("running"):
            if not activate_profile_window(runtime.get("pid")):
                message = "该观摩源进程仍在运行，但心跳已超时，请检查对应窗口。" if runtime.get("state") == "unresponsive" else "该观摩源进程仍在运行，请从任务栏切换到对应窗口。"
                QMessageBox.information(self, "观摩源正在运行", message)
            return
        try:
            launch_bridge_profile(
                sys.executable if getattr(sys, "frozen", False) else os.path.abspath(__file__),
                slug, frozen=bool(getattr(sys, "frozen", False)),
            )
        except OSError as error:
            QMessageBox.warning(self, "启动失败", f"观摩源启动失败：{error}")
            return
        self._schedule_observer_source_start_check(slug)
        QMessageBox.information(self, "正在启动", "观摩源桥接与对应 MT5 正在启动，将使用已保存的账号自动登录。")

    def _schedule_observer_source_start_check(self, slug):
        QTimer.singleShot(3000, lambda checked_slug=slug: self._verify_observer_source_started(checked_slug))

    def _verify_observer_source_started(self, slug):
        runtime = read_profile_runtime(CONFIG_ROOT, slug)
        self._refresh_observer_sources_button()
        if not runtime.get("running"):
            QMessageBox.warning(
                self,
                "观摩源未启动",
                f"观摩源“{slug}”没有建立运行心跳。档案和加密凭据已保留，可从观摩源菜单再次启动并查看独立窗口错误。",
            )

    def _open_new_observer_source(self):
        if load_config().get("role") != "admin" or BRIDGE_PROFILE != "default":
            QMessageBox.warning(self, "权限不足", "只有管理员主桥接可以新增观摩源。")
            return
        dialog = NewObserverSourceDialog(self)
        dialog.submit.clicked.connect(lambda: self._create_and_launch_observer_source(dialog))
        dialog.exec()

    def _create_and_launch_observer_source(self, dialog):
        if self._observer_login_request is not None:
            return
        values = dialog.values()
        raw_slug = values["slug"]
        slug = normalize_profile(raw_slug)
        if (not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_-]{0,39}", raw_slug or "")
                or slug == "default"):
            dialog.show_error("请输入有效的档案标识，仅支持字母、数字、短横线和下划线。")
            return
        if any(item["slug"] == slug for item in list_bridge_profiles(CONFIG_ROOT)):
            dialog.show_error("该配置档案已存在，请更换标识。")
            return
        if not values["account"] or not values["password"]:
            dialog.show_error("请输入网站中创建的专用桥接源账号和密码。")
            return
        account_owner = find_source_account_owner(CONFIG_ROOT, values["account"])
        if account_owner:
            dialog.show_error(f"该源账号已被“{account_owner.get('name') or account_owner['slug']}”使用，不能重复启动。")
            return
        mt5_path = values["mt5_path"]
        terminal_path = find_mt5_terminal_executable(mt5_path)
        if not terminal_path:
            dialog.show_error("所选目录中没有 terminal64.exe 或 terminal.exe。")
            return
        owner = find_mt5_path_owner(CONFIG_ROOT, mt5_path)
        if owner:
            dialog.show_error(f"该 MT5 目录已被“{owner.get('name') or owner['slug']}”使用。每个观摩源必须使用独立目录。")
            return

        parent_cfg = load_config()
        server = parent_cfg.get("server_url", DEFAULT_SERVER)
        try:
            server = normalize_server_url(server)
        except ValueError as error:
            dialog.show_error(f"主桥接服务器地址无效：{error}")
            return
        dialog.set_submitting(True)
        QApplication.processEvents()
        request = AsyncJsonRequest(f"{server.rstrip('/')}/api/login", {
            "email": values["account"], "password": values["password"], "client": "bridge",
        }, timeout=10, parent=self)
        self._observer_login_request = request
        request.completed.connect(
            lambda status_code, data: self._finish_create_observer_source_login(
                status_code, data, dialog, values, slug, server, mt5_path,
            )
        )
        request.start()

    def _finish_create_observer_source_login(self, status_code, data, dialog, values, slug, server, mt5_path):
        self._observer_login_request = None
        try:
            if not dialog.isVisible():
                return
        except RuntimeError:
            return
        user = data.get("user", {}) if isinstance(data, dict) else {}
        plan_source = user.get("planSource") or user.get("plan_source")
        if status_code != 200 or not data.get("token"):
            dialog.show_error(data.get("error", "源账号验证失败，请检查账号和密码。"))
            return
        if user.get("role") != "user" or plan_source != "observer_source":
            dialog.show_error("该账号不是专用桥接源账号，请先在统一管理后台的观摩频道中创建。")
            return
        try:
            write_profile_config(CONFIG_ROOT, slug, {
                "server_url": server,
                "email": values["account"],
                "token": data["token"],
                "refresh_token": data.get("refreshToken", ""),
                "remember": True,
                "auto_login": True,
                "auto_start_bridge": True,
                "saved_password": values["password"],
                "plan": user.get("plan", "pro"),
                "role": user.get("role", "user"),
                "plan_source": plan_source,
                "mt5_path": mt5_path,
                "mt5_portable": False,
            })
        except (OSError, ValueError) as error:
            dialog.show_error(f"观摩源本机配置保存失败：{error}")
            return
        try:
            register_bridge_profile(CONFIG_ROOT, slug, values["name"] or slug)
        except (OSError, ValueError) as error:
            dialog.accept()
            self._refresh_observer_sources_button()
            QMessageBox.warning(
                self,
                "观摩源已保存但名称登记失败",
                f"加密配置已安全保存，档案仍可通过标识“{slug}”启动，但显示名称登记失败：{error}",
            )
            return
        try:
            launch_bridge_profile(
                sys.executable if getattr(sys, "frozen", False) else os.path.abspath(__file__),
                slug, frozen=bool(getattr(sys, "frozen", False)),
            )
        except OSError as error:
            dialog.accept()
            self._refresh_observer_sources_button()
            QMessageBox.warning(
                self,
                "观摩源已保存但未启动",
                f"档案和加密凭据已安全保存，但独立进程启动失败：{error}\n请从观摩源菜单再次启动。",
            )
            return
        dialog.accept()
        self._refresh_observer_sources_button()
        self._schedule_observer_source_start_check(slug)
        QMessageBox.information(self, "观摩源已启动", "新的桥接窗口和独立 MT5 进程正在启动。统一管理后台将在连接成功后显示在线。")

    def _on_logout(self):
        self._update_timer.stop()
        self._pending_update_data = None
        self.bridge_page.stop_bridge()
        # stop_bridge() disables future token persistence synchronously. Clear
        # once more after that boundary so an in-flight refresh cannot restore
        # credentials between SettingsPage cleanup and this callback.
        self.settings_page._clear_local_auth()
        self.bridge_page.lbl_login_user.setText("")
        self.bridge_page.btn_observer_sources.setVisible(False)
        self.bridge_page.lbl_update_hint.setVisible(False)
        self.login_page.load_config()
        self.login_page.lbl_status.setText("")
        self.stack.setCurrentIndex(0)
        QApplication.processEvents()

    def _init_tray(self):
        ico_path = resource_path("aurum_icon.ico")
        if os.path.exists(ico_path):
            tray_icon = QIcon(ico_path)
        elif not self.windowIcon().isNull():
            tray_icon = self.windowIcon()
        else:
            tray_icon = self.style().standardIcon(QStyle.SP_ComputerIcon)
        self.tray = QSystemTrayIcon(tray_icon, self)
        self.tray.setToolTip(APP_NAME if BRIDGE_PROFILE == "default" else f"{APP_NAME} · {BRIDGE_PROFILE}")
        tray_menu = QMenu()
        act_show = QAction("打开界面", self)
        act_show.triggered.connect(self._show_from_tray)
        tray_menu.addAction(act_show)
        tray_menu.addSeparator()
        act_quit = QAction("退出", self)
        act_quit.triggered.connect(self._do_quit)
        tray_menu.addAction(act_quit)
        self.tray.setContextMenu(tray_menu)
        self.tray.activated.connect(self._tray_activated)
        self.tray.show()

    def _tray_activated(self, reason):
        if reason == QSystemTrayIcon.DoubleClick:
            self._show_from_tray()

    def _show_from_tray(self):
        self.showNormal()
        self.activateWindow()

    def _refresh_runtime_heartbeat(self):
        try:
            write_profile_runtime(
                CONFIG_ROOT, BRIDGE_PROFILE, APP_VERSION,
                self._runtime_started_at, self.windowTitle(),
            )
        except OSError as error:
            log_warn(f"运行状态写入失败: {error}")

    def _do_quit(self):
        self._runtime_timer.stop()
        self._update_timer.stop()
        self._quit_requested = True
        if self.bridge_page.stop_bridge():
            self._finish_quit_if_ready()
        else:
            self.tray.showMessage(
                APP_NAME, "正在安全停止桥接，完成后将自动退出。",
                QSystemTrayIcon.Information, 2000,
            )

    def _finish_quit_if_ready(self):
        if self._quit_requested:
            self.tray.hide()
            QApplication.quit()

    def closeEvent(self, event):
        event.ignore()
        self.hide()
        self.tray.showMessage(APP_NAME, "已最小化到系统托盘", QSystemTrayIcon.Information, 1500)

# ══════════════════════════════════════════════════════════
#  Entry
# ══════════════════════════════════════════════════════════

if __name__ == "__main__":
    # DPI awareness
    try:
        ctypes.windll.shcore.SetProcessDpiAwareness(1)
    except Exception:
        pass

    app = QApplication(QT_ARGV)
    app.setStyleSheet(DARK_STYLE)

    # Font
    font = QFont("Segoe UI", 10)
    font.setStyleStrategy(QFont.PreferAntialias)
    app.setFont(font)

    _instance_mutex = None
    _instance_mutex, acquired = acquire_instance_mutex(f"profile-{BRIDGE_PROFILE}")
    if not acquired:
        runtime = read_profile_runtime(CONFIG_ROOT, BRIDGE_PROFILE)
        activate_profile_window(runtime.get("pid"))
        sys.exit(0)
    win = MainWindow()
    app.aboutToQuit.connect(lambda: clear_profile_runtime(CONFIG_ROOT, BRIDGE_PROFILE, os.getpid()))
    win.show()
    sys.exit(app.exec())
