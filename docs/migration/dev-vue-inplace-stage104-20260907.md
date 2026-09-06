# 阶段 104：会员独立导入对账

新增 auditMembershipImport，不调用目标 converter 或 writer。直接以冻结 users 七字段、已审阅依据目录、运行绑定，对照实际 memberships 全 12 列及完整来源归档。

检查覆盖套餐/周期/来源、到期类型与 UTC 转换、revision=1、导入来源、观察/导入时间、原用户身份、原始值、来源散列、归档主键散列和运行归属。缺失、额外、重复和改写数据独立报错；来源依据不匹配则拒绝对账。

8 项关联测试通过。其中逐一修改 12 个目标字段及七个归档字段，验证即使重算公开散列也无法掩盖差异；同时检查 NULL 到期和有到期转换。

恢复副本 dev_vue_m1_source_20260907_02 真实运行使用两条 free/NULL 到期用户来源、明确的 synthetic-policy-only 测试依据。独立 SQL 回读 12 列与归档对账零差异，同次提交后断连查证、证据失败回滚、重复执行通过。新增会员及运行元数据清理后，旧表结构和 271007 行与基线一致。

回执：[dev-vue-membership-audit-probe-20260907.json](dev-vue-membership-audit-probe-20260907.json)，原始 SHA-256 `98d202c83eac0b887dd285c359003663680b940b8f3e37ce66ff1b5a75f7e3e0`，绑定 150 个文件。

远端目录 `/www/backup/aurum-v4/m1/20260906-01/membership-audit-probe-01`，运行 ffffffff-ffff-4fff-8fff-ffffffffff03。本轮当前 dev_vue 未写业务数据。

importMatchesReviewedInputs 仅证明结果与提供的来源和依据一致。证据目录真实性仍由调用方独立核验；真实时间/权益规则、业务消费者切换和旧字段删除未完成，不能据此标记全量升级完成。
