# 支付订单逐字段转换合同

本合同承接数据库逐表矩阵中的 `orders → payment_orders`。版本为 `payment-order-candidates/v1`，执行入口是 `scripts/lib/v4-payment-order-conversion.mjs`。这是正式目标写入前的候选转换合同，不是已安装的物理表定义；待支付监听关联核验后冻结 DDL。现有源值检查器保持不变。

## 逐字段主处置

全部源行另保留完整 23 字段及 SHA-256。下列主输出用于规范化，完整来源不能替代业务字段承接。

| 源 orders 字段 | 候选输出 | 规则 |
| --- | --- | --- |
| id | order.legacyId | 精确正整数字符串；最终经 legacy ID map 关联目标主键，不预先假定相等 |
| order_no | order.orderNumber | 原文保留；唯一比较规则待实际 MySQL 检查 |
| order_id | order.externalOrderId | 原文及 NULL 保留；与内部主键分开 |
| user_id | order.userId | 保留现有用户 ID，并检查父用户存在 |
| plan | order.productCodeRaw | 不自动映射新产品或补造产品 ID |
| plan_label | labels.product | 历史标签快照，保留 NULL 和空串 |
| period | order.periodRaw | 保留 month/monthly 等原值，产品周期映射另行核验 |
| period_label | labels.period | 历史标签快照，不作为周期判断依据 |
| amount | order.orderAmount | DECIMAL(20,8) 定点文本 |
| amount_confirmed | order.legacyAmountConfirmed | 独立历史金额；零值不能回退到 amount，不解释为链上实际到账 |
| referral_credit_applied | order.referralCreditApplied | 定点文本；不得超过订单金额；历史导入不改变推荐余额 |
| currency | order.currencyRaw | 原文保留；USD 标签不自动证明抵扣及链上金额的单位换算 |
| status | order.statusRaw | 保留 paid/pending/cancelled/expired；未知值进入阻断项 |
| status_label | labels.status | 历史显示快照，不作为状态机输入 |
| payment_method | order.paymentMethodRaw | 原文、空串、NULL 分别保留 |
| paid_at | order.paidAt | 原墙钟及显式解析状态，不生成支付或权益事件 |
| created_at | order.createdAt | 原墙钟及显式解析状态，不用导入时间代替 |
| crypto_chain | paymentEvidence.chainRaw | 仅来源事实，待和监听记录核对 |
| crypto_address | paymentEvidence.addressRaw | 保留完整原文，不擅自归一化地址 |
| crypto_amount | paymentEvidence.expectedAmount | 期望匹配金额，NULL 不转零，不当作实际到账 |
| crypto_tx_hash | paymentEvidence.transactionHashRaw | 保留来源哈希，单凭此值不创建已确认交易 |
| crypto_confirmations | paymentEvidence.confirmations | 精确整数/NULL；不能仅凭计数授予权益 |
| crypto_expires_at | paymentEvidence.expiresAt | 原墙钟及显式解析状态，不重新启动旧监听 |

## 时间与目标反向覆盖

每个时间输出固定包含 `sourceWallClock / utc / resolution / basisEvidence`。源 NULL 对应 absent；非 NULL 且缺少可信历史依据对应 unresolved；两者 utc、basisEvidence 均为 NULL。此版本没有 resolved 分支，也不接受调用方提供任意偏移。历史时间依据核验后追加解析版本，绑定源 hash、覆盖范围和证据；UTC+3 展示默认不参与转换。

候选额外输出的来源：sourceId/sourceHash/source 来自完整源行；credit 来自既有订单抵扣分类器；effects 的四个值固定为零余额变动及禁止支付交易、权益发放、监听入队。候选 hash 绑定全部输出，并按源数值 ID 稳定排序。

目标主键、产品 ID、标准周期、币种换算、支付交易 ID、匹配关系、权益事件及最终 UTC 时间均未生成。不能将候选对象直接写入最终 payment_orders，或将未生成字段补默认值后称为全量回填。

## 后续实施与验收

1. 读取 crypto_watch_list 全字段，与订单按实际业务键核对；检查共享地址、金额差、时间窗、取消和过期语义，以及链上哈希唯一作用域。结果不能靠订单状态推断。
2. 核对产品/周期与现有权益来源，明确历史 paid 订单和已兑现权益的对应关系；导入不触发重复激活。
3. 冻结 payment_orders、payment_transactions、payment_matches 的物理结构及约束，追加迁移并做真实 MySQL 冲突/恢复演练。
4. 接入同库回填事务、独立逐订单/用户/币种金额和引用对账、重复运行及提交不确定恢复。上述候选转换测试不替代这些验收。

每行保留 product_mapping_required、currency_basis_required、payment_watch_reconciliation_required、entitlement_reconciliation_required；时间和推荐抵扣分类器的原阻断项继续保留。候选可供检查，但 businessWritesEnabled 和 fullOrderConverted 始终为 false。

## 两轮复审

第一轮（覆盖与职责）：逐项核对 23 个源字段都有主输出；将支付期望值与订单主体分开，历史标签单列快照。调整为保留 legacyAmountConfirmed 命名，避免未核实前宣称实际到账或最终应付；不复制旧支付路由，不额外创建通用事件框架。

第二轮（兼容、数据与异常）：检查 NULL/空串/零值、定点金额、原状态、父关系、时间未知、候选排序与副作用边界。调整为无时间字段也不能跳过产品、币种、支付匹配和权益核验；已有 paid 抵扣不再次扣款，cancelled/expired 抵扣不能自动退款。剩余风险为真实唯一键比较、监听关联、权益证据和历史时间依据；均未通过本合同豁免。
