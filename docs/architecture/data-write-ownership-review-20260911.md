# 当前服务端写入归属复核

2026-09-11。本次检查 server/src 源码，不连接数据库、不执行迁移，不代表全库数据语义验收。

## 当前结果

`sql-write-inventory-20260911.json` 覆盖 117 个静态写入目标、374 个候选。唯一多域写入目标是 outbox_events：业务域在原事务追加事件，outbox 管理投递状态，不能为了单一写入者数字拆开事务。

对照 20260908 的矩阵，除 outbox 和风险预留两表外，已有明确建议归属的静态写入表与当前模块一致。风险预留及其事件现在由 execution 管理，与 trade-execution-state-machine 中执行准备、未知结果继续占用、结果提交/释放的生命周期一致；风险政策和审批记录仍由 risk 管理。旧矩阵的 risk 归属不能继续用作这两张表的开发指导。

## 旧矩阵缺失的当前写入表

| 当前职责归属 | 表 |
|---|---|
| trading：上下文、品种采集与终端时钟事实 | trading_context_changes_v4、instrument_collection_requests_v4、terminal_clock_observations_v4 |
| strategies：策略写入回执及订阅偏好 | strategy_write_receipts_v4、subscription_execution_preferences |
| risk：政策写入回执 | risk_policy_write_receipts |
| trade-history：历史采集任务与来源回执 | history_collection_tasks_v4、terminal_history_collection_receipts_v4、terminal_history_deal_provenance_v4、terminal_history_order_provenance_v4 |
| reviews：候选、复盘任务与回执 | manual_candidate_tasks_v4、manual_review_candidate_evidence_v4、system_review_tasks_v4、period_review_workflows_v4、review_write_receipts_v4 |
| execution：部分平仓和保护工作流 | partial_close_parent_dispatches_v4、partial_close_workflow_events_v4、partial_close_workflows_v4、position_protection_commands_v4、position_protection_dispatches_v4、position_protection_outcomes_v4、position_protection_reviews_v4、position_protection_unissued_expiries_v4 |

以上记录当前实现职责，不对历史表删除或自动移动数据作授权。具体静态写入位置保存在清单的 evidence 字段。

## 未解析候选人工核查

22 个候选逐项保存于 `sql-unresolved-review-20260911.json`，含当前源文件 SHA-256：

- 16 个是锁模式 update、类型方法 create 或 SHOW CREATE TABLE 返回键等字符串，未构成 SQL 写入。
- 2 个 WITH 查询最终为 SELECT，分别读取宏观数据和历史日汇总。
- 1 个 JOIN UPDATE 只修改 risk_reservations_v4，execution 拥有事务。
- 1 个动态恢复 UPDATE 的目标固定为 ai_analysis_runs/ai_trader_runs，由 inference 拥有。
- 2 个快照替换写入的表类型固定为 open_position_snapshots/pending_order_snapshots，由 trading 在同事务替换。

这份人工记录不能自动豁免新 SQL，文件变化后须重新核对。

## 尚未关闭的范围

121 个间接 execute/query 调用已按当前源码追踪，记录见 `sql-indirect-call-review-20260911.json`：110 个 SELECT、10 个业务写入端口、1 个 Bridge 历史查询端口。源文件哈希相同的条目复用既有逐项记录；变化的条目重查调用点和查询常量/构造器。10 个业务调用包含新增的上下文写入适配及 HTTP 入口，最终进入所属域事务，并非路由直接 SQL。SELECT 包含锁定读取，不能据分类将其移出事务。

这次分类未发现新的间接 SQL 写入目标。数据库对象、旧服务、历史表和只读跨域 SQL 的业务契约不在此静态结论范围内。还需将当前数据库目录和功能矩阵与各域读写入口对应，不能以“仅 outbox 多写入”宣布完全模块化。
