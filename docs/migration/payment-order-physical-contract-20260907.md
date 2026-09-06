# payment_orders 物理合同

012_payment_orders.sql 追加创建订单事实表，不改旧 orders。实施顺序为真实参考库约束演练、恢复副本结构协调器演练、当前 dev_vue 结构安装、经过领域证据门的数据回填。该 SQL 已在开发参考库通过真实约束演练，因此内容冻结；尚未注册同库协调器或在当前 dev_vue 安装，不允许单独从服务入口加载。结果见 [阶段 84](dev-vue-inplace-stage84-20260907.md)。

## 领域与字段

payment_orders 承接商业订单，和交易 execution 订单分开。product_code、billing_period_code 及相应 label 是成交时产品快照；可以保留停售或历史产品，不强制引用可变的当前产品目录。新订单的产品准入仍由商业应用层检查。旧 month/monthly 不在 DDL 中自动互换。

来源映射：orders.id → legacy_order_id，并经 ID map 关联新的 id；order_no → order_number；order_id → external_order_id；user_id 原样保留；plan/plan_label → product_code/product_label；period/period_label → billing_period_code/billing_period_label；amount → order_amount；amount_confirmed → legacy_amount_confirmed；referral_credit_applied 原名承接；currency → currency_code；status/status_label 原名承接；payment_method → payment_method_code；created_at/paid_at 经有证据转换后进入对应 UTC 列。

legacy_amount_confirmed 只在 legacy_import 行保留，不能解释为实际到账、自动回退为订单总额或套用等式修复。native 行该列必须 NULL，新的现金支付事实由支付交易和匹配关系承接。金额使用 DECIMAL(20,8)，抵扣不为负且不超过订单金额；不强加“总额 = 历史 confirmed + 抵扣”，以免拒绝或篡改已观察到的取消订单金额差。

订单上的 6 个 crypto 字段属于后续支付匹配/来源证据合同，本表不丢弃它们、也不把地址和期望金额塞入订单交易事实。完整 23 字段来源需先由 source evidence 和 hash 固定；支付关联尚未完成时不能宣称旧 orders 已全部承接，不能删除旧表。

## 新字段与约束

- id 是新 BIGINT UNSIGNED 主键；revision 从 1 开始并限制为正数。user_id 保持 INT，外键指向 users，无级联删除。
- 三个订单标识分别唯一；order_number/external_order_id 保留旧 utf8mb4_0900_ai_ci 比较规则，避免未审查就改变业务唯一性。NULL 外部标识允许多行，不能因此略过领域身份异常门。
- origin 区分 legacy_import/native。历史行必须有正数 legacy_order_id、真实 migration_run_id、source_sha256、imported_at_utc 和历史 confirmed 金额。native 不允许伪造这些迁移字段。
- imported_at_utc 仅是登记时间；created_at_utc 必填，不能以登记时间代替。paid 必须有 paid_at_utc。旧墙钟没有依据时不能写最终表；原始值保留在源证据，SQL 不填默认 UTC+3/UTC+8。
- currency_code 保留原 NULL 可能性；不能把未知币种补为 USD，非空字符串也不直接证明换算关系。业务启用依旧需要币种/单位核验。
- 唯一 (id,user_id) 为后续匹配表提供防跨用户复合外键。索引覆盖用户订单列表和状态处理的稳定 created_at_utc/id 顺序；这是查询设计，不宣称已测得性能收益。

## 两轮复审与后续验证

第一轮（覆盖和职责）：采用产品快照而不是要求历史订单引用当前产品，避免为停售产品伪造目录；拆开旧 confirmed 金额与未来实际支付交易；保留 6 个 crypto 字段仍未物理承接的明确缺口。

第二轮（兼容、数据和异常）：保留旧标识排序规则；历史迁移必须有来源与真实 run 外键；新订单不能伪造历史金额；SQL CHECK 各 NULL 分支显式约束；paid 时间缺失拒绝而不补造。当前 12 行仍没有 UTC 转换依据，故不能回填。

真实 MySQL 必测：合法 native/legacy 行、零金额及全抵扣、取消订单金额差；负金额/超额抵扣、无来源迁移行、native 混入来源、无 run/user、重复 legacy/订单号/外部标识、paid 无日期、零 revision；全部事务回滚，验证没有残留业务行。结构演练应记录 SQL hash 和 SHOW CREATE TABLE，并做重复/断连恢复后再注册到同库协调器。
