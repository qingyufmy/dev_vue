import base64
import json
import os
import sys
import tempfile
import unittest


AI_DIR = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "public", "ai"))
if AI_DIR not in sys.path:
    sys.path.insert(0, AI_DIR)

from bridge_profile_runtime import migrate_profile_config_secrets, register_bridge_profile, write_profile_config
from bridge_secret_store import config_for_storage, config_from_storage, protect_secret, unprotect_secret


class BridgeSecretStoreTests(unittest.TestCase):
    def test_dpapi_round_trip_is_bound_and_not_plaintext(self):
        protected = protect_secret("local-secret-123")
        self.assertTrue(protected.startswith("dpapi:v1:"))
        self.assertNotIn("local-secret-123", protected)
        self.assertEqual(unprotect_secret(protected), "local-secret-123")

    def test_legacy_xor_password_is_migrated(self):
        password = "legacy-password-123"
        key = b"AURUM_BRIDGE_v2"
        encoded = base64.b64encode(bytes(
            byte ^ key[index % len(key)]
            for index, byte in enumerate(password.encode("utf-8"))
        )).decode("ascii")
        config, migration_needed = config_from_storage({
            "token": "legacy-jwt",
            "refresh_token": "legacy-refresh",
            "saved_password": encoded,
        })
        self.assertTrue(migration_needed)
        self.assertEqual(config["saved_password"], password)
        stored = config_for_storage(config)
        self.assertEqual(stored["secrets_version"], 1)
        self.assertTrue(all(stored[field].startswith("dpapi:v1:") for field in (
            "token", "refresh_token", "saved_password",
        )))

    def test_named_profile_writer_never_serializes_plaintext_secrets(self):
        with tempfile.TemporaryDirectory() as root:
            path = write_profile_config(root, "source-a", {
                "email": "source@example.com",
                "token": "access-token-value",
                "refresh_token": "refresh-token-value",
                "saved_password": "password-value",
            })
            with open(path, "r", encoding="utf-8") as handle:
                stored_text = handle.read()
            self.assertNotIn("access-token-value", stored_text)
            self.assertNotIn("refresh-token-value", stored_text)
            self.assertNotIn("password-value", stored_text)
            stored = json.loads(stored_text)
            self.assertEqual(stored["secrets_version"], 1)

    def test_startup_migrates_existing_named_profiles(self):
        with tempfile.TemporaryDirectory() as root:
            register_bridge_profile(root, "source-a", "Source A")
            path = os.path.join(root, "profiles", "source-a", "config.json")
            with open(path, "w", encoding="utf-8") as handle:
                json.dump({
                    "token": "legacy-access-token",
                    "refresh_token": "legacy-refresh-token",
                    "saved_password": "plain-password",
                    "secrets_version": 1,
                }, handle)
            self.assertEqual(migrate_profile_config_secrets(root), {
                "migrated": ["source-a"], "failed": [],
            })
            with open(path, "r", encoding="utf-8") as handle:
                stored_text = handle.read()
            self.assertNotIn("legacy-access-token", stored_text)
            self.assertNotIn("legacy-refresh-token", stored_text)
            self.assertNotIn("plain-password", stored_text)

    def test_one_corrupt_profile_does_not_block_other_profile_migrations(self):
        with tempfile.TemporaryDirectory() as root:
            register_bridge_profile(root, "broken", "Broken")
            register_bridge_profile(root, "healthy", "Healthy")
            broken_path = os.path.join(root, "profiles", "broken", "config.json")
            healthy_path = os.path.join(root, "profiles", "healthy", "config.json")
            with open(broken_path, "w", encoding="utf-8") as handle:
                json.dump({"token": "dpapi:v1:not-valid", "secrets_version": 1}, handle)
            with open(healthy_path, "w", encoding="utf-8") as handle:
                json.dump({"token": "legacy-token", "secrets_version": 1}, handle)

            report = migrate_profile_config_secrets(root)

            self.assertEqual(report["migrated"], ["healthy"])
            self.assertEqual([item["slug"] for item in report["failed"]], ["broken"])
            with open(healthy_path, "r", encoding="utf-8") as handle:
                healthy_text = handle.read()
            self.assertNotIn("legacy-token", healthy_text)

    def test_invalid_secret_version_is_repaired_instead_of_hiding_the_profile(self):
        config, migration_needed = config_from_storage({
            "email": "source@example.com",
            "token": "legacy-access-token",
            "secrets_version": "invalid",
        })
        self.assertTrue(migration_needed)
        self.assertEqual(config["email"], "source@example.com")
        stored = config_for_storage(config)
        self.assertEqual(stored["secrets_version"], 1)
        self.assertTrue(stored["token"].startswith("dpapi:v1:"))


if __name__ == "__main__":
    unittest.main()
