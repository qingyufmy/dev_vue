# M1 B1：备份预检与恢复观测工具

> 2026-09-05；B1 首批工具实施记录。只有本地源码与离线测试，不是备份完成或恢复成功证明。
> 前置方案：[源备份、字段映射与回填对账](./stage-m1-data-backfill-and-reconciliation-plan.md)。
> 后续现场记录：[服务器备份条件只读核验](./stage-m1-b1-server-backup-readiness.md)；工具与容量已检查，实际加密备份/恢复仍未执行。

## 1. 本次范围与未执行事项

本次增加独立 CLI `scripts/verify-v4-backup.mjs`，不进入服务启动、PM2、队列或业务 Repository。它只提供观测、参数预览、文件完整性校验和两份观测的比较。

**不提供 export/create/restore/apply/cleanup 命令**。没有导出用户数据、SSH/真实数据库连接、建库、导入、回填、删除、配置修改、部署或终端操作。实际备份和恢复必须先确认存储、加密工具/密钥保管、DDL 窗口和准确库名，再实现并审核执行适配器。B1 整体尚未完成，不能据此开始 B2 回填。

## 2. 模块与入口

| 模块 | 职责 |
| --- | --- |
| `scripts/lib/v4-backup-preflight.mjs` | 校验连接身份，只读取得源或恢复源的结构指纹、类型与精确计数 |
| `scripts/lib/v4-backup-artifact.mjs` | 流式校验现有文件大小/SHA-256；生成不可执行的 mysqldump 参数预览 |
| `scripts/lib/v4-backup-observation.mjs` | 比较两份观测的结构与计数，保留证据等级边界 |
| `scripts/verify-v4-backup.mjs` | 严格命令参数、独立环境变量、脱敏错误、退出码；不读取 `.env` |

无需新运行依赖、数据库迁移或常驻服务。文件读取上限、表数量、查询和整体观测时间均受控。

### 2.1 离线可运行命令

```powershell
pnpm run verify:v4-backup help
pnpm run verify:v4-backup dump-plan --mysql-version=8.4.8 --dump-version=8.4.8
```

第二条只预览调用参数，不会发现/启动本机 mysqldump；传入版本是待现场核验的输入，不是已探测版本。生成结果为 `executable:false`，显式列出未通过的执行门。

