# 阶段199：订阅引用完整性

当前dev_vue累计147步、222表、3275列、789索引、117CHECK、106外键。新增strategy_subscriptions到交易账户及用户的两个目标外键，使用原有复合索引，无新增索引。保持原INT引用、5条订阅、开关、时间、归属事实与所有旧字段；账户/订阅BIGINT根转换仍属后续领域切换。

恢复副本2次DDL后异常全部reconcile、重复0DDL；当前库2DDL、内部重复0DDL。两次均保护所有221张业务表原值、其它结构和自增值；当前271337行业务数据保持，总271484行包含147条升级日志。独立进程再次验证147步、原165表及2598字段物理覆盖，现有106FK无孤立行、117CHECK均启用且无违规。

累计迁移相关回归44文件344项通过，覆盖历史迁移校验、幂等、中断恢复、数值/NULL保存、索引显示顺序和约束结构。没有启动服务、Redis、Bridge或触及公网。

证据：[源预检](dev-vue-subscription-foreign-key-source-20260908.json)、[恢复演练](dev-vue-subscription-foreign-key-rehearsal-20260908.json)、[开发库升级](dev-vue-subscription-foreign-key-upgrade-20260908.json)、[全库关系](dev-vue-current-relations-review-20260908-v3.json)、[目录v10](dev-vue-structure-remaining-work-20260908-v10.json)、[两轮复审](../database-subscription-foreign-key-plan-20260908.md)。最终范围验收见[独立结构升级验收](../database-independent-upgrade-acceptance-20260908.md)。
