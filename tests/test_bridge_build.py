# -*- coding: utf-8 -*-
import importlib.util
import os
import sys
import unittest


ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
BUILD_SCRIPT = os.path.join(ROOT, "public", "ai", "build_nuitka.py")
spec = importlib.util.spec_from_file_location("bridge_build", BUILD_SCRIPT)
bridge_build = importlib.util.module_from_spec(spec)
spec.loader.exec_module(bridge_build)


class BridgeBuildTests(unittest.TestCase):
    def test_context_requires_one_matching_version(self):
        context = bridge_build.build_context(ROOT)
        self.assertEqual(context["version"], "v2.4.8")
        self.assertEqual(context["numeric_version"], "2.4.8")

    def test_nuitka_command_contains_runtime_dependencies_and_security_exclusions(self):
        context = bridge_build.build_context(ROOT)
        command = bridge_build.nuitka_command(context, python_executable="python-test")
        text = " ".join(command)
        self.assertEqual(command[:3], ["python-test", "-m", "nuitka"])
        for package in ("PySide6", "MetaTrader5", "numpy", "websockets", "certifi"):
            self.assertIn(f"--include-package={package}", command)
        self.assertIn("PySide6.QtWebEngine*", text)
        self.assertIn("--windows-console-mode=disable", command)
        self.assertTrue(command[-1].endswith("aurum_bridge_gui.py"))

    def test_installer_is_generated_from_current_paths_and_keeps_upgrade_identity(self):
        context = bridge_build.build_context(ROOT)
        script = bridge_build.render_installer_script(context, context["nuitka_output"] / "bridge.dist")
        self.assertIn('#define MyAppVersion "2.4.8"', script)
        self.assertIn("AppId={{AURUM-Bridge-2.3.0}", script)
        self.assertIn("OutputBaseFilename=AURUM_Bridge_Setup", script)
        self.assertNotIn("2.3.9", script)
        self.assertNotIn("[UninstallDelete]", script)
        self.assertEqual(script.count('Source: "{#SourceDir}\\*"'), 1)


if __name__ == "__main__":
    unittest.main()
