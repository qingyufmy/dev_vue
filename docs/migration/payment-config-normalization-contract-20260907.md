# 固定支付配置来源与规范化合同

阶段 123。当前 dev_vue 五项固定支付配置完成两次只读一致核查：payment_mode 为 fixed，fixed_tron_address 非空，fixed_erc20_address/fixed_bep20_address/fixed_sol_address 为空串。五项均保留 created_at/updated_at 非空墙钟，未确定历史偏移。报告仅记录配置值形态/hash，不输出地址原文，见 [源结构及行证据](dev-vue-payment-config-source-review-20260907.json)。

## 来源覆盖

system_config 八字段：id、category、key、value、label、sort_order、created_at、updated_at。检查器严格限定 crypto_wallet 下上述五个键，保留八字段原值及逐行 hash；不扫描其他配置值或密钥。mediumtext 按实际字节上限及 UTF-8 往返验证，数值不经浮点转换。源缺失、NULL 和空串分别表达，不补默认地址。

目标沿用总矩阵的 system_settings：namespace/key 唯一、显式值类型、revision、敏感级别以及变更审计，不能另建第二套固定收款权威事实。旧 ID、原 category/key、label、sort_order 和两种旧时间都必须有明确承接字段或可追溯来源归档，不能仅保存运行 value 后宣称八字段完成。具体全表结构需与其余 system_config 命名空间一起审查；本轮不追加未经完整设计的 DDL。

## 消费者与兼容

旧 payment.js 的下单路径明确使用固定 TRON 配置；管理配置写入 payment_mode 和 fixed_tron_address 后清理进程缓存。旧 sweep.js 则按派生钱包序号查询/归集，两套来源不能合并。钱包规范读取器不是固定配置读取器，不能替代付款收款地址配置。

新配置读写需原子更新、revision 并发校验、同事务审计及跨进程缓存失效；新订单冻结当时 recipient 和配置版本，历史订单/监控保留原 recipient，不能随当前配置更新。空链地址不表示已启用多链支付；沿用当前 TRC-20 业务范围，其他键仍保留以供兼容。

## 两轮复核与限制

第一轮覆盖/职责：固定配置归 system_settings，派生身份归 payment_wallet_addresses，订单 recipient 为不可覆盖的历史快照；不新增重复地址权威表，不将当前配置匹配当作历史版本证据。

第二轮数据/并发/恢复：保留 NULL、空串、label、sort_order 和原墙钟；配置管理不能沿用两个独立 upsert 所产生的部分成功。缓存需按 revision 失效，回填不触发配置生效/支付通知/归集。原八字段与来源 hash、运行值及历史订单需分别对账；仅五项子集通过不能授权删除 system_config。

四项来源检查器测试通过。读取脚本验证完整 54 步结构、原表结构以及八字段/索引，未写数据库。下一步审查其余配置命名空间的元数据与类型，冻结 system_settings 完整字段及配置变更审计结构，再追加迁移和分批转换。全库规范化未完成。
