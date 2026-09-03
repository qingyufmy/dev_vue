# 交易执行统一状态机

> 版本：V1.0 设计基线
> 日期：2026-09-02
> 适用范围：AI 自动信号、用户手动交易、策略订阅者分发、持仓管理、挂单管理、风控、Bridge V4、MT4/MT5 回执、成交归因、对账和审计

## 1. 文档目标

本方案冻结新版交易执行的统一语义，使任何交易入口最终都经过同一条可恢复链路：

```text
请求/信号
  → 权限与账户快照
  → 风控决策与风险预留
  → 交易意图
  → Bridge 命令账本
  → MT4/MT5 执行
  → 回执与终端资源复核
  → 持仓/挂单/成交结果
  → 审计与实时通知
```

本阶段只确定状态、转换、幂等、权限、恢复和审计规则，不实现新版服务、不修改数据库、不执行真实交易，也不删除旧表或旧逻辑。物理表结构、逐表映射和数据迁移在阶段 7 单独设计。

## 2. 当前代码事实

当前系统已经具备多项可保留的安全能力，但分散在不同模块：

- `order_intents` 使用幂等键、风险预留、发送前持久化和 `uncertain` 对账；发送后未知结果不会自动重发。
- `bridge_v3_command_ledger` 记录命令业务哈希、连接世代、deadline、投递次数、结果哈希和只追加事件；已投递命令默认禁止重发。
- 自动信号分发通过 `auto_signal_deliveries` 记录每个用户的执行状态并关联订单意图。
- AI 持仓管理使用任务、命令、版本号、租约和 fencing token，区分撤单、成交竞态、平仓、部分平仓和人工复核。
- 管理员策略分发、批量平仓和批量撤单各自维护父任务与目标状态，并能表达部分成功和未知结果。
- `signal_outcomes` 与成交明细用于把信号、订单意图、ticket、position 和最终盈亏关联起来。

主要问题不是缺少保护，而是状态语义重复且不一致：

- `failed` 有时表示发送前参数错误，有时表示经纪商拒绝，有时表示无法确认结果。
- `skipped` 同时承担无需执行、目标已不存在、挂单已经成交和前置目标失败等不同含义。
- 父任务使用 `partial`，公共 V4 操作状态却没有对应状态。
- 业务任务状态、命令投递状态和终端资源状态混在同一长枚举时，前端难以解释，恢复逻辑也容易误判。
- 旧实现仍大量使用北京时间写库；新版必须统一为 UTC 事实时间。

## 3. 设计原则

1. **一个机械执行入口**：自动、手动、分发、风控和平仓最终都调用 execution 应用域，不各写一套发单逻辑。
2. **状态分层而非巨型枚举**：公共操作、执行意图、Bridge 命令、终端资源、来源分发分别维护自己的有限状态，通过稳定 ID 关联。
3. **发送不等于成功**：服务端写出 WebSocket、Bridge 接收命令、Bridge 调用终端均不能单独证明交易完成。
4. **未知结果优先安全**：只要命令可能已送达 MT，超时、断线、进程退出或数据库异常均进入 `uncertain`，禁止自动重发。
5. **同一业务动作只生成一个幂等身份**：客户端重试、HTTP 重试、队列重投和 Bridge 结果重放只能读取或推进原记录。
6. **每个账户独立成败**：批量分发不是跨账户事务；每个目标独立风控、独立命令、独立结果，父操作只做汇总。
7. **AI 不拥有机械执行权**：AI 只产生结构化建议；服务端确定性权限、风控、合约规则和 Bridge 安全层决定是否执行。
8. **短事务、无外部 I/O**：数据库事务只锁定和更新必要行；Bridge、模型和其它网络调用必须在事务外进行。
9. **事实时间统一 UTC**：状态转换与 deadline 存 UTC；终端时间仅作为带来源和校准状态的交易业务证据。
10. **前端可解释**：用户看到自然中文、当前阶段、失败原因和下一步；不得暴露内部异常堆栈或把未知显示成失败。

