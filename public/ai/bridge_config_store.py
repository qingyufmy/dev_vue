# -*- coding: utf-8 -*-
"""Thread-safe, atomic storage for one Bridge profile configuration."""
import json
import os
import tempfile
import threading
import time

from bridge_secret_store import config_for_storage, config_from_storage


def write_json_atomic(path, value):
    """Durably replace one JSON file without sharing a temp name across writers."""
    directory = os.path.dirname(os.path.abspath(path))
    os.makedirs(directory, exist_ok=True)
    temp_path = None
    try:
        with tempfile.NamedTemporaryFile(
            mode="w",
            encoding="utf-8",
            dir=directory,
            prefix=f".{os.path.basename(path)}.",
            suffix=".tmp",
            delete=False,
        ) as handle:
            temp_path = handle.name
            json.dump(value, handle, ensure_ascii=False, indent=2)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temp_path, path)
        temp_path = None
    finally:
        if temp_path:
            try:
                os.remove(temp_path)
            except FileNotFoundError:
                pass


class BridgeConfigStore:
    """Serialize read/modify/write cycles inside the Bridge process."""

    def __init__(self, path):
        self.path = os.path.abspath(path)
        self._lock = threading.RLock()

    def _save_locked(self, config):
        write_json_atomic(self.path, config_for_storage(config))

    def _quarantine_corrupt_locked(self):
        backup_path = f"{self.path}.corrupt-{time.time_ns()}"
        os.replace(self.path, backup_path)
        print(f"[Bridge] 损坏的本机配置已隔离，可从以下文件恢复: {backup_path}")
        return {}

    def load(self):
        with self._lock:
            try:
                with open(self.path, "r", encoding="utf-8") as handle:
                    stored = json.load(handle)
            except FileNotFoundError:
                return {}
            except (json.JSONDecodeError, UnicodeError):
                return self._quarantine_corrupt_locked()
            if not isinstance(stored, dict):
                return self._quarantine_corrupt_locked()
            config, migration_needed = config_from_storage(stored)
            if migration_needed:
                self._save_locked(config)
            return config

    def save(self, config):
        with self._lock:
            self._save_locked(dict(config or {}))

    def update(self, patch):
        with self._lock:
            config = self.load()
            config.update(dict(patch or {}))
            self._save_locked(config)
            return config
