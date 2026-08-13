from __future__ import annotations

from datetime import datetime, timezone
import importlib.util
import json
from pathlib import Path
import sys
import tempfile
import unittest


SCRIPT = Path(__file__).resolve().parents[2] / "scripts" / "push_period_reviews_to_lark.py"
SPEC = importlib.util.spec_from_file_location("push_period_reviews_to_lark", SCRIPT)
MODULE = importlib.util.module_from_spec(SPEC)
assert SPEC and SPEC.loader
sys.modules[SPEC.name] = MODULE
SPEC.loader.exec_module(MODULE)


class FakeApi:
    def __init__(self, cases, details):
        self.cases = cases
        self.details = details
        self.logged_in = False
        self.detail_calls = []

    def login(self):
        self.logged_in = True
        return "token-for-test"

    def list_cases(self, period_type):
        return list(self.cases.get(period_type, []))

    def get_case(self, case_id):
        self.detail_calls.append(str(case_id))
        return dict(self.details[str(case_id)])


class FakeSender:
    def __init__(self, outcomes=None):
        self.payloads = []
        self.outcomes = list(outcomes or [])

    def send(self, payload):
        self.payloads.append(payload)
        if self.outcomes:
            outcome = self.outcomes.pop(0)
            if outcome:
                raise outcome


def config(tmp, **overrides):
    values = {
        "base_url": "https://aurum.example.test",
        "email": "push@example.test",
        "phone": None,
        "password": "secret-password",
        "webhook_url": "https://open.larksuite.com/open-apis/bot/v2/hook/test",
        "lookback_days": 7,
        "max_cards": 20,
        "state_file": Path(tmp) / "state.json",
    }
    values.update(overrides)
    return MODULE.Config(**values)


def case(case_id, period_type="daily", version_id=11, **overrides):
    value = {
        "id": case_id,
        "period_type": period_type,
        "period_key": "2026-08-09" if period_type == "daily" else "2026-07",
        "strategy_id": 101,
        "strategy_title": "策略甲",
        "strategy_version": "v2",
        "status": "approved",
        "evidence_status": "complete",
        "current_version_id": version_id,
        "period_end_utc_msc": int(datetime(2026, 8, 9, tzinfo=timezone.utc).timestamp() * 1000),
        "source_count": 4,
        "statistics": {"trade_count": 4},
    }
    value.update(overrides)
    return value


def detail(item, content=None, version_no=1):
    content = content or {
        "period_summary": "整体按计划执行",
        "decision_quality": "good",
        "confidence": 0.8,
        "strengths": ["遵守止损"],
        "repeated_issues": ["确认偏早"],
        "risk_observations": ["控制单笔风险"],
        "daily_lessons": ["等待结构确认"],
    }
    return {
        **item,
        "versions": [{"id": item["current_version_id"], "version_no": version_no, "content": content}],
    }


