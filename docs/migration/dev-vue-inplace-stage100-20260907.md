# 阶段 100：会员来源锁定与逐行写入

新增 createMembershipWriter：调用方持有事务，按 users → memberships 顺序锁定；写入前核对冻结来源的 id/role/plan/plan_period/plan_source/plan_expires_at/updated_at 七字段，来源发生变化立即拒绝。时间只统一数据库读取的小数秒表示，不推断历史时区。

目标插入使用参数化 SQL，完整 12 列回读；已存在且逐字段一致时返回 applied=false，目标冲突不覆盖。verifyOnly 不创建缺失行。调用者修改公开 prepared 结果并重算散列仍被拒绝。

## 验证

11 项会员来源、转换和 writer 测试通过。writer 测试逐项修改七个来源字段，验证均在目标写入前拒绝。

参考库 dev_vue_m1_a 的真实 MySQL 验证通过：首次写入、完整目标回读、重复无新增、缺失 verifyOnly 拒绝、源用户套餐变化拒绝、会员 revision 变化拒绝、完整回滚。合成用户 777801、会员及运行 ffffffff-ffff-4fff-8fff-ffffffffff01 均无残留。自增计数可能前进，未重置。

回执 [dev-vue-membership-writer-probe-20260907.json](dev-vue-membership-writer-probe-20260907.json)，原始 SHA-256 `a173f471d2040cd9429594d3265bb97abe1a6120ab46b7f7ea43357b846ed7e1`，绑定 13 个工具文件。远端目录 `/www/backup/aurum-v4/m1/20260906-01/membership-writer-probe-01`。

当前 dev_vue 未写业务数据。该 primitive 不提交事务、不创建迁移回执/映射/来源归档，也不发放权益或发送通知；下一步接入 51 步批次适配及同事务完整来源证据，完成真实批量恢复演练。历史依据和业务消费者切换仍未完成。
