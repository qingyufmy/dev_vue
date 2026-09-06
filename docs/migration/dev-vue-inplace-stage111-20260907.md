# 阶段 111：返佣规则版本写入与同事务审计

实现 `updateReferralRulesInTransaction`：冻结输入，按数值 ID 排序锁定全部规则，全部 expectedRevision 匹配后才开始更新；递增 BIGINT revision，并通过同一 connection 插入 `referral_rule_changes`。规则更新与审计都由外层业务事务提交，任意异常必须回滚。

追加 `016_referral_rule_changes.sql`，已在 dev_vue_m1_a 执行，不得再改写。主键 `(rule_id, rule_revision)`、唯一键 `(request_id, rule_id)`；明确操作者、变更前后比例与 enabled、UTC 登记时间；外键不级联删除。已有四条配置初始化 revision=1 不生成伪历史审计，首个实际修改从 revision=2 开始。

## 定向复核

职责：该表仅记录商业规则变更，不承担佣金、用户余额或全站审计。管理用例负责认证授权、CSRF、请求幂等和事务拥有权；基础设施函数不自行提交，也不把操作者 ID 当作授权证明。

兼容与故障：固定锁顺序，最后一行冲突时前面各行尚未更新；旧 revision 重试返回冲突，HTTP 幂等层需从自己的持久回执返回已完成结果。审计错误向上传播，禁止捕获后提交部分结果。当前新 writer 未接业务消费者，不能与旧不递增 revision 的接口同时启用。

## 验证

七项关联测试、服务端类型检查与构建通过。真实 MySQL 验证使用当前构建出的 writer，见 [参考库回执](dev-vue-referral-rule-writer-probe-20260907.json)：

- 两条规则在一笔事务内更新，真实回读两条审计，逐项比较原比例、目标比例、原 enabled、目标 enabled、actor、request ID 和 revision。
- 旧 revision 的重复调用拒绝。
- 首个 UPDATE 后注入审计错误，外层显式 ROLLBACK 恢复原规则；最终审计为空、测试用户不存在。
- SQL 和构建文件散列进入回执。远端 `/www/backup/aurum-v4/m1/20260906-01/referral-rule-writer-probe-01`。

这不是多连接并发压测或 HTTP 幂等验收。下一步将空审计表接入同库升级第 53 步并验证重入，再补管理用例与事务/幂等接入。当前 dev_vue 仍为 52 步，未创建审计表、未修改业务规则配置，未切换消费者。
