# dev_vue 同库升级阶段 53：统一结构协调器

## 结果与范围

新增 `scripts/lib/inplace-schema-coordinator.mjs`，把现有 29 个不可变结构步骤纳入一个有序注册表。现有 SQL、步骤 ID、校验和及历史执行凭据保持原样；协调器不把旧库标记成已经运行 V4 bootstrap。

当前 dev_vue 真实只读核验两次一致：29 步均完成，原 165 张表、271007 行旧列内容与冻结对账一致。证据为 `dev-vue-schema-coordinator-review-20260907.json`。

本批没有 DDL/DML，没有业务回填、旧表删除、服务启动或部署。协调器的写入模式目前仅经过离线状态机验证；不能作为完整自动升级已经交付的证明。

## 协调行为

1. 使用既有 reference/SQL/checksum loader 构造完整注册表；不修改老执行器的严格历史校验。
2. 校验整个日志是合法的连续前缀，拒绝未知步骤、校验和漂移、缺口和不合法时间。
3. 写第一条日志之前，核验所有已登记列和表。CREATE 后又 ADD 外键的表按当前最后完成状态核验，避免拿最终结构去比较过期的中间结构。
4. 按原顺序逐步持久化 started、执行 DDL、回读结构、持久化 completed。started 且结构已经达到目标时仅补完成标记，不重复 DDL。
5. 原数据库身份、升级锁、日志结构、备份与旧数据对账仍由宿主入口负责。实时检查工具只暴露 `--write`（写本地报告）和 `--verify`，数据库事务只读，适配器写方法也显式禁用。

## 两轮复核

第一轮：统一协调解决跨批次历史互不兼容的问题；复用已审核 SQL 和物理结构读取器，不新增第二份 DDL。结构状态和业务迁移完成状态分离，返回 `fullNormalizationComplete: false`。

第二轮：在全部晚期对象预检通过前不允许早期写入；测试覆盖每个步骤的 DDL 响应丢失，以及每一步 started/completed 日志响应丢失。已完成列丢失、最终表结构漂移、未知日志及历史缺口均拒绝。

剩余边界：还需在恢复副本从初始旧结构完整执行协调器，验证物理 DDL/外键依赖、重建日志入口与恢复；当前真实库仅核验最终状态。该模块假定调用方已创建并验证日志、持有同一连接升级锁，尚未集成部署命令。全域业务转换、切换与旧结构清理门仍未关闭。

## 验证

- `pnpm exec vitest run tests/inplace-schema-coordinator.test.js tests/inplace-ordered-schema-upgrade.test.js`：45 项通过；其中协调器测试覆盖 29 个 DDL 中断点和 58 个日志响应丢失点。
- `node scripts/review-dev-vue-schema-coordinator.mjs --write`：真实 dev_vue 只读核验并生成报告。
- `node scripts/review-dev-vue-schema-coordinator.mjs --verify`：第二次真实读取与报告精确一致。

下一步优先将协调器接入恢复副本演练与明确的开发库升级入口，再逐域接入业务回填、语义对账和切换；部署前自动执行这些阶段的入口仍需完整验收。
