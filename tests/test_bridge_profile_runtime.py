# -*- coding: utf-8 -*-
import os
import sys
import tempfile
import unittest
import uuid
from datetime import datetime, timedelta, timezone

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, "public", "ai"))

from bridge_profile_runtime import (  # noqa: E402
    _kernel32, acquire_instance_mutex, clear_profile_runtime, find_mt5_path_owner,
    find_source_account_owner,
    list_bridge_profiles, normalize_profile, read_profile_runtime,
    register_bridge_profile, write_profile_config,
    write_profile_runtime,
)


class BridgeProfileRuntimeTests(unittest.TestCase):
    @unittest.skipUnless(os.name == "nt", "Windows named mutex behavior")
    def test_profile_mutex_detects_an_existing_64_bit_handle(self):
        key = f"unit-{uuid.uuid4().hex}"
        first, first_acquired = acquire_instance_mutex(key)
        second, second_acquired = acquire_instance_mutex(key)
        try:
            self.assertTrue(first)
            self.assertTrue(first_acquired)
            self.assertTrue(second)
            self.assertFalse(second_acquired)
        finally:
            kernel32 = _kernel32()
            if second:
                kernel32.CloseHandle(second)
            if first:
                kernel32.CloseHandle(first)

    def test_profile_registry_and_runtime_control_are_isolated(self):
        with tempfile.TemporaryDirectory() as root:
            created = register_bridge_profile(root, "Source A", "一号观摩源")
            self.assertEqual(created["slug"], "source-a")
            profiles = list_bridge_profiles(root)
            self.assertEqual([item["slug"] for item in profiles], ["default", "source-a"])
            mt5_path = os.path.join(root, "mt5-a")
            os.makedirs(mt5_path)
            write_profile_config(root, "source-a", {"mt5_path": mt5_path, "email": "SOURCE@example.com"})
            owner = find_mt5_path_owner(root, mt5_path)
            self.assertEqual(owner["slug"], "source-a")
            account_owner = find_source_account_owner(root, "source@example.com")
            self.assertEqual(account_owner["slug"], "source-a")
            self.assertIsNone(find_mt5_path_owner(root, ""))

            write_profile_runtime(root, "source-a", "v-test", "2026-07-22T08:00:00+00:00", "测试桥接")
            runtime = read_profile_runtime(root, "source-a")
            self.assertTrue(runtime["running"])
            self.assertEqual(runtime["pid"], os.getpid())
            self.assertTrue(clear_profile_runtime(root, "source-a", os.getpid()))
            self.assertFalse(read_profile_runtime(root, "source-a")["running"])

    def test_normalization_and_default_reservation(self):
        self.assertEqual(normalize_profile(" Source_A "), "source_a")
        with tempfile.TemporaryDirectory() as root:
            with self.assertRaisesRegex(ValueError, "profile_default_reserved"):
                register_bridge_profile(root, "default", "重复默认")

    @unittest.skipUnless(os.name == "nt", "Windows named mutex behavior")
    def test_stale_runtime_does_not_trust_a_reused_pid_without_profile_mutex(self):
        with tempfile.TemporaryDirectory() as root:
            profile = f"unit-stale-{os.getpid()}"
            runtime_dir = os.path.join(root, "profiles", profile)
            os.makedirs(runtime_dir)
            runtime_path = os.path.join(runtime_dir, "runtime.json")
            stale_time = (datetime.now(timezone.utc) - timedelta(minutes=5)).isoformat(timespec="seconds")
            with open(runtime_path, "w", encoding="utf-8") as handle:
                import json
                json.dump({
                    "profile": profile, "pid": os.getpid(),
                    "heartbeat_at": stale_time, "state": "running",
                }, handle)
            runtime = read_profile_runtime(root, profile)
            self.assertFalse(runtime["running"])
            self.assertEqual(runtime["state"], "stopped")
            self.assertTrue(runtime["stale_pid_reused"])


if __name__ == "__main__":
    unittest.main()
