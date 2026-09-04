# 阶段 12J：AI 调度、模型 Worker、风控与执行运行时接线验收记录

> 日期：2026-09-04
> 范围：分析调度器、Analysis/Trader/Risk Worker、任务型 Outbox、模型配置解析、平台共享额度、超时回收、PM2 角色与健康检查
> 边界：只完成源码与离线验证；未启动 V4 进程、未读取真实 `.env`、未执行迁移、未连接真实 MySQL/Redis/模型/Bridge/MT，也未执行交易

## 1. 结果

阶段 12J 已把阶段 12B～12H 的核心服务接入独立异步运行角色，API 和长连接网关不承担模型推理、风险评审或业务定时任务：

```text
Analysis Scheduler
  -> MySQL transaction: analysis.requested Outbox
  -> Outbox Dispatcher -> BullMQ analysis queue
  -> Analysis Worker -> immutable market_analysis
  -> MySQL transaction: trader.requested Outbox
  -> Outbox Dispatcher -> BullMQ trader queue
  -> account-scoped Trader Worker -> proposed trade_decision
  -> Outbox Dispatcher -> deterministic Risk Worker
  -> approved risk_decision
  -> Outbox Dispatcher -> Execution Worker
  -> execution intent -> Bridge command lifecycle
```

模型失败不会跳过确定性风控，风险拒绝不会进入执行队列；Bridge 已跨终端调用边界但结果未知时仍保持 `uncertain`，只允许精确对账，不会因 BullMQ 重试而重放终端命令。

## 2. 独立进程与故障域

`ecosystem.v4.config.cjs` 现在由宝塔一个 PM2 项目统一管理九个单实例 fork 角色：

- API V4
- 浏览器实时网关
- Bridge V4 网关
- Outbox Dispatcher
- Execution Worker
- Analysis Scheduler
- Analysis Worker
- Trader Worker
- Risk Worker

新增四个角色各自拥有连接池、健康端口、并发上限与优雅停机。Analysis/Trader 的模型调用互不占用 API 请求线程；Risk Worker 只做确定性计算和事务写入，不装载模型凭据；调度器使用不重叠的异步轮询循环，关闭时等待当前批次结束。

## 3. 任务型 Outbox 与幂等唤醒

业务事务仍是任务创建的唯一权威。Dispatcher 只在事务提交后按 `event_id` 作为 BullMQ `jobId` 投递：

| Outbox 事件 | 队列任务 | 条件 |
| --- | --- | --- |
| `analysis.requested` | `analysis.run` | 已创建分析 run |
| `trader.requested` | `trader.run` | 已创建账户级 trader run |
| `trade_decision.created` | `risk.review` | 仅 `proposed` |
| `risk.decision.created` | `execution.risk-decision.prepare` | 仅 `approved` |
| `execution.intent.prepared` | `execution.intent.prepare` | 已准备执行意图 |
| `bridge.command.queued` | `bridge.command.dispatch` | 已持久化 Bridge 命令 |

`stale` 交易决定和风险拒绝只完成业务状态，不创建空队列任务。重复 Outbox 投递由稳定 job ID 和各领域状态机共同吸收；执行 Worker 对风险决定与已准备 intent 使用不同的窄 job envelope，避免混淆两个阶段。

## 4. 模型解析与请求边界

每个任务开始前重新解析一次当前可用模型，而不是在进程启动时冻结某个用户的模型：

- 无论平台策略还是用户策略，都使用当前用户唯一默认模型；策略归属不会偷偷覆盖用户的模型选择。
- 用户选择的平台共享模型与平台策略使用的平台模型都必须通过共享开关、套餐和额度检查。
- Provider capability 必须为 `verified`，且 provider、model、base URL 与验证身份完全一致。
- 凭据只从 `AI_CREDENTIAL_KEYS_JSON` AES-256-GCM keyring 解密；缺失、明文、未知 key version 或认证失败均 fail closed。
- 仅接受 `chat_completions` 与 `responses` 两种显式协议；请求不启用流式输出。
- 请求体上限 16 MiB、响应体上限 4 MiB；响应按有界流读取，并区分 HTTP、传输、超时、过大和 JSON 合同错误。
- 默认要求 HTTPS，并在每次请求前重新解析 DNS；localhost、私网、链路本地、CGNAT、组播和私有 IPv6 地址被拒绝。只有显式开发配置才允许私网模型端点。

策略提示词作为独立 system message，冻结快照不再重复包含提示词；模型输出仍必须通过阶段 12B/12C 的领域合同校验后才能落库。

## 5. 平台共享额度与用量证据

模型请求发出前，`MysqlModelUsageLedger` 先开启事务并锁定当前用户行，再读取共享策略并统计该用户当天全部平台共享请求：

- 超过 `daily_requests_per_user` 或已结算 `daily_tokens_per_user` 时，在网络请求前拒绝。
- 额度是“每用户每日总额度”，不会因 manual/auto 分类而被重复计算；共享开关仍按用途分别判断。
- 通过准入后先插入 `reserved` 用量记录，再调用 provider。
- 完成后回写输入、输出、推理、缓存及总 Token，provider request ID、请求/响应字节、耗时和错误码。
- 个人模型不消耗平台共享额度，但同样生成请求审计记录。

