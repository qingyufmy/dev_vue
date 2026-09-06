# 支付匹配最终行与来源依据

preparePaymentMatchRows 将尚未认领链上交易的旧监听准备为 payment_matches 的 21 个物理字段。它先调用订单最终行转换器核验父订单来源、用户、显式目标 ID map 和历史时间，再使用订单 created_at_utc 作窗口起点，不能从监听 created_at 或导入时间代替。

监听 created_at 按来源 TIMESTAMP 经已验证 UTC 会话读取，NULL 原样保留。expires_at 是 DATETIME，使用每行独立时间依据转换。新的 payment-match-basis/v1 清单绑定整个监听集合 hash、快照和每个源行 hash，记录原链/地址/过期墙钟、时间偏移证据、资产合约/代码及资产来源证据。时间和资产证据均须匹配外部已核实目录，不能只凭当前链配置生成历史映射。

证据目录的历史真实性由后续受控读取入口核实，单纯调用纯函数传入同值 hash 不能证明真实来源。当前只有合成测试清单，没有真实业务可用的时区/资产清单。

转换保留全部监听原字段与对应订单完整原字段、父订单目标 hash、依据清单 hash 和本行记录；期望金额、确认策略、旧确认数及旧钱包索引分别承接。地址/链/资产合约使用目标可表示的非空 ASCII 文本，不静默替换无法表示的字符。期限必须晚于已解析的订单起点。

源 tx_hash 非 NULL 时明确拒绝，要求单独提供链上实际金额、发生时间和资产等事实后才能映射 payment_transaction_id。无哈希行不补造交易，输出 transactions 为空。pending 来源即使可准备物理字段也不启动监听；confirming/confirmed 或其他缺证据状态仍受来源检查约束。全库目标没有缩减为只支持无交易历史，已认领分支仍是后续必要工作。

返回值始终标记 businessWritesEnabled=false、activatesWatches=false、fullPaymentConverted=false。orders 自身 crypto 确认数等独立快照、币种依据、支付状态机和切换仍在未完成项中；共同原墙钟值相同不代表两份历史时区依据已经一致。

复核一：分离父订单窗口、监听 TIMESTAMP、过期墙钟和登记时间，完整保留两侧来源。复核二：按集合/行/原值绑定时间和资产，拒绝越界偏移、日期倒置、地址错配、无法表示的标识和伪造交易；保留未支持分支及真实证据缺口，不把测试 fixture 作为迁移准入。
