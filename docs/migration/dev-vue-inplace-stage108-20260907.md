# 阶段 108：返佣规则约束与读取契约

追加 `server/db/migrations/inplace/015_referral_rule_constraints.sql`：保留原五字段和唯一键，增加 BIGINT UNSIGNED revision，默认 1；增加 rate_bps 0–10000、enabled 0/1、revision 正数约束。该 SQL 已在隔离参考库执行，后续禁止改写。

## 真实结构验证

使用当前 dev_vue 的 SHOW CREATE TABLE 和四条原始规则，在 `dev_vue_m1_a` 创建原结构后执行追加 ALTER。没有修改当前 dev_vue，也没有启动应用服务。

- [来源结构与四行](dev-vue-referral-rule-schema-source-20260907.json)。
- [MySQL 8.4.8 验证回执](dev-vue-referral-rule-schema-probe-20260907.json)，含 ALTER 前后完整 DDL 和 SQL 散列。
- 四条原始记录五字段逐项一致，revision 全部为 1。
- rate_bps=-1/10001、enabled=-1/2、revision=0 五个反例均由 CHECK 拒绝。
- rate_bps=0/10000、enabled=0、revision=9007199254740993 可写入并准确回读；探针事务回滚后四条记录与 revision 均恢复。
- 远端探针目录 `/www/backup/aurum-v4/m1/20260906-01/referral-rule-schema-probe-01`。参考表及四条复制数据保留供升级器验证，不属于真实佣金事实。

## 读取实现

新增 `readReferralRule`，显式六列、参数化业务唯一键查询，返回 found/disabled/missing。规则 ID/revision 保持字符串，比例是有界整数基点；不存在或停用时不由 repository 自动选择返佣比例。严格拒绝数据库大小写不敏感匹配返回的非规范值、重复记录及非法数值。

六项关联测试及服务端类型检查通过。读取器尚未接入业务消费者；当前 dev_vue 无 revision，不能提前调用此读取器。真实 MySQL 验证覆盖 SQL 约束和回读，读取器目前只有离线行为测试。

## 后续必须完成

把参考 DDL 的前后状态接入同库协调器；原字段校验需允许且只允许新 revision/约束，不得豁免其它漂移。演练 DDL 提交后日志失败的恢复、重复执行和原始数据散列保护，再应用到当前 dev_vue。之后实现 revision 条件更新与同事务审计，并在明确缺失/停用兼容策略后切换消费者。全库自动升级和旧结构清理仍未完成。