class ConfigTests(unittest.TestCase):
    def test_env_overrides_dotenv_and_dry_run_allows_missing_webhook(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / ".env"
            path.write_text(
                "AURUM_BASE_URL=https://aurum.example\n"
                "AURUM_PUSH_EMAIL=file@example\n"
                "AURUM_PUSH_PASSWORD=file-password\n"
                "LARK_REVIEW_WEBHOOK_URL=https://open.larksuite.com/open-apis/bot/v2/hook/file\n",
                encoding="utf-8",
            )
            value = MODULE.Config.from_sources(
                config_path=path,
                environ={"AURUM_PUSH_EMAIL": "env@example", "AURUM_PUSH_PASSWORD": "env-password", "LARK_REVIEW_WEBHOOK_URL": ""},
                dry_run=True,
                repo_root=Path(directory),
            )
            self.assertEqual(value.email, "env@example")
            self.assertIsNone(value.webhook_url)

    def test_https_and_webhook_constraints(self):
        private_http = MODULE.Config.from_sources(
            environ={
                "AURUM_BASE_URL": "http://192.168.1.254/",
                "AURUM_PUSH_EMAIL": "a@b.test",
                "AURUM_PUSH_PASSWORD": "p",
            },
            dry_run=True,
        )
        self.assertEqual(private_http.base_url, "http://192.168.1.254")
        with self.assertRaises(MODULE.ConfigError):
            MODULE.Config.from_sources(
                environ={"AURUM_BASE_URL": "http://aurum.example", "AURUM_PUSH_EMAIL": "a@b.test", "AURUM_PUSH_PASSWORD": "p"},
                dry_run=True,
            )
        with self.assertRaises(MODULE.ConfigError):
            MODULE.Config.from_sources(
                environ={"AURUM_BASE_URL": "http://8.8.8.8", "AURUM_PUSH_EMAIL": "a@b.test", "AURUM_PUSH_PASSWORD": "p"},
                dry_run=True,
            )
        with self.assertRaises(MODULE.ConfigError):
            MODULE.Config.from_sources(
                environ={
                    "AURUM_BASE_URL": "https://aurum.example",
                    "AURUM_PUSH_EMAIL": "a@b.test",
                    "AURUM_PUSH_PASSWORD": "p",
                    "LARK_REVIEW_WEBHOOK_URL": "https://evil.example/hook",
                }
            )


class HttpAndApiTests(unittest.TestCase):
    def test_login_body_and_pagination(self):
        requests = []

        def transport(method, url, headers, body, timeout):
            requests.append((method, url, headers, json.loads(body.decode("utf-8")) if body else None, timeout))
            if method == "POST":
                return 200, {"ok": True, "token": "secret-token", "user": {"id": 1}}
            offset = int(url.split("offset=")[-1])
            page = [case(offset + 1)] if offset == 0 else []
            return 200, {"ok": True, "cases": page, "pagination": {"has_more": False, "next_offset": 1}}

        api = MODULE.AurumApi(config(tempfile.gettempdir()), http=MODULE.HttpClient(transport=transport))
        self.assertEqual(api.login(), "secret-token")
        rows = api.list_cases("daily")
        self.assertEqual(len(rows), 1)
        self.assertEqual(requests[0][3], {"email": "push@example.test", "password": "secret-password", "method": "password"})
        self.assertEqual(requests[0][4], 10)
        self.assertTrue(requests[1][2]["Authorization"].startswith("Bearer "))

    def test_api_requires_explicit_success(self):
        def transport(method, url, headers, body, timeout):
            return 200, {"ok": False}

        api = MODULE.AurumApi(config(tempfile.gettempdir()), http=MODULE.HttpClient(transport=transport))
        with self.assertRaises(MODULE.ApiError):
            api.login()


class SelectionAndCardTests(unittest.TestCase):
    def test_filter_recent_status_scope_and_dedup(self):
        now = datetime(2026, 8, 10, tzinfo=timezone.utc)
        rows = [
            case(1),
            case(1),
            case(2, status="generating"),
            case(3, evidence_status="incomplete"),
            case(4, strategy_scope="user"),
            case(5, period_end_utc_msc=int(datetime(2026, 7, 1, tzinfo=timezone.utc).timestamp() * 1000)),
            case(6, current_version_id=None),
        ]
        selected = MODULE.select_candidates(rows, lookback_days=7, now=now)
        self.assertEqual([item["id"] for item in selected], [1])

    def test_daily_monthly_mapping_and_strategy_isolation(self):
        daily = case(1)
        monthly = case(2, period_type="monthly", strategy_title="策略乙", version_id=21)
        daily_payload = MODULE.build_lark_card(detail(daily), detail(daily)["versions"][0])
        monthly_detail = detail(monthly, {"period_summary": "月度总结", "decision_quality": "mixed", "strengths": ["稳定"], "recurring_patterns": ["重复模式"], "risk_observations": [], "next_month_actions": ["下月行动"], "memory_candidates": [{"lesson": "x"}]})
        monthly_payload = MODULE.build_lark_card(monthly_detail, monthly_detail["versions"][0])
        daily_text = json.dumps(daily_payload, ensure_ascii=False)
        monthly_text = json.dumps(monthly_payload, ensure_ascii=False)
        self.assertIn("日复盘 · 策略甲", daily_text)
        self.assertIn("月复盘 · 策略乙", monthly_text)
        self.assertIn("下月行动", monthly_text)
        self.assertNotIn("daily_lessons", monthly_text)
        self.assertNotIn("evidence", daily_text.lower())

    def test_new_version_marker_and_redaction(self):
        item = case(10, version_id=19)
        content = {"period_summary": "联系 a.user@example.com，账户: 12345678", "strengths": ["手机号 13800138000"], "repeated_issues": [], "risk_observations": [], "daily_lessons": []}
        payload = MODULE.build_lark_card(detail(item, content, version_no=2), detail(item, content, version_no=2)["versions"][0])
        text = json.dumps(payload, ensure_ascii=False)
        self.assertIn("修订版", text)
        self.assertNotIn("a.user@example.com", text)
        self.assertNotIn("12345678", text)
        self.assertNotIn("13800138000", text)

    def test_summary_keeps_all_review_lists(self):
        item = case(11)
        content = {
            "period_summary": "完整总结",
            "decision_quality": "mixed",
            "confidence": 0.7,
            "strengths": ["优点1", "优点2", "优点3", "优点4"],
            "repeated_issues": ["问题1", "问题2", "问题3", "问题4", "问题5"],
            "risk_observations": ["风险1", "风险2", "风险3", "风险4"],
            "daily_lessons": ["行动1", "行动2", "行动3", "行动4", "行动5"],
        }
        summary = MODULE.build_lark_cards(detail(item, content), detail(item, content)["versions"][0])[0][1]
        text = json.dumps(summary, ensure_ascii=False)
        for value in ["优点1", "优点4", "问题1", "问题5", "风险1", "风险4", "行动1", "行动5"]:
            self.assertIn(value, text)

    def test_daily_detail_keeps_assessments_and_aggregates_chan(self):
        item = case(12)
        assessments = [{"outcome_id": index, "decision_quality": "good", "summary": f"交易总结{index}"} for index in range(1, 8)]
        diagnoses = [{"status": "normal", "issue_source": "data", "explanation": "重复说明"} for _ in range(6)]
        diagnoses.append({"status": "suspected_issue", "issue_source": "confirmation_lag", "explanation": "异常说明"})
        content = {
            "period_summary": "日总结", "decision_quality": "good", "confidence": 0.8,
            "strengths": [], "repeated_issues": [], "risk_observations": [], "daily_lessons": [],
            "trade_assessments": assessments, "chan_diagnoses": diagnoses,
            "period_chan_assessment": {"status": "suspected_issue", "issue_source": "confirmation_lag", "explanation": "周期说明", "confidence": 0.6},
        }
        detail_card = MODULE.build_lark_cards(detail(item, content), detail(item, content)["versions"][0])[0][1]
        text = json.dumps(detail_card, ensure_ascii=False)
        for index in range(1, 8):
            self.assertIn(f"交易总结{index}", text)
            self.assertIn(f"交易#{index}", text)
        self.assertIn("周期说明", text)
        self.assertIn("共 7 条", text)
        self.assertIn("异常说明", text)
        self.assertNotIn("重复说明", text)

    def test_monthly_detail_keeps_daily_assessments_and_counts(self):
        item = case(13, period_type="monthly")
        assessments = [{"period_case_id": index, "period_key": f"2026-07-{index:02d}", "decision_quality": "mixed", "summary": f"第{index}日总结"} for index in range(1, 6)]
        content = {
            "period_summary": "月总结", "decision_quality": "mixed", "confidence": 0.8,
            "strengths": [], "recurring_patterns": [], "risk_observations": [], "next_month_actions": [],
            "daily_assessments": assessments, "conflict_groups": [{"id": 1}, {"id": 2}],
            "memory_candidates": [{"lesson": "a"}, {"lesson": "b"}, {"lesson": "c"}],
        }
        detail_card = MODULE.build_lark_cards(detail(item, content), detail(item, content)["versions"][0])[0][1]
        text = json.dumps(detail_card, ensure_ascii=False)
        for index in range(1, 6):
            self.assertIn(f"第{index}日总结", text)
            self.assertIn(f"2026-07-{index:02d}", text)
        self.assertIn("冲突组：2 个", text)
        self.assertIn("记忆候选：3 条", text)

    def test_v3_card_structure_and_status_colors(self):
        item = case(14)
        version = detail(item)["versions"][0]
        cards = MODULE.build_lark_cards(detail(item), version)
        self.assertEqual([kind for kind, _ in cards], ["review"])
        payload = cards[0][1]
        elements = payload["card"]["elements"]
        self.assertEqual(payload["card"]["header"]["template"], "green")
        self.assertIn("已确认｜日复盘 · 策略甲", payload["card"]["header"]["title"]["content"])
        self.assertEqual(len(next(element["fields"] for element in elements if element.get("fields"))), 8)
        self.assertGreaterEqual(sum(element.get("tag") == "hr" for element in elements), 2)
        self.assertEqual(MODULE.build_lark_cards({**detail(item), "status": "draft"}, version)[0][1]["card"]["header"]["template"], "orange")
        self.assertEqual(MODULE.build_lark_cards({**detail(item), "status": "needs_revision"}, version)[0][1]["card"]["header"]["template"], "red")
        self.assertEqual(MODULE.build_lark_cards({**detail(item), "status": "approved"}, {**version, "content": {**version["content"], "decision_quality": "mixed"}})[0][1]["card"]["header"]["template"], "blue")

    def test_evidence_statistics_metrics_and_safe_fallback(self):
        item = case(40)
        review = detail(item, {"period_summary": "AI 文本净收益 999", "decision_quality": "good", "confidence": 0.8})
        review["evidence"] = {"statistics": {"net_profit": 256.58, "trade_count": 8, "wins": 6, "losses": 2, "win_rate": 0.75}}
        payload = MODULE.build_lark_card(review, review["versions"][0])
        fields_text = json.dumps(next(element["fields"] for element in payload["card"]["elements"] if element.get("fields")), ensure_ascii=False)
        self.assertIn("+256.58", fields_text)
        self.assertIn("8笔（胜6·负2）", fields_text)
        self.assertIn("75%", fields_text)
        self.assertNotIn("999.00", fields_text)

        missing = detail(case(41), {"period_summary": "缺失指标", "decision_quality": "good"})
        missing["evidence"] = {"statistics": {"wins": 2}}
        missing_fields = json.dumps(next(element["fields"] for element in MODULE.build_lark_cards(missing, missing["versions"][0])[0][1]["card"]["elements"] if element.get("fields")), ensure_ascii=False)
        self.assertIn("净收益", missing_fields)
        self.assertIn("--", missing_fields)

        monthly = detail(case(42, period_type="monthly"), {"period_summary": "月指标", "decision_quality": "mixed"})
        monthly["evidence"] = {"statistics": {"trading_days": 5, "trade_count": 8, "wins": 6, "losses": 2, "net_profit": 256.58}}
        monthly_fields = json.dumps(next(element["fields"] for element in MODULE.build_lark_cards(monthly, monthly["versions"][0])[0][1]["card"]["elements"] if element.get("fields")), ensure_ascii=False)
        self.assertIn("8笔（胜6·负2·5交易日）", monthly_fields)
        self.assertIn("+256.58", monthly_fields)
        self.assertIn("75%", monthly_fields)


class StateAndSenderTests(unittest.TestCase):
    def test_state_atomic_write_and_corruption(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "state.json"
            store = MODULE.StateStore(path)
            store.load()
            store.mark_sent("1:2", {"case_id": "1"})
            store.save()
            self.assertEqual(json.loads(path.read_text(encoding="utf-8"))["sent"]["1:2"]["case_id"], "1")
            path.write_text("{not-json", encoding="utf-8")
            with self.assertRaises(MODULE.StateError):
                MODULE.StateStore(path).load()
            self.assertEqual(path.read_text(encoding="utf-8"), "{not-json")

    def test_lark_success_business_shapes_and_retry(self):
        responses = [MODULE.HttpResponse(429, b"{}"), MODULE.HttpResponse(500, b"{}"), MODULE.HttpResponse(200, b'{"StatusCode":0}')]
        sleeps = []

        def transport(method, url, headers, body, timeout):
            return responses.pop(0)

        sender = MODULE.LarkSender(
            "https://open.larksuite.com/open-apis/bot/v2/hook/test",
            http=MODULE.HttpClient(transport=transport),
            sleep=sleeps.append,
        )
        sender.send({"msg_type": "interactive", "card": {}})
        self.assertEqual(sleeps, [1, 2])

    def test_lark_known_bad_and_unknown_responses(self):
        def bad_transport(method, url, headers, body, timeout):
            return 400, {"code": 1}

        with self.assertRaisesRegex(MODULE.LarkSendError, "HTTP 400") as context:
            MODULE.LarkSender("https://open.larksuite.com/open-apis/bot/v2/hook/test", http=MODULE.HttpClient(transport=bad_transport), sleep=lambda _: None).send({})
        self.assertFalse(context.exception.unknown)

        def unknown_transport(method, url, headers, body, timeout):
            raise TimeoutError()

        with self.assertRaises(MODULE.LarkSendError) as context:
            MODULE.LarkSender("https://open.larksuite.com/open-apis/bot/v2/hook/test", http=MODULE.HttpClient(transport=unknown_transport), sleep=lambda _: None).send({})
        self.assertTrue(context.exception.unknown)


class RunnerTests(unittest.TestCase):
    def test_state_unwritable_preflight_does_not_call_sender(self):
        with tempfile.TemporaryDirectory() as directory:
            blocked_parent = Path(directory) / "blocked"
            blocked_parent.write_text("not a directory", encoding="utf-8")
            item = case(1)
            api = FakeApi({"daily": [item], "monthly": []}, {"1": detail(item)})
            sender = FakeSender()
            value = config(directory, state_file=blocked_parent / "state.json")
            with self.assertRaises(MODULE.StateError):
                MODULE.PushRunner(value, api=api, sender=sender, sleep=lambda _: None).run()
            self.assertFalse(api.logged_in)
            self.assertEqual(sender.payloads, [])

    def test_detail_status_change_is_skipped_without_sending(self):
        with tempfile.TemporaryDirectory() as directory:
            item = case(1)
            stale = detail(item)
            stale["status"] = "generating"
            api = FakeApi({"daily": [item], "monthly": []}, {"1": stale})
            sender = FakeSender()
            summary = MODULE.PushRunner(config(directory), api=api, sender=sender, sleep=lambda _: None).run()
            self.assertEqual(summary.skipped, 1)
            self.assertEqual(summary.sent, 0)
            self.assertEqual(summary.failed, 0)
            self.assertEqual(sender.payloads, [])

    def test_inter_card_sleep_only_between_cards(self):
        with tempfile.TemporaryDirectory() as directory:
            one, two = case(1), case(2, strategy_title="策略乙", version_id=22)
            api = FakeApi({"daily": [one, two], "monthly": []}, {"1": detail(one), "2": detail(two)})
            sender, sleeps = FakeSender(), []
            summary = MODULE.PushRunner(config(directory), api=api, sender=sender, sleep=sleeps.append).run()
            self.assertEqual(summary.sent, 2)
            self.assertEqual(sleeps, [1])

            one_only = case(3)
            api = FakeApi({"daily": [one_only], "monthly": []}, {"3": detail(one_only)})
            sleeps = []
            summary = MODULE.PushRunner(config(directory, state_file=Path(directory) / "single.json", max_cards=1), api=api, sender=FakeSender(), sleep=sleeps.append).run()
            self.assertEqual(summary.sent, 1)
            self.assertEqual(sleeps, [])

    def test_dry_run_dedup_same_case_new_version_and_no_state_write(self):
        with tempfile.TemporaryDirectory() as directory:
            first = case(1)
            second = case(2, strategy_title="策略乙", version_id=22)
            api = FakeApi({"daily": [first, second], "monthly": []}, {"1": detail(first), "2": detail(second)})
            sender = FakeSender()
            value = config(directory)
            summary = MODULE.PushRunner(value, api=api, sender=sender, now=lambda: datetime(2026, 8, 10, tzinfo=timezone.utc)).run(dry_run=True)
            self.assertEqual(summary.sent, 2)
            self.assertEqual(sender.payloads, [])
            self.assertFalse(value.state_file.exists())

            store = MODULE.StateStore(value.state_file)
            store.load()
            store.mark_sent("1:11")
            store.save()
            second_version = detail(first, version_no=2)
            second_version["current_version_id"] = 12
            second_version["versions"][0]["id"] = 12
            api.details["1"] = second_version
            first["current_version_id"] = 12
            store.mark_sent(MODULE.card_state_key("2", "22", "review"))
            store.save()
            summary = MODULE.PushRunner(value, api=api, sender=sender, now=lambda: datetime(2026, 8, 10, tzinfo=timezone.utc)).run(dry_run=True)
            self.assertEqual(summary.sent, 0)

    def test_normal_run_marks_sent_and_unknown(self):
        with tempfile.TemporaryDirectory() as directory:
            one = case(1)
            two = case(2, strategy_title="策略乙", version_id=22)
            api = FakeApi({"daily": [one, two], "monthly": []}, {"1": detail(one), "2": detail(two)})
            sender = FakeSender([None, MODULE.LarkSendError("unknown", unknown=True)])
            value = config(directory, max_cards=2)
            summary = MODULE.PushRunner(value, api=api, sender=sender, now=lambda: datetime(2026, 8, 10, tzinfo=timezone.utc), sleep=lambda _: None).run()
            self.assertEqual(summary.sent, 1)
            self.assertEqual(summary.unknown, 1)
            state = json.loads(value.state_file.read_text(encoding="utf-8"))
            self.assertIn(MODULE.case_state_key("1"), state["sent"])
            self.assertIn(MODULE.case_state_key("2"), state["unknown"])
            self.assertEqual(state["sent"][MODULE.case_state_key("1")]["version_id"], "11")
            self.assertEqual(state["sent"][MODULE.case_state_key("1")]["card_kind"], "review")
            self.assertEqual(state["sent"][MODULE.case_state_key("1")]["schema"], MODULE.CARD_SCHEMA_VERSION)

    def test_old_v1_state_blocks_new_version(self):
        with tempfile.TemporaryDirectory() as directory:
            item = case(20)
            api = FakeApi({"daily": [item], "monthly": []}, {"20": detail(item)})
            sender = FakeSender()
            value = config(directory)
            value.state_file.write_text(json.dumps({"sent": {"20:11": {}}, "unknown": {}}), encoding="utf-8")
            summary = MODULE.PushRunner(value, api=api, sender=sender, sleep=lambda _: None).run()
            self.assertEqual(summary.sent, 0)
            self.assertEqual(len(sender.payloads), 0)

    def test_v2_single_card_blocks_new_version(self):
        with tempfile.TemporaryDirectory() as directory:
            item = case(21)
            api = FakeApi({"daily": [item], "monthly": []}, {"21": detail(item)})
            sender = FakeSender()
            value = config(directory)
            store = MODULE.StateStore(value.state_file)
            store.load()
            store.mark_sent(MODULE.card_state_key("21", "11", "summary", 2))
            store.save()
            summary = MODULE.PushRunner(value, api=api, sender=sender, sleep=lambda _: None).run()
            self.assertEqual(summary.sent, 0)
            self.assertEqual(len(sender.payloads), 0)

    def test_unknown_legacy_record_blocks_same_case(self):
        with tempfile.TemporaryDirectory() as directory:
            item = case(24, version_id=2)
            api = FakeApi({"daily": [item], "monthly": []}, {"24": detail(item)})
            sender = FakeSender()
            value = config(directory)
            value.state_file.write_text(json.dumps({"sent": {}, "unknown": {"24:1": {}}}), encoding="utf-8")
            summary = MODULE.PushRunner(value, api=api, sender=sender, sleep=lambda _: None).run()
            self.assertEqual(summary.sent, 0)
            self.assertEqual(summary.skipped, 1)
            self.assertEqual(sender.payloads, [])

    def test_case_key_prefix_does_not_match_and_other_case_sends(self):
        with tempfile.TemporaryDirectory() as directory:
            target = case(21)
            other = case(211, strategy_title="策略乙", version_id=12)
            api = FakeApi({"daily": [target, other], "monthly": []}, {"21": detail(target), "211": detail(other)})
            sender = FakeSender()
            value = config(directory)
            value.state_file.write_text(json.dumps({"sent": {"210:1": {}, "case:210:review": {}}, "unknown": {}}), encoding="utf-8")
            summary = MODULE.PushRunner(value, api=api, sender=sender, sleep=lambda _: None).run()
            self.assertEqual(summary.sent, 2)
            self.assertEqual(len(sender.payloads), 2)
            state = json.loads(value.state_file.read_text(encoding="utf-8"))
            self.assertIn(MODULE.case_state_key("21"), state["sent"])
            self.assertIn(MODULE.case_state_key("211"), state["sent"])

    def test_stable_case_key_blocks_current_version_change(self):
        with tempfile.TemporaryDirectory() as directory:
            item = case(26, version_id=11)
            api = FakeApi({"daily": [item], "monthly": []}, {"26": detail(item)})
            sender = FakeSender()
            value = config(directory)
            first = MODULE.PushRunner(value, api=api, sender=sender, sleep=lambda _: None).run()
            self.assertEqual(first.sent, 1)
            state = json.loads(value.state_file.read_text(encoding="utf-8"))
            self.assertIn(MODULE.case_state_key("26"), state["sent"])
            self.assertEqual(state["sent"][MODULE.case_state_key("26")]["version_id"], "11")

            item["current_version_id"] = 12
            api.details["26"] = detail(item, version_no=2)
            second = MODULE.PushRunner(value, api=api, sender=sender, sleep=lambda _: None).run()
            self.assertEqual(second.sent, 0)
            self.assertEqual(second.skipped, 1)
            self.assertEqual(len(sender.payloads), 1)

    def test_known_failure_is_not_marked_and_can_retry(self):
        with tempfile.TemporaryDirectory() as directory:
            item = case(25)
            api = FakeApi({"daily": [item], "monthly": []}, {"25": detail(item)})
            sender = FakeSender([MODULE.LarkSendError("known", unknown=False)])
            value = config(directory)
            first = MODULE.PushRunner(value, api=api, sender=sender, sleep=lambda _: None).run()
            self.assertEqual(first.failed, 1)
            state = json.loads(value.state_file.read_text(encoding="utf-8"))
            self.assertNotIn(MODULE.case_state_key("25"), state["sent"])
            self.assertNotIn(MODULE.case_state_key("25"), state["unknown"])
            second = MODULE.PushRunner(value, api=api, sender=sender, sleep=lambda _: None).run()
            self.assertEqual(second.sent, 1)
            state = json.loads(value.state_file.read_text(encoding="utf-8"))
            self.assertIn(MODULE.case_state_key("25"), state["sent"])

    def test_v2_summary_and_detail_both_migrate_without_v3_send(self):
        with tempfile.TemporaryDirectory() as directory:
            item = case(22)
            api = FakeApi({"daily": [item], "monthly": []}, {"22": detail(item)})
            sender = FakeSender()
            value = config(directory)
            store = MODULE.StateStore(value.state_file)
            store.load()
            store.mark_sent(MODULE.card_state_key("22", "11", "summary", 2))
            store.mark_unknown(MODULE.card_state_key("22", "11", "detail", 2))
            store.save()
            summary = MODULE.PushRunner(value, api=api, sender=sender, sleep=lambda _: None).run()
            self.assertEqual(summary.sent, 0)
            self.assertEqual(summary.skipped, 1)
            self.assertEqual(sender.payloads, [])

    def test_v3_sent_or_unknown_migrates_without_v4_send(self):
        for section in ("sent", "unknown"):
            with tempfile.TemporaryDirectory() as directory:
                item = case(23)
                api = FakeApi({"daily": [item], "monthly": []}, {"23": detail(item)})
                sender = FakeSender()
                value = config(directory)
                store = MODULE.StateStore(value.state_file)
                store.load()
                key = MODULE.card_state_key("23", "11", "review", 3)
                if section == "sent":
                    store.mark_sent(key)
                else:
                    store.mark_unknown(key)
                store.save()
                summary = MODULE.PushRunner(value, api=api, sender=sender, sleep=lambda _: None).run()
                self.assertEqual(summary.sent, 0)
                self.assertEqual(summary.skipped, 1)
                self.assertEqual(sender.payloads, [])

    def test_max_cards_is_actual_card_count_and_dry_run_writes_nothing(self):
        with tempfile.TemporaryDirectory() as directory:
            one, two, three = case(30), case(31, strategy_title="策略乙", version_id=31), case(32, strategy_title="策略丙", version_id=32)
            api = FakeApi({"daily": [one, two, three], "monthly": []}, {"30": detail(one), "31": detail(two), "32": detail(three)})
            sender = FakeSender()
            value = config(directory, max_cards=3)
            summary = MODULE.PushRunner(value, api=api, sender=sender, sleep=lambda _: None).run()
            self.assertEqual(summary.sent, 3)
            self.assertEqual(len(sender.payloads), 3)

            dry_directory = Path(directory) / "dry"
            dry_directory.mkdir()
            dry_api = FakeApi({"daily": [one], "monthly": []}, {"30": detail(one)})
            dry_sender = FakeSender()
            dry_value = config(dry_directory)
            dry_summary = MODULE.PushRunner(dry_value, api=dry_api, sender=dry_sender, sleep=lambda _: None).run(dry_run=True)
            self.assertEqual(dry_summary.sent, 1)
            self.assertEqual(dry_sender.payloads, [])
            self.assertFalse(dry_value.state_file.exists())


if __name__ == "__main__":
    unittest.main()
