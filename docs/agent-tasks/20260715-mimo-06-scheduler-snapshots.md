# Mimo Task 06：账户无关共享调度、私有推理与推理快照

## 前置

- Task 01–05 已审查通过。
- 分支：`dev_codex`。

## 目标

切换自动调度到新策略/模型解析，保证平台共享信号只分析市场；实现用户私有推理和可复现的推理快照。

## 必须实现

1. 平台共享策略输入排除管理员/用户 balance、equity、positions、pending、个人风控和盈亏。
2. 共享市场快照只含标准品种、K 线、成交量、价格、ATR、指标、时段和平台 AI 手数范围。
3. 平台共享策略使用平台主模型；私有策略按绑定用户模型 → 用户默认 → 平台 auto share 解析。
4. 用户模型调用错误不切平台模型；无模型时私有策略暂停并显示原因。
5. 私有策略 owner-only 调度；平台共享信号为每个订阅用户创建独立 Delivery 并经过账户风控。
6. 实现 `inference_snapshots`，保存实际 rendered system/user prompt、prompt hash、策略版本、模型元数据、credential source、紧凑 K 线、市场快照、Schema 版本和内容 hash。
7. 不保存密钥和 Authorization；限制快照体积，超限采用明确引用/证据不完整状态。
8. 保存标准品种和市场源；执行时继续使用用户报价和经纪商映射。
9. 个人 memory mode 字段先保存但本阶段不注入个人记忆。
10. 共享信号根记录不得写用户 ticket、批准订单或账户私有状态。
11. 测试管理员持仓/余额变化不影响相同市场输入的共享信号上下文。
12. 测试私有策略所有权、模型来源、提示词快照和密钥脱敏。

## 非目标

- 不实现复盘、结果追踪或记忆注入。
- 不实现前端。
- 不把账户相关策略继续标记为 shared。

## 验证

```powershell
npm test -- tests/ai/scheduler.test.js tests/ai/scheduler-safety.test.js tests/ai/manual-prompt.test.js tests/ai/market-data.test.js
npm test
```

## 交付

- 结果：`docs/agent-results/20260715-mimo-06-scheduler-snapshots-result.md`
- 提交并推送 `origin/dev_codex`。
- 列出共享输入字段白名单和快照保留限制。
- 完成后停止。
