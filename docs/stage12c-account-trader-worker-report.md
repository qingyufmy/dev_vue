# 阶段 12C：账户级 Trader Worker 验收记录

> 日期：2026-09-03  
> 范围：账户级 AI 交易员冻结上下文、模型任务、同账户租约、结构化决定与迟到结果拦截  
> 明确不包含：真实模型供应商接线、确定性风控决策、`execution_intent`、Bridge 指令、MT4/MT5 交易、迁移执行

## 1. 本阶段结论

阶段 12C 已把 Stage 12B 产生的 `ai_trader_runs` 从“只排队”推进为可离线驱动的账户级 Trader Worker。每次任务只处理一个系统用户拥有的一个交易账户，并冻结：

- 有效市场分析及 revision、内容哈希和有效期；
- 当前交易策略版本及提示词哈希；
- 订阅 revision 和 `entry/manage/both` 任务模式；
- 账户资金指标、全部持仓、全部挂单；
- 目标品种 Bid/Ask 报价和经纪商合约规格；
- 服务端只读风险摘要；
- 上述资源各自的 revision 与快照哈希。

模型只返回结构化 `trade_decision`。它不能调用 Bridge，也不会建立订单意图。候选动作必须包含独立 `action_id`、受支持的动作类型、动作参数和与冻结快照完全一致的 `expected_state`。

## 2. 并发与时效规则

1. Worker 开始前先锁定交易账户，再检查该账户是否已有未到期的 Trader 模型任务。
2. 同一交易账户同一时刻最多有一个运行中的 Trader 模型任务；后到任务返回 `trader_account_busy` 并延后领取，不调用模型。
3. 账户级 fencing token 按该账户历史 Trader task 单调增加；attempt 重试继续使用同一 token 和同一冻结快照。
4. 新市场分析替代旧任务时，在同一事务内同时过期旧 Trader run、model task 和运行中的 attempt，避免遗留租约阻塞新任务。
5. 模型返回后再次检查分析、订阅、账户、持仓、挂单、报价、合约和风险 revision。若变化，决定仍保存用于审计，但状态为 `stale` 并记录 `stale_reason`。
6. HTTP 返回完整决定；实时事件只发送决定 ID、账户、分析、动作、方向、置信度、状态和过期原因，不推送完整推理正文。

## 3. 数据库变化

新增显式迁移 `server/db/migrations/20260903_006_account_trader_worker.sql`：

- `market_instrument_snapshots`：目标账户和品种的合约规格只读投影；
- `account_risk_summaries`：账户确定性风险摘要只读投影；
- `ai_trader_runs` 增加分析、账户、报价、合约和风险 revision；
- `trade_decisions` 增加 `stale_reason`；
- `ai_model_tasks` 增加账户租约查询索引。

迁移是追加式的，不删除、不清空旧表，也未在本地数据库执行。旧版数据后续仍按有界批次、checkpoint 和对账结果迁移。

## 4. 第一轮复审

发现：新分析原来只会把旧 Trader run 标记为过期，但旧 run 已创建的模型 task/attempt 仍可能持有账户租约，导致新任务在 deadline 前无法领取。

调整：新增事务内的 `expireSupersededTraderRuns`，按稳定顺序锁定旧 run 和 task，并一起过期 run、task、attempt。

## 5. 第二轮复审

发现：旧的持仓/挂单读取用“当前列表中最大的 item revision”代表集合 revision。空列表无法表达“已确认清空后的新 revision”，会让冻结上下文误判。

调整：`MysqlTradingRepository` 改为始终读取 `trading_projection_revisions` 的集合 revision，列表为空时也能保留桥接端确认过的最新版本。

## 6. 剩余风险与后续边界

- 合约规格和风险摘要目前只有规范化读模型；其投影写入和旧数据回填尚未接线。缺失时 Trader Worker 失败关闭，不猜测默认值。
- 真实模型网关仍未接入，因此当前验证只证明任务、快照、重试和状态机合同，不证明供应商延迟与输出质量。
- 报价 revision 秒级变化时，长耗时模型结果可能频繁标记 `stale`。后续不得简单放宽；应由确定性执行前“重新报价 + 最大价格偏移 + quote age”规则决定能否从旧建议生成新订单参数。
- `trade_decision` 仍不是订单。下一阶段只有在风险策略、账户状态、报价和 expected state 全部通过后，才可以设计 `execution_intent`。

## 7. 后续阶段建议

下一阶段为 12D“确定性风险策略与决定评审”：实现规范化风险策略版本、账户级覆盖、风险摘要投影和对 `trade_decision` 的确定性评审。该阶段仍应先完成离线风险合同与迁移，不直接执行 MT4/MT5 交易。

## 8. 验证结果

- `pnpm test`：219 个测试文件、3428 项测试全部通过；当前 Codex 子进程需把 `PSModulePath` 临时限定为标准 Windows PowerShell 模块目录，才能让两项既有 Bridge 打包测试自动加载 `Get-FileHash`，未修改 Bridge 代码。
- `pnpm run typecheck:server`：通过。
- `pnpm run test:frontend`：通过，前端边界校验及 23 项测试全部通过。
- `pnpm run typecheck:frontend`：通过。
- `pnpm run build:frontend`：通过。
- OpenAPI V4 与 Browser Realtime V4 JSON：解析通过。
- `git diff --check`：通过。
