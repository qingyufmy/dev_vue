# 阶段195：运行表索引与完整签名复查

当前dev_vue累计139步、222表、787索引。本批补齐Bridge两个迁移来源唯一索引及设备查询、模型归属、用量额度和预约恢复共6个目标索引。两个迁移键无非空重复，旧索引保留；271337行业务数据、其它结构和自增值一致。独立只读目录复核139步、3275列、117CHECK、99FK，总271476行包含139条升级日志。

恢复首条唯一索引已执行后，MySQL将唯一索引显示到普通索引前，触发严格指纹冲突。保持已执行SQL、步骤checksum和started日志不变，仅按明确的6个完整索引描述规范化显示顺序；不忽略列、唯一性、方向或索引差异。诊断冻结后第1步reconcile，另5步逐DDL中断恢复；全部6个步骤中断均有记录。恢复业务行摘要还与上一阶段完整回执逐项相等。当前库实际6DDL、内部重复0DDL；临时权限恢复。

13项定向测试通过，包括6个中断位置、模型CHECK历史状态衔接、MySQL唯一索引顺序及结构差异不被隐藏。重复执行无DDL，不启动应用、Redis、Bridge或公网部署。

现存同名目标表139个显式目标索引已按列顺序、ASC/DESC、BTREE、前缀、可见性、唯一性复查：120个完全匹配，2个用户邮箱/手机号由既有唯一索引保留覆盖，17个依赖根实体缺列，随相应业务重构补齐。此结果不覆盖自动生成外键索引或完整查询性能。

真实EXPLAIN显示：用量恢复查询采用新idx_v4_model_usage_recovery，仍有排序；额度查询继续选择旧idx_usage_logs_user。检查使用现有有效正整数用户，不宣称查询提速。源预检使用历史user_id=0，不作为可比性能基线；新增额度索引在possible_keys中存在。

证据：[源预检](dev-vue-runtime-index-source-20260908.json)、[显示顺序诊断](dev-vue-runtime-index-rendering-20260908.json)、[恢复演练](dev-vue-runtime-index-rehearsal-20260908.json)、[开发库升级](dev-vue-runtime-index-upgrade-20260908.json)、[索引签名](dev-vue-target-index-review-20260908.json)、[EXPLAIN](dev-vue-runtime-index-explain-20260908.json)、[目录v7](dev-vue-structure-remaining-work-20260908-v7.json)、[两轮复审](../database-runtime-index-plan-20260908.md)。

当前入口：node scripts/upgrade-runtime-index-local.mjs --check/--apply <新绝对路径回执.json>；目录和类型预检工具要求139步。剩余根实体迁移、36项排序逐项处置、完整字段转换/反向目标覆盖、强软关系核对尚未全部完成；整体目标保持进行中。
