# 推理基础结构与记忆升级前置修正

状态：现库只读确认，方案待完整参考库和恢复副本验证；不是可直接执行的升级清单。此方案修正接续方案18.77的准入判断。191步完成只证明已登记步骤完成，不证明全部V4物理结构已经具备。

## 当前事实

- dev_vue：191条completed、没有started。inference_snapshots是789行旧表，id BIGINT，不是004要求的CHAR(36) ascii_bin；ai_model_tasks为9317行旧表，以task_id为主标识；strategy_subscriptions是5行旧结构。旧数据全部需要保留。
- 缺少004中9个名字：subscription_schedules、inference_snapshot_payloads、ai_model_attempts、ai_analysis_runs、market_analyses、market_analysis_payloads、ai_trader_runs、trade_decisions、trade_decision_payloads。
- strategies和strategy_versions已存在但各0行，不能由此假设旧策略/订阅已完成业务迁移。
- 恢复副本dev_vue_m1_source_20260910_01的050尝试未获DDL成功确认；后续只读检查确认审计表仍为原结构、record_version不存在，只留下inplace_054_01_strategy_memory_runtime_audit的started记录。此副本保留为失败证据，不删账本、不伪标completed、不继续盲重试。
- 050输入快照CHAR(36)外键与旧BIGINT父键不兼容，属于DDL前置条件遗漏。参考v59使用V4父表，所以其通过不代表现库父表适用。失败包装没有保留原MySQL错误码，原因依据实际父子列定义判断，不能伪称捕获了特定错误码。

## 调整后的执行顺序

1. 完整核对004及其005/006/007后续修改、009/010执行依赖和012记忆外键，复用现有完整目标DDL参考生成器。逐表区分兼容、缺失、同名旧结构，核对所有入站/出站外键、索引、触发器与字段类型。禁止直接对旧库运行004的CREATE IF NOT EXISTS。
2. 沿用已有subscription-root-promotion工作流，建立必要的V4 build表。旧inference_snapshots、ai_model_tasks及订阅保留完整原文/行/ID映射，明确legacy命名空间；最终原子切换需复用映射和反向切换验证，不能直接清空或把旧BIGINT快照ID原地转换为新UUID。
3. 新表外键指向对应已验证build父表；在旧策略/订阅业务映射和运行所需字段完成前，不把空新表提升为业务迁移完成。需要历史浏览的旧快照保留专门读取/映射入口，不把旧提示词无损保存冒充新的analysis/trader执行证据。
4. 推理父表切换和全部结构对账完成后，才重建记忆050升级计划。已失败的第192步计划作废，不编辑其SQL、旧loader、恢复脚本、基线或报告；后续使用新版本计划和新的已验证恢复副本。新准入使用memory-runtime-audit-upgrade-v2，当前明确拒绝旧父表。
5. 对新计划验证started/DDL/completed确认丢失、可恢复状态、全库原值保留、历史账本前缀一致和重复执行零DDL；验证后再升级dev_vue。运行入口随后检查推理、订阅与记忆完整结构，不只检查历史采集191步。

## 两轮复核

第一轮（范围与职责）：推理表归inference，订阅表归strategies，记忆审计归reviews；脚本只协调已核验迁移和快照，不把跨域SQL搬到运行模块。优先解决实际结构缺口，不继续仅在支架库累积通过记录。前端/Bridge产品细节仍后置。

第二轮（兼容与数据）：保护789旧快照、9317旧任务和5旧订阅，并确认实际所有外键关系；禁止覆盖、删旧表、清started或跳过FK。失败副本保留，新恢复副本按备份回执重新校验；旧脚本与证据冻结，新版本追加修正。完整父表类型/用途/摘要字段是必要准入，单独满足这些字段仍不证明整个数据库就绪。

证据：architecture/inference-schema-current-inventory-20260910.json、inference-schema-restored-inventory-20260910.json、memory-audit-restored-prepare/start-loss/ddl-loss-20260910.json。新增v2准入6项测试通过，现库写入0；推理完整结构升级仍未完成。

## 构建候选更新

截至reference-v65，依赖闭合的构建范围为12表（原10张推理表加risk决策/正文），新SQL055包含12CREATE及1条补循环外键的ALTER。现库7个外键父列匹配，候选注册表追加至204步；尚未在现库或新完整恢复副本执行。旧表保持原名和全部数据，订阅数据迁移/原子提升、旧快照/任务可追溯读取和记忆升级仍是后续必做项。

## 完整恢复副本验收结果

新02副本已通过258表338748行完整恢复/源副本准入，随后12CREATE及1循环FK ALTER累计只执行一次，最终204步、270表。开始/DDL/完成确认丢失及最后ALTER确认丢失恢复通过，重放零DDL；旧257张非journal表与191条历史不变。证据见architecture/inference-build-restored-proof-20260910.json。现库inventory-v5仍191步无started，下一步执行其build结构升级；旧业务转换、原子提升及记忆前置仍未完成。

## 当前开发库执行结果

现库已按同一候选完成204步/270表，13DDL应用及零DDL重放均通过，原257张非journal表及旧191条历史不变。独立inventory-v6确认12张build表为空且DDL一致。证据见architecture/inference-build-current-proof-20260910.json。尚未canonical提升或转换旧业务；旧BIGINT快照仍保留，050记忆审计继续等待正确父表与业务前置。
