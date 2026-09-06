# 阶段 102：会员批次真实恢复演练

在恢复副本 dev_vue_m1_source_20260907_02 完成会员整批真实 MySQL 验证。来源使用副本内两条 free 且 plan_expires_at=NULL 的真实用户七字段投影；NULL 策略依据显式标记为 synthetic-policy-only，仅用于验证迁移机制，不是历史业务准入证据。

## 结果

- 两条来源分别构成一个批次，原 users 未写入。
- 第一批实际 COMMIT 后销毁连接并模拟响应丢失，返回 backfill_commit_unknown；新连接读取运行/批次/检查点，查证为 committed。
- 第二批注入来源证据失败后，会员、映射、回执、来源、批次和检查点保持失败前状态；显式重试成功。
- 两批重复无新增；最终会员、映射、行回执、来源归档和批次各 2 条，检查点 sequence=2、processed_rows=2。
- 全部会员目标字段通过 verifyOnly 回读；另以原来源直接对比套餐、周期、来源、NULL 到期语义及七字段归档。映射、回执和来源散列逐项核对。
- 新增会员和本次运行全部迁移元数据按运行及用户范围清理，最终测试记录为零；旧表结构及原 271007 行与基线一致。

当前 dev_vue 未写入业务数据，未启用服务或切换会员消费者。该测试不证明真实无限期权益规则或历史时间，亦不创建历史开通事件。

回执：[dev-vue-membership-backfill-probe-20260907.json](dev-vue-membership-backfill-probe-20260907.json)，原始 SHA-256 `b1bfdac1058734ef2da6378446d7b9d920fea42059e718c55dcb48fdf8cc97e7`，绑定 147 个工具文件。

远端目录 `/www/backup/aurum-v4/m1/20260906-01/membership-backfill-probe-01`；运行 ffffffff-ffff-4fff-8fff-ffffffffff02。脚本语法检查通过，调用已通过 31 项定向测试的批次实现。

后续继续完善真实来源依据与会员独立验收，推进会员消费者切换及其余业务域。全量自动升级和旧结构删除仍未达到验收条件。
