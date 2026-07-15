# Task 07 交付结果：平仓结果监控与信号归因

> 执行者：Codex。用户取消 Mimo 委派后，由 Codex 直接实现并复审。

## 数据闭环

- migration 062 新增 `signal_outcomes` 与 `signal_outcome_deals`。outcome 以 order intent 唯一，deal 以交易账户 + MT5 deal ticket 唯一，重复扫描不会重复建结果或重复计费。
- 市价单成功后在订单意图事务中创建 outcome；挂单先保存 pending ticket，成交后 pending reconciler 使用原始 deal/position 证据补齐 position、deal 和 Delivery。
- Position Outcome Monitor 每 60 秒只从数据库读取 open/closing outcome，按用户批量查询自最早 outcome 起的历史与当前持仓。Bridge 离线时不改变状态，恢复后从数据库继续补齐，不依赖进程内游标。
- 完整平仓后第一次扫描进入 `closing` 并保存费用哈希；下一次扫描 deals 与费用哈希完全相同才进入 `closed` 并写 `review_eligible_at`。部分平仓始终保持 open。

## MT5 字段映射

- 开仓响应：order → entry order ticket；deal → entry deal ticket；由成交 deal 反查 position_id。
- history deals：ticket/deal_ticket、order、position_id、symbol、type、entry、magic、reason、comment、volume、price、profit、commission、swap、fee、time/time_msc、SL/TP。
- history orders：ticket、position_id、symbol、type/state、magic/reason/comment、初始/剩余手数、开仓/当前价、SL/TP、setup/done 时间。
- 普通历史页面不返回大体积原始 deals；只有 `include_deals=true` 的归因请求才附带原始 deal/order 证据。
- outcome 净损益固定为 `profit + commission + swap + fee`，并保存每个原始 deal 供审计。

## 归因规则

- Hedging：只按完整 MT5 `position_id` 聚合所有入场、部分平仓和最终平仓 deal。
- Netting 单意图：同一 position 只对应一个系统 outcome 时可按完整 position 聚合。
- Netting 多意图：两个及以上 outcome 落到同一 position，或出现无法安全拆分的 INOUT 反转 deal 时，全部标记 `attribution_ambiguous`，不把账户总盈亏伪分到某个信号。
- 外部干预：检测非系统 magic 的成交、实际入场手数超过批准手数、活动持仓 SL/TP 与批准订单不一致，并保存干预原因；外部/手工平仓仍可形成事实结果，但复盘会明确看到干预标记。

## 明确拒绝进入复盘的场景

- 没有由本系统 order intent 创建的旧交易；
- position/deal 证据缺失或 Bridge 历史不可用；
- Netting 多意图无法可靠拆分，状态为 `attribution_ambiguous`；
- 仍为部分平仓、持仓仍存在或费用尚未经过连续两次稳定扫描；
- 同一 pending ticket 消失但 positions/history/deals 均不能证明成交。

## 验证

- 覆盖 Hedging 完整/部分平仓、Netting 单意图、多意图歧义、手续费净损益、外部加仓/手工成交/SL-TP 修改、费用稳定双扫描、Bridge 离线与数据库唯一约束。
- Python Bridge 通过 `py_compile`，静态契约覆盖归因字段和按需原始 deal 输出。
- 全量回归：51 个测试文件、767 项测试通过。
- 真实 MySQL migration、真实 Hedging/Netting 账户和 MT5 deal 原因枚举联调保留到 Task 11。
