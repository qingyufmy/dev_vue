# 阶段 12G：Execution Worker、Bridge Gateway 与可信投影交接验收记录

> 日期：2026-09-03
> 范围：服务端 Execution Worker、Bridge V4 会话/当前 route、账户串行租约、持仓/挂单可信快照、重连恢复与风险预留吸收
> 明确不包含：执行数据库迁移、挂载正式公网 WSS upgrade、启动 Bridge、连接 MT4/MT5、执行交易或部署

## 1. 完成的竖切

```text
prepared execution intent
  -> Redis 账户短租约
  -> 恢复既有 queued command，或从服务端冻结 intent 组装新 command
  -> 数据库活动命令门保证同账户只有一个未收敛命令
  -> 当前 Redis route + 本进程 socket 精确投递

Bridge 单次 session ticket + session.hello
  -> MySQL 校验用户/安装/档案/账户归属/终端绑定/epoch
  -> Redis 按 WebSocket 档案计算连接额度并登记当前账户 route
  -> session.welcome
  -> 重连只发送一条 command.reconcile，不发送 command.request

positions / pending_orders 完整快照
  -> 当前 session fencing
  -> 公共交易投影 + exact trade state 同事务提交
  -> revision/time/ticket 或状态证据充分
  -> committed risk reservation -> absorbed
```

## 2. Gateway 与连接额度

- V4 ticket 仍为 60 秒内单次消费，hello 的安装 ID 和档案 ID必须与票据 claims 一致。
- 当前服务端首版明确一个 WebSocket 对应一个终端档案和一个账户 route；Bridge 软件连接多个 MT4/MT5 账户时建立多个独立档案连接。
- 基础额度为 1，购买额度按“同时活跃的 WebSocket/档案”累加，不按保存过多少账户或切换过多少账号计算。
- MySQL 先校验账号归属、档案、安装、平台、终端实例和账户身份；`connection_epoch_v4` 必须严格递增。Redis 保存当前账户 route，旧 socket 即使尚未物理断开，也无法 renew 或提交回执/投影。
- 新 session 写入后再激活；连接额度申请失败会关闭新 session，而不会先关闭旧数据库 session。
- 当前 socket directory 是模块化单体的进程内窄边界；未来若 BaoTa/PM2 使用多实例，必须增加 Redis Streams/进程定向投递或固定 sticky worker，不能假装进程内 socket 可跨实例访问。

## 3. Execution Worker 串行和崩溃恢复

- Redis 账户短租约只保护“读取候选、创建 durable command、投递”的短临界区，不跨终端等待持有。
- MySQL command source 额外拒绝同账户存在其他 `queued/dispatched/accepted/uncertain/reconciling` 命令，防止租约释放后第二条命令越过前一条未完成命令。
- Worker 每次先按稳定 `intent + sequence` 查找 durable command。若上次崩溃发生在 queued 后、发送前，只投递原命令和原 route；若命令已 dispatched 或更后状态，只返回既有状态，绝不重发。
- 新命令参数来自冻结 intent payload、当前服务端 route、可信 expected state 和服务端注入的 magic/deviation 默认值；socket 上行不能构造交易命令。
- 正式 runtime 组合时必须从配置/账户策略显式提供 `BridgeExecutionDefaults`，不能把测试值当生产默认值。

## 4. 重连只对账

- 新 epoch 接管后仅查询同终端、同 broker/login、旧 epoch 不高于当前 epoch 的 uncertain/reconciling 命令；后者只会重发幂等对账查询，不会重发交易指令。
- 每账户同一时刻最多发送一条 `command.reconcile`；结果先落库，再发送 `command.result_ack`，随后才请求下一条。
- 对账发送失败回到 uncertain；普通 dispatch 不参与重连恢复。
- 明确终态冲突仍走阶段 12F 的人工复核和风险预留重新占用规则。

## 5. 可信投影与 absorbed

