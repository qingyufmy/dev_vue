# Mimo Task 05：L2/L3/L6 状态型风控与熔断治理

## 前置

- Task 04 已审查通过。
- 分支：`dev_codex`；保留无关未跟踪文件。

## 目标

实现持仓/挂单频率、账户熔断、Kill Switch、观察期和字段级冷静期，并保证并发、重启和 Redis 不可用时仍安全。

## 必须实现

1. 新增/完善 `trading_accounts`、`risk_account_state`、风险预占和恢复申请结构。
2. 账户唯一键为 user + broker server + login；切换账户暂停自动交易并重新审核/观察。
3. 实现 L2：同向持仓+挂单、最小开仓间隔、每日成功开仓数、signal id 幂等和价格/时间去重。
4. 计数与敞口判断和订单意图预占在同一账户锁保护下，防止并发穿透。
5. 实现 R3.1：北京时间日基线、已实现净损益含 commission/swap/fee，加当前浮亏。
6. 实现 R3.2：按完整 position 聚合连续亏损，不把每个 deal 当一笔。
7. 实现 R3.3：资金流校正高水位、持久化 halt、人工恢复请求；数据不足 fail closed。
8. 实现 R3.4：margin level 和总名义敞口；使用真实合约参数和必要汇率。
9. 实现 L6：全局/用户 Kill Switch、字段级放宽冷静期、新账户观察期、账户审核和完整审计。
10. 平仓、减仓、撤单和紧急清仓在所有熔断状态下可用。
11. Redis 不可用时使用 DB；服务重启后状态保留。
12. 用户恢复与管理员恢复均写原因和审计；全局 Kill 仅管理员解除。
13. 添加 20 个并发请求、跨日、重启、资金流、外部持仓和恢复权限测试。

## 非目标

- 不改共享/私有调度。
- 不做复盘、记忆或前端。
- 不把外部 MT5 手工订单伪装为系统订单。

## 验证

```powershell
npm test -- tests/ai/scheduler-safety.test.js tests/bridge-ws.test.js tests/redis.test.js
npm test
```

## 交付

- 结果：`docs/agent-results/20260715-mimo-05-stateful-risk-result.md`
- 提交并推送 `origin/dev_codex`。
- 明确每日开仓计数口径、日亏损分母、资金流处理和 fail-closed 场景。
- 完成后停止。
