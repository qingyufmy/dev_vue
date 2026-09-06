# 阶段 82：支付监听全字段与订单关联核验

新增 `v4-payment-watch-source.mjs` 和只读工具 `review-dev-vue-payment-watches.mjs`。读取全部 13 个监听字段、全部 23 个订单字段及用户 ID；验证当前 dev_vue 的数据库 UUID、完整 47 步结构日志及原表结构指纹。使用只读一致快照，确认会话为 UTC；报告不导出业务地址、订单标识或原始行。

最终版本两次真实运行结果一致，见 [核验结果](dev-vue-payment-watch-review-20260907.json)：

- 8 条监听：4 cancelled、4 expired；均有且仅有一个精确匹配的订单，用户、地址、链、期望金额、交易哈希及过期墙钟值一致，状态对应正确。
- JavaScript 精确标识匹配与 MySQL 旧排序规则 JOIN 一致；SQL 未发现非 NULL 交易哈希重复组。此结果只证明当前记录，不能代替未来目标唯一键的冲突演练。
- 4 笔无监听的订单全部 paid，每笔推荐抵扣 5，crypto_amount 为 NULL、无交易哈希；不能为这些记录补造链上交易。权益是否已兑现仍需独立核验。
- 8 个 created_at 为 TIMESTAMP，经验证 UTC 会话读取后可保留为 UTC；8 个 expires_at 为 DATETIME，仍有 expiry_time_basis_required。没有用当前会话时区解释 DATETIME，也未以监听创建时间代替订单创建时间。
- 未发现 pending 订单缺失监听或实际记录的确认策略异常。源码已补充这些失败分支；当前无 pending/confirming 样本，不能宣称活动支付恢复已真实验收。

字段承接方向：id/order_id/user_id 保留为监听来源及订单关系；chain/address/expected_amount/expires_at 属于支付匹配请求；status、tx_hash、confirmations、required_confirmations 保留匹配状态及观测证据；wallet_index 保留来源钱包索引，不能自动等同新钱包 ID；created_at 保留 UTC 来源时间。全部原行/hash 另行保留。交易哈希或确认数单独存在不足以建立交易金额、到账时间和权益事实。

参考旧代码 `server/crypto/monitor.js` 的扫描路径使用订单创建时间作匹配起点，期望金额、地址与已占用哈希共同参与匹配；源订单 created_at 的历史时间问题因此仍影响最终匹配合同，不能因为监听 TIMESTAMP 可解析就跳过。

16 项定向测试通过（监听 6、订单源 4、订单候选 6），包括重复认领、跨用户、金额/状态不符、标识大小写、确认阈值、pending 无监听及副作用关闭。本轮只读，没有 DDL、DML、监听启动或权益事件。仅重新核验本域行与全库结构；未重新执行全库逐行数据 hash 对账。

下一步将实际一对一监听关系纳入支付目标物理结构与转换合同，并处理产品/权益引用；本报告不宣称支付三表已创建、订单已回填或全库升级完成。