## 4. 五类关联状态

### 4.1 公共异步操作 `operation`

所有 HTTP 交易写请求先返回一个 operation。它用于前端查询、WebSocket 增量和后台审计，不承载全部领域细节。

| 状态 | 含义 | 是否终态 |
|---|---|---:|
| `accepted` | 请求已通过基础合同并在 MySQL 持久化 | 否 |
| `queued` | 已写入 outbox，等待 execution worker | 否 |
| `running` | 正在验证、风控、投递或对账 | 否 |
| `succeeded` | 期望业务结果已由可靠证据确认 | 是 |
| `partially_succeeded` | 批量父操作已结束，部分目标成功、部分未成功 | 是 |
| `rejected` | 权限、风控、前置条件或经纪商明确拒绝，且无未知副作用 | 是 |
| `failed` | 系统无法完成，但已证明没有产生目标交易副作用 | 是 |
| `uncertain` | 可能已产生交易副作用但当前无法确认；必须对账 | 否 |
| `cancelled` | 在首次投递前成功取消 | 是 |
| `expired` | 在首次投递前超过有效期 | 是 |

`partially_succeeded` 只允许父级批量操作使用；任何单账户子操作不得使用它。

### 4.2 执行意图 `execution_intent`

执行意图描述“一次确定性的账户级业务动作”，包括：

- `order.place`
- `position.close`
- `position.modify_protection`
- `pending_order.cancel`
- `pending_order.modify`

内部状态：

| 状态 | 说明 |
|---|---|
| `preparing` | 冻结用户、账户、来源、目标资源和请求参数 |
| `risk_pending` | 等待独立风险决策 |
| `prepared` | 风控通过且风险预留、expected state 和命令参数已固化 |
| `dispatching` | 已创建 Bridge 命令并开始投递；从此不得普通重试 |
| `awaiting_result` | Bridge 已确认本地入账或 MT 调用已开始，等待终端结果 |
| `reconciling` | 正在通过命令账本、持仓、挂单、订单和成交历史核对 |
| `succeeded` | 目标资源状态已确认 |
| `rejected` | 确定性拒绝，未产生未知交易副作用 |
| `failed` | 系统失败且已证明无交易副作用 |
| `uncertain` | 结果未知，等待下一次对账或人工处理 |
| `cancelled` | 首次投递前取消 |
| `expired` | 首次投递前过期 |

`awaiting_confirmation` 不再作为交易执行状态；需要用户确认时，HTTP 请求仍未创建可发送意图。确认后的第二次请求使用同一个 `client_request_id` 创建或恢复原 operation。

### 4.3 Bridge 命令 `bridge_command`

Bridge 命令只描述通信和终端调用，不代替订单业务状态：

```text
queued
  ├─→ expired                 # 从未投递
  ├─→ cancelled               # 从未投递
  └─→ dispatched
       ├─→ accepted           # Bridge 已先写本地账本
       ├─→ rejected           # route/deadline/capability/expected state 拒绝
       └─→ uncertain          # 无法确认是否接收或是否已调用 MT

accepted
  ├─→ succeeded
  ├─→ rejected
  ├─→ failed
  └─→ uncertain

uncertain ─→ reconciling ─→ succeeded | rejected | failed | uncertain
```

约束：

- `command_id` 全局唯一；同 ID 不同业务哈希是安全冲突，不能覆盖。
- Bridge 必须先持久化命令，再回复 `command.accepted`，再调用 MT。
- 服务端持久化结果后才回复 `command.result_ack`；Bridge 在收到 ack 前保留并重放同一结果。
- `failed` 仅表示已确定命令未产生目标交易结果；无法证明时必须是 `uncertain`。
- `connection_epoch` 变化不会授权把旧命令发送到新连接；旧命令只允许对账。

### 4.4 终端资源状态

终端资源是经纪商事实的本地投影，不由 operation 状态直接推导。

**持仓**：

