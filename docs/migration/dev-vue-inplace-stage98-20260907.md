# 阶段 98：会员当前态目标结构与转换

已按 [会员当前态合同](membership-current-state-contract-20260907.md) 完成两轮复核、最终行转换及 014_memberships.sql。该 SQL 现已在开发参考库 dev_vue_m1_a 执行，后续不得修改，只能追加修正。

## 行为

一个用户一条当前态，保存原套餐、周期、来源及明确的到期类型。NULL 到期作为 no_expiry，须绑定原规则证据；不等同于购买永久套餐，不产生 grant。非空到期经逐行时间依据转换；已过期套餐仍保留原值，不在导入时永久覆盖为 free。

原 users.role 和 updated_at 保留在完整来源；迁移登记时间只作为 current_state_observed_at_utc，不冒充历史开通/修改时间。未知套餐、过期或错位证据、缺失依据均阻断转换。

## 验证

- 会员来源与最终行转换 7 项测试通过；使用合成依据，不宣称真实历史时间已确认。
- MySQL 8.4.8 参考库，UUID ac423207-6ef3-11f1-b302-000c29fda104：2 条合法写入、11 类拒绝通过；NULL/空串和毫秒到期回读一致。
- 非法场景包括未知套餐/到期类型、NULL 与到期类型矛盾、revision=0、缺少导入来源、原生行混入导入字段、缺失用户/运行、重复用户和缺少观察时间。
- 合成用户、会员及迁移运行均回滚，新 memberships 表为空。当前 dev_vue 和恢复副本未安装，不增加 root migration 伪记录。

回执：[dev-vue-membership-schema-probe-20260907.json](dev-vue-membership-schema-probe-20260907.json)，原始 SHA-256 `c4897ebdd2aea5bc257ed426e04f4188e5cdc9ea57fd5c83a43158b7c319f540`，包含源 SQL 散列及 SHOW CREATE TABLE。

远端路径 `/www/backup/aurum-v4/m1/20260906-01/membership-schema-probe-01`。测试用户 -2147482800/-2147482799/-2147482798，运行 ffffffff-ffff-4fff-8fff-fffffffffffe，结束时均无残留。

下一步把会员建表接入追加结构协调及恢复演练，再升级当前 dev_vue；会员真实回填、权限消费者切换和历史权益证据仍未完成，不能据此删除 users.plan*。
