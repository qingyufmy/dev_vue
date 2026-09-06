# 阶段 88：订单最终字段转换与逐行时间依据

实现 [订单最终行转换与时间绑定](payment-order-time-binding-20260907.md)。preparePaymentOrderRows 生成 payment_orders 的 23 个物理字段、全源证据及变换 hash，使用冻结 run、显式目标 ID map、逐行逐字段时间依据，不执行数据库操作。

27 项定向测试通过：本模块 12、完整订单来源 4、抵扣分类 11。覆盖超 JS 安全整数 ID、零 confirmed、原周期/NULL/取消订单金额差、快照漂移、源行 hash/原日期不符、跨字段、证据目录缺项、缺失/重复时间项、非法偏移、缺必填历史日期和错误 ID map。测试中的 UTC+8 是合成 fixture，不能作为当前 12 笔真实订单的时间证据。

已就 orders.created_at/paid_at/crypto_expires_at、crypto_watch_list.expires_at 的历史写入时区提出澄清，仍未获得真实订单可用的冻结时间依据。本轮未连接或写入数据库，没有补造证据文件、支付交易或权益事件。业务 writer、独立回读对账及匹配转换仍需继续实现，目标不缩减为仅完成结构。