```text
open → partially_closed → closing → closed
  └──────────────────────────────→ externally_changed
任何状态在证据不完整时 → unknown
```

**挂单**：

```text
pending → modifying → pending
pending → cancelling → cancelled
pending → partially_filled → filled
pending → expired
任何状态在证据不完整时 → unknown
```

终端资源使用 `resource_revision` 做乐观并发。修改止盈止损、撤单、改单和平仓必须携带读取时的 revision 和完整 expected state；过期 revision 在发送前明确 `rejected`。

### 4.5 来源与批量分发状态

来源只解释交易为何发生，不拥有另一套机械下单实现：

- `automatic_signal`
- `manual_order`
- `strategy_distribution`
- `position_management`
- `risk_guard`
- `admin_command`

批量分发由一个父 operation 和冻结的多个子 operation 组成。父级汇总规则：

| 子操作结果 | 父操作结果 |
|---|---|
| 全部成功或已处于期望状态 | `succeeded` |
| 至少一个成功，且至少一个 rejected/failed/expired/cancelled | `partially_succeeded` |
| 任一子操作 uncertain/running | `uncertain` 或 `running`，不得提前终结 |
| 零成功且有明确拒绝 | `rejected` |
| 零成功且只有系统失败 | `failed` |
| 目标快照为空 | `rejected`，原因 `no_eligible_targets` |

父操作的 `result_summary` 保存总数和各状态计数；子操作保留各自原因，不用 `skipped` 隐藏业务结果。

## 5. 核心状态转换

### 5.1 新开仓或新挂单

```text
accepted → queued → running/preparing
  → risk_pending
    ├─→ rejected              # 风控拒绝
    └─→ prepared              # 风险预留成功
         ├─→ cancelled/expired
         └─→ dispatching
              → awaiting_result
                ├─→ succeeded
                ├─→ rejected
                ├─→ failed
                └─→ uncertain → reconciling → 终态或继续 uncertain
```

只有 `succeeded` 才创建或确认交易 outcome。风险预留在成功时提交，在明确拒绝、发送前失败、取消或过期时释放；`uncertain` 必须继续占用预留，直至对账证明结果。

### 5.2 平仓

平仓是独立意图，不修改原开仓意图：

1. 冻结账户、ticket/position_id、方向、magic、当前手数、目标平仓手数和资源 revision。
2. 发送前重新查询精确持仓并比较 expected state。
3. 终端回执后再次查询持仓与成交历史。
4. 全部消失且成交归因匹配为 `succeeded`；剩余手数为部分平仓事实，更新资源后按请求目标判断成功或继续处理。
5. Bridge 返回成功但持仓仍完整存在时进入 `uncertain`，不得再次平仓。

若发送前已确认持仓不存在，且历史证据证明同一持仓已经关闭，则 operation 可幂等完成为 `succeeded`，`completion_reason=already_closed`；不能完成归因时进入 `uncertain`。

### 5.3 修改持仓止盈止损

- 使用独立 `position.modify_protection` 意图。
- `null` 表示不修改该字段；明确移除保护必须使用独立布尔意图，不以 `0` 和缺失混用。
- 发送前校验账户归属、ticket/position_id、方向、magic、volume、revision、价格精度、最小距离和 freeze level。
- 终端回执成功后必须以持仓快照复核实际 SL/TP；不一致进入 `uncertain`。
- 不允许把修改保护失败转换为自动平仓或新开仓。

### 5.4 撤销挂单

撤单必须处理“撤单同时成交”的竞态：

| 发送前/发送后事实 | 操作状态 | 资源结果 |
|---|---|---|
| 挂单仍存在且身份一致，随后确认消失并有取消证据 | `succeeded` | `cancelled` |
| 发送前已确认取消或过期 | `succeeded` | `cancelled/expired`，原因 `already_absent` |
| 发送前或发送中已经成交 | `rejected` | `filled`，原因 `pending_filled` |
| ticket 存在但身份不符 | `rejected` | 原资源不修改，原因 `resource_identity_changed` |
| Bridge 声称成功但挂单仍存在 | `uncertain` | `pending/unknown` |
| 数据范围不完整，无法判断消失原因 | `uncertain` | `unknown` |

