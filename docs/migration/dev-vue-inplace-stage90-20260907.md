# 阶段 90：订单完整迁移事务接入

新增订单专用 backfill contract/runner，保持已执行证明所绑定的旧版本不变。新模式仅允许同库 inplace-payment-order-v1、orders/payment-order-v1 流和 payment_orders 目标；继续沿用现有批次、检查点、ID map、回执算法及相同 BackfillError 身份，不更换事务模型。

createPaymentOrderBackfill 从最终行 writer 构造有序有界批次，绑定完整变换 hash、legacy→目标 ID map 及原始来源。源证据包含完整 23 字段、快照 ID、登记时间、时间清单 hash 和本行日期依据。闭包校验完整预制条目，调用方重算公开 hash 不能更换目标或时间依据。

MysqlPaymentOrderBackfillRepository 复用已有 MySQL 事务和 commit_unknown 实现，核对 dev_vue 或指定格式恢复副本、完整 50 步结构/日志及源 orders 结构；将 source evidence 的 INSERT 和独立回读放在同一事务连接、行回执之后，检查当前 run 等于目标来源 run。异常由原事务框架回滚，只有确认回滚的死锁有限重试；提交未知由 recovery 查询批次回执，不能直接重写。

42 项定向测试通过：订单 runner 15、原 MySQL 事务适配器 8、逐行 writer/批次/证据 7、最终转换 12。覆盖同批并发幂等、各组件回滚、未知提交恢复状态、旧游标/实例/结构、源键重映射、目标范围、时间证据篡改。此处 runner 的完整批次演练仍是内存事务模型；不能把之前单行 MySQL writer probe 表述为新整批 MySQL/源证据 SQL 已验收。

本轮没有数据库写入或真实订单回填。下一步在恢复副本用明确合成来源，执行实际 run/批次/映射/来源证据/检查点事务、注入真实 COMMIT 后断连、查证恢复和逐项清理，并检查原数据前后不变。当前真实历史时区问题仍待用户确认；支付匹配/币种/权益依赖未解除，不能只把 admission.approved 改为 true 就运行真实订单。
