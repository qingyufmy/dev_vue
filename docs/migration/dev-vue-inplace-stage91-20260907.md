# 阶段 91：订单整批真实 MySQL 提交恢复

在恢复副本 dev_vue_m1_source_20260907_02 使用现有合法用户作父引用，构造两条明确合成来源的取消订单，分别形成一行批次。没有写旧 orders/users；合成时间依据仅服务故障演练，不能用于真实订单迁移。恢复副本当时为完整 50 步结构。

新 probe 直接使用实际 createPaymentOrderBackfill、MysqlPaymentOrderBackfillRepository 和订单 runner。141 个工具/证据文件逐一校验 hash；远端目录 `/www/backup/aurum-v4/m1/20260906-01/payment-order-backfill-probe-01`。原表结构及原 271007 行在执行前后完整核对。

真实 MySQL 结果见 [演练回执](dev-vue-payment-order-backfill-probe-20260907.json)，SHA-256 `195c4cf7df501971e864e353eed45fcfec10ad8c1f20c80fcd13499280475d1a`：

1. 第一批真实 COMMIT 成功后销毁连接并模拟响应丢失，框架返回 backfill_commit_unknown；未自动重写。新连接 recovery 锁读批次回执得到 committed，单行 verifyOnly 再核对全部目标字段。
2. 第二批在源证据处理处注入 BackfillError。目标 INSERT、ID map 和批次等先前操作同事务回滚，七类组件数量与失败前一致；明确重试后完成。
3. 最终目标行、ID map、行回执、源证据、批次各 2；run/checkpoint 各 1。独立核对检查点 sequence=2、processed_rows=2、末游标，以及每条 map 的来源/目标 JSON、每条回执 hash/目标和每条完整源证据。独立 15 字段源事实对账通过。
4. 两批再次运行不新增组件。随后按固定合成 run 和目标 ID 在事务中清理本次新记录，所有测试组件为零；原 271007 行仍一致。已有用户未修改。自增元数据可能因目标合成 ID 增加，不称为整库字节级恢复。

本次验证了真实批次事务、源证据写入/回读、提交响应丢失后的查证和失败回滚。它未验证真实订单历史时区、真实币种/产品/权益依据、匹配表业务回填或新支付状态机，也没有在当前 dev_vue 回填任何订单。当前库仍保持阶段 87 的业务状态；本轮直接写入与清理仅发生于恢复副本的新迁移/订单表。

后续仍需真实源依据准入及支付匹配转换，才能对当前订单执行回填；全库统一升级、运行切换、完整回滚和旧表删除门继续保留。
