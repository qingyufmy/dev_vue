from __future__ import annotations

import copy
import json
import os
import subprocess
import sys
import tempfile
import unittest
import urllib.error
from pathlib import Path
from unittest.mock import patch

from examples.create_demo import create_demo
from lab.compiler import build, compare, read_contracts, verify_build
from lab.evaluation import evaluate
from lab.extraction import extract
from lab.materials import ingest, read_source
from lab.model import invoke
from lab.storage import LabError, file_sha, init_workspace, read_json, safe_child, strict_json, write_json, write_text
from lab.validation import validate_output


class LabTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.base = Path(self.temp.name)
        self.demo = create_demo(self.base / "demo")
        self.work = Path(self.demo["work"])
        self.build = Path(self.demo["build"])
        self.dataset = read_json(Path(self.demo["cases"]))
        self.responses = read_json(Path(self.demo["responses"]))

    def tearDown(self):
        self.temp.cleanup()

    def error(self, code, function, *args, **kwargs):
        with self.assertRaises(LabError) as captured:
            function(*args, **kwargs)
        self.assertEqual(captured.exception.code, code)

    def rules(self):
        return read_json(self.work / "rules.json")

    def save_rules(self, value):
        write_json(self.work / "rules.json", value, replace=True)

    def test_ingest_is_read_only_and_deduplicated(self):
        source = self.base / "more"
        write_text(source / "one.txt", "同一个观点")
        write_text(source / "two.srt", "同一个观点")
        before = file_sha(source / "one.txt")
        first = ingest(self.work, source)
        second = ingest(self.work, source)
        self.assertEqual(first, second)
        self.assertEqual(first["unique_sources"], 1)
        self.assertEqual(file_sha(source / "one.txt"), before)

    def test_video_and_unknown_encoding_are_reported(self):
        source = self.base / "binary"
        source.mkdir()
        (source / "video.mp4").write_bytes(b"fake-video")
        (source / "bad.txt").write_bytes(b"\xff\xfe\x81")
        result = ingest(self.work, source)
        self.assertEqual({item["status"] for item in result["pending_files"]}, {"needs_text", "encoding_unknown"})

    def test_source_workspace_overlap_is_rejected(self):
        self.error("source_workspace_overlap", ingest, self.work, self.work)

    def test_workspace_traversal_is_rejected(self):
        self.error("path_outside_workspace", safe_child, self.work, "..", "escaped")

    def test_source_revision_preserves_previous_record(self):
        source = self.base / "revision.txt"
        write_text(source, "原始表述")
        first = ingest(self.work, source)
        first_id = read_json(self.work / "imports" / f"{first['batch_id']}.json")["files"][0]["source_id"]
        write_text(source, "修订表述", replace=True)
        second = ingest(self.work, source)
        self.assertNotEqual(first["batch_id"], second["batch_id"])
        self.assertEqual(read_source(self.work, first_id)["text"], "原始表述")

    def test_init_never_overwrites_existing_material(self):
        self.error("workspace_not_empty", init_workspace, self.work)

    def test_empty_real_rules_do_not_generate_fake_prompts(self):
        path = self.base / "real"
        init_workspace(path)
        config = read_json(path / "config.json")
        config.update({"symbols": ["DEMO"], "timeframes": ["M5"], "max_analysis_validity_seconds": 60})
        write_json(path / "config.json", config, replace=True)
        self.error("rules_empty_or_too_many", build, path)
        self.assertFalse((path / "builds").exists())

    def test_synthetic_build_requires_explicit_flag(self):
        self.error("synthetic_build_requires_flag", build, self.work)

    def test_review_and_coverage_gate(self):
        rules = self.rules()
        rules["rules"][0]["review"] = {"status": "pending"}
        self.save_rules(rules)
        self.error("rule_coverage_incomplete", build, self.work, allow_synthetic=True)

    def test_bad_quote_is_not_evidence(self):
        rules = self.rules()
        rules["rules"][0]["evidence"][0]["quote"] = "作者没有说过这个"
        self.save_rules(rules)
        self.error("evidence_quote_not_found", build, self.work, allow_synthetic=True)

    def test_system_feedback_cannot_become_author_evidence(self):
        batch = ingest(self.work, self.base / "demo" / "materials", "system")
        source_id = read_json(self.work / "imports" / f"{batch['batch_id']}.json")["files"][0]["source_id"]
        rules = self.rules()
        rules["rules"][0]["origin"] = "explicit_statement"
        rules["rules"][0]["evidence"][0]["source_id"] = source_id
        self.save_rules(rules)
        self.error("system_feedback_is_not_author_evidence", build, self.work, allow_synthetic=True)

    def test_rule_conflicts_cannot_build(self):
        rules = self.rules()
        rules["rules"][0]["conflicts"] = ["尚未解释的矛盾"]
        self.save_rules(rules)
        self.error("rule_conflict_unresolved", build, self.work, allow_synthetic=True)

    def test_extraction_forces_pending_review_and_preserves_existing_rules(self):
        batch = ingest(self.work, self.base / "demo" / "materials")
        original = self.rules()
        before = file_sha(self.work / "rules.json")
        with patch("lab.extraction.invoke", return_value=json.dumps(original)):
            result = extract(self.work, batch["batch_id"], live=True)
        candidate = read_json(Path(result["file"]))
        self.assertTrue(all(rule["review"] == {"status": "pending"} for rule in candidate["rules"]))
        self.assertEqual(file_sha(self.work / "rules.json"), before)

    def test_extraction_never_sends_without_live_flag(self):
        with patch("lab.extraction.invoke") as call:
            self.error("live_flag_required", extract, self.work, "unused")
            call.assert_not_called()

    def test_prompt_external_dependency_cannot_build(self):
        rules = self.rules()
        rules["rules"][0]["statement"] = "请读取本地视频再决定"
        self.save_rules(rules)
        self.error("prompt_unresolved_dependency", build, self.work, allow_synthetic=True)

    def test_builds_are_repeatable_and_old_versions_unchanged(self):
        before = verify_build(self.build)
        self.assertEqual(build(self.work, allow_synthetic=True), before)
        rules = self.rules()
        rules["rules"][0]["statement"] += " 无依据时不得改写结论。"
        self.save_rules(rules)
        after = build(self.work, allow_synthetic=True)
        self.assertNotEqual(before["build_id"], after["build_id"])
        self.assertEqual(verify_build(self.build), before)
        diff = compare(self.build, self.work / "builds" / after["build_id"])
        self.assertEqual(diff["changed"], ["analyst-context"])
        self.assertEqual(diff["prompts_changed"], ["analyst"])

    def test_build_tampering_is_detected(self):
        write_text(self.build / "01-analyst-prompt.md", "changed", replace=True)
        self.error("build_checksum_mismatch", verify_build, self.build)

    def test_duplicate_json_keys_and_nonfinite_numbers_rejected(self):
        for raw, code in [(' {"action":"hold","action":"market_order"}', "json_duplicate_key"),
                          ('{"n":NaN}', "json_non_finite_number"), ('{"n":1e999}', "json_non_finite_number"),
                          ('{"ticket":9007199254740993}', "json_unsafe_integer_use_string"), ('```json\n{}\n```', "json_invalid")]:
            with self.subTest(raw=raw):
                self.error(code, strict_json, raw)

    def validate(self, role, output, snapshot=None):
        index = 0 if role == "analyst" else 1
        return validate_output(role, json.dumps(output), snapshot or self.dataset["cases"][index]["input"], 60)

    def test_output_examples_validate(self):
        for role, case_id in (("analyst", "analyst-wait"), ("trader", "trader-hold")):
            self.validate(role, json.loads(self.responses[case_id]))

    def test_future_evidence_and_expired_analysis_rejected(self):
        snapshot = copy.deepcopy(self.dataset["cases"][0]["input"])
        snapshot["market"]["confirmedAt"] = "2026-01-02T00:00:00Z"
        self.error("future_evidence_forbidden", self.validate, "analyst", json.loads(self.responses["analyst-wait"]), snapshot)
        result = json.loads(self.responses["analyst-wait"])
        result["validUntil"] = "2026-01-01T00:02:00Z"
        self.error("analysis_validity_invalid", self.validate, "analyst", result)

    def trader_action(self, kind="close_position", parameters=None):
        snapshot = copy.deepcopy(self.dataset["cases"][1]["input"])
        snapshot["positions"] = [{"ticket": "123", "symbol": "DEMO_SYMBOL"}]
        result = json.loads(self.responses["trader-hold"])
        result.update({"action": kind, "actions": [{"actionId": "action-1", "kind": kind,
            "parameters": parameters or {"ticket": "123"}, "expectedState": {key: snapshot[key] for key in snapshot if key.endswith("Revision")}}]})
        return snapshot, result

    def test_account_target_and_revision_cannot_be_forged(self):
        snapshot, result = self.trader_action()
        self.validate("trader", result, snapshot)
        result["actions"][0]["parameters"]["ticket"] = "reference-id"
        self.error("target_not_in_account", self.validate, "trader", result, snapshot)
        result["actions"][0]["parameters"]["ticket"] = "123"
        result["actions"][0]["expectedState"]["positionsRevision"] = 9
        self.error("expected_state_mismatch", self.validate, "trader", result, snapshot)

    def test_partial_close_conflict_and_after_close_rules(self):
        snapshot, result = self.trader_action(parameters={"ticket": "123", "close_percent": "50", "volume": None})
        self.error("decimal_string_required", self.validate, "trader", result, snapshot)
        del result["actions"][0]["parameters"]["volume"]
        result["actions"][0]["parameters"]["after_close_protection"] = {"stop_loss": "90"}
        self.validate("trader", result, snapshot)
        result["actions"][0]["parameters"]["close_percent"] = "100"
        self.error("partial_close_percent_invalid", self.validate, "trader", result, snapshot)

    def test_hold_cannot_hide_actions(self):
        snapshot, result = self.trader_action()
        result["action"] = "hold"
        self.error("hold_actions_forbidden", self.validate, "trader", result, snapshot)

    def opening(self):
        snapshot, result = self.trader_action("market_order", {"symbol": "DEMO_SYMBOL", "side": "buy", "position_size_tier": "light", "stop_loss": "90"})
        snapshot["analysis"]["result"]["opportunity"] = "long_setup"
        snapshot["risk"] = {"status": "ready"}
        result["side"] = "buy"
        return snapshot, result

    def test_opening_expiry_risk_and_size_mode(self):
        snapshot, result = self.opening()
        self.validate("trader", result, snapshot)
        result["actions"][0]["parameters"]["volume"] = "1"
        self.error("position_size_mode_conflict", self.validate, "trader", result, snapshot)
        del result["actions"][0]["parameters"]["volume"]
        snapshot["risk"]["status"] = "unavailable"
        self.error("entry_risk_unavailable", self.validate, "trader", result, snapshot)
        snapshot["risk"]["status"] = "ready"
        snapshot["capturedAt"] = "2026-01-01T00:01:00Z"
        self.error("analysis_expired", self.validate, "trader", result, snapshot)

    def test_exact_event_and_usage_are_required_for_opening(self):
        snapshot, result = self.opening()
        event_id = "event:" + "a" * 64
        result["actions"][0]["parameters"]["entry_event_id"] = event_id
        snapshot["entryEventPolicy"] = {"version": 1, "mode": "required", "timeframe": "M5"}
        snapshot["marketEntryEvents"] = {"analysisId": snapshot["analysis"]["id"], "sourceAccountId": "source",
            "timeframes": {"M5": {"timeframe": "M5", "sourceAccountId": "source", "symbol": "DEMO_SYMBOL", "state": "ready",
                "events": [{"id": event_id, "direction": "up", "stillValid": True, "confirmedAt": "2026-01-01T00:00:00Z"}]}}}
        snapshot["entryEventUsage"] = {"state": "read", "accountId": snapshot["account"]["id"], "strategyId": snapshot["strategy"]["id"],
                                        "items": [{"eventId": event_id, "state": "available"}]}
        self.validate("trader", result, snapshot)
        snapshot["entryEventUsage"]["items"][0]["state"] = "consumed"
        self.error("entry_event_not_available", self.validate, "trader", result, snapshot)

    def test_structurally_invalid_response_is_recorded_without_aborting_run(self):
        invalid = json.loads(self.responses["trader-hold"])
        invalid["action"] = ["hold"]
        write_json(Path(self.demo["responses"]), self.responses | {"trader-hold": json.dumps(invalid)}, replace=True)
        report = evaluate(self.work, self.build, Path(self.demo["cases"]), responses_path=Path(self.demo["responses"]))
        self.assertEqual((report["passed"], report["failed"]), (1, 1))

    def test_evaluation_offline_pair_and_exposure_ledger(self):
        report = evaluate(self.work, self.build, Path(self.demo["cases"]), responses_path=Path(self.demo["responses"]))
        self.assertEqual((report["passed"], report["failed"], report["model_validation"]), (2, 0, "not_tested"))
        self.assertFalse(report["execution_authorized"])
        saved = read_json(Path(report["report"]))
        self.assertEqual(saved["results"][1]["input_mode"], "paired_counterfactual")
        self.dataset["split"] = "holdout"
        write_json(Path(self.demo["cases"]), self.dataset, replace=True)
        again = evaluate(self.work, self.build, Path(self.demo["cases"]), responses_path=Path(self.demo["responses"]))
        self.assertEqual(again["split"], "exposed_regression")

    def test_failed_model_outputs_are_saved_and_do_not_fake_success(self):
        responses = self.responses | {"analyst-wait": "not JSON"}
        write_json(Path(self.demo["responses"]), responses, replace=True)
        report = evaluate(self.work, self.build, Path(self.demo["cases"]), responses_path=Path(self.demo["responses"]))
        self.assertEqual(report["failed"], 2)
        saved = read_json(Path(report["report"]))
        self.assertEqual(saved["results"][0]["raw_output"], "not JSON")
        self.assertEqual(saved["results"][1]["error"], "paired_analysis_unavailable")

    def test_missing_key_is_not_model_tested(self):
        config = read_json(self.work / "config.json")
        config["model"].update({"endpoint": "https://example.invalid/chat/completions", "name": "explicit-test-model"})
        write_json(self.work / "config.json", config, replace=True)
        with patch.dict(os.environ, {}, clear=True):
            report = evaluate(self.work, self.build, Path(self.demo["cases"]), live=True)
        self.assertEqual(report["model_validation"], "not_tested")
        self.assertEqual(report["failed"], 2)

    def test_contract_source_drift_is_detected(self):
        fake_repo = self.base / "repository"
        write_text(fake_repo / "server/src/modules/inference/domain/model-context-contract.ts",
                   "export const analysisContract = `changed`\nexport const traderContract = `changed`\n")
        self.error("project_contract_drift_rebuild_required", evaluate, self.work, self.build, Path(self.demo["cases"]),
                   responses_path=Path(self.demo["responses"]), repo=fake_repo)

    def test_model_transport_keeps_raw_response_and_never_logs_key(self):
        class Response:
            def __enter__(self): return self
            def __exit__(self, *args): return False
            def read(self, limit):
                return json.dumps({"model": "returned-model", "choices": [{"finish_reason": "stop", "message": {"content": "{\"ok\":true}"}}]}).encode()

        profile = {"endpoint": "https://example.invalid/chat/completions", "name": "requested-model", "api_key_env": "TEST_API_KEY"}
        record = self.base / "request.json"
        with patch.dict(os.environ, {"TEST_API_KEY": "test-secret"}), patch("urllib.request.OpenerDirector.open", return_value=Response()) as request:
            self.assertEqual(invoke(profile, "return JSON", {}, record), '{"ok":true}')
            body = json.loads(request.call_args.args[0].data)
            self.assertEqual([m["role"] for m in body["messages"]], ["system", "user"])
        self.assertNotIn("test-secret", record.read_text())
        self.assertEqual(read_json(record)["returned_model"], "returned-model")

    def test_model_truncation_is_saved_but_not_accepted(self):
        class Response:
            def __enter__(self): return self
            def __exit__(self, *args): return False
            def read(self, limit):
                return json.dumps({"choices": [{"finish_reason": "length", "message": {"content": "{}"}}]}).encode()
        profile = {"endpoint": "https://example.invalid/chat/completions", "name": "test", "api_key_env": "TEST_API_KEY"}
        record = self.base / "truncated.json"
        with patch.dict(os.environ, {"TEST_API_KEY": "secret"}), patch("urllib.request.OpenerDirector.open", return_value=Response()):
            self.error("model_incomplete_output", invoke, profile, "JSON", {}, record)
        self.assertIn('"length"', read_json(record)["raw_response"])
        self.assertEqual(read_json(record)["status"], "failed")

    def test_cli_exit_code_is_nonzero_for_failed_evaluation(self):
        responses = self.responses | {"analyst-wait": ""}
        write_json(Path(self.demo["responses"]), responses, replace=True)
        run = subprocess.run([sys.executable, str(Path(__file__).resolve().parents[1] / "promptlab.py"), "--work", str(self.work),
                              "evaluate", "--build", str(self.build), "--cases", self.demo["cases"], "--responses", self.demo["responses"]],
                             capture_output=True)
        self.assertEqual(run.returncode, 1)
        self.assertIn(b'"failed": 2', run.stdout)


if __name__ == "__main__":
    unittest.main()
