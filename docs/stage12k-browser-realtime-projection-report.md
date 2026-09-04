# 阶段 12K：浏览器领域实时投影与模型用量恢复验收记录

> 日期：2026-09-04
> 范围：AI 分析、账户级交易员、风控、异步操作的浏览器 WebSocket 小事件，事务 Outbox 双投递，多账户订阅授权，模型用量结算告警与遗留 reservation 回收
> 边界：仅完成源码与离线验证；未启动服务、未读取真实 `.env`、未执行迁移、未连接真实 MySQL/Redis/provider/Bridge/MT，也未执行交易

## 1. 结果

阶段 12K 补齐了阶段 12J 留下的非任务领域事件投影。业务事务仍只提交领域记录和 Outbox；独立 Dispatcher 在事务提交后完成两类副作用：

```text
business transaction
  -> committed outbox row
  -> stable BullMQ job (only task-bearing event types)
  -> Redis browser realtime small event
  -> mark outbox dispatched only after every applicable publisher succeeds
```

WebSocket 只通知“什么变了”，完整分析正文、完整推理、交易动作详情、风控规则、风险计算输入和账户快照继续由受权 HTTP 端点提供。Redis 发布失败时 Outbox 保持可重试；任务队列使用稳定 `event_id` 作为 job ID，重复投递不会据此重复模型调用或终端命令。

## 2. 作用域与订阅模型

| 目标 | 作用域 | 可订阅资源 | 断线恢复 |
| --- | --- | --- | --- |
| `signals` 用户级 | 当前系统用户 | `analysis_jobs`、`market_analyses`、`all` | HTTP 重拉分析任务/记录列表，再以 `after_revision=null` 订阅 |
| `signals` 账户级 | 当前用户拥有的交易账户 | `trader_jobs`、`trade_decisions` | HTTP 重拉账户决定列表，再以 `after_revision=null` 订阅 |
| `risk` | 当前用户拥有的交易账户 | `policy`、`summary`、`decisions`、`manual_release`、`all` | HTTP 重拉对应账户资源，再以 `after_revision=null` 订阅 |
| `operations` | 当前用户拥有的交易账户 | `all` | HTTP 重拉账户 operation，再以 `after_revision=null` 订阅 |

分析记录按系统账号归类，不随 MT4/MT5 账户切换。交易员、风控和执行操作按交易账户隔离。同一浏览器连接可以订阅当前用户拥有的多个账户；每个目标单独授权，任一越权目标会拒绝整次订阅替换，避免部分生效造成误判。

观摩模式只保留原有账户、行情、持仓和挂单只读投影。AI 交易决定、风控规则、手动解锁和 operation 含所有者决策信息，且当前没有对应的观摩 HTTP 恢复源，因此禁止通过观摩频道订阅。

## 3. 事件目录与载荷边界

| 事件 | 事件作用域 | 小载荷 |
| --- | --- | --- |
| `analysis.job.changed` | 用户 | 任务、策略、品种、状态、更新时间 |
| `market_analysis.created` | 用户 | 偏向、机会、置信度、有效期 |
| `trader.job.changed` | 账户 | 账户、分析、任务模式、状态、更新时间 |
| `trade_decision.created` | 账户 | 动作、方向、置信度、状态、失效原因 |
| `risk.policy.changed` | 账户 | 当前规则版本和 revision |
| `risk.summary.changed` | 账户 | 数据完整性和 revision |
| `risk.decision.created` | 账户 | 通过/拒绝状态和公开错误码 |
| `risk.manual_release.changed` | 账户 | 解锁状态、失效原因和 revision |
| `operation.changed` | 账户 | 操作类型、状态、更新时间、公开错误码 |

投影器从已提交数据库行读取当前聚合状态，而不是信任 Outbox payload 自报所有字段。多个尚未派发的旧状态允许合并为当前最新状态；`event_id` 和资源 revision 仍稳定，浏览器必须丢弃旧 revision 和重复事件。

列表型资源没有一个可与所有聚合根比较的全局 revision，因此不伪造跨重连事件回放：这些目标只接受 `after_revision=null`。账户快照、报价、K 线、持仓和挂单仍沿用阶段 11 的精确 revision 比对。

## 4. Outbox 一致性与故障恢复

- Dispatcher 领取 15 类任务或实时事件，并携带数据库 `created_at_utc` 作为事件发生时间。
- 队列 publisher 只处理真正需要后台任务的六类事件；非任务事件显式 no-op，不会误落到 Bridge 队列。
- composite publisher 顺序执行队列和 Redis publisher；任何一步失败都不把 Outbox 行标为完成。
- 队列已成功、Redis 暂时失败时，重试仍使用相同 BullMQ job ID。领域 worker 的状态机、CAS、租约和 fencing 继续是第二层幂等保护。
- Redis 事件不承担永久审计或跨连接重放。丢失、乱序、sequence 缺口或重连均回到 HTTP 权威快照。
- `uncertain` 终端结果仍只能精确对账，不能因为 Outbox、队列或 WebSocket 重试而重发终端命令。

