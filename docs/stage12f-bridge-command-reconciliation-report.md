# 阶段 12F：Bridge V4 持久命令与结果对账验收记录

> 日期：2026-09-03
> 范围：prepared execution intent 到 Bridge V4 命令、服务端持久账本、投递边界、回执确认、结果冲突与精确对账
> 明确不包含：执行数据库迁移、启动正式 Gateway、连接 Bridge、操作 MT4/MT5、生产部署

## 1. 本阶段解决的问题

阶段 12E 只把已批准风险决定转成 `execution_intent prepared` 和短期风险预留。本阶段补齐其后的机械命令生命周期：

```text
execution_intent prepared
  -> bridge_command queued（请求全文已持久化）
  -> bridge_command dispatched（事务已提交）
  -> 才允许 WebSocket 写入 command.request
  -> accepted / result
  -> 结果先持久化并推进 intent/reservation
  -> 才生成 command.result_ack
```

Bridge 仍只是数据与确定性终端命令适配器。策略、会员、账户归属、交易权限、风险、参数和 route 均由服务端在创建及发送前校验。

## 2. 命令身份与 V4 合同

- 命令 ID 和幂等键由 `execution_intent_id + command_sequence` 稳定生成，同一意图序号不会创建第二笔交易身份。
- create 响应丢失后的相同请求先读取并返回既有 durable command；不会因为 intent 已进入 dispatched/accepted 或 route 已重连而把幂等重试误判为新建失败。
- route 冻结 `terminal_instance_id + broker_server + login + connection_epoch`；首次投递必须精确匹配，重连后的结果/对账只允许同终端同账户且 epoch 单调增加。
- action 只允许 `order.place`、持仓保护修改、平仓、挂单修改和撤单五种交易动作；`execution.lookup` 只属于 Bridge 内部对账能力，不伪装成新的交易命令。
- decimal、ticket、订单方向/类型、显式移除字段、完整 expected state、deadline 和安全整数 epoch 在进入持久层前校验。
- intent 冻结 action JSON/hash 必须与命令参数一致，命令 deadline 不得超过 intent 的短期有效期。
- 持仓/挂单管理命令还必须精确匹配服务端 `bridge_trade_state_snapshots_v4`：ticket、完整 expected state、投影 revision、终端实例和 V4 epoch 任一缺失或不一致均拒绝。Stage 12G 未接入可信投影前，管理类命令不会降级为调用方自报 expected state。

## 3. 不重放与不确定结果

- route 在写入前明确不可用：命令/intent 记为 `failed`，确认未产生终端副作用，释放活动风险预留。
- `dispatched` 已提交后，WebSocket 写入抛错：结果无法证明，命令/intent 进入 `uncertain`，风险预留继续占用。
- `uncertain` 不能再次调用普通 dispatch；只能发送 `command.reconcile`，查询 Bridge 的持久账本和精确终端事实。
- 对账消息和原 `command.request` 使用不同消息类型；即使重连也不会把交易请求当作重试发送。

## 4. 回执、结果与风险预留

- `command.accepted` 表示 Bridge 已先写入本地 SQLite 账本，intent 进入 `awaiting_result`。
- `succeeded`：intent 成功，活动风险预留提交为 committed；在可信持仓/挂单投影标记 absorbed 前仍继续计入容量，消除“成功回执先到、投影后到”的漏算窗口。
- 明确 `rejected` 或 `failed`：intent 终结，活动风险预留释放。
- `uncertain`：intent 等待精确对账，活动风险预留保持 active。
- 账户容量统计包含 `active + committed` 预留，不再按 30 秒时间自动忽略；只有尚未投递的 prepared intent 才能由过期作业显式改为 `expired`。`absorbed` 只能由后续可信投影对账写入。
- 相同结果重复到达返回 `duplicate` ACK，不重复推进状态。
- 同一命令出现不同结果 hash 时，两份证据都保留；命令和 intent 转为 `uncertain`，不覆盖第一份结果，也不自动生成补偿单。
- 只有“前一份持久结果本身为 uncertain，随后显式进入 reconciling”的后续结果才是合法对账证据；它可以继续 uncertain（保持预留并允许下一轮精确对账），也可以收敛到 succeeded/rejected/failed。已有明确终态后再出现不同终态证据一律 fail-closed，并要求人工复核，不能直接再次 reconcile 解锁。
- 明确终态之后若出现冲突，`committed/released/expired` 预留都会重新变为 active，直到人工或精确对账解除，避免投影尚未追上时低估风险容量。
- operation 根据所有子 intent 汇总为 running、succeeded、partially_succeeded、rejected、failed 或 uncertain，并只通过小型 `operation.changed` outbox 事件通知浏览器。

## 5. 数据库与迁移边界

