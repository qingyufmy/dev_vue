# -*- coding: utf-8 -*-
import json
import os
import sys
import tempfile
import threading
import unittest


AI_DIR = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "public", "ai"))
if AI_DIR not in sys.path:
    sys.path.insert(0, AI_DIR)

from bridge_config_store import BridgeConfigStore, write_json_atomic


class BridgeConfigStoreTests(unittest.TestCase):
    def test_corrupt_json_is_quarantined_before_starting_clean(self):
        with tempfile.TemporaryDirectory() as root:
            path = os.path.join(root, "config.json")
            with open(path, "wb") as handle:
                handle.write(b'{"token":"incomplete"')
            store = BridgeConfigStore(path)
            self.assertEqual(store.load(), {})
            self.assertFalse(os.path.exists(path))
            backups = [name for name in os.listdir(root) if name.startswith("config.json.corrupt-")]
            self.assertEqual(len(backups), 1)
            with open(os.path.join(root, backups[0]), "rb") as handle:
                self.assertEqual(handle.read(), b'{"token":"incomplete"')

    def test_non_object_json_is_quarantined(self):
        with tempfile.TemporaryDirectory() as root:
            path = os.path.join(root, "config.json")
            with open(path, "w", encoding="utf-8") as handle:
                json.dump(["unexpected"], handle)
            self.assertEqual(BridgeConfigStore(path).load(), {})
            self.assertFalse(os.path.exists(path))

    def test_concurrent_updates_do_not_lose_fields_or_leave_temp_files(self):
        with tempfile.TemporaryDirectory() as root:
            path = os.path.join(root, "config.json")
            store = BridgeConfigStore(path)
            threads = [
                threading.Thread(target=store.update, args=({f"field_{index}": index},))
                for index in range(20)
            ]
            for thread in threads:
                thread.start()
            for thread in threads:
                thread.join()
            config = store.load()
            self.assertEqual({config[f"field_{index}"] for index in range(20)}, set(range(20)))
            self.assertEqual([name for name in os.listdir(root) if name.endswith(".tmp")], [])

    def test_atomic_writer_replaces_complete_json(self):
        with tempfile.TemporaryDirectory() as root:
            path = os.path.join(root, "runtime.json")
            write_json_atomic(path, {"generation": 1})
            write_json_atomic(path, {"generation": 2, "ready": True})
            with open(path, "r", encoding="utf-8") as handle:
                self.assertEqual(json.load(handle), {"generation": 2, "ready": True})


if __name__ == "__main__":
    unittest.main()