## 5. 模型用量结算恢复

模型调用前的 `reserved` 记录仍是平台额度准入证据。完成结算现在必须准确更新一条仍为 `reserved` 的记录，否则产生 `model_usage_reservation_not_pending` 告警；结算异常不会遮蔽已经取得的模型结果，也不会触发第二次 provider 请求。

Analysis Scheduler 每轮在正常调度前，小批量把超过配置时限的遗留 `reserved` 标为：

- `request_status=error`
- `error_code=model_usage_reservation_abandoned`
- `accounting_status=usage_unknown`

这是保守的审计修复，不猜测 token 数、不把未知用量当零，也不重放 provider。默认超时 30 分钟，可通过 `V4_MODEL_USAGE_RESERVATION_MAX_AGE_MS` 在 1 分钟至 24 小时内配置。Worker 使用并发安全的失败版本计数：发生结算失败的任务不会在返回模型结果后立刻清除健康告警；只有后续没有新结算失败的任务才恢复健康。

## 6. 两轮独立复审

### 第一轮：职责、数据量与过度设计

初版评审确认无需新增第二条 WebSocket、永久事件总线或 Redis Stream；复用既有浏览器实时频道和 V4 envelope 足够。完整推理、规则 JSON、风险 evaluation 和账户大快照均从事件移除。评审发现原会话错误地限制一次只能订阅一个账户，已改为逐目标授权的多账户订阅，符合“额度按 Bridge WebSocket 连接数、交易账户可更换或多账户使用”的既定规则。

同轮还发现旧队列 publisher 会把未知的非任务事件落入 Bridge 命令分支；现已把每种任务事件显式分支，其他事件安全返回。投影器改为读取事务提交后的权威行，避免依赖过时或缺字段的 Outbox payload。

### 第二轮：权限、并发、幂等、时间和恢复

权限复审发现，若只验证观摩账户归属，观摩用户可能订阅所有者专属 AI/风控/operation 事件，而又没有合法 HTTP 恢复源；现已禁止这三类观摩订阅。用户级分析事件强制 `account_id=null`，其他领域事件强制账户 ID，Redis 入站解析器会拒绝类型与作用域不一致的消息。

恢复复审发现模型用量结算告警会被同一成功任务立即清除；已用进程内单调失败版本修正，并防止自定义告警 handler 的异常遮蔽模型原始结果。遗留 reservation 的耗时改用数据库 UTC 时钟计算，回收有界且只改变审计状态。所有时间在线上协议中继续使用 UTC ISO；终端时区不参与本阶段聚合身份或恢复判断。

## 7. 离线验证

- 领域实时与运行时定向测试：5 files / 36 tests passed
- 根 `pnpm test`：234 / 235 files、3534 / 3536 tests passed；仅 `tests/bridge-release-tool.test.js` 两项既有失败，原因是子 PowerShell 进程无法识别 `Get-FileHash`，与本阶段代码无关
- `pnpm run typecheck:server`：通过
- `pnpm run typecheck:frontend`：通过
- `pnpm run build:server:v4`：通过
- `pnpm run build:frontend` 与应用边界检查：通过
- `git diff --check`：通过

关键回归覆盖：用户/账户作用域隔离、多自有账户同连接、观摩越权拒绝、紧凑目标字段、1～32 个订阅目标边界、作用域错配事件拒绝、小载荷排除完整推理与规则、任务与 Redis 双 publisher 失败传播、用量结算异常不重试模型、遗留 reservation 有界回收。

## 8. 剩余风险与后续门

- 本阶段没有连接真实 MySQL、Redis 或 provider；Outbox 双投递的断电窗口、Redis 重连、MySQL 锁等待和长期积压仍需阶段 15～16 演练。
- trade 前端只获得了统一事件合同，AI 分析师、交易员、风控师和操作状态页面尚未接入这些订阅；下一子阶段必须保持“HTTP 首屏/重连，WebSocket 小更新”。
- 列表型领域资源有意不提供跨连接回放或全局 revision；若未来需要事件历史，应建立独立的只读事件查询模型，不能把 Redis Pub/Sub 冒充审计库。
- 公网旧库到 V4 旁路表的迁移尚未执行。若历史 pending Outbox 引用的目标 V4 行不存在，投影会失败并进入现有重试/死信流程，不能静默标记完成。
- 旧模型用量表尚未把每条 reservation 与 V4 model task/attempt 建立强外键关联；阶段 15 需在保留现有数据前提下补 legacy ID map、回填和对账。
- 已建立的浏览器连接不会在数据库权限改变瞬间主动重鉴权；当前依赖连接重建和 HTTP 授权。权限撤销的主动断开应在非功能安全验收中加入。
- 未连接 Bridge/MT，也未执行任何实盘或模拟交易；本阶段不能作为端到端交易验收。

因此，本阶段可以认定为“AI、风控和异步操作的浏览器小事件投影与模型用量恢复源码完成并通过离线验证”，不能据此宣称真实基础设施、前端页面、数据迁移或生产运行已经验收。
