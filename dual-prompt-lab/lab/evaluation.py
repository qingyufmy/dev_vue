from __future__ import annotations

import copy
import uuid
from pathlib import Path
from typing import Callable

from .compiler import FILENAMES, REPO, read_contracts, verify_build
from .model import invoke
from .storage import LabError, canonical, identifier, read_json, require, safe_child, sha, strict_json, utc_now, workspace, write_json
from .validation import validate_input, validate_output


def evaluate(work: Path, build_path: Path, cases_path: Path, *, live: bool = False,
             responses_path: Path | None = None, repeats: int = 1, repo: Path = REPO,
             caller: Callable = invoke) -> dict:
    require(live != (responses_path is not None), "choose_live_or_saved_responses")
    require(type(repeats) is int and 1 <= repeats <= 5, "repeat_count_invalid")
    root, config = workspace(work)
    manifest = verify_build(build_path)
    require(manifest["scope"]["mode"] == config["mode"], "build_workspace_mode_mismatch")
    require(manifest["contract_sha256"] == read_contracts(repo)[1], "project_contract_drift_rebuild_required")
    dataset = read_json(cases_path)
    require(isinstance(dataset, dict) and dataset.get("schema_version") == 1
            and dataset.get("mode") == config["mode"] and dataset.get("split") in ("development", "holdout"), "dataset_invalid")
    cases = dataset.get("cases")
    require(isinstance(cases, list) and 0 < len(cases) <= 100, "cases_empty_or_too_many")
    ids: set[str] = set()
    for case in cases:
        require(isinstance(case, dict), "case_invalid")
        case_id = identifier(case.get("id"))
        require(case_id not in ids, "case_id_duplicate")
        ids.add(case_id)
        require(case.get("role") in FILENAMES and isinstance(case.get("input"), dict), "case_role_or_input_invalid")
        require(isinstance(case.get("expect"), dict) and bool(case["expect"]), "case_expectation_required")
        require(isinstance(case.get("scenario"), str) and bool(case["scenario"].strip()), "case_scenario_required")
    responses = read_json(responses_path) if responses_path else None
    if responses is not None:
        require(isinstance(responses, dict) and set(responses) == ids and all(isinstance(v, str) for v in responses.values()),
                "responses_must_cover_cases")
        require(repeats == 1, "saved_response_repeats_not_meaningful")
    dataset_hash = sha(canonical(dataset))
    fingerprints = {sha(canonical({"role": case["role"], "input": case["input"]})) for case in cases}
    exposure_paths = [safe_child(root, "exposures", fingerprint + ".json") for fingerprint in sorted(fingerprints)]
    exposed = any(path.exists() for path in exposure_paths)
    run_id = uuid.uuid4().hex
    run_dir = safe_child(root, "evaluations", run_id)
    run_dir.mkdir(parents=True, exist_ok=False)
    write_json(run_dir / "cases.snapshot.json", dataset)
    # Register before evaluation, including failed runs, so failures cannot reset holdout exposure.
    for exposure_path in exposure_paths:
        if not exposure_path.exists():
            write_json(exposure_path, {"first_run_id": run_id, "build_id": manifest["build_id"], "first_exposed_at": utc_now()})
    results, prior = [], {}
    for repetition in range(repeats):
        prior = {}
        for case in cases:
            role, case_id = case["role"], case["id"]
            record = {"case_id": case_id, "role": role, "scenario": case["scenario"], "repetition": repetition + 1,
                      "status": "failed", "output": None, "error": None, "input_mode": "frozen"}
            raw = None
            snapshot = copy.deepcopy(case["input"])
            try:
                if "analysis_case_id" in case:
                    parent = prior.get(case["analysis_case_id"])
                    require(role == "trader" and parent is not None and parent["role"] == "analyst" and parent["status"] == "passed",
                            "paired_analysis_unavailable")
                    snapshot["analysis"] = {"id": "evaluation-" + case["analysis_case_id"],
                                            "contentHash": sha(canonical(parent["output"])), "result": parent["output"]}
                    record["input_mode"] = "paired_counterfactual"
                    # Existing event catalogues identify the original analysis, never the newly generated one.
                    require(not snapshot.get("marketEntryEvents"), "paired_event_catalogue_requires_rebuild")
                validate_input(role, snapshot)
                # Historical identity must not pretend the newly compiled prompt was originally used.
                record["original_strategy"] = copy.deepcopy(snapshot["strategy"])
                snapshot["strategy"] = {"id": snapshot["strategy"].get("id"), "versionId": manifest["build_id"],
                                        "promptHash": manifest["files"][FILENAMES[role]]}
                record["effective_input"] = snapshot
                record["input_sha256"] = sha(canonical(snapshot))
                prompt = (build_path / FILENAMES[role]).read_text(encoding="utf-8")
                raw = caller(config["model"], prompt, snapshot, run_dir / f"{case_id}.{repetition + 1}.request.json") if live else responses[case_id]
                output = validate_output(role, raw, snapshot, manifest["scope"]["max_analysis_validity_seconds"])
                record["output"] = output
                for path, expected in case["expect"].items():
                    require(isinstance(path, str) and all(part for part in path.split(".")), "expectation_path_invalid")
                    observed = output
                    for part in path.split("."):
                        require(isinstance(observed, dict) and part in observed, "expectation_path_missing", path)
                        observed = observed[part]
                    require(observed == expected, "expectation_mismatch", path)
                record["status"] = "passed"
            except LabError as error:
                record["error"] = error.code
                record["error_detail"] = error.detail
            except (KeyError, TypeError, ValueError, AttributeError):
                record["error"] = "document_shape_invalid"
            record["raw_output"] = raw
            record["original_input_sha256"] = sha(canonical(case["input"]))
            results.append(record)
            prior[case_id] = record
            write_json(run_dir / f"{case_id}.{repetition + 1}.result.json", record)
    variability = {case["id"]: len({sha(canonical(row["output"])) for row in results if row["case_id"] == case["id"] and row["output"] is not None})
                   for case in cases}
    requests_recorded = len(list(run_dir.glob("*.request.json")))
    report = {"schema_version": 1, "run_id": run_id, "build_id": manifest["build_id"], "created_at": utc_now(),
              "mode": config["mode"], "transport": "live_model" if live else "saved_responses",
              "model_validation": "tested_on_declared_cases" if live and requests_recorded == len(results) and all(r["status"] == "passed" for r in results)
                  else "attempted_not_passed" if requests_recorded else "not_tested",
              "model_requests_recorded": requests_recorded,
              "dataset_sha256": dataset_hash, "split": "exposed_regression" if exposed else dataset["split"],
              "split_evidence": "local_input_exposure_ledger_only",
              "total": len(results), "passed": sum(r["status"] == "passed" for r in results),
              "failed": sum(r["status"] == "failed" for r in results), "unique_outputs_per_case": variability,
              "method_fidelity": "requires_human_review", "profitability": "not_tested",
              "project_runtime_validation": "not_tested", "execution_authorized": False,
              "results": results}
    write_json(run_dir / "report.json", report)
    return {key: value for key, value in report.items() if key != "results"} | {"report": str(run_dir / "report.json")}
