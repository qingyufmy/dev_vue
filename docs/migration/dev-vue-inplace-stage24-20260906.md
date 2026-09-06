# 同库升级第二十四批：策略表真实结构承接

2026-09-06。恢复副本演练和当前dev_vue增量执行均已完成，未回填策略业务数据或启动任何任务。

## 实际变更

从同一MySQL实例的既有V4参考库dev_vue_m1_a只读采集strategies、strategy_versions完整SHOW CREATE，保存为[参考结构](dev-vue-strategy-reference-20260906.json)。新增inplace/006_strategy_tables.sql：CREATE strategies、CREATE strategy_versions、追加strategies的当前版本复合外键。第一步保留该外键所需索引，最后只加约束；完成后的两张表定义与参考一致，owner_user_id仍引用原users.id。

006已执行，必须冻结；后续修正只能追加迁移。其3步记录为inplace_005_01–03，复用database_upgrade_steps_v4，不篡改旧schema_migrations。新的strategy adapter验证前23步、完整结构、原始数据、触发器和约束名称冲突，再由顺序DDL执行器操作。

## 恢复副本验收

在dev_vue_m1_source_20260906_01运行3条DDL，分别在第一次CREATE和最后ADD FOREIGN KEY成功后销毁连接并抛出模拟响应丢失错误。重新连接后按结构识别已执行步骤、补记journal；每条DDL只执行一次，随后重复升级为零DDL。两张表行数均为0；原165表271007行原字段哈希与备份一致。

执行工具存于现有备份目录的strategy-rehearsal独立目录，88个脚本/SQL/参考文件逐一SHA-256核对后收集[演练回执](dev-vue-strategy-schema-rehearsal-20260906.json)。这是实际MySQL DDL提交后的故障代理演练，不宣称真实网络随机断包测试。部署、交易和业务回填未参与。

## 当前dev_vue结果

`node scripts/upgrade-dev-vue-strategy-schema.mjs --plan`验证数据库身份、备份、前序结构、原行哈希及演练文件摘要后，显示3步pending。首次`--apply`执行3条DDL，内部重复检查通过；独立第二次`--apply`为0条DDL。

- 当前182张表、26条已完成同库步骤；旧214条迁移历史由原始表哈希校验完整保留。
- 原165表271007行原字段哈希一致；旧策略、账户、归属、任务与信号数据没有转换、删除或修改。
- 新strategies、strategy_versions为空，外键与CHECK保留；未启用策略或发布版本。
- [执行回执](dev-vue-strategy-schema-apply-20260906.json)、[重跑回执](dev-vue-strategy-schema-repeat-20260906.json)分别保存，不相互覆盖。

12项顺序DDL/账户建表定向测试与脚本语法检查通过，真实副本和源库执行证据如上。本批未修改服务源码，没有部署或启动服务。

## 后续与限制

下一步承接旧策略、版本、订阅的字段与ID关系，推进其它同名根冲突；策略表存在不表示业务迁移完成。冻结的旧阶段检查器仍只认识其阶段的22/23步，新业务writer应接入完整26步身份验证后使用，不能绕过未知步骤检查强跑旧入口。现有源库CLI要求两张新表为空，业务回填后应由后续版本入口接管；第三次运行同一CLI会因本地回执已存在而拒绝覆盖，plan仍可用。

历史时间依据、真实账户/归属回填、全域字段合同、最终部署升级入口、旧结构删除及完整业务验收均未完成。整体目标保持进行中。
