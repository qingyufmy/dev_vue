# 阶段192：既有列约束和比较范围补全

当前dev_vue已从105步升级至114步，仍222表。本批9条ALTER：users的nickname/avatar/role/plan/created_at/updated_at改NOT NULL；ai_model_usage_logs.id改BIGINT UNSIGNED；trading_accounts.broker_server扩容191；margin_mode改NULL DEFAULT NULL。

所有用户值、日志ID和账户模式保持。NULL约束前重新验证25用户6列均非空；12,139日志ID均正数，未增加入站外键；4账户经纪商名最长18字符。margin_mode缺省不再伪造netting，已有netting/hedging值原样保留。主键、唯一索引和排序语义未变化。

恢复副本9次DDL后异常全部reconcile，重复0DDL；当前dev_vue执行同9步、内部重复0DDL。两次保护全部221张既有业务表，当前库271,337行业务数据、其它结构和自增值一致；总271,451行包含114条升级日志。临时权限已恢复，没有启动服务、Redis或Bridge，没有公网部署。

46项相关迁移测试通过，另3项字段比较测试通过。前75/91/105步累计checksum和重复修改同一用户时间列的状态衔接经过测试与真实DB复核。独立只读进程再次验证114步并两次采集完整目录一致。

证据：[真实预检](dev-vue-column-constraints-source-20260908.json)、[恢复演练](dev-vue-column-constraints-rehearsal-20260908.json)、[当前库升级](dev-vue-column-constraints-upgrade-20260908.json)、[剩余目录v4](dev-vue-structure-remaining-work-20260908-v4.json)。两轮复审见[列约束计划](../database-column-constraints-plan-20260908.md)。

## 尚未收口

目标同名表当前剩11项类型差异、1项可空性差异；另外6张缺列同名表和69张根实体依赖缺表仍需逐域处理。完整类型相等不能证明结构完全规范，目录已补默认值和排序规则检查：22项默认差异、37项排序规则差异，必须逐项整改或记录具体保留依据，不能直接豁免。

默认值中users两个UTC now(3)由阶段190/192明确保留，不应仅为匹配空库无默认而删除；模型默认provider/active、用量默认success等仍需核查写入口语义。排序差异大多为旧人类文本0900_ai_ci与目标unicode_ci，不按名称机械全表转换；3项目标ascii_bin为bridge_refresh_sessions.token_hash、inference_snapshots.standard_symbol和ai_model_tasks.lease_owner，后两项与根结构切换关联，前者可继续检查旧摘要长度/字符集/碰撞与消费者兼容。

旧字段存在与没有丢行不等于全量转换合同、反向目标覆盖、查询计划已完成，目标保持进行中。

## 当前入口

```powershell
node scripts/upgrade-column-constraints-local.mjs --check <新绝对路径回执.json>
node scripts/upgrade-column-constraints-local.mjs --apply <新绝对路径回执.json>
node scripts/review-database-standardization-local.mjs --read-only <新绝对路径目录.json>
node scripts/review-database-type-data-local.mjs --read-only <绝对路径剩余目录v4.json> <新绝对路径回执.json>
```

114步库使用当前入口，旧工具保持冻结的历史版本语义并拒绝未知新步骤；不得绕过校验重跑旧回填。用户表未来写入须遵守目标必填合同，显式NULL将被数据库拒绝；这不代表注册/资料写入功能已完成。
