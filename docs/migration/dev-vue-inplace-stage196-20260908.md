# 阶段196：基础域关系完整性

当前dev_vue累计144步、222表、789索引、117CHECK、104外键。本批5个目标外键：Bridge会话用户、默认模型配置的模型、能力配置的模型/验证用户、用量日志的模型；MySQL为验证用户与用量模型自动建立两个辅助索引，已纳入完整DDL指纹。均无级联删除/更新。

恢复副本5次DDL后异常全部reconcile，重复0DDL；5次无效引用UPDATE均以ER_NO_REFERENCED_ROW_2拒绝，事务回滚后全部业务表的行摘要、结构、自增值不变。当前开发库执行5DDL、重复0DDL，同样保护221张业务表271337行；独立只读完整目录再次确认144步，原165表和原字段完整。总271481行包含144条升级日志。20项定向测试通过，包含历史索引/约束状态衔接与5点异常恢复。

7组基础关系中两组仍需历史合同配合：user_model_defaults.user_id存在1条孤立记录，ai_model_usage_logs.user_id存在11787条孤立记录。两条用户外键没有安装，不删除历史、补用户0、重映射用户或置NULL。对应模型设置、平台用量/审计迁移阶段明确来源分类及新写入约束后补齐。模型ID引用本批单独完成，不以用户孤立记录阻断可独立关系。

证据：[源预检](dev-vue-foundation-foreign-key-source-20260908.json)、[恢复演练](dev-vue-foundation-foreign-key-rehearsal-20260908.json)、[真实拒绝验证](dev-vue-foundation-foreign-key-enforcement-20260908.json)、[开发库升级](dev-vue-foundation-foreign-key-upgrade-20260908.json)、[目录v8](dev-vue-structure-remaining-work-20260908-v8.json)、[两轮复审](../database-foundation-foreign-key-plan-20260908.md)。

当前入口为node scripts/upgrade-foundation-foreign-key-local.mjs --check/--apply <新绝对路径回执.json>；目录与类型工具现在要求144步。未启动应用、Redis、Bridge或部署公网。剩余全域关系语义、排序保留依据及源/目标覆盖仍须完成最终核对，整体目标继续。
