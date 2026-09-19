from __future__ import annotations

import os
import shutil
import subprocess
import uuid
from pathlib import Path

from .compiler import REPO
from .storage import read_json, require, safe_child, workspace


def project_check(work: Path, report_path: Path) -> dict:
    root, _ = workspace(work)
    report = read_json(report_path)
    require(report.get("schema_version") == 1 and isinstance(report.get("results"), list), "evaluation_report_invalid")
    require(any(row.get("output") is not None for row in report["results"]), "no_model_outputs_to_check")
    node = shutil.which("node")
    runner = REPO / "node_modules/vitest/vitest.mjs"
    require(node is not None and runner.exists(), "project_test_runtime_unavailable")
    destination = safe_child(root, "project-checks", uuid.uuid4().hex + ".json")
    destination.parent.mkdir(parents=True, exist_ok=True)
    env = {**os.environ, "PROMPTLAB_PROJECT_REPORT": str(report_path.resolve()), "PROMPTLAB_PROJECT_CHECK": str(destination),
           "PYTHONIOENCODING": "utf-8"}
    result = subprocess.run([node, str(runner), "run", "--config", "dual-prompt-lab/vitest.config.ts"],
                            cwd=REPO, env=env, capture_output=True, timeout=90)
    require(destination.exists(), "project_contract_runner_failed")
    checked = read_json(destination)
    require(result.returncode == 0 or checked.get("failed", 0) > 0, "project_contract_runner_failed")
    return checked | {"report": str(destination)}
