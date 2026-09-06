# 阶段 96：支付来源全字段归档对账

实现独立于目标 converter 的归档对账器，覆盖 orders 全部 23 列与 crypto_watch_list 全部 13 列。对账从冻结来源与数据库回读归档比较，不从目标转换结果反推来源。

## 字段去向

| 旧字段 | 业务目标与证据处置 |
| --- | --- |
| orders.crypto_chain / crypto_address / crypto_amount | 有匹配时分别对应 payment_matches.chain / recipient_address / expected_amount；全部原值仍在订单 source payload 保留。无匹配时不补造匹配 |
| orders.crypto_tx_hash | 原样保留在订单 source payload；不能仅凭旧哈希补造 payment_transactions 的到账金额、资产合同或链上时间 |
| orders.crypto_confirmations | 订单独立历史观测，保留在订单 source payload；不覆盖监听确认数 |
| orders.crypto_expires_at | 旧墙钟保留在订单 source payload；匹配 UTC 到期时间须经逐行时间依据转换，归档保真不等于转换正确 |
| crypto_watch_list 全 13 列 | 全部原样保留在匹配 source payload；含原 TIMESTAMP 的 UTC 读取值及 DATETIME 墙钟值 |
| crypto_watch_list.confirmations | payment_matches.legacy_confirmations 保留监听观测；其与订单观测不同不被强制合并 |

上述 source payload 实际存储于 data_migration_source_rows，按 run_id、stream_id、source_pk_sha256 定位。匹配归档还保存完整父订单来源、父运行以及已绑定时间/资产依据。归档不替代活动业务所需的规范实体。

## 检查与真实演练

- 校验来源主键散列、运行、快照、投影版本、字段集合、每个原值、完整来源散列及匹配父来源/父运行；缺失、额外、重复归档分别检查。
- 原值按 canonical JSON 比较，NULL、空串、金额文本和墙钟不自动归一。单元测试逐一篡改 36 个字段，即使重算保存散列也能发现。
- 在恢复副本 dev_vue_m1_source_20260907_02 实际导入两条合成父订单/匹配，从 MySQL 回读来源归档后对账零差异。订单确认数 7 与监听确认数 2 均独立保留。
- 同次演练再次通过提交后断连查证、证据失败回滚和重复无新增；精确清理合成目标及迁移元数据后，原始结构和 271007 行与基线一致。自增计数可能前进，未重置。
- 当前 dev_vue 未写入，历史时间和资产依据未获真实验证；未启用任何支付副作用。

回执：[dev-vue-payment-source-archive-probe-20260907.json](dev-vue-payment-source-archive-probe-20260907.json)，SHA-256 `e595a9b84df8a7be58e5f6f985f9ac330f8e60a39428b168f9d436f076be1797`，绑定 155 个文件。

远端演练目录 `/www/backup/aurum-v4/m1/20260906-01/payment-source-archive-probe-01`。合成目标 ID 777603/777604，来源 ID 2147482200/2147482201；匹配运行 `ffffffff-ffff-4fff-8fff-fffffffffffc`，父运行 `ffffffff-ffff-4fff-8fff-fffffffffffd`。

归档对账测试 4 项通过，其中一项逐一覆盖 36 个字段。归档对账返回的 sourceValuesPreserved 不授予删除许可，也不证明目标业务事实、真实时间或完整支付转换。后续仍须完成支付领域准入、权益效果与运行链路核验，以及全量升级、读写切换与删除门。
