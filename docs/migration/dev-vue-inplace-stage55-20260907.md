# dev_vue 同库升级阶段 55：统一开发库结构升级命令

## 本批结果

新增 `pnpm run upgrade:dev-vue-schema --plan` 与 `pnpm run upgrade:dev-vue-schema --apply`，统一调用已经过真实恢复副本演练的 29 步结构协调器。

实际对当前 `server/.env` 指定的 dev_vue 运行 plan 和 apply：29 步均已完成，DDL 0 次、日志写入 0 次；执行前后原 165 张表、271007 行原列数据对账一致。apply 内部再次运行协调器也全部跳过。

回执：`dev-vue-schema-upgrade-c87fd03a-896c-4311-bae6-243a3457c690.json`。这次证明新命令对已经升级的开发库可重复运行；从旧结构起步的物理 DDL 证据来自阶段 54 的协调器演练，而非本次零变更执行。

## 命令合同

```powershell
pnpm run upgrade:dev-vue-schema --plan
pnpm run upgrade:dev-vue-schema --apply
```

- 参数必须明确选择 plan 或 apply；没有默认写入模式。
- 从当前仓库 `server/.env` 读取连接，库名必须是 dev_vue，实例 UUID 必须匹配冻结备份。
- 必须具有已验证的升级日志表。尚未初始化日志的旧库会拒绝；初始备份、日志初始化与部署编排仍需单独接入。
- 开始前校验阶段 54 演练中的步骤 ID/checksum、6 个实际恢复点、重复执行结果、旧数据对账 hash，以及 101 个演练工具文件的 SHA-256。证据缺失、改动或来自另一备份/实例均拒绝。
- 在同一连接持有统一升级锁，先验证全部原结构/原列数据与全部迁移状态，再执行未完成步骤。apply 完成后重跑检查与原数据对账。
- apply 在数据库操作前以独占创建方式预留本地回执。失败回执保留；未知 DDL 结果通过原日志和结构重新判定，不通过重复执行 SQL 猜测。

## 验证

`pnpm exec vitest run tests/inplace-coordinator-proof.test.js tests/inplace-schema-coordinator.test.js tests/inplace-ordered-schema-upgrade.test.js`：56 项通过。

新增 11 项证据门测试：正确演练可用；错误实例、备份、checksum、缺失恢复点、旧数据 hash、伪重复结果、缩减/重复 manifest、路径越界、工具内容变化均拒绝。

实际 `--plan` 通过；实际 `--apply` 通过并保存回执。未启动服务、未部署、未执行业务回填或旧结构删除。

## 复核与剩余边界

第一轮：命令只协调既有不可变结构步骤，不复制 DDL、不修改旧迁移、不在应用启动时自动迁移。明确返回 `fullNormalizationComplete: false`，结构命令成功不是部署就绪。

第二轮：演练证据与输入源、SQL、工具代码绑定；目标库固定；整批预检、同连接锁、逐步日志、回读与重复执行保留。当前原数据 hash 冻结于备份，开发业务数据有变化时会拒绝，不能用于边写业务边升级。调用前仍需收敛业务写入口；升级锁只协调升级程序，不拦截普通业务连接。

完整自动升级仍缺全域数据转换、业务可用性与接口验收、初始日志/备份入口整合、切换和旧结构删除。本命令尚未挂入部署脚本；不能把它单独作为“旧库升级完成后启动 V4”的依据。下一步应继续账户/身份与策略订阅数据承接，逐个关闭字段语义和历史数据对账阻断。
