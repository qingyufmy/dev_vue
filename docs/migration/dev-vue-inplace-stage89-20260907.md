# 阶段 89：订单逐行 writer 与独立源事实对账

新增 mysql-payment-order-writer.mjs。工厂从完整源行和时间依据重新准备目标，闭包冻结允许写入的完整条目；调用方即使重算公开 hash，也不能改金额/来源再调用 writer。SQL 仅参数化 SELECT FOR UPDATE 和 INSERT，已有行逐字段一致才返回 applied=false，冲突拒绝覆盖；插入后独立回读全部 23 个物理字段。verifyOnly 缺行时直接报 not_committed，不补写。

新增 v4-payment-order-fact-audit.mjs，不调用最终行转换器、不比较其预制目标，直接从原订单源值核对目标 legacy ID、用户、标识、产品快照、周期、状态、付款方式及三个独立金额共 15 字段。重复 legacy ID 拒绝，缺行/多行/金额交换/用户不符逐项列出。它明确不验证 UTC/迁移元数据或 crypto 覆盖，fullReconciliationComplete 保持 false，不能单独作为删旧表依据。

17 项测试通过（writer/对账 5，最终行转换 12）。测试文件首次有一个闭合括号遗漏，已修复后重跑全部本批定向测试通过。

真实 MySQL 8.4.8 验证见 [回执](dev-vue-payment-order-writer-probe-20260907.json)，SHA-256 `c4bdedb05da30bee56bf51f6e36bcd04a7e0d3191a315b0ef0b662f3117467ac`。在 dev_vue_m1_a 使用独立合成用户/订单 777101、合成 run 与时间依据，10 个工具文件逐一校验 hash：

- 实际 writer 首次插入并回读成功，verifyOnly 重复不插入；源码的 DATE_FORMAT/CAST 投影与真实 mysql2 返回值一致。
- 独立 SQL 读取 15 字段并通过源事实对账；人为改变 fixture 的历史 confirmed 金额后，writer 拒绝目标冲突。
- 整体事务回滚，订单、用户和 run 的 fixture 行均为零；回滚后 verifyOnly 缺行拒绝且保持零行。
- 远端目录 `/www/backup/aurum-v4/m1/20260906-01/payment-order-writer-probe-01`。自增元数据可能因合成用户/订单增加，不宣称参考库字节级还原。

writer 是调用方事务内的单行原语，不管理提交、不自动建 run/ID map/receipt/checkpoint/source evidence，不创建交易、通知或权益。真实提交未知后的完整恢复尚未演练，也未接入当前库回填 CLI；必须先补齐这些同事务记录及支付领域准入。真实历史时间依据仍未确认，合成 UTC+8 不能替代真实证据。本轮没有写当前 dev_vue、旧业务表或公网。
