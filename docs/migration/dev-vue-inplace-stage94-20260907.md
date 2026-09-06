# 阶段 94：支付匹配批量回填事务

本阶段实现无已认领交易的历史支付匹配批量迁移代码。当前 dev_vue 未执行 DDL/DML；没有将合成时间、资产依据当作真实历史依据。

## 实现

- `inplace-payment-match-v1` 仅允许 `crypto_watch_list/payment-match-v1` 来源流及 `payment_matches` 目标；订单必须已经导入且全部目标字段与冻结父订单一致。
- 固定批次绑定来源散列、目标映射、完整匹配来源、父订单来源、时间/资产依据和父迁移运行。调用者修改载荷并重算公开散列仍会被拒绝。
- 目标、旧 ID 映射、行回执、完整来源证据和检查点使用同一个 MySQL 事务；来源证据写入后完整回读，失败导致事务回滚。
- 适配器要求当前 50 步结构完整，绑定 orders 与 crypto_watch_list 的结构指纹、目标库及服务器 UUID；不过滤未知迁移步骤。
- 提交结果未知时查证批次，不盲目重写；仅完整回滚后的死锁允许有限重试。

为保持已有真实演练清单的文件散列有效，新增匹配版本 contract/runner；事务实现仍复用已有 MysqlBackfillRepository，未修改旧版本、已执行 SQL 或历史证明文件。

## 定向复核及验证

职责复核：仅历史迁移，不启动支付监听，不生成链上交易、会员权益或余额流水；匹配 writer 先锁定核验父订单，再访问匹配。

数据与异常复核：匹配来源、父来源及两类时间依据共同进入不可变批次；新适配器补充来源回读失败回滚及运行 ID 不一致拒绝测试。

以下 36 项测试通过（模拟事务/SQL证据，不是本阶段真实数据库演练）：

```powershell
pnpm exec vitest run tests/mysql-payment-match-backfill.test.js tests/v4-payment-match-backfill.test.js tests/v4-payment-match-backfill-runner.test.js tests/mysql-payment-match-writer.test.js tests/v4-backfill-mysql-repository.test.js
```

## 剩余工作

1. 在恢复副本准备合成父订单，完成匹配整批真实 COMMIT 后断连、来源证据失败回滚、重复与逐项对账，并清理合成数据。
2. 核实真实历史时间及资产证据后，才能确定真实匹配回填准入；已有交易认领分支尚未实现。
3. 业务读写切换、完整自动升级入口和旧结构删除仍未完成。本阶段不能作为无损全量升级已验收的结论。
