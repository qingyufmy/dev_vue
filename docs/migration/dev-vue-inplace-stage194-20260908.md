# 阶段194：模型归属与额度单例

当前dev_vue累计133步、222表、117个CHECK。本批新增两个冻结V4目标CHECK：平台模型归属0、用户模型归属正整数；平台额度配置id=1。现有6个模型与1条配置满足，所有模型状态、金额、ID、UTC时间不变。

恢复副本2次DDL后异常均reconcile；事务内两次无效UPDATE均被MySQL以ER_CHECK_CONSTRAINT_VIOLATED拒绝并回滚，重复执行0DDL。当前开发库应用2步、重复0DDL；两次升级核对全部221张业务表的271337行、其它结构及自增值保持。独立只读目录再次确认133步、3275列、781索引、117CHECK、99FK，总271470行包含133条升级日志；原165表及字段完整保留。

32项相关测试通过，覆盖旧步骤checksum、两次中断恢复及严格结构比较不掩盖意外变化。真实约束拒绝验证仅在恢复副本执行。没有修改用户0、模型权限或额度，没有启动应用或公网部署。

证据：[源预检](dev-vue-model-check-source-20260908.json)、[恢复演练](dev-vue-model-check-rehearsal-20260908.json)、[开发库升级](dev-vue-model-check-upgrade-20260908.json)、[目录v6](dev-vue-structure-remaining-work-20260908-v6.json)、[两轮复审](../database-model-check-plan-20260908.md)。

当前入口为node scripts/upgrade-model-check-local.mjs --check/--apply <新绝对路径回执.json>；完整目录和类型预检工具现要求133步。旧工具保留历史版本语义。整体剩余11类型、1可空性、6默认、36排序差异及6表缺列/69缺表不因这两个CHECK减少；全库索引/关系与字段转换覆盖继续核对。
