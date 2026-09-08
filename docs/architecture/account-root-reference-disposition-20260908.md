# 账户根旧引用处理与切换前置项

依据：[当前库只读证据](account-reference-review-20260908-v4.json)。本次未写数据库，当前库仍由147步协调器通过结构校验。账户映射摘要与前次一致，4条旧账户归并为3个实体；旧ID和原始字段继续保留。

## 当前发现

按列名发现38个账户引用候选，28列有非空数据，其中10列共236处引用指向将被合并的旧ID。这里统计的是字段出现次数，不是236笔交易或236个不同业务对象。只有strategy_subscriptions声明了指向旧账户根的外键，其余不能依赖数据库自动追踪表名变化。

| 旧表/字段 | 合并ID出现次数 | 承接阶段与处理 |
| --- | ---: | --- |
| mt5_account_bindings.current_trading_account_id | 1 | P1：旧事实保留；通过既有身份映射生成新归属，不将旧绑定表直接交给V4读写 |
| mt5_account_ownership_history.trading_account_id | 136 | P1：原历史保留，迁移后的区间与来源映射已在副本对账；当前库仍需回填 |
| strategy_subscriptions.trading_account_id | 1 | P3：旧外键随旧根指向legacy表；订阅自身升级时映射账户ID，未升级前不能用新根解释该字段 |
| ai_position_management_evaluations.trading_account_id | 32 | P4/P5：冻结评估证据，按新任务/执行模型迁移，不原位改写历史推理事实 |
| ai_position_management_tasks.trading_account_id | 21 | P4/P5：区分历史任务与未完成任务，不能让新Worker直接接管旧任务 |
| order_intents.trading_account_id | 11 | P5：同时迁移意图、命令、回执及账户映射；未知执行状态先对账，禁止重新派发 |
| risk_account_state.trading_account_id | 1 | P5：核对账户合并后的限制含义；不能按默认值解除风控或随意覆盖另一旧账户状态 |
| risk_reservations.trading_account_id | 11 | P5：与对应意图/决定/额度保留关联，核查未释放预留后迁移 |
| signal_outcome_deals.trading_account_id | 12 | P5：保留原归因和交易标识，经映射生成新历史，不按账户/时间近似合并成交 |
| signal_outcomes.trading_account_id | 10 | P5：与信号、意图及成交整体对账，保留旧事实与来源 |

以上是迁移职责安排，不是对这些表所有写端口的完整验收。历史读取若要显示旧记录，须经明确的legacy来源及ID映射查询；不能把“旧字段的数值仍存在”当作“可以JOIN新账户根”。

## JSON与字符串证据

扫描类型为JSON或名称包含json/payload/metadata/context/params/config/result/snapshot的179列，共233,395个非空值、448,822,030字节。按明确账户键及account/accounts对象内id检查，发现271处候选、262处匹配现有旧ID、0处匹配合并ID；其余9处不能仅因数值不同就认定为孤儿账户。

初次检查遇到大型复盘证据和gzip-base64快照，随后依据实际大小扩展有界检查，并按旧inference-snapshots.js的显式gzip-base64格式解码789条。最终无大小/遍历限额遗漏，无不安全数字ID。17,411个值不是JSON，主要来自名称匹配的状态、引用文本和策略/记忆正文；这不等于17,411条损坏数据。

该检查不覆盖任意未命名文本、其它编码、嵌套字符串中的JSON或语义不明确的subject_id/aggregate_id等。后续按所属域合同核查这些字段，不能把当前结果表述为全库不存在隐式账户引用。旧快照正文和迁移账本不做批量替换。

## 服务端与运行入口

当前V4源码19个文件包含40个直接账户根SQL字面量：39个SELECT及MysqlAccountRegistration的1个INSERT；写入经账户注册端口进入Bridge同连接事务。查询普遍使用account_login、platform、deleted_at_utc及规范化归属表，因此旧结构不是这些用例的完整运行基础。

旧版写入仍存在于server/admin/user-deletion.js、server/routes/ai/risk-state.js和server/routes/ai/strategy-ownership.js；server/migrations.js也保留旧结构转换逻辑。risk-state中还有通过JOIN读取账户根而实际更新risk_account_state的语句，不能把所有UPDATE候选误算为根表写入者。上述文件留作旧功能/迁移输入，不能在账户根提升后继续写同名新表。

静态SQL不证明进程已停，也不覆盖任意动态SQL。当前V4入口同时组装多个业务域，trading/index仍公开具体repository，封装尚未完成。账户根提升后不能因此启用尚未迁移的订阅/执行等流程；需明确模块就绪条件，不能依赖SQL报错充当业务隔离。

## 下一步

1. 核查本机实际服务进程、数据库连接及启动入口，落实本轮切换的停写条件；当前进程路径搜索不能排除未归属的相对入口。
2. 为账户样板列出查询依赖表和接口就绪条件，补齐其正式结构与真实只读流程；未迁移业务入口保持明确未就绪。
3. 当前库准备独立的账户回填/提升证据，按已验证的恢复协议执行。旧软引用保留在旧业务域，不统一UPDATE；账户根切换不等于全部历史业务迁移完成。
4. 按上表推进各域ID映射和用例，再逐项关闭遗留引用。

第一轮复审：把账户身份合并与旧业务事实保留分开，明确236是引用次数；不把建议阶段当作唯一写入者已落实。第二轮复审：补入旧Worker/旧写入口隔离、未知执行不重放、风控状态不默认解除，以及JSON扫描范围与未解释字段限制。当前结论支持制定切换条件，不单独证明当前库已可开放全部V4功能。
