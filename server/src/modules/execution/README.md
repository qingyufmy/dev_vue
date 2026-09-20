# Execution 模块边界

负责 operation、intent、命令派发及结果恢复。预留的创建、提交、释放与投影吸收当前归本模块实现，风控判断归 risk；模块整体公开导出与其它跨域 SQL 尚未全部收口。

## 可信投影的同事务能力

`composition.ts` 提供 `createProjectionReservationAbsorber(connection)`，只由运行组装入口注入 trading。实现留在 infrastructure，公开结果仅为已吸收预留 ID；不通过业务 index 导出连接工厂或 SQL。

交易账户可信投影拥有事务：先校验并锁定账户/归属/绑定/连接与投影 revision，写入快照、来源证明和精确 ticket 状态，然后使用同一连接执行吸收。适配器不取得新连接，不开启、提交、回滚或释放事务。

吸收读取本模块的成功 intent/command/result 及 committed 预留，按预留 ID 加锁；要求投影 revision 比命令冻结 revision 新、观察时间不早于完成时间，并通过精确 ticket/字段判断。条件更新后在同事务写审计事件；事件失败必须传播给外层回滚。此批搬迁保持既有 SQL 与算法不变。

验证入口：`mysql-trading-offline-accounts.test.ts` 覆盖实际适配器与同连接编排、成功提交、事件失败回滚及能力缺失拒绝；`bridge-projection-absorption.test.ts` 覆盖精确结果判断。测试连接替身不代表真实 MySQL 锁竞争与恢复验收。

`scripts/verify-projection-absorption-mysql.mjs <新的绝对路径回执>`在当前开发MySQL独立连接建立最小临时InnoDB表，运行构建后的execution适配器，验证真实驱动时间序列化、提交、重复及事件冲突回滚；销毁连接清理临时表。必须先构建server，输出文件不得存在。它不验证正式表/FK、完整投影写入、锁竞争或提交未知。真实验证确认DATETIME(3)拒绝ISO字符串直接绑定，因此写入时间先转换Date，由UTC连接池序列化；非法时间在SQL前拒绝。


投影吸收领域判断使用本域 CommandResultProjection 六字段只读合同，不依赖 trading 应用层类型。交易投影适配由基础设施消费 trading 公开端口，再按结构传入领域判断；完整 Bridge 状态不作为领域依赖。精确票据、部分平仓数量及保护字段判断保持既有规则，定向入口为 server/tests/bridge-projection-absorption.test.ts。
## 业务与运行组装入口

index只公开领域模型、应用端口与用例，不再转导出MySQL/Redis适配器或HTTP路由。composition仅供bootstrap/entrypoints运行组装：绑定数据库、缓存与事务时钟依赖，并通过createExecutionHttp组合operation读取、用户执行命令及分发路由。外层API registrar仅挂载插件，继续在trade Host约束内注册，不直接依赖模块私有路由。

本轮验证：browser-realtime-runtime、execution-intent-persistence-boundary、execution-read-model-routes、user-execution-command-boundary共21项；实际离线Fastify注册96/96匹配合同。剩余内部层次/跨域依赖与SQL所有权仍需处理，适配器迁出index不代表执行链已完成真实终端验收。

领域输入由execution-input定义：动作、JSON事实、风险规则及完整审核回执。execution领域不再导入inference/risk内部类型；边界适配保持结构兼容，不改变持久化字段、canonical JSON、哈希或状态机。应用层调用风险公开能力，适配器通过公开类型解释源数据。已登记导入债务清零，跨域SQL与事务所有权仍须单独验收。107项执行/Bridge/风控回归及服务端类型检查通过。


准备执行时通过 RiskDecisionExecutionWriter 关联风控决策，不再直接写 risk_decisions_v4。关联发生在原执行事务内、bundle写入后且outbox写入前；false转为原 execution_source_revision_conflict，数据库异常传播到原事务处理。API与执行Worker入口注入同连接工厂。

PendingOrderOriginReader公开挂单历史创建来源读取，composition绑定同一事务连接和TradeDecisionOriginReader，内部复用readPendingOrigins。未找到证明返回unresolved；混合策略/非策略来源拒绝。此端口不证明后续生命周期或当前授权。去重快照已复用该能力；测试pending-order-origin-port、pending-origin-reader和pending-dedup-snapshot-reader。


持仓结果分类：market_order/modify_position只将明确position_ticket识别为持仓ticket；当前MT5查询结果须同时满足found/complete、kind=trade、current_state=active_position，才允许读取ticket别名。history_order/history_deal的position_id不能直接作为当前持仓ticket，普通position/ticket无上下文也不采信。结果仍按原状态保存，无法分类记unknown，旧行不重写。持仓创建结果本身尚不证明净持仓的完整策略归属，后续需要稳定position identifier与当前ticket的映射及完整成交沿革。


开仓订单来源：OpeningOrderOriginReader / createMysqlSnapshotOpeningOrderOriginReader在调用者授权一致快照内复用执行账本，支持market_order与pending_order。市价只接受明确order/order_ticket，不用position或裸ticket推断；冲突别名、策略混合证据拒绝，缺证未决。该端口只证明创建归属，不证明当前持仓完整生命周期。验证入口opening-order-origin.test.ts、pending-origin-reader及pending-order-origin-port；真实SQL参考pending-origin-reference.mjs。
# 个人旧执行归档（2026-09-12）

archived-execution-reader 应用端口与 MysqlArchivedExecutionReader 仅读取 order_intents 原用户记录。`/api/v4/history/executions` 采用原 ID 游标，详情返回原状态和票号；legacy_account_id 是旧命名空间，允许 null，不作为新账户操作入口。归档永远 executable=false，不创建或重放 intent。行为验证见 server/tests/history-archive-http.test.ts。
