# Mimo Task 03：订单意图、幂等与统一开仓入口

## 前置

- Task 01、02 已审查通过。
- 分支：`dev_codex`；保留无关工作树内容。

## 目标

在不改变交易策略语义的前提下，收拢所有新增订单路径，建立订单意图、账户级串行化和 MT5 不确定状态对账基础。

## 必须实现

1. 新增 `order_intents`、`risk_reservations` 及必要索引和状态约束。
2. 自动信号幂等键至少包含 signal、user、trading account；手工订单要求 client request id。
3. 建立统一服务，例如 `prepareAndExecuteOrderIntent()`；手工下单、手工 AI、自动 Delivery、信号页执行和挂单替换均调用它。
4. `mt5Bridge(..., 'open'/'pending')` 只允许在统一执行适配层出现；平仓、减仓、撤单保持独立可用。
5. 保留现有风险校验作为兼容适配，不在本阶段实现全部新规则。
6. 同一账户使用 DB 锁/短租约串行准备和预占；Redis 只能加速。
7. 不在 DB 事务中等待 Bridge 网络调用。
8. Bridge 成功写 ticket；明确失败释放预占；超时或未知结果进入 `uncertain`，禁止自动重发。
9. `uncertain` 对账完成前不释放可能已占用的风险预占。
10. 添加后台对账入口和过期 lease 回收；不得把 uncertain 当普通失败。
11. 扩展 Bridge/服务端可追踪引用，尽可能把 order intent 短标识写入安全 comment，并处理长度限制。
12. 增加并发、重复请求、超时、重启恢复和 close/cancel 不受阻测试。

## 非目标

- 不实现完整 L1–L6。
- 不改 AI 提示词、共享调度或复盘。
- 不声称 MT5 调用“恰好一次”。

## 验证

```powershell
npm test -- tests/ai/strategy.test.js tests/ai/scheduler-safety.test.js tests/bridge-ws.test.js
rg -n "mt5Bridge.*'(open|pending)'" server
rg -n 'mt5Bridge.*"(open|pending)"' server
npm test
```

静态搜索只允许统一适配层和测试命中。

## 交付

- 结果文件：`docs/agent-results/20260715-mimo-03-order-intent-gateway-result.md`
- 提交并推送 `origin/dev_codex`。
- 列出每个旧入口如何迁移、uncertain 对账限制和未覆盖的外部 MT5 手工并发。
- 完成后停止。