挂单成交不能显示为“撤单成功”，也不能用 `skipped` 掩盖。

### 5.5 修改挂单

- 使用独立 `pending_order.modify` 意图，携带完整 expected state 与目标字段。
- 修改过程中若挂单已成交，operation 为 `rejected`，并立即刷新对应持仓。
- MT4 不支持的 stop-limit 等能力由 Bridge capability 在发送前拒绝；不得静默降级为另一订单类型。
- 回执后用挂单快照复核价格、SL/TP、有效期和手数。

## 6. 自动分析、手动交易与策略分发

### 6.1 自动信号

- 分析结果先独立保存，观望信号不创建执行意图。
- 每个“系统用户 + 交易账户 + 信号 + 动作版本”只生成一个幂等子操作。
- 订阅、自动分析开关、交易发送开关、会员、账户归属、Bridge route 和风险状态在发送前重新校验。
- AI 原始方向、信号类型和参数不得被服务端改写；风控拒绝作为独立 execution 结果记录。
- 用户没有连接 Bridge 时仍可完成分析并保存信号，但执行 operation 明确 `rejected: bridge_unavailable`。

### 6.2 用户手动交易

- 普通用户只能操作当前归属且具备交易权限的账户。
- 前端必须提交 `client_request_id` 和确认后的完整订单参数；重复点击只能返回同一 operation。
- 手动单可不关联 AI 信号，但必须记录 actor、账户、参数快照、风险决策和终端结果。
- 观摩模式严格只读，不得创建交易 operation。

### 6.3 向策略订阅者分发手动单

- 仅具备 `trade.distribute` 权限的角色显示并可调用分发能力；普通订阅用户不可向其它账户广播交易。
- 确认时冻结策略版本、订单参数、有效期和当时所有合格订阅目标。后续新订阅用户不得加入同一次分发。
- 每个目标重新校验会员、订阅时间、接收时段、自动执行开关、交易权限、账户归属、Bridge route、合约规格和风控。
- 每个目标创建独立执行意图；同一账户内串行，不同账户有界并发。
- 同一系统用户拥有多个已连接交易账户时，每个账户按自己的策略订阅、接收时段、风险政策和 Bridge route 独立执行；用户级并发额度只控制当前账户 WebSocket 数量，不共享或合并账户风险。
- 一个目标失败不得回滚已成功目标，也不得绕过其它目标的独立风控。
- 前端展示父操作汇总，并允许展开每个账户的明确状态和原因。

### 6.4 分发平仓

- 分发平仓只能针对原分发的稳定 `distribution_id` 和其已确认子 outcome。
- 确认时冻结仍处于 open/partially_closed 的精确 ticket/position_id；不得按品种或策略模糊地把账户全部平仓。
- 每个目标单独创建 `position.close` 子操作并复核当前归属、magic、方向和手数。
- 原分发之外的手动单、其它策略单或外部仓位不得被包含。
- 父操作按子操作结果产生 `succeeded / partially_succeeded / rejected / failed / uncertain`。

## 7. 幂等身份

所有键由服务端规范化后计算，客户端提供的字符串不能直接决定跨用户作用域。

| 来源 | 幂等业务身份 |
|---|---|
| 自动信号 | `account_id + signal_id + action + action_version` |
| 用户手动交易 | `user_id + account_id + client_request_id` |
| 分发父操作 | `actor_user_id + strategy_id + client_request_id` |
| 分发子操作 | `distribution_id + target_account_id + action + target_revision` |
| AI 持仓管理 | `management_task_id + command_type + command_sequence` |
| 风控保护 | `risk_event_id + account_id + ticket + action` |
| 管理员命令 | `admin_job_id + target_id + action` |
| Bridge 命令 | `execution_intent_id + command_sequence` |

