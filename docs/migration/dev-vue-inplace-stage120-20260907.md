# 阶段 120：钱包批次事务、来源归档及独立对账

钱包回填现已接入现有 data_migration_runs/checkpoints/batches/id_maps/row_receipts/source_rows。没有新增数据库表或修改已执行 SQL。本轮当前 dev_vue 只读核查两次一致：54 个 completed 步骤、wallet_keys 四条来源 hash 与阶段 116 相同，payment_wallet_addresses 零行，见 [只读回执](dev-vue-wallet-backfill-readiness-20260907.json)。

## 实现

- `v4-wallet-backfill.mjs` 冻结转换条目，按数字 ID 稳定分批，绑定 snapshot、run、转换 hash；唯一源流为 wallet_keys/wallet-v1，唯一目标为 payment_wallet_addresses。来源归档包含原五字段和完整时间依据。
- `v4-wallet-backfill-contract.mjs` 限定同库、独立恢复库、批准状态、流及目标白名单，校验每批行数/字节限制、主键、游标、映射和内容 hash。复用原 canonical/hash/主键函数，不扩大既有会员合同。
- `v4-wallet-backfill-runner.mjs` 以钱包合同适配现有 runner 事务算法。目标、ID map、receipt、batch、checkpoint 同事务；仅已确认回滚的死锁有界重试。提交未知只读锁定回执确认，不自动重放 writer。
- `mysql-wallet-backfill.mjs` 复用现有 MySQL 事务仓储。插入 receipt 后在同一连接归档原始来源，并回读校验；失败由外层整体回滚。新身份读取适配完整 54 步协调器，旧 51 步会员适配器及其历史证明保持不变。
- `v4-wallet-audit.mjs` 不导入转换器或 writer，独立计算预期创建时间并逐一核对 13 列及来源归档，检测缺失、多余、重复和证据变更；对账通过不授权运行切换或删除旧表。

## 验证和复核

七个相关测试文件共 41 项通过。事务测试覆盖并发重复、映射冲突、writer 失败整批回滚、提交前后响应丢失、未知状态保持和死锁次数限制；仓储测试覆盖同连接归档/回读、错误来源回滚和错误 run 写前拒绝；独立对账逐字段篡改目标和原五字段归档，均能发现。

以上写入/恢复证据为 Mock 和内存事务。当前 MySQL 仅实际执行新身份读取与源数据读取，没有实际钱包批次 DML。已修正测试夹具残留的会员字段引用，清理过期命名；未修改冻结迁移文件、旧证明链或用户数据。

## 后续和限制

恢复副本需执行真实批次写入、证据失败回滚、提交响应丢失恢复、独立回读和清理验收。当前四条非空创建时间的真实依据仍未取得；合成夹具依据不得用于当前数据回填。批次调用方仍需绑定审查后的 manifest、时间证据目录及预检，不能仅把 approved 设置为 true 就称为生产可用自动升级。

wallet_keys 的删除仍需真实回填、运行读写切换及清理门验收；当前固定支付收款地址和派生钱包关系保持分离。全库自动升级与旧结构退出尚未完成。
