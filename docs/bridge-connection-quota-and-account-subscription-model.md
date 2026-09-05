# Bridge 并发连接额度与账户级策略订阅模型

> 日期：2026-09-02
> 状态：重构需求基线补充
> 适用范围：量见智桥、AI 交易实验室、商业订单、权益、交易账户、策略订阅、后台管理

## 1. 产品结论

- 每个系统用户默认拥有 **1 条 Bridge 账户 WebSocket 并发连接额度**。
- 每条有效账户 WebSocket 只服务一个 MT4 或 MT5 账户；MT4 与 MT5 共用用户并发上限。
- 用户可以单独购买额外并发连接额度。当前可同时在线的账户连接数等于默认 1 条加当前有效的已购/赠送额度。
- 额度只计算当前用户实际占用的账户 WebSocket 连接，不限制用户保存过、使用过或历史关联过多少交易账户。
- 断开、删除或更换账户后释放该连接额度；用户可以在额度范围内自由连接、删除和更换 MT4/MT5 账户。
- Bridge 软件必须支持多个相互隔离的 MT4/MT5 终端档案，每个档案使用独立 Worker 和独立账户 WebSocket。
- 同一稳定交易账户同一时刻仍只允许一个具备交易权限的当前 route；购买更多并发额度不会允许同一账户重复执行。
- 交易执行订阅绑定具体交易账户。用户可以让账户 A 订阅策略甲、账户 B 订阅策略乙，也可以让多个账户分别订阅同一策略。Pro 的用户级分析订阅不以本人 Bridge 或交易账户为前提，见[观摩与无桥接订阅补充](./observer-and-pro-analysis-subscription-requirements.md)。

## 2. 并发连接额度

### 2.1 额度计算

合同名称统一为 `bridge_connection_quota`：

```text
connection_limit = base_connection_limit
                 + active_purchased_connection_grants
                 + active_manual_connection_grants

connections_in_use = 当前用户有效的账户 WebSocket lease 数
connections_available = connection_limit - connections_in_use
```

- `base_connection_limit` 默认固定为 1。
- 购买 1 条额外额度后，并发上限为 2；购买 N 条后为 `1 + N`。
- 额度按系统用户跨电脑、跨 Bridge 安装实例汇总，不能通过重复安装绕过。
- 管理员平台观摩源使用独立的 `observer_source` 连接额度，不占普通用户额度。
- 购买有效期、续费方式和价格由商业产品阶段决定；权益模型支持永久、固定期限和人工赠送，不在 Bridge 代码中写死。

### 2.2 什么情况占用额度

- Bridge Gateway 完成账户 WebSocket 鉴权并原子取得连接 lease 后，占用 1 条额度。
- 每条连接必须绑定 `user_id + terminal_profile_id + terminal_instance_id + trading_account_id + connection_epoch`。
- 保存一个离线终端档案、登记一个历史交易账户或保留策略订阅不占用额度。
- 正常关闭 WebSocket 会立即释放 lease；异常断线在心跳 TTL 到期后释放。
- 同一逻辑连接的重连使用新的 `connection_epoch` 原子接管旧 lease，不应短暂重复计数，也不要求等待旧 TTL。
- 同一稳定交易账户从另一设备或档案重连时，新 route 接管旧 route；最终只占用 1 条额度。
- 只读账户建立服务器账户 WebSocket 时同样占用 1 条额度；它是否能交易由账户权限单独决定。
- 浏览器 WebSocket、HTTP 请求、下载更新、配对授权和本地终端探测不计入账户连接额度。

### 2.3 并发争用与额度减少

- Gateway 在接受账户连接前，从 MySQL 权益投影读取当前上限，并在实时状态存储中原子申请用户连接 lease。
- 同一用户同时发起多条连接时，申请必须原子化，任何时刻不得超过上限。
- 活跃 lease 使用 TTL 和心跳续期；连接进程崩溃后能自动过期，不在数据库中保留永久占用。
- Redis/实时状态丢失时，Gateway 必须重新建立受控 lease；它不能导致重复交易，交易 route 仍由数据库身份、connection epoch 和命令状态机共同约束。
- 退款、到期或管理员撤销使当前连接数超过新上限时，不关闭 MT4/MT5，不自动平仓、撤单或改变终端登录。
- 系统进入 `over_quota`，禁止新增账户连接，并通知用户主动断开超额连接。宽限结束后，由用户明确保留的连接继续；其余连接只断开服务器通道，不关闭本地终端。
- 系统不得随机选择交易账户执行平仓、删档或切换登录；宽限时长和选择交互在商业实施阶段确认。

## 3. Bridge 多账户运行模型

