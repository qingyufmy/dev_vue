# -*- coding: utf-8 -*-
"""Local runtime primitives shared by AURUM Bridge profiles and the manager."""
import ctypes
import ctypes.wintypes
from datetime import datetime, timezone
import json
import os
import re

from bridge_config_store import write_json_atomic
from bridge_secret_store import config_for_storage, config_from_storage


PROFILE_REGISTRY_FILE = "profile_registry.json"
RUNTIME_FILE = "runtime.json"
HEARTBEAT_STALE_SECONDS = 15


def _kernel32():
    kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
    kernel32.OpenProcess.argtypes = [ctypes.wintypes.DWORD, ctypes.wintypes.BOOL, ctypes.wintypes.DWORD]
    kernel32.OpenProcess.restype = ctypes.wintypes.HANDLE
    kernel32.GetExitCodeProcess.argtypes = [ctypes.wintypes.HANDLE, ctypes.POINTER(ctypes.wintypes.DWORD)]
    kernel32.GetExitCodeProcess.restype = ctypes.wintypes.BOOL
    kernel32.CloseHandle.argtypes = [ctypes.wintypes.HANDLE]
    kernel32.CloseHandle.restype = ctypes.wintypes.BOOL
    kernel32.CreateMutexW.argtypes = [ctypes.c_void_p, ctypes.wintypes.BOOL, ctypes.wintypes.LPCWSTR]
    kernel32.CreateMutexW.restype = ctypes.wintypes.HANDLE
    kernel32.OpenMutexW.argtypes = [ctypes.wintypes.DWORD, ctypes.wintypes.BOOL, ctypes.wintypes.LPCWSTR]
    kernel32.OpenMutexW.restype = ctypes.wintypes.HANDLE
    return kernel32


def _instance_mutex_name(key):
    return "Global\\AURUM_Bridge_" + normalize_profile(key)


def normalize_profile(value):
    profile = re.sub(r"[^a-zA-Z0-9_-]", "-", str(value or "default").strip())[:40].strip("-_")
    return (profile or "default").lower()


def profile_config_dir(config_root, profile):
    profile = normalize_profile(profile)
    return config_root if profile == "default" else os.path.join(config_root, "profiles", profile)


def _utc_now_text():
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def _read_json(path, fallback=None):
    try:
        with open(path, "r", encoding="utf-8") as handle:
            value = json.load(handle)
        return value if isinstance(value, (dict, list)) else fallback
    except (OSError, ValueError, TypeError):
        return fallback


def _write_json_atomic(path, value):
    write_json_atomic(path, value)


def load_profile_registry(config_root):
    value = _read_json(os.path.join(config_root, PROFILE_REGISTRY_FILE), {}) or {}
    profiles = value.get("profiles", {}) if isinstance(value, dict) else {}
    return profiles if isinstance(profiles, dict) else {}


def list_bridge_profiles(config_root):
    registry = load_profile_registry(config_root)
    profiles = {"default": {"slug": "default", "name": "默认桥接", "created_at": None}}
    profiles_root = os.path.join(config_root, "profiles")
    try:
        names = os.listdir(profiles_root)
    except OSError:
        names = []
    for name in names:
        path = os.path.join(profiles_root, name)
        if os.path.isdir(path):
            slug = normalize_profile(name)
            profiles[slug] = {"slug": slug, "name": slug, "created_at": None}
    for raw_slug, metadata in registry.items():
        slug = normalize_profile(raw_slug)
        if slug == "default" or os.path.isdir(profile_config_dir(config_root, slug)):
            item = metadata if isinstance(metadata, dict) else {}
            profiles[slug] = {
                "slug": slug,
                "name": str(item.get("name") or profiles.get(slug, {}).get("name") or slug)[:60],
                "created_at": item.get("created_at"),
            }
    return sorted(profiles.values(), key=lambda item: (item["slug"] != "default", item["created_at"] or "", item["slug"]))


