# 阶段191：模型配置和用量类型优化

当前dev_vue从91步升级到105步，表数222。3表14列按既有目标类型升级：模型provider/model_name容量64/191；模型max_tokens/request_timeout_ms、平台请求额度用INT UNSIGNED；平台token额度和用量日志8个计数用BIGINT UNSIGNED。主键、策略归属、状态未改。

## 验收

本地env连接当前MySQL。恢复副本14条DDL后逐条注入异常，全部reconcile，不重放DDL；重复执行0DDL。当前dev_vue随后执行14条DDL，内部重复0DDL。临时权限恢复，应用、Redis、Bridge和公网均未启动或部署。

两次均全表核对；当前库221张既有业务表271,337行数据、其它结构、自增值不变，105条升级日志使总行数为271,442。数值对账用完整十进制文本和NULL，避免驱动INT数字/BIGINT字符串差异，也避免JS Number损失精度。字符串、默认值、NULL、排序规则和列顺序均保留；两条NULL超时设置未改零。

36项定向测试通过：17项本批回归覆盖14条DDL中断续接、不重放、非严格SQL模式拒绝及默认值漂移拒绝；19项时间精度回归通过。真实独立进程复核105步checksum/结构，完整目录连续两次相同。

证据：[源数据范围](dev-vue-model-capacity-source-20260908.json)、[恢复演练](dev-vue-model-capacity-rehearsal-20260908.json)、[当前库升级](dev-vue-model-capacity-upgrade-20260908.json)、[剩余目录v3](dev-vue-structure-remaining-work-20260908-v3.json)。两轮复审见[实施方案](../database-model-capacity-plan-20260908.md)。

## 剩余工作与兼容

当前13项类型差异、8项可空性差异、6张缺列同名表、69张受根实体依赖阻断的目标表；不是全域完成。目录新增可空性对比，避免把类型相等误报为约束一致。20个去重后的差异字段又经真实范围/NULL/关系预检；users.nickname/avatar/role/plan/created_at/updated_at的25行均无NULL，可继续评估NOT NULL，无需填假数据。主键、关联和状态仍按各域合同处理。

保留的旧默认值与目标空库默认有差异，仍需业务合同处理，不能由本批类型相等推定默认语义已统一。V4额度目前使用Number比较，当前值在安全范围内；未来超JS安全整数输入和汇总比较必须在用量消费者重构时完善，本批没有写大额度或宣称任意大整数业务链已验证。

105步当前入口：

```powershell
node scripts/upgrade-model-capacity-local.mjs --check <新绝对路径回执.json>
node scripts/upgrade-model-capacity-local.mjs --apply <新绝对路径回执.json>
node scripts/review-database-standardization-local.mjs --read-only <新绝对路径目录.json>
node scripts/review-database-type-data-local.mjs --read-only <绝对路径剩余目录v3.json> <新绝对路径预检.json>
```

旧91步及以下工具保留历史语义，遇到新版本拒绝；后续回填先适配当前完整结构与语义摘要，不覆盖旧SQL或绕过校验。本阶段继续推进数据库目标，不宣称全部完成。
