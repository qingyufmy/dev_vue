# 订单最终行与历史时间绑定

`scripts/lib/v4-payment-order-rows.mjs` 将完整旧订单投影准备为已安装 payment_orders 的 23 个物理字段，不执行 SQL。输入为完整来源行、用户 ID 集合、明确的一对一目标 ID map、冻结 run、时间依据清单和外部已核实证据目录。

时间清单版本 payment-order-time/v1，必须绑定 sourceTable=orders、整个有序源集合 hash 和 sourceSnapshotId。每个非 NULL created_at/paid_at 单独绑定 sourceId、完整源行 hash、字段名、原始墙钟、offsetMinutes、evidenceId/evidenceSha256。证据 ID/hash 必须在调用方传入的已核实证据目录中匹配。重复、额外字段、不相同源值、缺失依据或越界偏移均拒绝。

证据目录不是事实验证器：后续执行入口必须从可信已核实文件加载并校验实际内容/hash及适用历史范围；不能由前端、请求参数或自动推断生成目录来证明自己。当前没有真实订单时间清单，不能仅填 evidenceId 或复制测试 fixture 就启动回填。

UTC 转换只作用于被精确绑定的字段，支持逐行/逐字段不同偏移，保留毫秒和 MySQL 日期范围。缺少 created_at、paid 订单缺少 paid_at 均拒绝，不能用 imported_at_utc 代替。NULL 的非必填 paid_at 原样保留，不需要也不接受虚构的时间依据。crypto_expires_at 不在本转换器解析范围内，待匹配转换与同源证据覆盖。

目标新增事实：ID 来自显式 ID map；revision 固定 1；origin 固定 legacy_import；migration_run_id 来自冻结 run；source_sha256 为完整源行 hash；imported_at_utc 仅取冻结登记时间。用户、订单标识、历史产品/周期/标签、独立金额与付款方式来自源值，不重算财务事实。全部 23 个原字段，包括尚待关联的 crypto 字段，仍在 provenance.source 中保留。

该模块始终输出 businessWritesEnabled=false、fullPaymentConverted=false 和零导入余额变化，并保留支付匹配/crypto 字段、币种依据、权益核验及旧抵扣义务的未完成项。准备物理字段不代表允许写入；下一步 writer 还须核对真实迁移 run、用户、ID map、证据存储和业务门。

复核一（覆盖与职责）：产品/周期按阶段 84 的历史快照规则承接，不把可变当前产品目录作为历史事实；整个原行保留，不能用 23 个目标列数代替源字段覆盖。复核二（证据、数据与异常）：按源行/字段绑定时间，登记时间单列、禁止默认时区；没有可信真实清单则不接真实写入。剩余风险是证据内容的历史真实性，单元测试和 hash 不能独立证明。