def register_bridge_profile(config_root, slug, name=""):
    slug = normalize_profile(slug)
    if slug == "default":
        raise ValueError("profile_default_reserved")
    os.makedirs(profile_config_dir(config_root, slug), exist_ok=True)
    registry = load_profile_registry(config_root)
    current = registry.get(slug, {}) if isinstance(registry.get(slug), dict) else {}
    registry[slug] = {
        "name": str(name or current.get("name") or slug).strip()[:60] or slug,
        "created_at": current.get("created_at") or _utc_now_text(),
    }
    _write_json_atomic(os.path.join(config_root, PROFILE_REGISTRY_FILE), {"profiles": registry})
    return {"slug": slug, **registry[slug]}


def write_profile_config(config_root, profile, config):
    path = os.path.join(profile_config_dir(config_root, profile), "config.json")
    _write_json_atomic(path, config_for_storage(config))
    return path


def migrate_profile_config_secrets(config_root):
    """Upgrade every existing profile without requiring each profile to start."""
    migrated = []
    failed = []
    for profile in list_bridge_profiles(config_root):
        path = os.path.join(profile_config_dir(config_root, profile["slug"]), "config.json")
        stored = _read_json(path, None)
        if not isinstance(stored, dict):
            continue
        try:
            config, migration_needed = config_from_storage(stored)
            if migration_needed:
                _write_json_atomic(path, config_for_storage(config))
                migrated.append(profile["slug"])
        except Exception as error:
            failed.append({
                "slug": profile["slug"],
                "error": str(error)[:200] or type(error).__name__,
            })
    return {"migrated": migrated, "failed": failed}


def find_mt5_path_owner(config_root, mt5_path, exclude_profile=None):
    raw_requested = str(mt5_path or "").strip()
    if not raw_requested:
        return None
    requested = os.path.normcase(os.path.realpath(raw_requested))
    excluded = normalize_profile(exclude_profile) if exclude_profile else None
    for profile in list_bridge_profiles(config_root):
        if profile["slug"] == excluded:
            continue
        path = os.path.join(profile_config_dir(config_root, profile["slug"]), "config.json")
        config = _read_json(path, {}) or {}
        raw_configured = str(config.get("mt5_path") or "").strip()
        if raw_configured and os.path.normcase(os.path.realpath(raw_configured)) == requested:
            return profile
    return None


def find_source_account_owner(config_root, account, exclude_profile=None):
    requested = str(account or "").strip().casefold()
    if not requested:
        return None
    excluded = normalize_profile(exclude_profile) if exclude_profile else None
    for profile in list_bridge_profiles(config_root):
        if profile["slug"] == excluded:
            continue
        path = os.path.join(profile_config_dir(config_root, profile["slug"]), "config.json")
        config = _read_json(path, {}) or {}
        if str(config.get("email") or "").strip().casefold() == requested:
            return profile
    return None


def _pid_running(pid):
    try:
        pid = int(pid)
    except (TypeError, ValueError):
        return False
    if pid <= 0:
        return False
    if os.name == "nt":
        kernel32 = _kernel32()
        process = kernel32.OpenProcess(0x1000, False, pid)
        if not process:
            return False
        try:
            exit_code = ctypes.wintypes.DWORD()
            return bool(kernel32.GetExitCodeProcess(process, ctypes.byref(exit_code))) and exit_code.value == 259
        finally:
            kernel32.CloseHandle(process)
    try:
        os.kill(pid, 0)
        return True
    except OSError:
        return False


def read_profile_runtime(config_root, profile):
    path = os.path.join(profile_config_dir(config_root, profile), RUNTIME_FILE)
    runtime = _read_json(path, {}) or {}
    pid = runtime.get("pid")
    if not _pid_running(pid):
        return {**runtime, "pid": pid, "state": "stopped", "running": False}
    heartbeat = runtime.get("heartbeat_at")
    try:
        heartbeat_at = datetime.fromisoformat(str(heartbeat).replace("Z", "+00:00"))
        age = max(0, (datetime.now(timezone.utc) - heartbeat_at.astimezone(timezone.utc)).total_seconds())
    except (TypeError, ValueError):
        age = HEARTBEAT_STALE_SECONDS + 1
    if age > HEARTBEAT_STALE_SECONDS and os.name == "nt" and not _instance_mutex_exists(f"profile-{profile}"):
        return {
            **runtime, "pid": int(pid), "state": "stopped", "running": False,
            "heartbeat_age_seconds": round(age, 1), "stale_pid_reused": True,
        }
    state = "running" if age <= HEARTBEAT_STALE_SECONDS else "unresponsive"
    return {**runtime, "pid": int(pid), "state": state, "running": True, "heartbeat_age_seconds": round(age, 1)}


