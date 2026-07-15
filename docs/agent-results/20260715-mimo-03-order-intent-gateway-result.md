# Task 03 交付结果：订单意图、幂等与统一开仓入口

> 执行者：Codex。用户取消 Mimo 委派后，由 Codex 直接完成实现、审查与验证。

## 完成内容

- migration 058 新增 `order_intents` 与 `risk_reservations`，包含幂等键、租约、状态、交易/挂单 ticket、Bridge 短引用和必要索引。
- 新增 `prepareAndExecuteOrderIntent()`，在短事务中锁定用户与交易账户、创建风险预占并取得发送租约；Bridge 网络调用严格位于事务外。
- 手工下单强制 `client_request_id`；自动信号幂等键包含 signal、user、trading account；网页端在一次订单编辑会话中复用请求 ID。
- Bridge 明确拒绝时释放预占；超时、连接异常或发送后落库失败进入 `uncertain`，保留预占并禁止自动重发。
- 后台对账器以安全短 comment/ticket 查询挂单、持仓与历史，区分写入 `pending_ticket` 或 `trade_ticket`；过期的发送前租约可回收，已经进入 Bridge 发送阶段的过期租约转为 `uncertain`。
- 保持平仓、减仓和撤单为独立入口，不受统一开仓网关阻断。

## 旧入口迁移

| 旧入口 | 新调用链 |
| --- | --- |
| 手工网页下单 | `bridge-ws open` → `executeOrderCore` → `prepareAndExecuteOrderIntent` |
| AI 分析后自动执行 | `strategy.handleAnalyze` → `executeOrder` → 统一网关 |
| 自动推理 Delivery | `scheduler` → `executeOrder` → 统一网关 |
| 信号页立即执行 | `bridge-ws execute` → `executeOrderCore` → 统一网关 |
| 兼容挂单转换 | `executeOrderCore` 内生成 pending payload → 统一网关 |

服务端新增订单的 `open`/`pending` Bridge 调用只保留在 `server/routes/ai/order-intents.js` 统一适配层。

## uncertain 边界

- 未确认结果不会当作普通失败，也不会自动释放风险预占或自动重发。
- 当前对账依赖 MT5 Bridge 返回 comment/ticket；若券商截断或覆盖 comment 且没有可关联 ticket，需要人工确认。
- 无法约束绕过本服务直接在 MT5 终端、EA 或其他系统产生的并发订单；后续状态型风控会按账户快照将这些外部仓位纳入风险计算。

## 验证

- 订单网关、策略、调度器和 Bridge 定向回归：4 个文件、99 项测试通过。
- 全量回归：46 个文件、720 项测试通过。
- 静态搜索确认服务端新增订单 Bridge 调用仅位于统一订单意图适配层。
- 对应 migration 已在真实 MySQL 应用并通过 readiness；真实 MT5 Bridge 开仓/挂单仍需在 Kill Switch 开启或模拟账户环境做生产前冒烟。
