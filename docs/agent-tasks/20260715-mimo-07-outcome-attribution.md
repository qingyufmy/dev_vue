# Mimo Task 07：平仓结果监控与信号归因

## 前置

- Task 03、06 已审查通过。
- 分支：`dev_codex`。

## 目标

建立 signal → delivery/order intent → MT5 deals → 完整平仓结果的可靠闭环，为风控统计和复盘提供事实数据。

## 必须实现

1. 新增 `signal_outcomes`、`signal_outcome_deals`，索引 user/account/position/ticket/status。
2. 入场成功后创建 outcome；挂单成交后由 reconciler 创建/更新。
3. Position Outcome Monitor 使用 DB 持久状态，每次只扫描未关闭 outcome，Bridge 离线后可补齐。
4. 扩展 Bridge history 输出必要的 position id、order、deal ticket、entry、magic、reason、comment、volume、profit、commission、swap、fee、时间和 SL/TP。
5. 按完整 position 聚合部分成交和部分平仓，净盈亏包含费用。
6. Hedging 账户按 position 归因。
7. Netting 账户建立 deal 分配账本；多订单意图无法可靠分配时标记 `attribution_ambiguous`，不伪造单信号盈亏。
8. 检测用户手工加仓、修改 SL/TP、手工/外部平仓并记录 `external_intervention`。
9. 唯一约束确保同一 deal 不重复写、同一完整 outcome 不重复触发。
10. 仅在完整平仓和费用稳定后标记 review eligible。
11. 增加 Hedging、Netting 单意图、Netting 多意图歧义、部分平仓、Bridge 离线补齐和重复扫描测试。

## 非目标

- 不调用 AI 生成复盘。
- 不做记忆、UI 或自动权重调整。
- 不为证据不足的旧交易猜测 signal id。

## 验证

```powershell
npm test -- tests/ai/scheduler.test.js tests/ai/scheduler-safety.test.js tests/bridge-ws.test.js
npm test
```

## 交付

- 结果：`docs/agent-results/20260715-mimo-07-outcome-attribution-result.md`
- 提交并推送 `origin/dev_codex`。
- 结果给出 MT5 字段映射、归因规则和明确拒绝复盘的场景。
- 完成后停止。
