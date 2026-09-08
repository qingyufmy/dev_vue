# 阶段198：用量策略引用容量与目标外键签名

当前dev_vue累计145步。ai_model_usage_logs.strategy_id已扩大为BIGINT UNSIGNED NULL，原12139行策略ID1–3及1个NULL保留，不重映射旧策略。恢复副本DDL后异常reconcile、重复0DDL，当前库执行1DDL/重复0DDL；全221业务表271337行、其它结构及自增值保持。19项定向迁移测试通过。

独立复核当前145步、222表、3275列、789索引、117CHECK、104外键；总271482行包含145条升级日志。原165表及原字段均保留，现有104FK/117CHECK再次全量核对，无孤立引用、违规行或禁用CHECK。剩余类型差异从11减到10。

对现存同名目标表的70个目标外键进一步比对列顺序、父表/父列及更新/删除动作（RESTRICT与NO ACTION按相同立即拒绝语义比较），54个签名匹配；11个缺子字段，2个历史user_id=0，1个推理快照策略根类型/映射差异。另2个订阅用户/账户引用需要补充独立处置：当前5条订阅两组孤立数0，可继续核验目标SQL、类型和历史合同后实施；不能以根表还有缺列为由直接豁免。

证据：[预检](dev-vue-usage-strategy-capacity-source-20260908.json)、[恢复演练](dev-vue-usage-strategy-capacity-rehearsal-20260908.json)、[当前库升级](dev-vue-usage-strategy-capacity-upgrade-20260908.json)、[现有约束重验](dev-vue-current-relations-review-20260908-v2.json)、[目标外键签名](dev-vue-target-foreign-key-signatures-20260908.json)、[目录v9](dev-vue-structure-remaining-work-20260908-v9.json)、[两轮复审](../database-usage-strategy-capacity-plan-20260908.md)。

当前入口node scripts/upgrade-usage-strategy-capacity-local.mjs --check/--apply <新绝对路径回执.json>。目录、类型、全库关系检查器均接续145步。未启动应用或公网操作；独立结构收口仍需订阅关系及最终覆盖验收。
