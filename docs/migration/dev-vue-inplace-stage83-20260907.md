# 阶段 83：修正支付后处理与会员激活的映射

旧 `jobs/payment-side-effects.js` 的完成事务负责通知和推荐佣金处理；会员当前态由 `crypto/monitor.js` 的支付事务、以及全抵扣订单创建事务更新。因此 payment_side_effects 的 completed 不能直接转换为一条新的 membership_activations，也不能在迁移时重新调用旧激活逻辑。

修正 [逐表迁移矩阵](../database-table-migration-matrix.md)：该来源先承接为支付后投递历史；只有未完成义务在单独核验通知/佣金幂等事实后才允许进入新版 outbox。历史 completed 不重新入队。会员激活来源仍需由订单、用户权益状态及可验证历史证据确定，当前可变用户状态不能倒推出每笔订单授予的准确期限。

新增全字段检查器与只读工具。最终两次真实读取一致，见 [报告](dev-vue-payment-effects-review-20260907.json)：4 行、全部 11 字段、均 completed；精确外部订单键匹配与旧 MySQL JOIN 一致，关联订单已支付且用户一致，没有未完成义务或完成态字段矛盾。所有旧 DATETIME 仍保留原值并标记历史时间依据缺失。

逐字段主处置：id 为精确 bigint 来源标识；order_id/user_id 为订单和用户引用；status/attempt_count 为投递执行历史；next_attempt_at/locked_at/completed_at/created_at/updated_at 为各自原始墙钟及待解析时间；last_error 原文及 NULL 分开保留。完整源行和 hash 保留，所有补发通知、重算佣金、授予权益和 outbox 入队开关关闭。

15 项定向测试通过（本模块 3、监听 6、订单候选 6），覆盖 bigint 超出 JS 安全整数、重复源义务、用户/订单状态不符、未完成处理与 completed 字段矛盾。当前真实数据只覆盖 completed，pending/retry/processing 恢复仍仅有检查分支和测试，不代表真实投递验收。

两轮复核：第一轮核对职责，取消来源记录直接映射会员激活的错误假设；第二轮检查历史完成状态、幂等和副作用，保持 completed 不重放，活动义务独立恢复。剩余问题是会员授予期限、产品/周期映射和历史时间依据。此次因此先纠正来源语义，没有冻结或执行支付目标 DDL；避免将错误映射固化进表结构。本轮未执行数据库写入，也未重新计算全库行 hash。