```text
一个系统用户
  └─ 一个或多个 Bridge 安装实例
      └─ 一个或多个 terminal profile
          └─ 一个隔离 Worker
              └─ 一个 MT4 或 MT5 账户
                  └─ 一条独立账户 WebSocket
```

规则：

- Bridge Core 支持新增、启动、停止、删除和更换 terminal profile。
- 每个 profile 使用独立终端路径、平台、账户身份、本地数据作用域、Worker、WebSocket、连接世代、时区证据和诊断状态。
- 单个 Worker 崩溃、终端关闭、历史同步、大查询或 WebSocket 重连只影响对应 profile。
- 每条账户 WebSocket 独立鉴权、限流、订阅数据、处理精确请求和接收确定性命令；不得用一条共享连接混发多个账户数据。
- Bridge Core 汇总展示用户连接上限、当前占用、剩余额度和各 profile 状态，但额度权威来自服务端。
- 多个 profile 可同时连接任意 MT4/MT5 组合，只要当前有效账户 WebSocket 数不超过上限。

## 4. 新增、删除与更换账户

### 4.1 新增

1. 用户选择已启动的 MT4/MT5 终端或安装 MT4 EA。
2. Bridge 只读识别 platform、终端路径、broker server、login 和权限。
3. 用户确认创建 terminal profile。
4. 需要连接服务器时申请 WebSocket lease；额度不足只阻止服务器连接，不删除本地档案。

### 4.2 更换

- 用户可在同一 profile 中更换终端或账户，也可以删除后重新新增。
- 更换前先停止旧账户接收新命令，关闭旧账户 WebSocket，并递增 connection epoch。
- 已经投递但结果未知的交易命令继续按旧 route 对账；不得转发给新账户。
- 清理旧账户的内存报价、持仓、挂单、revision、时区和查询缓存后，再建立新账户作用域。
- 新账户连接复用刚释放的并发额度，不要求额外购买。
- 旧账户的服务器端交易、信号、风控、复盘和审计历史仍保留，并继续引用稳定 `trading_account_id`。

### 4.3 删除

- 删除 profile 会先断开账户 WebSocket并释放连接 lease，再停止对应 Worker。
- 删除只移除 Bridge 本地档案和可重建缓存，不操作 MT4/MT5 账户，不关闭用户终端，不修改终端登录，不执行任何交易动作。
- 未收到服务端确认的 Bridge 命令结果、安全账本和必要对账证据不得直接删除；profile 可从界面隐藏，但安全记录按留存期保存，完成 ack/对账后再清理。
- 删除本地 profile 不自动删除服务器交易账户、策略订阅或历史。服务器端解绑/删除订阅必须是另一个明确且可审计的操作。

## 5. 账户级策略订阅

以下字段描述账户级执行订阅；用户级仅分析订阅不强制绑定交易账户，拆分与旧数据映射待订阅 B2 批次实施，不直接改变现有外键：

```text
system_user_id
trading_account_id
strategy_id
strategy_version_policy
symbols
analysis_enabled
execution_enabled
receive_schedule
risk_profile_id
```

规则：

- 不再使用“每个用户只能有一个活动订阅”的用户级单例。
- 每个账户独立选择策略、品种、接收时间、自动分析开关、交易发送开关、风险配置和止盈偏好。
- 账户 A 的订阅启停、运行时段、策略修改、WebSocket 断线或风险状态不得修改账户 B 的订阅。
- 同一用户的多个账户可以订阅同一策略，调度和交付仍按账户创建独立目标和幂等执行意图。
- 同一账户可以保存多个订阅；同账户同标准品种存在多个可执行策略时必须使用明确冲突规则，不能静默重复下单。仅分析订阅不受执行冲突限制。
- 分析记录仍按系统用户归类；交易执行、风险、持仓、挂单和账户绩效按具体 `trading_account_id` 关联。
- 账户离线或本地 profile 被删除时，服务器保留订阅配置但不向该账户执行交易；重新连接同一稳定账户后恢复下一正常调度点，禁止补跑离线期间历史信号。

## 6. 权益与商业模型

并发连接额度是独立可购买权益：

- 商业产品使用独立产品类型，例如 `bridge_connection_quota`。
- 支付成功产生不可变 entitlement grant；当前并发上限由默认额度和有效 grants 汇总投影。
- 每个订单、支付交易、激活副作用和 grant 必须幂等关联，重复回调不能重复增加并发上限。
- 退款、撤销和到期通过权益事件减少上限，不删除 grant、连接历史或交易账户历史。
- 管理后台可查看用户连接上限、当前活动连接、来源、有效期和超额状态；人工赠送或撤销必须有权限、原因和审计。
- 前端显示“默认 1 条 + 已购/赠送 N 条、当前连接 M 条”，不能把历史账户数误当成额度占用。