用量结算失败不会让已经取得的模型结果被自动重试，从而避免因审计表瞬时故障重复扣费或产生第二次模型判断；模型 attempt 自身仍保存 provider 返回的 usage，后续监控必须把用量结算异常视为告警。

## 6. 并发、重试与超时回收

- Analysis 与 Trader 的 provider 重试由模型 task/attempt 状态机控制，默认最多 2 次、硬上限 3 次；BullMQ 不替代领域 fencing。
- Trader 领取时按交易账户串行。遇到 `trader_account_busy`，当前 job 延后到现有租约结束附近，而不是占住 Worker 轮询。
- 调度器每轮先回收超过绝对 deadline 的 running model task：按既有锁顺序锁账户、run、task，关闭活动 attempt，并把 task/run 标为终止状态。
- 回收只写失败事实和 Outbox，不调用模型、不重新创建任务；崩溃时无法确认的 provider 调用不会被盲目重放。
- Risk Worker 与 Execution Worker 继续依赖领域幂等键、revision、CAS、账户租约和持久命令账本，不依据队列“至少一次”语义直接重复交易。

## 7. 配置与部署形态

新增配置项覆盖四个健康端口、调度批次/间隔、三类 Worker 并发、模型超时/重试、超时回收批次及私网端点开发开关；示例值已写入 `server/.env.example`。新增四个 `start:v4:*` 脚本，生产构建仍输出到 `server/dist-v4`。

宝塔启动方式不变：仍添加一个 PM2 项目并选择同一个 ecosystem 文件。PM2 可以分别显示九个角色的 PID、内存、重启次数和日志；不能把并发角色改成同一 Node 进程内的定时器。

## 8. 离线验证

- 核心定向测试：8 files / 56 tests passed
- `pnpm run typecheck:server`：通过
- `pnpm run build:server:v4`：通过
- `pnpm run typecheck:frontend`：通过
- `pnpm run test:frontend`：8 files / 23 tests passed
- `pnpm run build:frontend` 与应用边界检查：通过
- 根 `pnpm test`：233 / 234 files、3525 / 3527 tests passed；仅 `tests/bridge-release-tool.test.js` 两项既有失败，原因是其子 PowerShell 进程缺少 `Get-FileHash`，与本阶段代码无关
- `git diff --check`：通过

关键回归覆盖：六类任务型 Outbox 路由、stale/rejected 不入队、模型 JSON/Responses envelope、provider 特定 structured output、额度预留先于网络请求、用量结算、平台额度锁顺序、凭据 fail closed、过期任务不调用模型，以及九角色 PM2 接线。

## 9. 两轮复审

### 第一轮：运行职责与重复执行

初版若在 Worker 启动时固定一个模型，会错误地跨用户复用配置；已改为每个 run 按用户、策略版本和触发用途解析模型。风险批准到执行意图原先也可能被同步串联，已统一改成事务 Outbox 唤醒 Execution Worker。Trader 账户忙改为 BullMQ 延迟任务，进程崩溃遗留 running task 则由绝对 deadline 回收，均不把基础设施重试直接等同于再次调用终端。

### 第二轮：安全、额度与迁移边界

复审发现平台模型只有“允许共享”校验，没有原子额度预留和完成结算；已增加用户行锁、每日总额度、请求前 reservation 及请求后证据回写。随后增加请求时 DNS 复核和有界响应读取，避免只依赖保存配置时的一次验证。

数据库兼容复审确认：当前模型配置和用量读取仍依赖公网旧库已有的模型表，而 V4 `ai_model_tasks` 等表与旧同名表存在结构重塑要求。为了遵守“保留现有数据、迁移单独演练”的边界，本阶段没有用临时 ALTER 或自动建表绕过；必须在阶段 15 通过旁路迁移、legacy ID map、校验和与回滚点解决后才能启用运行时。

## 10. 剩余风险与后续门

- 未使用真实 provider 验证不同厂商的错误体、usage 字段、Responses JSON mode 和长耗时行为。
- `analysis.running/failed`、`market_analysis.created`、风险、operation 等非任务 Outbox 事件仍等待专用浏览器实时投影器；当前 Dispatcher 故意只领取六类任务事件，不能提前把未推送事件标为 dispatched。启用前必须完成用户级/账户级实时资源合同。
- 用量 settlement 失败目前保留模型 attempt usage 并记录进程错误日志，但尚无独立告警和 reservation 修复任务。
- 还未执行数据库迁移或真实 MySQL 锁竞争测试；额度行锁、公平性、连接池容量与死锁重试需在旁路库压测。
- 九角色 ecosystem 未真实启动；健康端口、Redis 断线、PM2 连续重启、优雅停机和日志轮转尚未联调。
- 未连接 Bridge/MT，也未执行任何实盘或模拟交易；本阶段不能作为端到端交易验收。

因此，本阶段可以认定为“AI 调度、模型 Worker、确定性风控和执行任务的运行时源码接线完成并通过离线验证”，不能据此宣称模型供应商、数据库迁移、实时 UI、Bridge 或生产运行已经验收。
