# -*- coding: utf-8 -*-
"""Local runtime primitives shared by AURUM Bridge profiles and the manager."""
import ctypes
import ctypes.wintypes
from datetime import datetime, timezone
import json
import os
import re


PROFILE_REGISTRY_FILE = "profile_registry.json"
RUNTIME_FILE = "runtime.json"
HEARTBEAT_STALE_SECONDS = 15


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
    os.makedirs(os.path.dirname(path), exist_ok=True)
    temp_path = f"{path}.{os.getpid()}.tmp"
    with open(temp_path, "w", encoding="utf-8") as handle:
        json.dump(value, handle, ensure_ascii=False, indent=2)
        handle.flush()
        os.fsync(handle.fileno())
    os.replace(temp_path, path)


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
    _write_json_atomic(path, dict(config or {}))
    return path


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
        process = ctypes.windll.kernel32.OpenProcess(0x1000, False, pid)
        if not process:
            return False
        exit_code = ctypes.wintypes.DWORD()
        alive = bool(ctypes.windll.kernel32.GetExitCodeProcess(process, ctypes.byref(exit_code))) and exit_code.value == 259
        ctypes.windll.kernel32.CloseHandle(process)
        return alive
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
    mutex_name = "Global\\AURUM_Bridge_" + normalize_profile(key)
    handle = ctypes.windll.kernel32.CreateMutexW(None, False, mutex_name)
    return handle, ctypes.windll.kernel32.GetLastError() != 183


def activate_profile_window(pid):
    if os.name != "nt" or not _pid_running(pid):
        return False
    found = {"value": False}
    callback_type = ctypes.WINFUNCTYPE(ctypes.wintypes.BOOL, ctypes.wintypes.HWND, ctypes.wintypes.LPARAM)

    def callback(hwnd, _):
        process_id = ctypes.wintypes.DWORD()
        ctypes.windll.user32.GetWindowThreadProcessId(hwnd, ctypes.byref(process_id))
        if process_id.value != int(pid) or not ctypes.windll.user32.IsWindowVisible(hwnd):
            return True
        ctypes.windll.user32.ShowWindow(hwnd, 9)
        ctypes.windll.user32.SetForegroundWindow(hwnd)
        found["value"] = True
        return False

    ctypes.windll.user32.EnumWindows(callback_type(callback), 0)
    return found["value"]