def write_profile_runtime(config_root, profile, version, started_at, window_title):
    path = os.path.join(profile_config_dir(config_root, profile), RUNTIME_FILE)
    payload = {
        "profile": normalize_profile(profile),
        "pid": os.getpid(),
        "state": "running",
        "version": str(version),
        "window_title": str(window_title),
        "started_at": started_at,
        "heartbeat_at": _utc_now_text(),
    }
    _write_json_atomic(path, payload)
    return payload


def clear_profile_runtime(config_root, profile, pid=None):
    path = os.path.join(profile_config_dir(config_root, profile), RUNTIME_FILE)
    runtime = _read_json(path, {}) or {}
    expected_pid = int(pid or os.getpid())
    if runtime and int(runtime.get("pid") or 0) != expected_pid:
        return False
    try:
        os.remove(path)
        return True
    except FileNotFoundError:
        return True
    except OSError:
        return False


def acquire_instance_mutex(key):
    """Return (handle, acquired). The handle must stay referenced for process lifetime."""
    if os.name != "nt":
        return None, True
    kernel32 = _kernel32()
    ctypes.set_last_error(0)
    handle = kernel32.CreateMutexW(None, False, _instance_mutex_name(key))
    if not handle:
        return None, False
    return handle, ctypes.get_last_error() != 183


def _instance_mutex_exists(key):
    if os.name != "nt":
        return False
    synchronize = 0x00100000
    kernel32 = _kernel32()
    handle = kernel32.OpenMutexW(synchronize, False, _instance_mutex_name(key))
    if not handle:
        return False
    kernel32.CloseHandle(handle)
    return True


def activate_profile_window(pid):
    if os.name != "nt" or not _pid_running(pid):
        return False
    candidates = []
    callback_type = ctypes.WINFUNCTYPE(ctypes.wintypes.BOOL, ctypes.wintypes.HWND, ctypes.wintypes.LPARAM)
    user32 = ctypes.WinDLL("user32", use_last_error=True)
    user32.EnumWindows.argtypes = [callback_type, ctypes.wintypes.LPARAM]
    user32.EnumWindows.restype = ctypes.wintypes.BOOL
    user32.GetWindowThreadProcessId.argtypes = [ctypes.wintypes.HWND, ctypes.POINTER(ctypes.wintypes.DWORD)]
    user32.GetWindowThreadProcessId.restype = ctypes.wintypes.DWORD
    user32.GetWindowTextLengthW.argtypes = [ctypes.wintypes.HWND]
    user32.GetWindowTextLengthW.restype = ctypes.c_int
    user32.IsWindowVisible.argtypes = [ctypes.wintypes.HWND]
    user32.IsWindowVisible.restype = ctypes.wintypes.BOOL
    user32.ShowWindow.argtypes = [ctypes.wintypes.HWND, ctypes.c_int]
    user32.ShowWindow.restype = ctypes.wintypes.BOOL
    user32.SetForegroundWindow.argtypes = [ctypes.wintypes.HWND]
    user32.SetForegroundWindow.restype = ctypes.wintypes.BOOL

    def callback(hwnd, _):
        process_id = ctypes.wintypes.DWORD()
        user32.GetWindowThreadProcessId(hwnd, ctypes.byref(process_id))
        if process_id.value != int(pid):
            return True
        # Qt creates helper windows as well as the actual QMainWindow. A titled
        # top-level window identifies the profile UI even when it is hidden in
        # the system tray, which is exactly when a second launch should restore it.
        if user32.GetWindowTextLengthW(hwnd) <= 0:
            return True
        candidates.append((bool(user32.IsWindowVisible(hwnd)), hwnd))
        return True

    user32.EnumWindows(callback_type(callback), 0)
    if not candidates:
        return False
    _, hwnd = sorted(candidates, key=lambda item: item[0], reverse=True)[0]
    user32.ShowWindow(hwnd, 9)  # SW_RESTORE also reveals tray-hidden windows.
    user32.SetForegroundWindow(hwnd)
    return True
