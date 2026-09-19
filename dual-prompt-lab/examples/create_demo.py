"""Generate isolated synthetic fixtures. These are never author trading rules."""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from lab.compiler import build, example_output
from lab.materials import ingest
from lab.rules import STAGES
from lab.storage import init_workspace, read_json, require, write_json, write_text
from lab.validation import REVISIONS


def create_demo(base: Path) -> dict:
    require(not base.exists() or not any(base.iterdir()), "demo_directory_not_empty")
    work, materials = base / "workspace", base / "materials"
    init_workspace(work, synthetic=True)
    config = read_json(work / "config.json")
    config.update({"title": "合成协议测试", "symbols": ["DEMO_SYMBOL"], "timeframes": ["M5"], "max_analysis_validity_seconds": 60})
    write_json(work / "config.json", config, replace=True)
    statements = {f"{role}-{stage}": f"合成测试：{label}缺少明确依据时等待，不创造交易动作。"
                  for role, stages in STAGES.items() for stage, label in stages.items()}
    write_text(materials / "synthetic-notes.txt", "\n".join(statements.values()) + "\n")
    batch = ingest(work, materials)
    source_id = read_json(work / "imports" / f"{batch['batch_id']}.json")["files"][0]["source_id"]
    rules = []
    for role, stages in STAGES.items():
        for stage in stages:
            rule_id = f"{role}-{stage}"
            rules.append({"id": rule_id, "role": role, "stage": stage, "origin": "engineered_definition",
                          "statement": statements[rule_id], "conditions": ["仅适用于合成测试输入"],
                          "invalidation": ["真实市场输入不适用"], "required_inputs": ["market" if role == "analyst" else "analysis.result"],
                          "evidence": [{"source_id": source_id, "quote": statements[rule_id], "locator": "合成测试文本"}],
                          "conflicts": [], "review": {"status": "approved", "reviewer": "synthetic-test-only", "reviewed_at": "2026-01-01T00:00:00Z"}})
    write_json(work / "rules.json", {"schema_version": 1, "rules": rules}, replace=True)
    strategy = {"id": "synthetic-strategy", "versionId": "synthetic-v1", "promptHash": "0" * 64}
    analyst_input = {"kind": "analysis", "strategy": strategy, "market": {"symbol": "DEMO_SYMBOL", "dataGaps": ["合成缺失输入"]},
                     "macro": None, "capturedAt": "2026-01-01T00:00:00Z"}
    analyst_output = example_output("analyst")
    trader_input = {"kind": "trader", "strategy": strategy, "analysis": {"id": "synthetic-analysis", "result": analyst_output},
                    "account": {"id": "synthetic-account"}, "positions": [], "pendingOrders": [],
                    "quote": {"symbol": "DEMO_SYMBOL", "bid": "100", "ask": "101"},
                    "contract": {"symbol": "DEMO_SYMBOL"}, "risk": {"status": "unavailable"},
                    "capturedAt": "2026-01-01T00:00:00Z", "entryMethods": ["market"], **{key: 1 for key in REVISIONS}}
    cases = {"schema_version": 1, "mode": "synthetic", "split": "development", "cases": [
        {"id": "analyst-wait", "role": "analyst", "scenario": "证据缺失", "input": analyst_input, "expect": {"opportunity": "none"}},
        {"id": "trader-hold", "role": "trader", "scenario": "分析师交易员配对等待", "input": trader_input,
         "analysis_case_id": "analyst-wait", "expect": {"action": "hold", "actions": []}},
    ]}
    write_json(base / "cases.json", cases)
    write_json(base / "responses.json", {"analyst-wait": json.dumps(analyst_output, ensure_ascii=False),
                                        "trader-hold": json.dumps(example_output("trader"), ensure_ascii=False)})
    manifest = build(work, allow_synthetic=True)
    return {"work": str(work), "build": str(work / "builds" / manifest["build_id"]),
            "cases": str(base / "cases.json"), "responses": str(base / "responses.json"), "mode": "synthetic"}


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="生成隔离合成测试，不生成真实作者策略")
    parser.add_argument("--output", type=Path, required=True)
    print(json.dumps(create_demo(parser.parse_args().output), ensure_ascii=False, indent=2))