同一幂等身份但请求业务哈希不同必须返回 `409 idempotency_conflict`，不得覆盖旧参数或创建第二笔交易。

## 8. 并发、租约与锁

### 8.1 串行键

所有会改变终端交易状态的命令按以下键串行：

```text
trading_account_id + terminal_instance_id + ownership_epoch
```

同账户的下单、撤单、改单、平仓和保护修改不会并发写终端；跨账户使用受控并发。报价、K 线和只读查询不进入交易串行队列。

### 8.2 数据库并发

- 按固定顺序锁：账户/归属 → operation/intent → 风险状态/预留 → outbox。
- 使用 `state_version` 做乐观并发，使用 lease token + fencing token 防止旧 worker 回写。
- 外部 I/O 前提交事务；回执使用新事务和期望版本推进状态。
- worker 失去租约后立即停止，不得继续发 Bridge 命令或覆盖结果。
- 死锁只允许重试无外部副作用的短事务；任何已经开始发送的步骤不得因数据库重试而重发命令。

### 8.3 账户切换与连接世代

- 普通账户同一时刻只允许一个具备交易权限的有效终端 route。
- 一个系统用户可以在有效 Bridge 并发额度内拥有多个普通账户 route；每个 route 对应一条独立账户 WebSocket。离线档案不占额度，限制单位仍是同一稳定交易账户最多一个可交易 route，而不是整个系统用户只能有一个终端。
- 账户切换、归属接管或 `connection_epoch` 变化会取消尚未投递的旧 route 命令。
- 已经投递的旧 route 命令进入对账，不能转发到新 route。
- 管理员观摩源是独立只读身份，不进入普通用户交易 route。

## 9. 失败与恢复矩阵

| 故障位置 | 状态 | 自动动作 |
|---|---|---|
| 持久化 operation 前失败 | 无 operation | 客户端可使用同 request id 重试 |
| 已 accepted/queued，尚未创建 Bridge 命令 | `queued/running` | 同一意图可由 worker 恢复 |
| 风控或 expected state 明确不通过 | `rejected` | 不重试；参数或状态变化后创建新请求 |
| 发送前系统失败且确认无副作用 | `failed` | 只可恢复同一意图，是否重试由错误策略决定 |
| Bridge 命令已标记 dispatched 后断线 | `uncertain` | 查询 Bridge 账本、订单、成交、持仓、挂单 |
| Bridge 收到命令但服务端没收到 accepted | `uncertain` | 不重发；等待 Bridge 重连上报账本 |
| MT 返回结果但服务端落库失败 | `uncertain` | Bridge 保留结果并重复上报，服务端按结果哈希幂等写入 |
| Bridge 成功回执但资源未出现/未消失 | `uncertain` | 在限定窗口内对账，不按成功或失败猜测 |
| 相同结果重复到达 | 原状态 | 幂等确认并再次发送 result ack |
| 同命令不同结果哈希 | `uncertain` | 安全事件 + 人工复核，不覆盖证据 |
| 任务租约超时且从未投递 | `queued/failed/expired` | 同意图安全恢复 |
| 任务租约超时且可能已投递 | `uncertain` | 只对账 |
| 服务重启 | 持久状态不变 | outbox/worker 从 MySQL 恢复，不根据内存推断 |

对账必须有范围上限、游标、时间窗口和证据完整度。超过可自动核实窗口仍无法确定时保留 `uncertain` 并进入人工处理，不得释放风险预留或生成补偿单。

## 10. 权限与风险边界

每次发送前均校验：

1. actor 会话、角色和命令权限；
2. 系统用户与交易账户当前归属；
3. Bridge route、终端实例、broker server、login 和 ownership epoch；
4. 观摩/只读/交易权限；
5. 会员和策略订阅对当前动作是否有效；
6. 用户运行时段只限制该用户接收和执行信号，不改变平台策略实际运行时间；
7. 账户和平台 kill switch；
8. 独立风险政策、风险快照完整度和风险预留；
9. 品种映射、合约规格、最小手数、步进、价格精度和终端 capability；
10. 目标资源 expected state 与 revision。

