# 阶段 110：返佣规则第 52 步真实升级

当前 dev_vue 已完成 `inplace_014_01_referral_rule_constraints`，仍为 202 表，升级日志为 52 个 completed。四条返佣规则原五字段不变，新增 revision 均为 1。业务消费者未切换。

## 恢复副本证据

新增共享执行器与主机演练入口，固定 dev_vue/指定恢复副本、实例 UUID、升级锁和完整前置日志。保护原 165 表/271007 行，同时枚举已登记新增表的完整列和主键，比较升级前后行散列。

在 `dev_vue_m1_source_20260907_02` 实际执行 ALTER，随后在完成 journal 前抛出注入异常。再次检查发现 started + 完整目标结构，补齐 completed；重复运行不再执行 DDL。注入的是 DDL 后应用异常，并非网络断线。

[恢复回执](dev-vue-referral-rule-rehearsal-20260907.json)绑定 164 文件清单，SHA-256 `5a75e18038faa6e7c55ddb213b15df702b2796d9be5046922f974662761b2fb8`。远端目录 `/www/backup/aurum-v4/m1/20260906-01/referral-rule-rehearsal-01`。原数据及已新增表的全部受保护行散列一致。

## 当前库与入口

`node scripts/upgrade-dev-vue-schema.mjs --plan|--apply` 升级为 v9，验证所有历史证明及新的固定恢复证明，再协调全部 52 步；仍为显式入口，不在服务启动时运行。

- [首次执行](dev-vue-schema-upgrade-7a0d89dc-f210-4241-a220-ca7005672982.json)：verified，1 条 DDL、2 次 journal 写入。
- [独立重跑](dev-vue-schema-upgrade-27ceb582-6f21-4fdd-92d4-e1d4c6b7200e.json)：verified，0 条 DDL、0 次 journal 写入。
- 两次均完整验证原 271007 行，并保护会员、推荐账户、推荐账本、支付订单/交易/匹配数据；新 revision 初始化或已存在 revision 的保留均校验。
- 13 项定向测试通过。

旧 51 步专用会员回填/只读探针属于历史版本，在新库上会拒绝未知日志或结构变化；后续使用必须追加兼容适配，不能过滤第 52 步或忽略原结构漂移。已完成的 21 条会员数据未改动，另外 4 条历史到期记录仍待依据。

全库规范化、业务读写接入、部署自动编排及旧结构清理未完成。返佣规则下一步为带 revision 的同事务修改和审计，以及业务策略明确后的消费者切换。
