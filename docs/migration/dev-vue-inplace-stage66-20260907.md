# 阶段 66：推荐账户事务回填实现

新增推荐域 writer、合同、runner 和 MySQL adapter，尚未执行真实业务回填。

`createReferralBackfill` 在完整冻结来源上转换，再生成按用户 ID 排序的批次。目标、映射、原始投影、来源 hash、登记时间和转换 hash 一并绑定。金额不经过 Number；SQL 使用参数，目标已存在且完全一致时不 INSERT，不一致时拒绝覆盖。writer 内部保留独立期望值，不能通过修改公开 payload 后重算 hash 绕过校验。

`MysqlReferralBackfillRepository` 复用已有 MySQL 事务实现，每个事务验证完整 46 步升级身份；行回执后在同一连接插入 `data_migration_source_rows` 并锁定回读。证据注明这是 users 的推荐字段投影，并保留原始 created_at/updated_at；不冒称整张 users 所有字段均已处置。

现有不可变账户合同只允许账户源与账户目标。为保持既有演练 hash 和旧任务行为，增加推荐版合同与 runner，保持原算法，明确只允许 `inplace-referral-v1`、`users/referral-account-v1` 和 `user_referral_accounts`。两版共享同一 BackfillError 类，因此原 MySQL adapter 的已回滚死锁和提交未知识别继续有效。旧合同、runner 与任何已执行 SQL 均未修改。后续通用化必须保留旧证明及迁移版本，不能直接放宽历史任务的白名单。

## 验证

33 项推荐域测试通过：13 项值转换、5 项 writer/证据/白名单、15 项事务协议。另有 8 项共用 MySQL repository 测试通过。

事务协议覆盖并发重复批次、整批回滚、checkpoint 顺序、映射冲突、提交前/后结果丢失、未知状态不自动重放、已确认回滚死锁有限重试，以及 writer 回执不一致。由旁路库测试迁移到同库测试时，两个旧断言仍假定 source 与 target 必须不同，已按推荐同库合同改为“目标不得偏离源库”；其余恢复行为不变。

这些是源码与内存故障验证，不能代替 MySQL 真实提交恢复。推荐表仍为空，开发库保持 197 表/46 步。下一步生成持久且可复用的回填 run 清单，在恢复副本执行 25 条真实回填、提交后断连恢复、源证据与目标独立回读，验证后再用于当前 dev_vue。全库规范化及删除门仍未完成。
