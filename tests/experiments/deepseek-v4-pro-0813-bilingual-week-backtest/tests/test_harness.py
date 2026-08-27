"""Offline contract tests for the isolated bilingual experiment.

The tests use only small in-memory fixtures.  They do not initialize a
terminal, open a network connection, or require the provider key.
"""

from __future__ import annotations

import json
import sys
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace

SCRIPT_ROOT = Path(__file__).resolve().parents[1] / "scripts"
sys.path.insert(0, str(SCRIPT_ROOT))

from build_report import build_report, formal_record_binding  # noqa: E402
from common import (  # noqa: E402
    CHAN_POLICY_VERSION,
    bar_close_ms,
    bar_open_ms,
    natural_language_adherence,
    normalize_data_plan,
    parse_json_object_strict,
    sha256_bytes,
    simulate_outcome,
    structural_contract_eligibility,
    structural_contract_passed,
    validate_signal_output,
    validate_translation,
    write_json,
)
from fetch_mt5_data import (  # noqa: E402
    calibrate_broker_offset,
    normalise_and_filter_rates,
    resolve_unique_symbol,
    utc_datetime_for_mt5,
)
from run_experiment import (  # noqa: E402
    ExperimentError,
    _cached_translation_source_binding,
    _mask_translation_tokens,
    _strategy_chunks,
    _unmask_translation_tokens,
    build_formal_messages,
    decision_points,
    normalize_base_url,
)


class FakeTerminal:
    TIMEFRAME_M1 = 1

    def __init__(self, symbols=None, ticks=None):
        self._symbols = [SimpleNamespace(name=value) for value in (symbols or [])]
        self._ticks = list(ticks or [])

    def symbols_get(self):
        return self._symbols

    def symbol_info_tick(self, _symbol):
        return self._ticks.pop(0)


def _rate(raw_time: int, *, open_price=100, high=101, low=99, close=100):
    return {
        "time": raw_time,
        "open": open_price,
        "high": high,
        "low": low,
        "close": close,
        "tick_volume": 1,
        "spread": 2,
    }


def _hold_output():
    return {
        "signal_type": "hold",
        "entry_method": "observe",
        "confidence": 0.7,
        "position_size_tier": "observe",
        "position_size_reason": "证据不足，保持观望",
        "position_action": "observe",
        "pending_action": "none",
        "pending_action_reason": "",
        "management_direction": "none",
        "hard_gate_status": "fail",
        "hard_gate_failures": ["trend_unclear"],
        "minimum_reward_to_risk": None,
        "recommended_reward_to_risk": None,
        "reward_to_risk_status": "not_applicable",
        "recommended_take_profit_tier": None,
        "decision_summary": "当前观望",
        "trigger_condition": "等待确认",
        "invalidation_condition": "重新评估",
        "key_reasons": ["结构证据不足"],
        "risk_factors": ["波动不确定"],
        "analysis": "当前行情证据不足。",
        "reasoning": "策略门槛未满足。",
        "experience_usage": {
            "considered_refs": [], "used_refs": [], "rejected_refs": [],
            "considered_ids": [], "used_ids": [], "rejected_ids": [], "influence": "",
        },
    }


def _trade_output(signal_type="buy", entry_method="market", **prices):
    output = _hold_output()
    anchor = (
        prices.get("stop_limit_price")
        if entry_method == "stop_limit"
        else prices.get("limit_price")
        if entry_method != "market"
        else 100
    )
    stop_loss = prices.get("stop_loss_price", 90)
    take_profit = prices.get("take_profit_1_price", 130)
    risk = abs(anchor - stop_loss) if anchor is not None else 0
    reward = abs(take_profit - anchor) if anchor is not None else 0
    recommended_reward_to_risk = reward / risk if risk else 3.0
    output.update({
        "signal_type": signal_type,
        "entry_method": entry_method,
        "confidence": 0.8,
        "position_size_tier": "probe",
        "position_size_reason": "结构满足，使用试探仓",
        "position_action": "open",
        "hard_gate_status": "pass",
        "hard_gate_failures": [],
        "minimum_reward_to_risk": 1.0,
        "recommended_reward_to_risk": prices.get("recommended_reward_to_risk", recommended_reward_to_risk),
        "reward_to_risk_status": "pass",
        "recommended_take_profit_tier": 1,
        "decision_summary": "执行测试信号",
        "trigger_condition": "测试触发",
        "invalidation_condition": "测试失效",
        "key_reasons": ["测试理由"],
        "risk_factors": ["测试风险"],
        "analysis": "测试行情分析。",
        "reasoning": "测试推理。",
        "experience_usage": {
            "considered_refs": [], "used_refs": [], "rejected_refs": [],
            "considered_ids": [], "used_ids": [], "rejected_ids": [], "influence": "",
        },
        "stop_loss_price": prices.get("stop_loss_price", 90),
        "take_profit_1_price": prices.get("take_profit_1_price", 130),
        "take_profit_2_price": prices.get("take_profit_2_price", 135),
        "take_profit_3_price": prices.get("take_profit_3_price", 140),
        "limit_price": prices.get("limit_price"),
        "stop_limit_price": prices.get("stop_limit_price"),
    })
    return output