- `positions` 和 `pending_orders` 只接受完整快照；增量帧返回 `resync_required`，避免把局部 deletes 当作“持仓已不存在”。
- 合同新增拒绝未知字段的规范化 position/pending item。账户 ID不由 Bridge item 提供，而从已认证 route 注入。
- 同一 MySQL 事务锁定账户和当前 session，推进公共 projection revision，替换 exact-state 快照，再评估预留吸收。
- `order.place` 必须由终端结果 ticket 精确命中当前实体；完整平仓/撤单必须由完整快照证明目标缺失，部分平仓则必须由冻结前状态精确证明剩余手数；修改保护/挂单必须逐字段匹配请求结果。
- 所有动作还要求快照 revision 严格高于该 intent 冻结 revision，且快照观测时间不早于终端结果时间。任一证据不足，预留继续保持 committed 并计入容量。

## 6. 数据库与迁移

阶段 12G 复用未执行的 `20260903_010_bridge_v4_command_ledger.sql`：

- `bridge_connection_sessions.connection_epoch_v4`
- `bridge_trade_state_snapshots_v4`
- `bridge_commands_v4` 及 payload/result/event
- `risk_reservations_v4.absorbed`

没有修改旧迁移、没有新增无必要表，也没有执行任何迁移。公网旧结构到 V4 的迁移链继续保留。

## 7. 第一轮复审：职责与最小设计

第一轮发现并修正：

1. 连接额度不能沿用阶段 11 的“账户数量”租约；V4 Gateway 改为 WebSocket/档案 lease，账户可删除和更换。
2. 在容量申请前关闭旧 session 会导致新连接超额时误伤旧连接；改成新 session 先登记、Redis claim 成功后再激活替换。
3. 只用进程内 socket map 无法判断当前 route；命令 transport 同时检查 Redis route 与本进程 connection directory。
4. 不引入工作流引擎、微服务或 Bridge 业务规则；继续使用模块化单体、MySQL 短事务、Redis lease 和窄协议适配。

## 8. 第二轮复审：并发、断线和误吸收

第二轮发现并修正：

1. Worker 发送后立即释放 Redis lease，且短租约可能在慢查询期间过期；同账户活动 command gate 同时放在候选读取和账户行锁后的命令创建事务中。
2. Worker 崩溃在 queued 与发送之间时，用当前 route 重组会产生幂等冲突或错误换路；增加 durable queued 原命令恢复，dispatched 及以后绝不重发。
3. 一次重连批量发送 32 条 reconcile 会违反单命令在途设计；调整为每次一条，结果落库并 ACK 后再取下一条。
4. 仅凭 ticket/缺失会误吸收旧快照；增加“投影 revision 严格递增 + 观测时间不早于结果”的双重门。
5. 被替换 socket 仍可能在物理 close 前发消息；每个 accepted/result/stream 都再次 renew Redis fencing 并 touch 精确 MySQL session。

## 9. 验证结果

- Stage 12G 定向：7 files / 50 tests passed。
- 服务端 TypeScript：passed。
- Bridge V4 JSON Schema：JSON 解析 passed。
- 前端边界、全量测试、全量 typecheck 与四应用 build：passed。
- 根全量：227 files / 3496 tests passed；另有 2 个既有 Bridge release tooling 测试因当前子 `powershell.exe` 环境缺少 `Get-FileHash` 失败，与本阶段代码无关。
- `git diff --check`：passed。

## 10. 剩余风险

- 当前仍是离线模块边界，尚未挂到 `server/index.js` 的正式 `/bridge/v4/ws` upgrade；不能据此宣称公网 Gateway 已运行。
- 未在真实 MySQL 8.4.8/Redis 上演练锁竞争、Lua 接管、连接过期和故障恢复。
- 当前 position/pending 规范化条目需要 Bridge .NET/MT4/MT5 适配器按合同产生；本阶段只验证服务端 decoder，不修改或启动客户端。
- PM2 多实例下需要明确 socket 所在 worker 的路由方式；在此之前建议 Gateway 单实例或 sticky worker，不能跨进程直接使用 in-memory directory。
- 没有执行任何模拟账户或真实账户交易，也没有读取用户当前终端。