## 7. 目标逻辑实体与实时状态

阶段 7 逐表设计至少覆盖：

| 逻辑实体 | 存储 | 职责 |
|---|---|---|
| `entitlement_grants` | MySQL | 购买、赠送、退款、撤销和有效期等权益来源 |
| `user_connection_capacities` | MySQL 投影 | 用户当前并发上限和 revision，可由 grants 重建 |
| `terminal_profiles` | Bridge 本地 + 服务端摘要 | 隔离 MT4/MT5 档案和能力摘要，不代表当前占用额度 |
| `terminal_bindings` | MySQL | profile、终端实例、稳定交易账户及 route 绑定历史 |
| `bridge_connection_sessions` | MySQL 审计摘要 | 连接开始、结束、原因、账户和 connection epoch，不作为实时计数锁 |
| `bridge_connection_leases` | 实时状态存储 | 当前有效账户 WebSocket lease、TTL 和用户并发计数 |
| `strategy_subscriptions` | MySQL | 系统用户、具体交易账户和策略的订阅配置 |
| `subscription_schedules` | MySQL | 用户接收并执行订阅信号的时区和时间范围 |

约束：

- 并发上限的购买事实和当前 WebSocket 占用必须分离；不能为每个历史交易账户永久分配额度。
- 同一用户申请/释放连接 lease 必须原子化；重连同一逻辑连接使用 takeover，不产生双计数。
- 同一稳定交易账户最多一个当前可交易 route。
- 策略订阅显式引用 `trading_account_id`，但交易账户离线不删除订阅和历史。
- MySQL 连接会话历史只用于审计与恢复说明，实时在线判断以 Gateway 持有的 WebSocket 和带 TTL 的 lease 为准。

## 8. API 与实时事件

建议资源：

- `GET /api/v4/bridge/connection-capacity`
- `GET /api/v4/bridge/terminal-profiles`
- `POST /api/v4/bridge/terminal-profiles`
- `POST /api/v4/bridge/terminal-profiles/{profile_id}/connect`
- `POST /api/v4/bridge/terminal-profiles/{profile_id}/disconnect`
- `POST /api/v4/bridge/terminal-profiles/{profile_id}/replace-account`
- `DELETE /api/v4/bridge/terminal-profiles/{profile_id}`
- `GET /api/v4/commerce/bridge-connection-products`
- `POST /api/v4/commerce-orders`，使用 `product_type=bridge_connection_quota`
- `GET/POST/PATCH /api/v4/strategy-subscriptions`，`trading_account_id` 必填

实时事件：

- `bridge.connection_capacity.changed`
- `bridge.terminal_profile.changed`
- `runtime.bridge.changed`，作用域包含具体账户、profile 和 connection epoch
- `strategy.subscription.changed`，作用域包含具体交易账户

购买、连接、断开、替换、删除和订阅保存全部走幂等 HTTP 或 Bridge 设备合同；浏览器 WebSocket 不执行写操作。

## 9. 验收场景

- 新用户可以保存多个本地档案，但默认同一时刻只有 1 条账户 WebSocket 能连接服务器。
- 断开账户 A 后可以立即连接账户 B，不需要购买新额度。
- 购买 1 条额外额度后可以同时连接两个任意组合的 MT4/MT5 账户。
- 一个用户在两台电脑上的账户 WebSocket 总数仍不超过服务端上限。
- 同一账户跨设备重连只保留新 route、只计 1 条，旧命令不会被发送到新 route。
- 多个账户同时在线时，每个账户有独立 WebSocket、Worker、数据 revision、命令队列和故障边界。
- 用户可以删除或更换 profile；本地操作不关闭 MT、不产生交易副作用，也不删除服务器历史。
- 账户 A 和账户 B 可以订阅不同策略，自动分析、信号、风控和交易结果完全隔离。
- 支付回调、队列重投和页面重复提交不会重复增加并发上限。
- 正常断开立即释放额度，异常断线按 TTL 释放，同一逻辑连接重连不会短暂双计数。
- MT4、MT5 和混合多账户分别通过连接、查询、实时增量、断线恢复、更换、删除和交易命令隔离测试。

## 10. 未冻结的商业参数

- 额外连接额度是永久购买、按月/按年订阅，还是同时支持。
- 单用户最大并发连接上限。
- 权益到期/退款后的宽限时长和连接选择交互。
- 额度产品价格、折扣、返佣和会员联动规则。