def _m1_bars(decision_ms, count=12 * 60, missing_indices=()):
    return [
        {
            "time_utc_msc": decision_ms + index * 60_000,
            "open": 100,
            "high": 101,
            "low": 99,
            "close": 100,
        }
        for index in range(count)
        if index not in set(missing_indices)
    ]


class HarnessTests(unittest.TestCase):
    def test_strategy_translation_chunks_preserve_source(self):
        source = "# 标题\n\n第一段 M1 34。\n\n第二段 H1 1.5。"
        chunks = _strategy_chunks(source, max_chars=18)
        self.assertGreater(len(chunks), 1)
        self.assertEqual("\n".join(chunks), source)
        self.assertTrue(all(len(chunk) <= 18 or "\n" not in chunk for chunk in chunks))

    def test_translation_protected_token_mask_round_trip(self):
        source = "中文M5结构，使用 strategy_context.indicators.ema34，RR 1.5，输出 hold。"
        masked, replacements = _mask_translation_tokens(source)
        self.assertNotIn("M5", masked)
        self.assertNotIn("1.5", masked)
        self.assertEqual(_unmask_translation_tokens(masked, replacements), source)

    def test_cached_translation_is_bound_to_current_chinese_source(self):
        strategy_zh = "# 标题\n\n使用 M1。"
        strategy_en = "# Title\n\nUse M1."
        schema_zh = {"analysis": "简体中文，使用 M1。"}
        schema_en = {"analysis": "Simplified Chinese, use M1."}
        chunks = _strategy_chunks(strategy_zh)
        self.assertEqual(len(chunks), 1)
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            chunk_root = root / "translation-chunks"
            write_json(chunk_root / "strategy-01-of-01.json", {
                "source_sha256": sha256_bytes(strategy_zh),
                "translation": strategy_en,
            })
            schema_source = json.dumps(schema_zh, ensure_ascii=False, separators=(",", ":"))
            write_json(chunk_root / "schema.json", {
                "source_sha256": sha256_bytes(schema_source),
                "schema_en": schema_en,
            })
            binding = _cached_translation_source_binding(
                source_root=root,
                strategy_zh=strategy_zh,
                strategy_en=strategy_en,
                schema_zh=schema_zh,
                schema_en=schema_en,
            )
            self.assertTrue(binding["source_binding_verified"])
            with self.assertRaisesRegex(ExperimentError, "source_mismatch"):
                _cached_translation_source_binding(
                    source_root=root,
                    strategy_zh=strategy_zh + " 新措辞",
                    strategy_en=strategy_en,
                    schema_zh=schema_zh,
                    schema_en=schema_en,
                )

    def test_base_url_rejects_persistable_credentials_or_query(self):
        self.assertEqual(normalize_base_url("https://example.invalid/v1/"), "https://example.invalid/v1")
        for value in ("http://example.invalid/v1", "https://user:pass@example.invalid/v1", "https://example.invalid/v1?key=secret"):
            with self.subTest(value=value), self.assertRaises(ExperimentError):
                normalize_base_url(value)

    def test_symbol_ambiguity_fails_closed(self):
        terminal = FakeTerminal(symbols=["XAUUSD.s", "XAUUSDm"])
        with self.assertRaisesRegex(RuntimeError, "symbol_ambiguous"):
            resolve_unique_symbol(terminal, "XAUUSD")

    def test_server_epoch_offset_and_closed_filter(self):
        # Broker raw epoch is UTC+3.  The second bar is still forming.
        actual_open = 1_700_000_000
        offset = 10_800
        asof = (actual_open + 60 + 1) * 1000
        rows = normalise_and_filter_rates(
            [_rate(actual_open + offset), _rate(actual_open + 60 + offset)],
            timeframe="M1",
            broker_offset_seconds=offset,
            asof_utc_msc=asof,
        )
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0]["time_utc_msc"], actual_open * 1000)
        self.assertEqual(rows[0]["time_server_msc"], (actual_open + offset) * 1000)
        boundary = utc_datetime_for_mt5(actual_open * 1000, offset)
        self.assertEqual(int(boundary.timestamp()), actual_open + offset)

    def test_advancing_tick_calibrates_plus_three_hours(self):
        now = 1_700_000_000.0
        terminal = FakeTerminal(ticks=[
            SimpleNamespace(time_msc=int((now + 10_800) * 1000)),
            SimpleNamespace(time_msc=int((now + 10_801) * 1000)),
        ])
        result = calibrate_broker_offset(
            terminal,
            "XAUUSD.s",
            wait_seconds=0,
            now_fn=lambda: now,
            monotonic_fn=lambda: 0,
            sleep_fn=lambda _seconds: None,
        )
        self.assertEqual(result["broker_offset_seconds"], 10_800)
        self.assertTrue(result["raw_time_advanced"])

    def test_translation_invariants(self):
        schema_zh = {
            "signal_type": "仅允许 buy | sell | hold，周期 M15，参数 34。",
            "key_reasons": ["保留 strategy_context.timeframes.M15。"],
            "constant": 3,
        }
        schema_en = {
            "signal_type": "Only buy | sell | hold, timeframe M15, parameter 34.",
            "key_reasons": ["Keep strategy_context.timeframes.M15."],
            "constant": 3,
        }
        audit = validate_translation("使用 M15 的 strategy_context。", "Use strategy_context on M15.", schema_zh, schema_en)
        self.assertTrue(audit["passed"], audit)
        changed = dict(schema_en)
        changed["signal_type"] = "Only buy | sell | hold, timeframe H1, parameter 34."
        self.assertFalse(validate_translation("使用 M15。", "Use M15.", schema_zh, changed)["passed"])

    def test_decision_points_and_no_future_input(self):
        start = 1_700_000_000_000
        bars = []
        for index in range(20):
            opened = start + index * 300_000
            bars.append({
                "time_utc_msc": opened,
                "time_server_msc": opened + 10_800_000,
                "open": 100,
                "high": 101,
                "low": 99,
                "close": 100,
            })
        market = {
            "plan": {"primary_timeframe": "M5", "timeframes": [{"timeframe": "M5", "kline_count": 5}]},
            "window": {"start_utc_msc": start, "end_utc_msc": start + 20 * 300_000, "outcome_hours": 12},
            "timeframes": {"M5": {"bars": bars}, "M1": {"bars": []}},
        }
        selected = decision_points(market, 4)
        self.assertEqual(len(selected), 4)
        for item in selected:
            self.assertGreaterEqual(item["decision_time_utc_msc"], start)
            self.assertLessEqual(item["decision_time_utc_msc"], start + 20 * 300_000)
            index = (item["decision_time_utc_msc"] - start) // 300_000 - 1
            self.assertEqual(bar_close_ms(bars[index], "M5"), item["decision_time_utc_msc"])

    def test_hold_contract_and_language_proxy(self):
        output = _hold_output()
        schema = {key: "description" for key in output}
        result = validate_signal_output(output, schema, ["market"], 100)
        self.assertTrue(result["passed"], result)
        self.assertEqual(natural_language_adherence(output, "zh")["rate"], 1.0)

    def test_no_memory_instruction_echo_is_a_contract_failure(self):
        output = _hold_output()
        output["experience_usage"]["influence"] = "本次没有提供记忆，必须返回空字符串"
        schema = {key: "description" for key in output}
        result = validate_signal_output(output, schema, ["market"], 100)
        self.assertFalse(result["passed"])
        self.assertIn("experience_influence_nonempty_without_memory", result["errors"])

    def test_pending_price_direction_uses_frozen_market_price(self):
        cases = (
            ("buy_limit", "limit", {"limit_price": 90, "stop_loss_price": 80, "take_profit_1_price": 120}, True),
            ("buy_limit", "limit", {"limit_price": 110, "stop_loss_price": 100, "take_profit_1_price": 130}, False),
            ("sell_limit", "limit", {"limit_price": 110, "stop_loss_price": 120, "take_profit_1_price": 90}, True),
            ("sell_limit", "limit", {"limit_price": 90, "stop_loss_price": 120, "take_profit_1_price": 80}, False),
            ("buy_stop", "stop", {"limit_price": 110, "stop_loss_price": 100, "take_profit_1_price": 130}, True),
            ("buy_stop", "stop", {"limit_price": 90, "stop_loss_price": 80, "take_profit_1_price": 120}, False),
            ("sell_stop", "stop", {"limit_price": 90, "stop_loss_price": 100, "take_profit_1_price": 70}, True),
            ("sell_stop", "stop", {"limit_price": 110, "stop_loss_price": 120, "take_profit_1_price": 80}, False),
        )
        for signal, entry, prices, expected in cases:
            with self.subTest(signal=signal, prices=prices):
                output = _trade_output(signal, entry, **prices)
                schema = {key: "description" for key in output}
                result = validate_signal_output(output, schema, [entry], market_price=100)
                self.assertEqual(result["passed"], expected, result)
                if expected:
                    self.assertNotIn("pending_price_direction_invalid", result["errors"])
                else:
                    self.assertIn("pending_price_direction_invalid", result["errors"])

    def test_pending_price_direction_does_not_use_model_reference_price(self):
        output = _trade_output(
            "buy_limit", "limit", limit_price=90, stop_loss_price=80, take_profit_1_price=120,
        )
        output["reference_price"] = 10_000
        schema = {key: "description" for key in output}
        result = validate_signal_output(output, schema, ["limit"], market_price=100)
        self.assertTrue(result["passed"], result)
        missing_current = validate_signal_output(output, schema, ["limit"], market_price=None)
        self.assertFalse(missing_current["passed"])
        self.assertIn("pending_reference_price_unavailable", missing_current["errors"])

    def test_stop_limit_relation_and_actual_entry_anchor(self):
        valid = _trade_output(
            "buy_stop_limit", "stop_limit", limit_price=110, stop_limit_price=105,
            stop_loss_price=100, take_profit_1_price=120,
        )
        schema = {key: "description" for key in valid}
        self.assertTrue(validate_signal_output(valid, schema, ["stop_limit"], 100)["passed"])

        wrong_relation = dict(valid, stop_limit_price=115)
        invalid = validate_signal_output(wrong_relation, schema, ["stop_limit"], 100)
        self.assertFalse(invalid["passed"])
        self.assertIn("stop_limit_price_relation_invalid", invalid["errors"])

        # With a trigger anchor of 110 this would look valid; the actual
        # stop-limit entry is 105, so SL=106 must be rejected.
        wrong_anchor = dict(valid, stop_loss_price=106)
        invalid_anchor = validate_signal_output(wrong_anchor, schema, ["stop_limit"], 100)
        self.assertFalse(invalid_anchor["passed"])
        self.assertIn("buy_price_direction_invalid", invalid_anchor["errors"])

        missing = dict(valid)
        missing.pop("stop_limit_price")
        missing_schema = {key: "description" for key in valid}
        missing_result = validate_signal_output(missing, missing_schema, ["stop_limit"], 100)
        self.assertFalse(missing_result["passed"])
        self.assertIn("stop_limit_price_required", missing_result["errors"])

        sell_valid = _trade_output(
            "sell_stop_limit", "stop_limit", limit_price=90, stop_limit_price=95,
            stop_loss_price=100, take_profit_1_price=80,
        )
        sell_schema = {key: "description" for key in sell_valid}
        self.assertTrue(validate_signal_output(sell_valid, sell_schema, ["stop_limit"], 100)["passed"])
        sell_wrong_relation = dict(sell_valid, stop_limit_price=85)
        sell_invalid = validate_signal_output(sell_wrong_relation, sell_schema, ["stop_limit"], 100)
        self.assertFalse(sell_invalid["passed"])
        self.assertIn("stop_limit_price_relation_invalid", sell_invalid["errors"])

    def test_structural_contract_eligibility_only_exempts_no_memory_echo(self):
        echo = {
            "passed": False,
            "errors": ["experience_influence_nonempty_without_memory", "experience_used_refs_nonempty_without_memory"],
        }
        eligible = structural_contract_eligibility(echo)
        self.assertTrue(eligible["eligible"], eligible)
        self.assertFalse(eligible["strict_passed"])
        self.assertEqual(eligible["blocked_errors"], [])
        self.assertTrue(structural_contract_passed(echo))

        mixed = dict(echo, errors=echo["errors"] + ["signal_entry_method_mismatch"])
        blocked = structural_contract_eligibility(mixed)
        self.assertFalse(blocked["eligible"], blocked)
        self.assertIn("signal_entry_method_mismatch", blocked["blocked_errors"])
        self.assertFalse(structural_contract_passed({"passed": False, "errors": []}))

    def test_contract_language_factor_preserves_chinese_response_semantics(self):
        schema = {"analysis": "Chinese market analysis."}
        market = {"latest_price": 100}
        messages = build_formal_messages("English strategy.", schema, market, "en")
        system = messages[0]["content"]
        self.assertIn("must be in Simplified Chinese", system)
        self.assertNotIn("must be in English", system)
        self.assertIn("## Output format", system)
        self.assertIn("## Compact market-data encoding", system)
        self.assertIn("kline_fields", system)
        chinese_contract = build_formal_messages(
            "English strategy.", {"analysis": "简体中文。"}, market, "zh", "en"
        )
        self.assertEqual(messages[1]["content"], chinese_contract[1]["content"])

    def test_formal_json_parser_does_not_repair_fences_or_prefixes(self):
        parsed, error = parse_json_object_strict('{"signal_type":"hold"}')
        self.assertEqual(parsed, {"signal_type": "hold"})
        self.assertIsNone(error)
        self.assertIsNotNone(parse_json_object_strict('```json\n{"signal_type":"hold"}\n```')[1])
        self.assertIsNotNone(parse_json_object_strict('answer: {"signal_type":"hold"}')[1])

    def test_same_bar_stop_loss_has_priority(self):
        decision = 1_700_000_000_000
        future_bars = []
        for index in range(12 * 60):
            future_bars.append({
                "time_utc_msc": decision + index * 60_000,
                "open": 100,
                "high": 110 if index == 0 else 101,
                "low": 90 if index == 0 else 99,
                "close": 105 if index == 0 else 100,
            })
        market_data = {
            "timeframes": {"M1": {"bars": future_bars}}
        }
        market_snapshot = {"latest_price": 100, "primary_timeframe": "M1"}
        output = {
            "signal_type": "buy", "entry_method": "market", "stop_loss_price": 95,
            "take_profit_1_price": 105, "recommended_take_profit_tier": 1,
        }
        result = simulate_outcome(output, market_data, market_snapshot, decision)
        self.assertTrue(result["filled"])
        self.assertEqual(result["status"], "sl")
        self.assertEqual(result["exit_price"], 95)

    def test_invalid_contract_is_not_replayed(self):
        decision = 1_700_000_000_000
        market_data = {"timeframes": {"M1": {"bars": _m1_bars(decision)}}}
        market_snapshot = {"latest_price": 100, "primary_timeframe": "M1"}
        output = _trade_output("buy", "market", stop_loss_price=95, take_profit_1_price=105)
        result = simulate_outcome(
            output, market_data, market_snapshot, decision,
            validation={"passed": False, "errors": ["buy_price_direction_invalid"]},
        )
        self.assertEqual(result["status"], "invalid_contract")
        self.assertFalse(result["filled"])
        self.assertFalse(result["contract_eligible"])

    def test_unknown_direction_does_not_become_sell(self):
        decision = 1_700_000_000_000
        market_data = {"timeframes": {"M1": {"bars": _m1_bars(decision)}}}
        result = simulate_outcome(
            {"signal_type": "unexpected"}, market_data,
            {"latest_price": 100, "primary_timeframe": "M1"}, decision,
        )
        self.assertEqual(result["status"], "invalid")
        self.assertIsNone(result["direction_return_4h_pct"])
        self.assertIsNone(result["direction_return_12h_pct"])

    def test_future_gap_excludes_trade_from_replay_and_hold_reference(self):
        decision = 1_700_000_000_000
        market_data = {"timeframes": {"M1": {"bars": _m1_bars(decision, missing_indices=(6 * 60,))}}}
        market_snapshot = {"latest_price": 100, "primary_timeframe": "M1"}
        trade = _trade_output("buy", "market", stop_loss_price=95, take_profit_1_price=105)
        validation = {"passed": True, "errors": []}
        result = simulate_outcome(trade, market_data, market_snapshot, decision, validation=validation)
        self.assertEqual(result["status"], "insufficient_future")
        self.assertFalse(result["filled"])
        self.assertEqual(result["future_data_12h"], "partial")
        self.assertIsNone(result.get("return_pct"))

        hold = simulate_outcome(_hold_output(), market_data, market_snapshot, decision, validation=validation)
        self.assertEqual(hold["status"], "not_applicable")
        self.assertEqual(hold["future_data_12h"], "partial")
        self.assertIsNone(hold["direction_return_12h_pct"])

    def test_report_summary_is_reproducible_shape(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            calls = []
            for group, strategy_language, schema_language in (("zh_zh", "zh", "zh"), ("zh_en", "zh", "en"), ("en_zh", "en", "zh"), ("en_en", "en", "en")):
                output = _hold_output()
                calls.append({
                    "status": "success", "pair_id": "m5-1", "group": group,
                    "strategy_language": strategy_language, "schema_language": schema_language,
                    "http_status": 200, "parse_error": None, "parsed_output": output,
                    "contract_passed": True, "latency_ms": 10, "request_bytes": 100,
                    "thinking": {"type": "disabled"},
                    "response_bytes": 200, "usage": {"prompt_tokens": 10, "completion_tokens": 20},
                    "backtest": {"status": "not_applicable", "filled": False},
                })
            experiment = {
                "model": "deepseek-v4-pro-0813", "base_url": "https://example.invalid/v1",
                "design": {"actual_samples": 1, "formal_calls_expected": 4},
                "source": {"vm_branch": "main", "vm_commit": "a" * 40, "local_commit": "a" * 40, "symbol": "XAUUSD.s"},
                "source_hashes": {}, "translation_audit": {"source": "fixture", "passed": True, "errors": []},
                "decisions": [{"decision_id": "m5-1", "decision_time_utc": "2023-11-14T22:13:20Z"}],
                "calls": calls,
            }
            experiment_path = root / "experiment.json"
            experiment_path.write_text(json.dumps(experiment, ensure_ascii=False), encoding="utf-8")
            summary = build_report(experiment_path=experiment_path)
            self.assertEqual(set(summary["groups"]), {"zh_zh", "zh_en", "en_zh", "en_en"})
            self.assertTrue((root / "summary.json").exists())
            self.assertTrue((root / "pairwise.csv").exists())
            self.assertTrue((root / "report.md").exists())

    def test_report_rejects_stale_narrative_audit_binding(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            calls = []
            for group in ("zh_zh", "zh_en", "en_zh", "en_en"):
                calls.append({
                    "status": "success", "pair_id": "h1-1", "decision_id": "h1-1", "group": group,
                    "http_status": 200, "parse_error": None, "parsed_output": _hold_output(),
                    "contract_passed": True, "validation": {"passed": True, "errors": []},
                    "thinking": {"type": "disabled"}, "request_sha256": f"request-{group}",
                    "response_sha256": f"response-{group}", "backtest": {"status": "not_applicable"},
                })
            experiment = {
                "calls": calls,
                "decisions": [{"decision_id": "h1-1"}],
            }
            (root / "experiment.json").write_text(json.dumps(experiment), encoding="utf-8")
            binding = formal_record_binding(calls)
            write_json(root / "narrative-fact-audit.json", {
                "scope": {
                    "formal_records_audited": 4,
                    "formal_record_set_sha256": "0" * 64,
                },
                "results": {
                    "explicitly_contradictory_records": 0,
                    "explicit_contradictions_by_group": {group: 0 for group in ("zh_zh", "zh_en", "en_zh", "en_en")},
                },
            })
            self.assertNotEqual(binding["formal_record_set_sha256"], "0" * 64)
            with self.assertRaisesRegex(ValueError, "narrative_audit_record_hash_mismatch"):
                build_report(experiment_path=root / "experiment.json")


if __name__ == "__main__":
    unittest.main(verbosity=2)
