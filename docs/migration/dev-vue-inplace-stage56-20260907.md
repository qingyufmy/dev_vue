# dev_vue 同库升级阶段 56：账户回填器适配完整结构

新增 `mysql-coordinated-account-backfill.mjs`，让账户/归属回填事务通过统一协调器核验全部 29 步，而非旧适配器仅支持的 23 步。旧适配器、旧演练文件及其校验和保持不变。

新适配器继承已有事务、源行证据与未知提交恢复机制，只替换每次事务中的目标身份读取。storageMode 仍是相同的 `inplace-account-v2` 物理行合同；schemaHash 额外绑定 `coordinated-account/v1` 和全部迁移步骤，旧回填 run 不能无声续用新结构身份。未创建业务回填 run，也未写入业务表。

## 实际来源验证

`node scripts/review-dev-vue-coordinated-account-ownership.mjs --read-only` 创建 v3 只读报告；`--verify` 第二次读取一致。每次还对比旧 v2 报告，除目标结构身份和观测时刻外的来源事实全部保持一致。

- 旧账户 4 条，账户实体候选 3 个。
- 历史归属区间 274 条，开放区间 3 条，当前绑定 3 条。
- 当前归属一致性问题 0；保留旧单账户曾切换用户的提示。
- `timeBasisConfirmed=false`、`readyForBackfill=false`；没有用终端时区解释旧业务 DATETIME。

证据：`dev-vue-account-ownership-review-v3-20260907.json`。该报告证明当前来源与映射候选未漂移，不证明旧历史平台/币种全覆盖或可执行权限已经完成转换。

## 验证与边界

50 项定向测试通过：新事务适配器 4、源行证据 4、账户 writer 6、协调器 36。新用例验证每个事务都读取完整结构身份、缺日志拒绝、未完成后续阶段回滚、提交响应丢失仍进入 unknown 状态；没有真实写入事务或故障注入。

真实回填尚需指定 `trading_accounts`、`mt5_account_ownership_history` 的历史 DATETIME 时间依据。已再次向用户询问；第一条问题中的“归属区间表”名称已在沟通中纠正为实际旧表 `mt5_account_ownership_history`。不得将 MT5 默认 UTC+3 当作这个依据。

还需将平台/币种历史证据、权限投影、真实业务演练与准入清单一并关闭，再执行账户和归属回填。本批没有 DDL/DML、部署、任务启动或旧结构删除，整体升级目标继续进行。
