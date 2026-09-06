# 同库升级第九批：账户迁移暂存结构

当前 dev_vue 已完成四张账户迁移暂存表：trading_accounts_v4_build、trading_account_ownership_intervals_v4_build、trading_account_ownerships_v4_build、user_trading_account_settings_v4_build。旧账户表未改名，业务数据未回填，运行开关未启用。本批不涉及公网。

设计和两轮复核见 [账户承接设计](dev-vue-account-build-design-20260906.md)。四张表保留目标结构的生成列、唯一约束、组合外键与时间 CHECK，引用当前 users，并在同库承接目标账户实体。SQL 004 已执行，后续不得修改。

## 真实验证

- 恢复副本 dev_vue_m1_source_20260906_01 实际模拟首张表建成后连接中断；重新连接后识别已落地结构，补记完成，再建立其余三张表。总计四次 DDL，重复运行无新增 DDL。
- 源 dev_vue 实际执行四次 CREATE，内部重复执行及独立再次运行全部通过，后者 DDL 为零。
- 原有 165 张表、271007 行原有列内容哈希与备份证据一致。四张新增表均为空。
- 当前实查 179 张表、22 条 completed 升级记录，旧 schema_migrations 214 条保留。
- account-build 与 foundation 定向测试合计 8 项通过。

证据：[演练](dev-vue-account-build-rehearsal-20260906.json)、[源库执行](dev-vue-account-build-apply-20260906.json)、[独立重复执行](dev-vue-account-build-repeat-20260906.json)。执行证据绑定工具文件、步骤 checksum、MySQL 实例和备份快照。

当前阶段入口为 `node scripts/upgrade-dev-vue-account-build.mjs --plan|--apply`。早期阶段入口不认识新增日志步骤，不能用作当前全量升级入口。本入口仍绑定本次冻结源数据，也不是最终部署自动升级命令。

## 后续工作

完成账户实体及个人设置的全字段转换、稳定 ID 映射持久化、归属数据回填和逐项对账；历史 DATETIME 转 UTC 仍需明确历史写入时区。随后实现受控原子表名切换、应用读取验收和恢复流程，再处理其他领域及已替代结构删除。当前暂存结构不能代表业务迁移或全面规范化已经完成。
