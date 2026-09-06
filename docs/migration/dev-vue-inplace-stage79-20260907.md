# 阶段 79：真实推荐余额事务与并发探针

在开发参考库 dev_vue_m1_a 使用独立测试用户 777001，执行当前 V4 构建产物 `postReferralCreditInTransaction`。执行前检查固定实例及测试 ID/run 不存在，实际验证以下路径：

1. 初始余额 80、opening revision=1。两个独立连接并发提交相同 order_debit=29，其中第一次在写完后由门闩等待第二个事务启动；最终一条 applied=true、一条 applied=false，均返回同一事件 revision=2、余额 51。
2. 新事件先 INSERT 账本，再在余额 UPDATE 前抛错，调用方 ROLLBACK；独立连接读出的余额、revision 和全部账本内容与故障前完全相同，没有残留账本行。
3. 单次 order_release=29 通过，余额回到 80、revision=3，账本共 opening/debit/release 三行。

测试提交过的独立 fixture 随后按精确 user ID/run ID 清理；用户、推荐账户、账本和迁移 run 均核验为 0 条残留。清理只针对本次创建的测试记录。参考库 users 的 AUTO_INCREMENT 可能因显式正测试 ID 增大；没有调整计数器，也不声称参考库物理元数据完全不变。当前 dev_vue 和恢复副本未执行这些财务操作。

证据 `dev-vue-referral-posting-probe-20260907.json`，SHA-256 `c18234f08dfd5696f83e8139674f48676e4044b8189588df62e3db5cce1db5af`；记录实际并发返回、回滚结果、返还结果、清理计数和编译产物 hash。脚本及产物上传前后逐文件 SHA-256 相同，使用阶段 78 已构建的源码，无服务启动。

本次证明内部原语在所列 MySQL 路径的事务行为，不证明订单权限、已支付与取消竞争、佣金审核状态、outbox 或 HTTP 幂等已接入。下一步需要商业领域完整的订单/佣金源事实及调用事务，再决定应用读写切换和旧字段退出；全库规范化与删除门仍未完成。
