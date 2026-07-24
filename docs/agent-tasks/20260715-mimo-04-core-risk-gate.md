# Mimo Task 04：风控配置骨架与 L1/L4/L5 核心闸门

## 前置

- Task 03 已审查通过。
- 分支：`dev_codex`；必读总设计第 5–12 章。

## 目标

把模型/策略配置与执行风控分离，建立版本化有效策略和无状态核心规则，所有订单意图保存原始与批准订单。

## 必须实现

1. 新增 `risk_policy_sets`、`risk_policy_versions`、`risk_policy_change_items`、`risk_profiles`、`risk_decisions`。
2. 建立规则注册表：code、类型、单位、安全方向、默认、允许范围、锁定、放宽分类和中文文案。
3. 解析系统硬规则、平台默认/边界、用户账户策略和只能收紧的策略风控档案。
4. 混合提交按字段处理：收紧立即；放宽写待生效项；不得整体延迟。
5. 实现 L5 严格 Schema：非法枚举、缺关键字段、挂单缺价格、非法 entry method 均降级 hold，不回退 market，不解析 reasoning 指令。
6. 实现 L1：品种、强制 SL、SL/TP 方向、ATR 止损上下限、RR、挂单合法性/有效期、AI 手数平台范围、最大手数和真实单笔风险。
7. AI 建议手数只可向下；R1.3 扩 SL 后同比缩手并完整复检；低于最小手数拒绝。
8. Bridge 提供 tick value、tick size、contract size、volume min/max/step、digits、point、trade mode；缺关键参数 fail closed。
9. 实现 L4：交易时间、周末保护、TTL、报价年龄、点差、市价信号 ATR 漂移。
10. 分离市价漂移、挂单偏离和 broker slippage，用户在管理员范围内配置。
11. 风控函数返回结构化 pass/adjust/default/reject 决策，不原地修改原信号。
12. 添加规则单测、属性边界测试、调整后复检和策略版本审计测试。

## 非目标

- 不实现 L2/L3 状态型规则和恢复流程。
- 不做 UI。
- 不自动删除旧 max_position_size 字段。

## 验证

```powershell
npm test -- tests/ai/llm.test.js tests/ai/config.test.js tests/ai/strategy.test.js tests/ai/scheduler-safety.test.js
npm test
```

## 交付

- 结果文件：`docs/agent-results/20260715-mimo-04-core-risk-gate-result.md`
- 提交并推送 `origin/dev_codex`。
- 结果逐条列出 R1/L4/L5 的实现状态和未实现规则。
- 完成后停止。