管理员权限不能跳过账户身份、Bridge route、幂等、终端能力、结果确认和审计。紧急平仓仍是显式、可审计、逐账户的 `position.close` 操作。

## 11. 事件、追踪与审计

所有状态推进写入不可变事件，最少包含：

- `event_id`、`occurred_at_utc`、`event_type`；
- `operation_id`、`execution_intent_id`、`bridge_command_id`；
- `parent_operation_id`、`distribution_id`、`source_type/source_id`；
- `actor_type/actor_user_id`、`user_id`、`trading_account_id`；
- `terminal_instance_id`、`connection_epoch`、`ownership_epoch`；
- `from_status/to_status`、`reason_code`、安全脱敏摘要；
- `request_hash`、`expected_state_hash`、`result_hash`；
- `signal_id`、`risk_decision_id`、`outcome_id`、ticket/position_id；
- `trace_id`、`causation_id`、`correlation_id`。

不得把 API key、刷新令牌、完整账号凭据或模型密钥写入事件。原始 Bridge 结果和大快照保存在受控证据表/对象中，事件只保存引用和哈希。

浏览器通过 `operation.changed`、`signal.execution.changed`、`positions.changed` 和 `pending_orders.changed` 获得增量；刷新或 revision 缺口时使用 HTTP 恢复权威快照。

## 12. 前端展示规则

- `accepted/queued`：已受理，等待处理。
- `running`：显示当前阶段，例如“风控校验中”“正在发送”“正在核对终端结果”。
- `succeeded`：只有确认目标结果后显示“已下单/已平仓/已撤单/已修改”。
- `partially_succeeded`：显示成功数、失败数和待处理数，可展开每个目标。
- `rejected`：显示自然中文原因以及可修改项，不显示成系统故障。
- `failed`：显示“本次未执行”，并明确没有产生交易副作用。
- `uncertain`：显示“结果待核对”，禁用重复执行按钮，只提供刷新状态或联系管理员。
- `cancelled/expired`：说明命令未发送到终端。

前端不得依据 WebSocket 断线、按钮超时或本地乐观状态自行把交易改成失败或成功。

## 13. 旧状态到目标语义

| 旧状态/模块 | 目标处理 |
|---|---|
| `order_intents.preparing/prepared/bridge_sending` | 迁移为 execution intent 的 `preparing/prepared/dispatching` |
| `order_intents.uncertain` | 保留为强安全语义，进入统一对账 |
| `auto_signal_deliveries.not_attempted/executing` | 作为来源子操作投影，不再拥有发单实现 |
| `auto_signal_deliveries.success/failed/skipped` | 由关联 operation 结果投影，并把 skipped 原因分类为 rejected/succeeded/expired/cancelled |
| `bridge_v3_command_ledger` | 迁移为 Bridge V4 命令账本，保留业务哈希、结果哈希和事件历史 |
| `ai_position_management_tasks` 长状态 | 保留为领域工作流；实际撤单/平仓命令改关联统一 execution intent |
| 管理员 dispatch/close/cancel 父任务 | 迁移为父 operation + 冻结目标 + 子 operation |
| `partial` | 公共状态统一为 `partially_succeeded` |
| `failed_manual_review` | `failed` 或 `uncertain` + `manual_review_required=true`，按是否可能有副作用区分 |
| `skipped` | 删除模糊状态，按实际结果映射为 succeeded/rejected/cancelled/expired |

迁移只允许增加新结构、回填、双读核对和受控切换；不得在阶段 7 设计完成前直接改旧数据。

## 14. 验收场景

### 14.1 单账户

- HTTP 重发同一手动单只产生一个 operation、一个 intent 和至多一次 MT 副作用。
- 风控拒绝、Bridge 离线、只读账号、观摩模式和 stale revision 均在发送前终止。
- 服务端在发送前、发送后、回执前、回执落库后分别崩溃，恢复后不重复下单。
- Bridge 回执成功但终端快照暂未出现时保持 uncertain，后续对账可收敛。
- MT4 与 MT5 分别通过市价单、挂单、改单、撤单、部分平仓、全平仓和修改保护测试。

