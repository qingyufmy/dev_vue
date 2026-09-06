# 阶段 71：订单抵扣字段可执行分类

实现 `v4-order-credit-conversion.mjs`，验证精确金额、用户父关系、原 ID 和 NULL 字段，保留订单金额、amount_confirmed、原币种、外部订单号与来源 hash。该模块只处理抵扣字段投影，不宣称完整订单转换。

所有输出 `migrationBalanceDelta=0`：历史 paid 抵扣作为已消费事实，不能重扣期初余额；pending 抵扣作为待核验的返还义务，必须先核对支付/观察状态，不能自动释放；cancelled/expired 且有抵扣的订单标记历史返还未证实，不能仅凭状态认为已退款或再次退款。未知有抵扣状态阻断。没有抵扣的历史行仍保留，不用金额相等规则修改 cancelled 数据。

11 项测试通过，覆盖零变动、未授权返还、取消/过期证据不足、无父用户、重复 ID、无效/超精度金额、原币种 NULL、amount_confirmed 差异及顺序稳定性。

`review-dev-vue-order-credit.mjs --write/--verify` 两次真实只读检查一致，结果 `dev-vue-order-credit-review-20260907.json`：12 条订单均可读取该投影，其中 4 条 historical_consumption、8 条 no_credit，无当前抵扣分类阻断。原 165 表/271007 行指纹仍匹配。没有写入订单、余额或退款任务。

下一步仍需期初账本结构、完整订单字段及关联转换、运行事务接入；当前分类器不是退款授权器。全库规范化、自动部署升级和旧结构删除尚未完成。