新增迁移 `20260903_010_bridge_v4_command_ledger.sql`，建立：

- `bridge_commands_v4`
- `bridge_command_payloads_v4`
- `bridge_command_results_v4`
- `bridge_command_events_v4`
- `bridge_trade_state_snapshots_v4`

阶段 11 的 opaque 文本 `connection_epoch` 原样保留，010 新增 nullable 的 `connection_epoch_v4 BIGINT UNSIGNED`。因此旧 e1/e2 数据无需猜测转换，旧连接 lease 的 string 合同也不被本阶段破坏。旧全局 epoch 唯一键改为 `terminal_instance_id + epoch` 复合唯一；不同 MT4/MT5 profile 可以各自从同一 epoch 起步。旧 `bridge_v3_command_ledger` 不删除、不更新、不自动回填。旧记录以后按 command/hash/route/result 证据有界迁移；任何可能已送达终端但无法证明的状态只能映射为 `uncertain`。

本阶段没有执行 010，也没有把未执行的结构描述成当前数据库事实。

## 6. 第一轮复审：协议与副作用边界

第一轮发现并调整：

1. 阶段 11 的 opaque `connection_epoch` 与 Bridge V4 数值合同不同；最终采用并列 `connection_epoch_v4`，避免对旧文本 epoch 作有损或不可证明映射。
2. 仅依赖 command ID 不能防止错动作；持久层增加 intent action-kind 到 Bridge action 的确定映射检查。
3. 先发送再落 `dispatched` 会在数据库失败时产生不可追踪副作用；改为短事务先推进，再在事务外写 socket。
4. “socket 抛错”等于“没有发送”并不成立；统一进入 `uncertain`，禁止普通重试。

## 7. 第二轮复审：结果、锁和恢复

第二轮重点检查多回执、预留和死锁边界：

- 结果正文和 hash 追加保存，当前投影只保存稳定引用；冲突不能覆盖证据。
- 锁顺序固定为账户/route → execution intent → Bridge command → reservation → operation/outbox；外部 I/O 不进入事务。
- 只有明确无副作用的发送前失败释放风险预留；`uncertain` 与 reconciling 均不释放。
- result ACK 由应用层在 repository 成功返回后构造；服务端落库失败时不 ACK，Bridge 保留 Outbox 并重复上报同一结果。
- 当前没有引入工作流引擎、分布式事务或 Bridge 业务策略，保持模块化单体和窄协议边界。

第三轮针对可上线边界又修正：

- command params 绑定冻结 intent action JSON/hash；管理类 expected state 再绑定可信终端状态快照及投影 revision，不接受调用者单方面构造。
- 旧 session epoch 不原地改型，解除全局唯一并建立终端实例复合唯一；V4 数值 fence 使用独立列。
- account 显式先锁，再校验 route、intent、command、reservation 和 operation，避免依赖 MySQL join 优化器的锁顺序。
- 重连后允许同终端同账户更高 epoch 上报结果，ACK 返回实际入站 route；不会把旧请求投递到新 route。
- 区分合法 uncertain 对账收敛与明确终态冲突，后者会重新占用风险预留。

## 8. 验证结果

- Stage 12D/12E/12F 定向状态机与边界：5 files / 49 tests passed。
- 服务端 TypeScript：`npm run typecheck:server` passed。
- 合同：OpenAPI 与 Realtime JSON 均解析成功。
- 根全量：224 files 中 223 passed；3477 tests 中 3475 passed。仅 `tests/bridge-release-tool.test.js` 的 2 项既有环境失败：子 `powershell.exe` 找不到 `Get-FileHash`，与本阶段命令状态机无关。
- 前端：边界验证 passed；8 files / 23 tests passed；全部 workspace typecheck passed；www/auth/admin/trade build passed。
- `git diff --check` passed。

本阶段没有把根全量的 2 项环境失败误报为通过，也没有为了消除它们修改 Bridge 发布工具。

## 9. 剩余风险与后续阶段

- MySQL 迁移和锁竞争尚未在旁路库演练，SQL 单元边界不能替代真实 MySQL 8.4.8 验证。
- 正式 `/bridge/v4/ws` Gateway 尚未接入本服务；当前 transport 是窄接口和内存测试替身。
- 发送前的最终报价偏移、合约规格和完整终端 expected-state 采集仍需在后续 execution worker/Gateway 竖切中写入 `bridge_trade_state_snapshots_v4`；在此之前管理类命令保持 fail-closed。
- Redis 账户串行租约、重连后命令恢复、Bridge Outbox ACK 和断电场景需阶段 15–16 联调。
- 未进行任何 MT4/MT5 下单、挂单、撤单、修改或平仓；离线状态机通过不能代替实机验收。
