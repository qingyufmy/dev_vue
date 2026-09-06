# 同库升级第六批：身份与迁移基础表已落库

2026-09-06 13:49:36 UTC，当前 `dev_vue` 新增九张表，13:50:21 UTC 重复执行全部为 completed，无重复 DDL。独立只读复核：175 张表、18 条同库升级完成回执、旧 schema_migrations 214 条记录。

## 本批范围与业务边界

新增 auth_sessions、auth_authorization_codes、terminal_profiles、bridge_connection_capacity_grants、data_migration_runs、data_migration_checkpoints、data_migration_batches、data_migration_id_maps、data_migration_row_receipts。

完整定义只读取自当前 V4 参考库 dev_vue_m1_a，九表均为零行；[参考定义](./dev-vue-inplace-foundation-reference-20260906.json) 已保存。生成独立追加 SQL `server/db/migrations/inplace/003_identity_migration_tables.sql`，与原编号迁移的来源、checksum 绑定。选中的每张表在原计划仅有一条 CREATE，没有被遗漏的后置 ALTER。本 SQL 已在恢复副本和开发源库执行，正文从此冻结。

这九张表均为空结构，没有复制旧授权码、复活会话、登记可执行任务或激活连接额度。原会员权益仍保留在旧事实中；新结构接通业务前必须完成额度与账户事实转换，不可把空表当成业务迁移完成。没有启用 V4 运行开关、重启应用或接触交易终端。

## 执行器与真实恢复过程

执行器复用 database_upgrade_steps_v4，在统一的 18 步注册表上校验全部历史；然后调用冻结的首批列执行器验证其九列。新表以完整 SHOW CREATE 定义、约束和触发器检查作为后置条件，未知表、错误定义、历史缺口或 checksum 改变均拒绝。

副本演练有两个实际发现，均保留旧工具目录，没有删除或重建已成功的表：

1. 首张 auth_sessions 创建并断开连接后，重新读取时 MySQL 为 utf8mb4_unicode_ci 列补显了 CHARACTER SET utf8mb4。首版文本比较拒绝这项等价表示，日志停在 started。修正只消除该显式重复字符集声明，保留排序规则、类型和键；原 SQL 与步骤 checksum 没变。
2. recovery-01 从该 started 恢复为 reconciled，完成其余八表，重复执行通过，原数据哈希一致；最后空表检查把驱动返回的字符串 "0" 与数值 0 严格比较，发生误报。修复为精确字符串计数检查。recovery-02 仅核对全部 completed 的现场，没有执行 DDL，并生成正式回执。

[演练回执](./dev-vue-inplace-foundation-rehearsal-20260906.json) 明确 verificationOfCompletedRun=true、ddlExecutionsThisVerification=0。ddlExecutions=9 是前两次执行累计通过检查的建表数，不表示最终复核执行了九次 DDL。最终读取全部原有列时，165 张原表、271007 行完整哈希仍匹配首批恢复证据；九张新表均零行。

[实际工具清单](./dev-vue-inplace-foundation-tools-20260906.json) 保存最终恢复工具与原迁移输入共 35 个文件摘要，已与工作区逐项核对。旧目录、recovery-01 和 recovery-02 分开保留，原备份未覆盖。

## 开发库执行与复跑

新入口要求首批九列已经完成，先校验全注册表、父约束名称冲突、原库完整结构及原有数据与备份匹配，再逐表执行。执行完再次验证原结构及全部原有列。实际证据：[首次执行](./dev-vue-inplace-foundation-apply-20260906.json)、[重复执行](./dev-vue-inplace-foundation-repeat-20260906.json)。

```powershell
node scripts/upgrade-dev-vue-foundation.mjs --plan
node scripts/upgrade-dev-vue-foundation.mjs --apply docs/migration/dev-vue-inplace-backup-20260906.json docs/migration/dev-vue-inplace-column-rehearsal-20260906.json docs/migration/dev-vue-inplace-foundation-rehearsal-20260906.json docs/migration/dev-vue-inplace-foundation-tools-20260906.json
```

进入本批后用新入口检查整个已注册历史；旧 columns 入口只认识前九步，会拒绝后续日志，不再作为当前库入口。各批入口仍需收敛为最终完整部署升级命令，当前不是全量自动升级完成。

8 项定向测试通过（5 项新执行器/定义恢复、3 项旧数据证据检查），Node/Python 语法与 diff 检查通过；真实副本恢复、开发源库首次/重复执行及独立计数均已完成。普通命名锁只协调遵守该协议的升级进程，不替代最终全域迁移的停写策略。

## 下一步

优先将账户公共实体、个人设置、历史归属及连接额度迁入新权威结构，复用已有账户映射候选、ID map、receipt 和 checkpoint 工具。继续解决账户、订阅、快照和任务四项根结构冲突，再开放其余依赖表。活动业务需要新 API 实际读取和使用这些事实，之后才能删除对应旧结构；本批尚未删除表或字段，完整规范化目标保持进行中。
