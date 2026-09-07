# 阶段 173：恢复副本学习域演练输入

新增 prepareLearningRehearsalInputs，专用于 dev_vue_m1_source_20260907_02、已核实 VM UUID 的恢复副本。生成固定两个演练 run、单行批次、配套 reviewed basis、证据目录和双清单，便于随后在真实提交前后注入故障并按原批次恢复。

时间假设明确标记 synthetic-learning-time-assumption/v1，证据摘要绑定恢复副本、源集合摘要和人工设定的 480 分钟偏移。它只测试转换与恢复机制，不代表历史时区已确认；返回 historicalTimeVerified=false/currentDevVueApplyAuthorized=false。代码拒绝目标为当前 dev_vue 或不同服务器 UUID。

演练准备仍走正式转换及双清单预检：用户缺失、课程/进度映射不一致、非规范时长等不能因使用合成时间而放行。不在 sourceSnapshotId 或注册时间上使用当前隐式时间，重复准备使用调用者明确提供的冻结时间。

3 项定向测试通过：一致双清单/单行批次、当前库与错误服务器拒绝、用户缺失及无效时长拒绝。本轮复查 VM 仍无 mysqld 进程或 socket；没有执行真实演练、创建数据库、写入业务行或修复服务。

该模块只是后续真实演练的输入工具，不是演练通过证据。仍需保留故障数据、确定 MySQL 恢复方案、恢复后重新核验旧库及副本，再执行真实提交/恢复/清理与全行对账。全域自动升级和旧结构删除目标未完成。
