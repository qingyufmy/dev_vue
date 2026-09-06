# dev_vue 同库升级阶段 59：宏观与经济日历结构承接

本批从 V4 参考库两次读取最终结构，并在隔离恢复副本实际承接宏观/经济日历域 11 张表。当前 dev_vue 仅只读预检，没有执行本批 DDL。

## 范围

追加 `server/db/migrations/inplace/008_macro_tables.sql`，使用最终 SHOW CREATE 定义，包含：macro_data_sources、macro_feature_sets、economic_calendar_events、macro_model_versions、macro_series、macro_ingestion_runs、macro_pipeline_jobs、macro_research_snapshots、economic_calendar_event_revisions、macro_observations、macro_snapshot_observations。

macro_research_snapshots 已在根迁移中经历后续 ALTER；本批使用参考库最终定义，不筛选重放旧初始化文件。外键依赖仅为上述表与原 users，按依赖顺序建表；完整 FK、CHECK、索引、列类型和排序规则保留。没有默认提供商、模型、日历事件或调度任务初始化，没有启动采集或模型请求。

## 实现

- `inplace-macro-schema.mjs`：在原协调器 29 步后扩展 11 步，合计 40 步；旧协调器和演练校验和不变。
- 绑定参考库身份、28 份根迁移校验和、11 张参考表和逐条 SQL；验证外键父表创建顺序。
- 读取新增对象时检查普通表类型、额外触发器及完整结构指纹。
- `review-dev-vue-macro-schema.mjs --write`：当前 dev_vue 一致性只读快照预检，29 completed / 11 pending；原 165 表、271007 行旧列对账一致。
- `rehearse-dev-vue-macro-schema.mjs`：固定恢复副本 dev_vue_m1_source_20260907_02，要求原 29 步完整、宏观表尚未登记；原备份 hash 和执行工具逐文件核验后执行。

## 真实演练

11 条 CREATE 各执行一次。分别在 macro_data_sources、macro_research_snapshots、macro_snapshot_observations 建表成功后主动销毁连接，重连后核对结构，仅补完成日志。3 个故障点全部精确恢复，重复执行 0 DDL；最终 40 步全部完成。

每次执行前及最终完成后校验原结构和原始列数据：165 表、271007 行一致。新增表未写业务行。本批失败边界是已提交 DDL 至完成日志之间，不泛化为全部主机/网络故障已覆盖。

回执 `dev-vue-macro-schema-rehearsal-20260907.json` 的 SHA-256：`c65031f87a7d82c1e61b4feb5e8b1c283b76cc05b9a90e971941909baebdfbfe`。

执行工具包 SHA-256：`d1913e4026aa7a88433f2cb4c10d4aad620cf41e419970bf6ca1fee8ed1c1482`；106 个工具/SQL/参考文件已逐项与本地核验一致。远端证据位于原备份根的 macro-reference-01 和 macro-rehearsal-01，保留；本地临时压缩包已删除。

## 两轮复核及后续

需求复核：一次完整承接宏观结构依赖，不把旧数据迁移简化成建表；参考空表仅证明目标结构，不证明旧宏观数据或内容已经可用。

恢复复核：已有目标不覆盖，完整 40 步预检后执行增量，前 29 步仍严格校验；绑定源码 SQL 与物理参考，旧数据保持不变。60 项定向测试通过，覆盖 11 个新增步骤全部离线响应丢失点、晚期冲突拒绝和已有协调器/演练证据门回归。

008 已在恢复副本执行，必须保持不可变。下一步新增有演练凭据约束的开发库入口，执行当前 dev_vue 的 11 步；之后继续业务映射、数据回填和切换。当前旧的 29 步入口不会自动接受未来 40 步历史，入口接管须显式版本化；完整自动部署升级、旧结构清理仍未完成。
