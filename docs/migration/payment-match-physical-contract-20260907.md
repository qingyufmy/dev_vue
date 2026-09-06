# 支付交易与匹配物理合同

013_payment_matches.sql 追加 payment_transactions、payment_matches，依赖已有 payment_orders。已在开发参考库通过真实约束演练，SQL 内容冻结；尚待接入同库协调器并安装当前 dev_vue。不改变旧表或启动支付监听，结果见 [阶段 86](dev-vue-inplace-stage86-20260907.md)。

payment_transactions 表示一笔已采集证据的实际入账转账，记录链、交易哈希、资产合约及代码、收款地址、实际金额、发生时间、首次/最近观测时间、确认数、revision 和证据 hash。不从旧 expected_amount 或 amount_confirmed 补造 received_amount，不从监听创建时间补造交易发生时间。当前 8 条旧监听没有可据以建立实际交易的完整链上证据，不能因建表而增加交易行。

payment_matches 表示订单的期望收款与认领。payment_order_id/user_id 的复合外键防止跨用户订单引用；payment_transaction_id/chain/asset_contract/recipient_address 的复合外键保证认领的实际交易属于对应链、资产和地址。实际金额与期望金额分别保存，不设相等外键或 CHECK，旧扫描使用金额差和时间窗，具体容差必须由应用合同承接，不能在 DDL 擅自改成精确相等。

唯一 payment_order_id 保持当前已核验的一单一监听，重开或多次收款不在本合同自动扩展；唯一 payment_transaction_id 防止重复认领。交易哈希保留旧全局唯一范围，对 ASCII 哈希继续大小写不敏感地限制重复；地址、资产合约使用 ascii_bin 精确比较。支持范围是现有支付链的单笔入账匹配，不声称支持一笔交易中的多个代币转账事件。非 ASCII 标识、更多精度或多事件须另行版本化，禁止静默截断。

## 来源映射

| crypto_watch_list 源字段 | 主承接 |
| --- | --- |
| id | legacy_watch_id，并登记目标 ID map |
| order_id、user_id | 解析到 payment_order_id/user_id；保留源外部 ID 证据 |
| chain、address | chain、recipient_address |
| expected_amount | expected_amount，DECIMAL(20,8) |
| status | 独立匹配状态 pending/confirming/confirmed/cancelled/expired |
| tx_hash | 仅在完整实际交易证据核验后解析 payment_transaction_id；原哈希保留来源 |
| confirmations | legacy_confirmations，历史监听快照，不当作新的链上观测 |
| required_confirmations | required_confirmations；NULL 历史可保留在非活动状态，native 必须为正 |
| wallet_index | legacy_wallet_index，不能冒充新版钱包 ID |
| created_at | 在验证 UTC 会话后读取 TIMESTAMP，承接 created_at_utc；原 NULL 保留 |
| expires_at | 有历史依据后转换 expires_at_utc |

window_start_at_utc 必须来自对应订单 created_at 的有证据转换，不能拿监听 TIMESTAMP 替代。asset_contract 是新增事实，来自经过核验、适用于该历史范围的收款资产配置；不能仅凭 chain 或当前配置猜测。origin/run/source_sha256/imported_at_utc 保留迁移来源；完整监听、订单原值分别保存证据。

旧 orders 的 crypto_chain/address/amount/tx_hash/confirmations/expires_at 仍需逐项对账：共同字段对应上述匹配/交易引用，订单自身确认数是独立来源快照，不能被监听确认数覆盖。存在差异时保留双方并阻断；本合同不把未对账字段视为已承接。

## 状态和执行边界

pending 不允许已认领交易；confirming/confirmed 必须有交易且确认策略非 NULL；cancelled/expired 可以保留已观察交易，不能删除迟到收款事实。confirmed 与实际确认阈值、订单 paid 的一致性涉及多行，须由确定性的支付事务锁定后检查并同事务变更；SQL 外键/CHECK 不被描述为已实现完整支付状态机。

原始 legacy_confirmations/legacy_wallet_index 可保留 NULL 或异常整数，但异常不得进入运行。native 禁止写这两个历史字段或迁移来源，必须有创建时间及正数确认策略。所有匹配期望金额为正，期限严格晚于匹配起点；时间有歧义时不能写最终表。

## 两轮复审

第一轮（职责/完整性）：拆开期望金额与实际到账、匹配状态与交易观测；保留历史确认数/钱包索引，避免将来源投影升级为财务权威；明确资产合约来源缺口。

第二轮（数据/并发/异常）：加入两个复合外键与认领唯一键；保留交易哈希全局大小写不敏感唯一性；取消实际金额必须等于期望金额的错误约束；允许关闭匹配保留迟到交易。剩余门为资产配置证据、历史时间、容差/确认状态机、完整源字段证据与回填事务恢复，不能由结构测试豁免。

真实演练覆盖合法 pending/confirming/关闭历史、金额差保留、跨用户/跨地址/跨资产/跨链拒绝、重复认领/哈希、无 run/订单、非法状态/确认策略/时间窗，全部测试业务行回滚。结构安装和业务回填分别记录验收。
