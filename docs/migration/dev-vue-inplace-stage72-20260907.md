# 阶段 72：推荐期初账本结构与生成规则

追加待演练 SQL `011_referral_credit_ledger.sql`；尚未加入升级步骤注册表，也未在任何数据库执行。当前 dev_vue 仍为 197 表/46 步，已有 25 条推荐账户余额不变。

账本按 user_id/account_revision 主键保存连续版本候选，并以 user_id/event_kind/source_key 保证业务事件唯一。只包含 opening、order_debit、order_release、commission_credit；取消和过期统一使用 order_release，不能以不同事件种类分别返还。用户引用推荐账户，opening 引用迁移 run；没有级联删除。

opening 必须 revision=1、previous_balance=NULL、delta=NULL、migration_run_id 非空。resulting_balance 是已迁余额，允许零和负值；不能把期初余额误认为历史充值，也不能再次加回账户。后续事件 revision>1、前值与 delta 非空，结果必须满足金额算式；扣减不得透支，入账 delta 必须为正。数据库 CHECK 不证明连续版本、业务权限、事件来源 hash 或跨表余额一致，这些由后续短事务 writer 验证。

`prepareReferralOpenings` 绑定冻结 run、来源集合 hash 和用户数，逐用户核对目标账户的全部转换字段，只有与原回填完全一致的 revision=1 账户才生成 opening 候选。记录来源行 hash、迁移 run、登记时间及确定性 source_key。不会 UPDATE 余额或根据旧订单重建假历史。

5 项测试通过：正/零/负余额、余额/版本/登记时间漂移、来源变更及目标遗漏。此证据不等于 MySQL 约束验证。

两轮复核：第一轮区分“观察到的期初余额”与“实际财务变动”，使用 NULL 前值/delta；第二轮检查 SQL 的 NULL 三值逻辑，由 shape CHECK 强制非 opening 的值非空后才检查金额关系。实际 MySQL 执行、CHECK 反例、独立恢复和统一升级入口接入仍为下一步；旧字段删除、应用切换和全库规范化尚未完成。
