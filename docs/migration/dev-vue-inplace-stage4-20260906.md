# 同库升级第四批：开发源库首批增量已执行

2026-09-06 13:28:48 UTC，当前 `.env` 指定的 `dev_vue` 首批九列增量执行完成。13:29:40 UTC 重复执行，九步全部为 `completed`，未再次执行 DDL。整体规范化、业务数据转换、新表承接和旧结构删除尚未完成。

## 实际结果

- `users` 新增 `last_seen_at_utc`、`profile_revision`。
- `bridge_refresh_sessions` 新增七列：`credential_version`、`installation_id`、`profile_id`、`generation`、`migration_key`、`source_fingerprint`、`source_refresh_session_id`。旧凭据默认版本为 3，未自动授予 V4 身份；未推算旧历史时间。
- 新建独立 `database_upgrade_steps_v4`，九步完成回执均已持久保存。旧 `schema_migrations` 214 条记录保留。独立只读复核当前 166 张表（165 张原表加一张升级日志）。
- 首次与重复执行均完整扫描 165 张原有表的全部原有列，271,007 行按主键有序哈希与恢复演练证据一致；新增列之外的 SHOW CREATE 结构也与备份基线一致。

执行回执：[首次升级](./dev-vue-inplace-apply-20260906.json)、[重复执行](./dev-vue-inplace-repeat-20260906.json)。备份密文在执行前重新读取完整 SHA-256，与第三批回执一致；口令仍为 root/0600，未输出其内容。

## 自动执行入口

从仓库根目录执行，连接信息只读取 `server/.env`，目标必须是 `dev_vue`。实际执行还核对实例 UUID、备份与演练的快照对应关系，以及已演练 SQL、执行核心和 MySQL 适配器的完整文件哈希。

```powershell
node scripts/upgrade-dev-vue-columns.mjs --plan
node scripts/upgrade-dev-vue-columns.mjs --apply docs/migration/dev-vue-inplace-backup-20260906.json docs/migration/dev-vue-inplace-column-rehearsal-20260906.json docs/migration/dev-vue-inplace-rehearsal-tools-20260906.json
```

第二条命令可非交互运行。当前范围只支持这批九列；它还不是整个 V4 的部署升级入口。当前规则要求原有结构与数据继续匹配所绑定的备份；发生新业务写入或其它结构变更后，会拒绝使用这份旧基线，须更新对应备份与验证证据。不能通过改 JSON 的摘要、跳过对账或伪造完成回执绕过。

## 恢复与剩余工作

DDL 前持有命名锁，先验证全批状态；新日志先持久写 started，再执行对应 DDL，读取后置结构后记 completed。已提交 DDL 丢失完成回执时，重连后可识别实际列并继续；九列之外的结构差异仍会阻断。恢复演练证据见第三批报告。

本次执行后的两份 SQL 已进入共享环境，`server/db/migrations/inplace/001_upgrade_journal.sql` 与 `002_user_bridge_columns.sql` 正文冻结，后续结构修正只能追加。原 bootstrap 与编号 001–025 也保持冻结。

12 项定向测试、语法和 diff 检查通过；真实源库首次执行、重复执行和独立只读回执计数验证通过。没有重启、部署、切换 V4 运行开关或接触终端。

下一批应处理其余同名表兼容及新表外键依赖，逐域承接旧事实并对账，补齐索引、时间/精度转换和业务可用性。已有 SQL 含跨表外键，不能简单把 101 张目标专有表一次性复制进来并声称迁移完成。最后按实际数据去向和业务引用逐项删除已替代结构。
