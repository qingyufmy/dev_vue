# 阶段 112：返佣规则审计表同库升级

当前 dev_vue 已执行 `inplace_015_01_referral_rule_changes`，为 203 表、53 个 completed 步骤。审计表为空；本次没有修改规则、发放返佣或生成历史审计。

第 53 步绑定阶段 111 实际参考 DDL 及 SQL 校验和，复用已有升级日志、独占锁和 started/completed 恢复机制。历史迁移及已绑定证明不变。

## 真实演练及当前库

- 恢复副本 `dev_vue_m1_source_20260907_02` 实际 CREATE 后注入异常，重入查证后只补齐日志；重复执行零 CREATE。原 271007 行及已有新增表的完整受保护行散列一致，审计表保持为空。
- [恢复回执](dev-vue-referral-rule-audit-rehearsal-20260907.json)绑定 170 文件清单，SHA-256 `3ac2058754643ec305018a85886b85f1f7717f7244c78abe403b040bfb588f9c`。远端 `/www/backup/aurum-v4/m1/20260906-01/referral-rule-audit-rehearsal-01`。
- 显式 `upgrade-dev-vue-schema.mjs` 入口升级为 v10，逐项验证历史证明与新增证明，增加审计表已存在数据保护。
- [当前库首次应用](dev-vue-schema-upgrade-6a694439-b1bd-4cb6-8d45-09386a147094.json)：1 DDL、2 次日志写入；[独立重跑](dev-vue-schema-upgrade-babff3f0-44ea-4181-bb06-bb060e1750a5.json)：0 DDL、0 日志写入。均 verified，原 271007 行和会员/推荐/支付保护通过。
- 14 项关联测试通过。

## 剩余范围

管理用例的授权、请求幂等、事务拥有权、接口及消费者切换尚未完成；不能把新增审计表视为管理功能已经上线。规则缺失/停用时的财务策略仍须显式处理。支付真实回填、四条非空到期会员、其余领域规范化、部署自动编排以及旧结构清理继续保留在总体目标内。