### 14.2 批量分发

- 目标列表在确认时冻结；新增或取消订阅不改变已确认分发。
- 同一账户最多一个子操作，不因多个订阅重复下单。
- 某些账户成功、某些风控拒绝时父 operation 为 partially_succeeded。
- 任一目标 uncertain 时父 operation 不提前显示完成。
- 分发平仓只关闭原分发产生且仍可归因的精确仓位。

### 14.3 并发与安全

- 同账户的开仓、撤单、改单、平仓按串行键有序，跨账户有界并发。
- 账户切换或 connection epoch 更新后，旧未发命令被取消，旧已发命令只对账。
- worker 租约过期、队列重复投递、Bridge 结果重复上报均不重复交易。
- 数据库死锁重试不会跨越外部发送边界。
- 未知关键枚举、身份不符、能力不足和证据不完整均失败关闭。

## 15. 第一轮复审：功能完整性与简化

复审范围：自动信号、手动单、策略分发、分发平仓、持仓保护、挂单管理、风控、Bridge 和前端反馈。

- 原本计划用一套状态覆盖全部对象，会让持仓分析状态和通信状态互相污染；调整为五类关联状态。
- 原公共状态无法表达批量部分成功；增加 `partially_succeeded`，只允许父操作使用。
- 原 `skipped` 含义过多；目标模型删除该公共语义，改为明确的成功、拒绝、取消、过期或未知。
- 原管理员分发存在来源目标和订阅目标的专用流程；目标架构统一为冻结目标后逐账户创建子 operation，不复制发单逻辑。
- 分发平仓若只按策略或品种匹配会误平其它仓位；增加原 distribution/outcome/ticket 精确归因要求。
- `awaiting_confirmation` 混入执行状态增加恢复分支；调整为确认前不创建可发送意图，确认请求复用 client request id。

第一轮结论：功能覆盖完整，统一执行入口的同时保留必要领域状态，没有引入独立微服务或无收益抽象。

## 16. 第二轮复审：重复交易、竞态与故障恢复

复审范围：发送边界、断线、账户切换、租约、数据库死锁、撤单成交竞态、部分成功和人工处理。

- 若只在 Bridge accepted 后禁止重发，WebSocket 写出但 accepted 丢失仍可能重复；调整为服务端一旦持久化 `dispatched` 并尝试写出就进入不可普通重试区。
- Bridge 成功回执不一定等于终端资源已达到期望状态；增加回执后精确资源复核。
- 挂单在撤单期间可能成交；明确映射为 `rejected + resource filled`，不得宣称撤单成功。
- 事务死锁重试若包含 Bridge 调用会重复交易；明确外部 I/O 永远位于事务外，已投递步骤不参与事务重试。
- 父分发若在仍有 uncertain 子项时标为 partial 会掩盖风险；规定 uncertain 优先，必须先对账。
- 账户接管后将旧命令转发新连接可能串号；明确 connection/ownership epoch 是 fencing 条件，旧已发命令只对账。
- 对账无界扫描会拖慢交易 worker；要求有界窗口、游标、完整度标记，超界转人工复核。

第二轮结论：状态机能够区分明确拒绝、无副作用失败和可能有副作用的未知结果，可作为阶段 7 逐表数据库设计的权威输入。

## 17. 本阶段验证限制

- 已审查当前订单意图、Bridge V3 命令账本、自动信号分发、AI 持仓管理和管理员批量执行源码及相关测试标题。
- 本阶段没有连接 `dev_vue` 数据库，没有执行 DDL/DML，没有核对真实数据分布和索引选择性。
- 本阶段没有启动 Bridge、MT4/MT5 或网站，也没有执行下单、挂单、撤单、改单和平仓。
- 新状态尚未实现，不能把本文结论描述成当前运行功能已经升级。