参数在原方案基础上增加 `--skip-add-drop-table`、`--skip-add-locks` 和 `--complete-insert`：避免默认输出包含覆盖旧表的 DROP、恢复期表锁，并写明 INSERT 列名；不使用 `--compact` 以免连字符集设置一并关闭。所有选项仍须在实际客户端复核。[MySQL 8.4 官方参数说明](https://dev.mysql.com/doc/refman/8.4/en/mysqldump.html)

已有文件的离线校验接口：

```text
node scripts/verify-v4-backup.mjs verify-artifact --file=<绝对路径> --sha256=<可信来源的64位小写hash> --bytes=<精确正整数字符串>
node scripts/verify-v4-backup.mjs compare-observations --baseline=<绝对路径> --baseline-sha256=<hash> --actual=<绝对路径> --actual-sha256=<hash>
```

hash 和大小必须来自另行保管/审核的记录；攻击者可同时修改文件和期望 hash 时，该检查不提供真实性证明。相同 hash 也不证明 SQL 安全、解密成功或恢复可用。

### 2.2 获批后才能运行的数据库观测

命令为 `inspect-source` 或 `inspect-restored`，必须显式设置：

- `V4_BACKUP_DATABASE`：源只能 `dev_vue`；恢复源只能 `dev_vue_m1_source_YYYYMMDD_NN`，且必须与本次授权名称一致。
- `V4_BACKUP_SERVER_UUID`：现场确认的实例 UUID。
- `V4_BACKUP_SOCKET_PATH`、`V4_BACKUP_USER`、`V4_BACKUP_PASSWORD`：通过受控环境注入，不输出、不传命令参数、不入 Git。

此首版仅支持在数据库 Linux 主机上通过 Unix socket 执行（外层可用已授权 SSH），不偷偷回退到 TCP，也不接受生产/其它库或 A/B 目标作为恢复源。正则校验只限制名称形状，**不能替代用户对具体库名的授权**。

观测在同一独立连接显式设置 UTC、REPEATABLE READ，开启只读一致性事务并最终 ROLLBACK；不假设实例默认隔离级别。MySQL 的 CONSISTENT SNAPSHOT 不会自动切换隔离级别。[MySQL 事务说明](https://dev.mysql.com/doc/refman/8.4/en/commit.html) 它只读列元数据、表结构和 COUNT，不读密码/用户行/推理正文；输出结构 hash，不输出 DDL/default/comment 等可能含字面量的内容。若出现首版不支持的对象、非 InnoDB、缺主键或结构漂移，明确拒绝，不自动修复。

元数据不受 InnoDB 数据快照完整保护，前后结构检查仅发现部分漂移，仍需外部确认无 DDL 窗口。包括自增状态的指纹变化也会保守阻断，不能通过忽略字段掩盖。

## 3. 输出和失败边界

- 精确行数以十进制字符串返回/比较，超过 JS 安全整数仍不丢精度。
- 文件校验使用固定大小 chunk，不把大 dump 一次性载入内存；拒绝目录、硬链接和路径中的符号链接/junction；读取前后检查文件身份和变化。
- 观测 JSON 最大 8 MiB；验证 hash 后读取时再验 hash，避免读取变化后的内容。
- 错误只输出稳定机器码，不输出底层 SQL、文件路径、凭据或内部堆栈。
- 结构/计数不同退出 1；相同也返回 `scope:schema_and_counts_only`、`sourceSnapshotBound:false`、`rowContentsVerified:false`、`migrationReady:false`。
- 原库观测与 mysqldump 不是同一个事务。即便恢复计数吻合，也不能把这份观测当作导出快照的原始真相。逐行值、归属、金额、载荷和冻结源绑定仍须后续实现。

## 4. 两轮实现复审

第一轮（需求/模块/复杂度）：保留独立工具，不建立 ETL 服务；复用已有结构指纹，备份、恢复和业务回填分离。将“工具具备检查能力”与“已执行备份恢复”分开。未确认密钥/路径时不提前接通写操作。

第二轮（安全/异常/数据）：严格连接身份与目标名称、禁止环境回退、禁止 SQL 文件执行、错误脱敏、精确计数、分块 hash、链接路径拒绝；任何哈希/计数结果都不升级为用户数据迁移完成。离线 Mock 不能证明实际数据库权限足够、备份完整或 Linux 工具可用。

## 5. 验证与下一步

本地验证：新工具 4 files / 23 tests，通过；合并原迁移执行/恢复/纠正/指纹、基础结构、目标预检和交易历史聚合对账回归，共 **11 files / 79 tests，通过**。四个新 MJS 文件语法检查、CLI help/参数预览、文档本地链接与 `git diff --check` 通过。

```powershell
pnpm exec vitest run tests/v4-backup-preflight.test.js tests/v4-backup-artifact.test.js tests/v4-backup-observation.test.js tests/v4-backup-cli.test.js tests/v4-schema-migration-runner.test.js tests/v4-migration-recovery.test.js tests/v4-migration-corrections.test.js tests/v4-schema-fingerprint.test.js tests/v4-foundation-schema.test.js tests/v4-migration-target-preflight.test.js tests/trade-history-migration-rehearsal.test.js
```

复核后额外补了精确恢复库成功路径、复合主键顺序/重复拒绝、COUNT 超出安全整数拒绝和不可取消连接拒绝；没有用 fake 的缺失 STATISTICS 当作真实数据库兼容情况。查询超时销毁连接，CLI 连接关闭也有上限。

剩余现场门：实际元数据/备份权限可能影响可见对象范围，须与独立批准清单交叉核验，不能把当前账号看到的 0 个对象当作全实例权限证明；Linux socket、磁盘/文件权限、客户端版本、加密/解密、SQL 作用域审查和真正恢复均未验收。未更改前端、V4 业务源码或已执行迁移，因此本轮未重跑全前端构建，也不宣称业务运行验证。

下一步先确认并检查：备份私有目录、磁盘容量、现成加密工具与密钥独立保管位置、准确恢复源库。随后才实施导出/恢复执行适配器及真实演练；不得直接拿预览参数交给 shell 执行。现有 `dev_vue_m1_a`、`dev_vue_m1_b` 继续保持原样，暂不写业务数据。
