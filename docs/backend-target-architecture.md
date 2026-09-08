# 后端目标架构与异步任务隔离方案

> 状态：架构已冻结，V4 TypeScript 入口及独立 PM2 角色已实现；具体业务进度见主路线图。2026-09-06 按本地 `c433155e` 校正部署入口，不代表宝塔或真实依赖验收通过。
>
> 日期：2026-09-02
>
> 适用范围：主站、AI 交易实验室、管理后台、统一认证、浏览器实时通道、Bridge 设备通道和全部后台任务
>
> 前置合同：[API V4、浏览器实时协议 V4 与 Bridge 设备协议 V4](./api-v4-and-realtime-protocol.md)

## 1. 结论

新版后端采用以下组合：

- 运行时：Node.js 24 LTS；部署时锁定经过完整测试的具体补丁版本。
- 语言：TypeScript 严格模式。
- HTTP 框架：Fastify 5 系列；实施时锁定经过验证的具体小版本。
- 架构形态：单仓库、单后端产品、按业务域划分的模块化单体。
- 后台任务：BullMQ；实施时锁定经过验证的稳定版本。
- 数据权威：MySQL；关键业务使用事务、outbox、确定性幂等键和可恢复状态机。
- 缓存与实时协调：Redis；缓存与任务队列使用不同 Redis 实例，或具备等价的资源、持久化和淘汰策略隔离。
- 进程边界：HTTP API、浏览器实时网关、Bridge 设备网关、调度器及各类 Worker 独立运行。

本方案不采用 NestJS、微服务、事件溯源、全量 CQRS、Kafka、RabbitMQ、GraphQL 或运行时依赖注入容器。当前规模下，这些方案增加的代码和运维复杂度大于收益。

这里的“模块化单体”不等于“所有工作跑在一个进程”：业务代码和数据合同仍在一个代码库中复用，但不同运行职责必须由不同 OS 进程承载。后台任务故障、阻塞或内存上涨不得影响 API、实时网关、Bridge 网关或其它任务组。

## 2. 重构前代码事实（历史基线）

以下是 2026-09-02 对本地 `dev_vue`、提交 `3813000f0e3b1b5ce99e198360bdaf66c8abc658` 的只读审查结果，不代表目标架构已经实现。

本节只保留重构动机，不用于判断当前源码或运行状态。当前源码入口为 `server/src/entrypoints/`，运行角色以根 `ecosystem.v4.config.cjs` 为准，阶段证据以[主路线图](./refactor-master-roadmap.md)为准。

### 2.1 单进程承担过多职责

- `server/index.js:470-494` 在同一进程初始化 Bridge WebSocket、数据库、迁移、治理检查和 HTTP 监听。
- `server/index.js:497-590` 在 HTTP 启动后继续启动 Bridge 账本清理、AI 恢复、自动调度、订单对账、持仓管理、风控监控、复盘、记忆、人工分析、支付、通知、存储维护和情绪数据刷新。
- 这些任务共享同一 Node 事件循环、进程内存、数据库连接池和异常退出边界。一个任务出现同步阻塞、内存泄漏或未处理异常时，会影响主 HTTP 服务和其它任务。

### 2.2 后台任务主要依赖进程内定时器

- `server/jobs/payment-side-effects.js:132-159` 使用 `setTimeout` 和 `setInterval` 驱动支付副作用。
- `server/notification-center.js:660-707` 使用进程内循环和定时器串行处理通知活动。
- `server/index.js:511-528`、`server/index.js:573-590` 直接创建业务轮询定时器。
- 这种方式缺少统一的持久投递、任务租约、并发预算、跨进程隔离、死信处理和任务级监控。

### 2.3 数据与模块边界过宽

- `server/routes/` 中有 68 个文件直接导入数据库能力，约有 1,147 处查询辅助调用。
- `server/migrations.js` 约 391 KiB，`period-review.js` 约 380 KiB，`scheduler.js` 约 245 KiB，`bridge-ws.js` 约 234 KiB；路由、业务编排、查询、状态机和副作用存在混合。
- `server/db.js:30-43` 当前连接池 `queueLimit: 0` 且会话时区为 `+08:00`；目标数据库规范要求 UTC 和有界资源等待。
- `server/redis.js:22-34` 只有一个通用 Redis 单例，重试超过 10 次停止；这不适合作为必须持续恢复的任务消费者连接。
- 当前依赖中没有 BullMQ。

### 2.4 可保留的业务资产

- 已有交易幂等、Bridge 命令账本、结果确认、revision、支付副作用记录和部分恢复逻辑应保留其业务语义。
- 旧模块的测试与生产规则是迁移输入，不应通过一次性大重写丢失。
- 迁移采用按业务竖切逐步替换；旧定时器只有在对应新 Worker 完成对账和故障演练后才可停用。

## 3. 框架比较

| 方案 | 优点 | 主要问题 | 结论 |
| --- | --- | --- | --- |
| 继续 Express + JavaScript | 初期改动最小，旧代码可直接运行 | 现有 route/SQL/定时器混合不会自然消失；合同、类型和模块封装仍需大量自建约束 | 只作为迁移来源，不作为 V4 目标 |
| Fastify + TypeScript | 插件作用域适合业务模块封装；JSON Schema 请求校验和响应序列化与 OpenAPI V4 契合；代码量较小 | 仍需自行坚持应用层、领域层和 repository 边界 | **采用** |
| NestJS + TypeScript | 模块、DI、守卫和队列集成完整 | 装饰器、反射、DI 容器和框架约定带来更多样板；本项目并不需要微服务式抽象 | 不采用 |
| 独立微服务 | 可独立扩缩和部署 | 分布式事务、版本协调、排障和运维成本高；当前团队和部署规模没有足够收益 | 不采用 |

Fastify 官方说明 `register` 默认创建封装作用域，可形成有向依赖图并避免跨依赖；其请求验证和响应序列化采用 JSON Schema，适合把 V4 合同直接落到传输边界。参见 [Fastify Plugins](https://fastify.dev/docs/latest/Reference/Plugins/) 与 [Validation and Serialization](https://fastify.dev/docs/latest/Reference/Validation-and-Serialization/)。

## 4. 运行拓扑

### 4.1 独立运行角色

```text
reverse proxy
  ├─ api process                 HTTP /api/v4, auth callbacks, health
  ├─ browser-realtime process    /realtime/v4
  └─ bridge-gateway process      /bridge/v4/ws

scheduler process                只扫描到期工作并投递任务

queue Redis (noeviction + AOF)
  ├─ execution workers
  ├─ analysis workers
  ├─ review workers
  ├─ payment workers
  ├─ notification workers
  └─ maintenance workers

MySQL                           业务权威、outbox、operation、审计
cache Redis                     可重建缓存、限流、短锁、实时修订
```

强制规则：

- API 进程只处理短请求；不得启动业务定时器或消费任务。
- 浏览器实时网关只验证单次票据、管理订阅并推送已提交事件；不得运行 AI 或执行交易。
- Bridge 网关只处理设备会话、精确查询、确定性命令和结果确认；不得运行调度、策略或复盘。
- 调度器只查询“现在到期但尚未登记”的工作并写入 outbox/队列；不得自己执行任务。
- 每个 Worker 进程只消费一个任务组。进程管理器按角色单独拉起、停止和重启。
- 开发环境可以用一个命令同时拉起多个子进程，但不得退化为一个 Node 进程内的多个定时器。

### 4.2 宝塔启动与管理方式

正式环境继续使用宝塔“网站 → Node 项目”作为统一管理入口，不创建十个宝塔项目，也不要求运维人员在终端逐个启动进程。

本项目使用根 `ecosystem.v4.config.cjs` 注册一个 `aurum_ai` PM2 项目，由同一配置文件的 `apps` 数组声明全部独立运行角色；不要误选旧版启动配置。面板使用方式参考[宝塔面板 Node.js PM2 部署](https://docs.bt.cn/practical-tutorials/nodejs-pm2-deployment)与 [PM2 Ecosystem File](https://pm2.keymetrics.io/docs/usage/application-declaration/)，目标面板版本仍须实际验收。

宝塔面板目标配置：

| 面板字段 | 目标值 | 说明 |
| --- | --- | --- |
| 项目类型 | PM2 项目 | 不使用默认单入口项目或传统项目 |
| 项目名称 | `aurum_ai` | 面板只保留一个统一项目入口 |
| Node 版本 | Node.js 24 LTS 的已验证补丁版本 | 截图中的 `v24.18.0` 属于 24 LTS；上线前以锁定版本的完整测试为准 |
| 启动文件 | `ecosystem.v4.config.cjs` | `apps` 数组声明 API、网关、scheduler 和 Worker |
| 运行目录 | 项目正式部署根目录 | 当前目录未变时为 `/www/wwwroot/aurum-ai` |
| 面板负载实例数 | `1` | 禁止由面板把 scheduler 或 Worker 整体复制多份 |
| 内存上限 | 不使用一个项目级统一上限代替角色预算 | 每个 app 在 ecosystem 中分别配置 |
| 自动重载 | 关闭 | 生产环境 `watch: false`，代码发布后受控 reload |
| 包管理器 | `pnpm` | 版本以根 `package.json` 的 `packageManager` 为准；安装使用仓库 lockfile，面板不支持锁定版本时先独立安装再选择不安装依赖，不改用 npm 重解依赖 |
| 环境变量 | 只放非敏感启动参数 | 密钥仍由 `server/.env` 或后续密钥机制提供 |

`ecosystem.v4.config.cjs` 的原则：

- 每个运行角色是一个独立 `apps` 项，使用 `fork` 模式和独立进程名。
- 初始每个角色 `instances: 1`；API 是否增加实例必须经过连接池、幂等和负载测试，scheduler 不能靠增加实例提升性能。
- 每个角色单独配置 `autorestart`、`restart_delay`、`max_memory_restart`、日志和优雅停机时间。
- 宝塔项目列表负责“一键启动/停止/重启整个 AURUM”；宝塔的 PM2 监控负责查看和处理单个角色。
- 单个 Worker 崩溃时由 PM2 只重启该角色；只有用户在宝塔主动停止整个项目时，所有角色才一起停止。
- 数据库迁移是独立部署命令，不得放进任一 app 的启动入口，避免多进程同时迁移。

2026-09-06 本地配置已有 11 个角色，数量不是目标；不为每个小功能继续增加进程。保持 API、实时、Bridge 与耗时/关键任务隔离，新增独立角色必须有故障隔离或调度预算依据。`max_memory_restart` 是重启阈值，不是实测占用；先测总连接池、CPU、内存、队列延迟与启动恢复，再优化低频任务分组。本次没有改变运行配置。

这种方式保留用户熟悉的宝塔管理体验，同时仍满足后台任务和主进程的 OS 进程隔离。最终需在目标宝塔版本上实测项目启停、单角色重启、日志、开机自启、优雅停机和异常恢复。

### 4.3 为什么拆分浏览器与 Bridge 网关

Bridge 通道承载账户数据和交易命令，优先级、身份、流控、超时和审计要求高于普通页面实时推送。两个网关分开后，浏览器订阅激增、慢客户端或页面广播不会抢占 Bridge 的事件循环和连接预算。

### 4.4 健康与就绪

每个运行角色分别提供：

- 存活检查：进程事件循环仍可响应。
- 就绪检查：该角色的必要依赖可用；例如 API 可访问 MySQL，Worker 可访问队列 Redis 和 MySQL。
- 降级状态：非必要依赖异常时可继续提供的能力必须明确，禁止统一返回“服务正常”。
- 关闭状态：先停止接收新请求或新任务，再在限定时间内完成或安全放弃在途工作。

## 5. 代码与模块结构

```text
server/
  src/
    entrypoints/
      api.ts
      browser-realtime.ts
      bridge-gateway.ts
      scheduler.ts
      worker-execution.ts
      worker-analysis.ts
      worker-review.ts
      worker-payment.ts
      worker-notification.ts
      worker-maintenance.ts
    bootstrap/
      config.ts
      logger.ts
      database.ts
      cache.ts
      queue.ts
      composition-root.ts
    modules/
      identity/
      users/
      memberships/
      content/
      billing/
      notifications/
      platform-config/
      bridge/
      trading-accounts/
      market-data/
      strategies/
      models/
      analysis/
      risk/
      execution/
      reviews/
      audit/
    shared/
      kernel/
      observability/
      security/
      time/
  migrations/
  .env
```

不要求每个模块生成一套空目录。模块只在需要时使用以下层次：

```text
modules/<domain>/
  index.ts                 唯一跨域业务入口，公开端口与必要 DTO
  composition.ts           受限运行组装入口，只由 bootstrap/entrypoints 使用
  transport/http/          Fastify 路由与合同适配
  transport/realtime/      该域实时投影适配
  transport/jobs/          任务载荷与消费者适配
  application/             用例、应用端口、事务编排
  domain/                  状态、不变量、领域规则
  infrastructure/          repository、外部供应商适配
```

### 5.1 依赖方向

```text
transport -> application -> domain
                         -> repository ports
infrastructure ----------> repository ports
entrypoint -> composition root -> modules
```

- route/handler 不得直接写 SQL、Redis 或供应商调用。
- repository 只实现本业务域的数据访问；禁止跨域直接查询其它模块私有表。
- Worker 调用应用用例，不调用 HTTP 路由，也不通过 HTTP 请求本服务。
- 模块同步协作通过对方公开的 application port；延迟副作用通过 outbox 领域事件。
- 先使用显式工厂和 composition root 注入依赖，不引入运行时 DI 容器。

## 6. 业务域边界

| 业务域 | 主要职责 | 不得承担 |
| --- | --- | --- |
| identity | OIDC、凭据、MFA、会话和撤销 | 会员、交易权限、Bridge 设备会话 |
| users | 用户资料、联系方式和偏好 | 认证凭据、平台角色配置 |
| memberships | 套餐、权益、到期和提醒事实 | 支付链监听、通知发送 |
| billing | 订单、TRC20 匹配、确认、退款/取消状态 | 直接修改会员而不留 outbox 与审计 |
| content | 课程、内容、社区、媒体元数据 | 交易业务 |
| notifications | 站内、邮件、短信任务与回执 | 自己判断会员或支付业务状态 |
| platform-config | TDK、域名、功能开关和发布版本 | 直接修改 DNS/TLS/反向代理 |
| bridge | 设备、终端、连接代次、精确查询和命令账本 | 策略、AI、风控、复盘 |
| trading-accounts | 账户归属、观摩路由和账户快照 | 终端执行、AI 推理 |
| market-data | 报价、K 线、品种规格和修订 | 策略结论、交易指令 |
| strategies | 策略与不可变版本、订阅配置 | 模型供应商调用、订单执行 |
| models | 模型配置、凭据引用、用量与调用适配 | 交易结论改写、风控 |
| analysis | 手动/自动分析、信号与推理快照 | 最终风控、机械执行 |
| risk | 账户风控参数、风险决策和 kill switch | 改写模型原始结论 |
| execution | 订单意图、分发、Bridge 命令、回执和对账 | 策略分析、提示词判断 |
| reviews | 日/月/手动复盘、确认和策略记忆 | 自动修改策略 |
| audit | 只追加审计、关联 ID 和查询投影 | 代替各域业务状态 |

交易执行的具体统一状态机已在阶段 6 冻结为 [交易执行统一状态机](./trade-execution-state-machine.md)；`execution` 是唯一机械执行编排域，自动信号、手动交易、策略分发和持仓/挂单管理不得自行调用 Bridge 绕过它。

## 7. 异步任务架构

### 7.1 投递语义

BullMQ 官方说明队列最坏情况下是至少一次投递，因此所有消费者必须幂等，不能假设任务只执行一次。多个 Worker 进程也是官方推荐的并发和高可用方式。参见 [BullMQ](https://docs.bullmq.io/) 与 [Concurrency](https://docs.bullmq.io/guide/workers/concurrency)。

每个任务至少包含：

```text
job_type
job_version
job_id                 # 确定性 ID
operation_id           # 对应 API 异步 operation
scope                  # user/account/strategy/resource IDs
requested_at_utc
not_before_utc
deadline_utc
attempt
trace_id
payload_ref             # 指向数据库权威记录，避免复制大载荷和密钥
```

禁止把访问密钥、密码、完整模型上下文、完整 K 线或大批量用户数据直接塞入任务载荷。Worker 以 `payload_ref` 读取已授权、已版本化的数据库快照。

### 7.2 关键任务写入流程

```text
HTTP/应用用例
  1. 校验合同、身份、权限和幂等键
  2. MySQL 事务写业务状态 + operation + outbox
  3. 提交事务
  4. 返回 202 + operation_id

outbox dispatcher
  5. 领取未投递 outbox
  6. 以确定性 job_id 投递 BullMQ
  7. 标记投递结果；失败可重试

worker
  8. 领取任务并检查权威状态与幂等结果
  9. 执行一次有界工作
 10. 事务写结果、审计和后续 outbox
 11. 实时网关按提交后的事件推送 operation/resource revision
```

交易、支付确认、会员生效、退款、策略发布、管理员批量操作必须使用该流程。只更新可重建缓存的非关键任务可以直接投递，但仍需确定性任务 ID。

### 7.3 队列与进程组

| 任务组 | 典型任务 | 隔离原因 | 初始并发原则 |
| --- | --- | --- | --- |
| execution | 订单意图、Bridge 分发、回执对账、持仓保护、撤单和平仓 | 涉及真实交易，延迟和顺序最敏感 | 按账户/终端串行，跨账户有界并发 |
| analysis | 自动/手动分析、模型调用、用量恢复 | 外部模型慢且可能长时间超时 | 按供应商和用户限流，禁止无限并发 |
| review | 日/月复盘、人工交易复盘、记忆整理 | 大上下文、长 I/O、可延迟 | 低优先级、有界并发 |
| payment | TRC20 扫描、确认、支付副作用、会员提醒事实 | 金额与会员状态要求幂等和对账 | 按链/订单有界并发 |
| notification | 站内、邮件、短信、活动物化 | 外部供应商限流，不能拖慢支付 | 按渠道独立限流 |
| maintenance | 清理、归档、存储维护、情绪数据刷新 | 低优先级且可能批量扫描 | 单独进程，小批量、可暂停 |

高优先级任务必须使用独立队列/Worker，而不是只依赖同一队列里的数字优先级。每组独立设置并发、速率、超时、内存限制和重启策略。

### 7.4 调度规则

- API 和网关中禁止业务 `setInterval`/`setTimeout`。
- 调度器只扫描数据库中的 `next_run_at_utc`、状态和租约，采用有界批次与确定性槽位键登记任务。
- 自动分析按可信终端时间映射到 UTC 槽位；错过槽位按既定业务规则丢弃，不因队列恢复连续补跑。
- 固定平台维护任务可以使用 BullMQ Job Scheduler；用户/账户/策略维度的业务调度以数据库状态为权威，避免为每个用户常驻一个进程定时器。
- 调度器多实例运行时使用数据库领取或等价租约防重；Redis 锁只做补充，不是唯一正确性条件。

### 7.5 失败、重试与取消

- 只重试已分类为瞬时失败且副作用可幂等的任务。
- 参数、权限、业务状态、风控拒绝和合同错误不重试。
- 外部超时使用指数退避加随机抖动，并设置截止时间；超过截止时间进入终态或人工处理。
- Worker 进程退出时停止领取新任务，在限定时间内完成、续租或释放在途任务。
- 结果不确定的交易或支付操作不得直接重做，必须进入对账流程。
- 管理后台“任务中心”只允许暂停队列、重试符合条件的失败任务、取消尚未开始的可取消任务；所有操作写审计。

### 7.6 CPU 与 I/O

Node 官方说明 `worker_threads` 适合 CPU 密集型 JavaScript，不适合替代异步 I/O，并建议使用线程池而不是每个任务临时创建线程。参见 [Node.js Worker threads](https://nodejs.org/api/worker_threads.html)。

- 数据库、模型 HTTP、邮件、短信、链和对象存储属于异步 I/O，使用普通 Worker 的有界并发。
- 压缩、大型解析、报表生成或统计计算等 CPU 工作进入固定大小线程池或可终止的隔离子进程。
- CPU 子任务必须有输入大小限制、超时和内存预算；不得在 API 或任一网关事件循环执行。

## 8. Redis 与缓存

BullMQ 官方要求队列 Redis 使用 `maxmemory-policy=noeviction`，并建议启用持久化；这与可淘汰缓存的目标不同。因此正式环境默认使用：

- queue Redis：只给 BullMQ，`noeviction`、AOF、容量告警和备份策略。
- cache Redis：缓存、限流、短租约、实时修订；允许根据容量策略淘汰可重建键。

参见 [BullMQ Going to production](https://docs.bullmq.io/guide/going-to-production) 与 [Connections](https://docs.bullmq.io/guide/connections)。

连接策略：

- API 侧队列 producer 在 Redis 故障时快速失败，不能让 HTTP 请求无限等待。
- Worker 消费连接允许持续重连，但必须通过就绪状态和告警体现不可用。
- 每个进程创建自己的 Redis 连接；不得跨进程共享客户端。
- 缓存键必须带业务域、资源身份、版本和作用域；账户数据必须包含用户/账户/观摩频道隔离维度。
- 缓存丢失不得导致业务数据丢失，缓存恢复不得触发重复交易或重复付款。

## 9. 数据库与事务边界

- 每个运行角色有独立 MySQL 连接池；部署前计算所有实例的连接上限总和，不能让每个进程使用相同的大池。
- 连接池等待队列必须有界，连接获取、查询和事务必须有超时及指标。
- 新会话统一 UTC，业务时间保存为 `DATETIME(3)`；终端时间按时间证据转换，不改变数据库会话时区。
- 路由和 Worker 均通过 repository 访问数据库；禁止 `SELECT *`、无边界历史查询和跨域私表查询。
- 事务内只做必要读取、锁定、状态校验和写入；模型、Bridge、链、短信、邮件、存储等外部 I/O 全部在事务外。
- 多表锁定遵守数据库迁移方案规定的固定顺序。只有完整幂等事务可对死锁做有限重试。
- 批处理按主键游标小批量提交，不持有跨网络调用或长时间事务。
- outbox 领取使用有界批次和数据库租约；多个 dispatcher 不得重复产生不同 job ID。

## 10. HTTP、实时与 Bridge 边界

### 10.1 HTTP API

- Fastify route 只完成 Schema、身份、权限、幂等头、调用 use case 和响应映射。
- V4 OpenAPI 是请求和响应的权威合同；请求拒绝发生在业务用例之前。
- 快速同步命令完成事务后返回结果；需要外部 I/O 或批量处理的命令返回 `202 operation`。
- 响应 Schema 明确允许字段，避免 repository 行或敏感字段被直接序列化。

### 10.2 浏览器实时网关

- 只接受短时单次票据，建立后绑定用户、会话和授权作用域。
- 从已提交的领域事件或实时投影读取变化，按 V4 revision 推送。
- 不接收业务写命令，不执行列表查询，不直接访问其它模块私表。
- 慢客户端按协议合并、降频或断开，不能形成无限内存队列。

### 10.3 Bridge 网关

- 独立验证设备会话、终端身份、连接代次、deadline 和幂等命令。
- 每个 MT4/MT5 terminal profile 使用独立账户 WebSocket；Gateway 按系统用户的有效权益上限原子维护带 TTL 的连接 lease，同一逻辑连接重连接管不得双计数。
- 精确查询和命令写入 durable ledger；断线后的未知结果进入对账，不自动重做。
- Bridge 网关不做策略、模型或风险判断，只传送服务端已确定的请求和结果。

## 11. 权限与安全

- 认证模块留在模块化单体内，不为 SSO 单独拆微服务。
- HTTP、浏览器 WS、Bridge WS 使用不同凭据和会话模型。
- RBAC 在应用用例入口执行；资源归属、会员、账户、观摩频道和管理员操作级权限不能只靠路由名称判断。
- Worker 不信任任务载荷中的用户身份或权限结果；执行前从权威记录重读必要状态。
- 管理员批量任务记录发起人、理由、作用域、输入摘要、幂等键、结果和失败明细。
- 密钥只通过配置/密钥服务引用，不进入日志、队列载荷、outbox 正文或审计详情。
- Fastify Schema 只能来自受版本控制的项目代码，禁止接受用户上传 Schema 参与动态编译。

## 12. 日志、指标与追踪

### 12.1 结构化日志

统一字段至少包含：

```text
timestamp_utc, level, service_role, module, event,
request_id, trace_id, operation_id, job_id, attempt,
user_id, account_id, strategy_id, terminal_instance_id,
duration_ms, outcome, error_code
```

用户 ID 等只记录内部标识，不记录密码、Token、密钥、完整提示词、完整模型响应或支付敏感信息。

### 12.2 指标

- API：请求量、延迟、错误率、连接池等待、慢查询。
- 浏览器实时：连接数、订阅数、发送字节、丢弃/合并、revision 缺口、慢客户端。
- Bridge：连接数、心跳延迟、查询延迟、命令状态、未知结果、重连和账户切换。
- 队列：等待、活动、完成、失败、重试、超期、最老任务年龄和每组 Worker 利用率。
- 数据库/Redis：连接使用率、锁等待、死锁、缓存命中、队列 Redis 内存与持久化状态。
- 外部依赖：供应商延迟、限流、超时、熔断和恢复。

### 12.3 关联追踪

`request_id -> operation_id -> outbox_id -> job_id -> Bridge request_id/order_intent_id` 必须可关联。首版使用统一上下文字段即可；是否接入 OpenTelemetry 由实施阶段依据排障收益决定，不作为架构落地前置条件。

## 13. 错误治理

- 传输层统一使用 V4 `error.code`，内部异常不直接返回堆栈或供应商原文。
- 错误分为合同、认证、授权、业务拒绝、冲突、限流、依赖失败、超时、结果未知和内部错误。
- 每个外部依赖有独立超时、并发限制和熔断状态；一个模型或短信供应商异常不得耗尽整个 Worker 池。
- `unhandledRejection`/`uncaughtException` 仍让当前进程退出，由进程管理器只重启该角色；禁止吞掉未知进程级错误继续运行。
- 交易/支付“未知”是显式业务状态，不能等价成失败后自动重试。

## 14. 从旧后端迁移

按竖切迁移，不做一次性重写：

1. 建立 TypeScript、Fastify、配置、日志、数据库、缓存和队列基础设施，但不接流量。
2. 建立 operation、outbox、任务状态与管理后台只读任务中心合同。
3. 选择无交易副作用的维护任务验证独立 scheduler/worker、重试、停机和监控。
4. 迁移通知与异步导出，验证供应商限流和失败恢复。
5. 迁移复盘/记忆和 AI 分析，验证大载荷引用、模型限流与取消。
6. 在阶段 6 状态机冻结后迁移交易执行与对账。
7. 迁移支付与会员副作用，完成真实 MySQL 事务形状和 TRC20 对账验证。
8. 逐业务域将 Express route 替换为 Fastify route + use case + repository。
9. 对每个旧定时器进行“双跑只观测 -> 结果对账 -> 单一新执行者 -> 删除候选”切换。
10. 只有阶段 17 获得用户逐项授权后，才删除旧入口、旧定时器和旧模块。

迁移期间不允许两个执行者同时产生真实交易、支付、通知或会员副作用。影子运行必须只读或把输出写入独立对比记录。

## 15. 自动化架构约束

实施时至少加入以下静态检查：

- `transport/http`、`transport/realtime` 和 `entrypoints` 不得导入数据库驱动或 repository 实现。
- `domain` 不得导入 Fastify、BullMQ、MySQL、Redis、HTTP 客户端或供应商 SDK。
- 模块不得深层导入其它模块，只能从公开入口导入 application port 或合同。
- API 与网关 entrypoint 不得导入 `Worker`、Job Scheduler 或业务定时器。
- Worker 不得导入 route/handler。
- 新源码不得出现未登记的业务 `setInterval`/`setTimeout`。
- OpenAPI、实时 Schema、任务载荷 Schema、数据库迁移和 TypeScript 类型必须通过 CI。

## 16. 验收条件

### 16.1 架构验收

- API、浏览器实时、Bridge、scheduler 和六类 Worker 可分别启动、停止和健康检查。
- 宝塔只显示一个 `aurum_ai` PM2 项目；一键启停整个项目正常，PM2 监控可区分各运行角色及日志。
- 人为终止一个 Worker 后，PM2 只恢复该 Worker，API、两个网关和其它 Worker 的 PID 与连接保持稳定。
- 终止任一 Worker 不影响 API、两个网关和其它 Worker；恢复后只继续符合条件的任务。
- 人为制造一个 CPU 阻塞任务时，只影响其隔离子进程，不增加 API/Bridge 事件循环延迟。
- 依赖边界检查能阻止 route SQL、跨模块私有导入和 API 进程启动 Worker。

### 16.2 任务验收

- 重复投递同一 job 不产生重复副作用。
- Redis 短暂不可用后，已提交的关键 outbox 不丢失；恢复后能安全投递。
- Worker 在处理前、外部调用后、事务提交前后分别崩溃，结果均可恢复或进入明确未知/人工处理状态。
- 交易任务严格按账户/终端顺序执行；通知、复盘或维护积压不影响交易队列。
- 所有任务具有超时、有限重试、退避、取消规则、审计和管理入口。

### 16.3 性能与资源验收

- 每个进程的数据库池总和不超过数据库预算；池等待和超时可见。
- API、浏览器实时、Bridge、各 Worker 分别完成压力与长时运行测试。
- 队列积压、Redis 内存、最老任务年龄和外部依赖限流均有报警阈值。
- 实际并发值通过测试确定，不以本方案中的示意值直接上线。

## 17. 第一轮复审

复审范围：需求覆盖、业务边界、现有能力复用、最小代码和是否设计过度。

发现与调整：

- 初稿曾考虑 NestJS 和微服务。复审后改为 Fastify 模块化单体，保留 TypeScript、合同校验和模块封装，同时去掉装饰器 DI、服务发现和分布式事务。
- 用户要求后台任务不能影响主进程或其它任务，仅把任务放到一个通用 Worker 仍不足；调整为 API/两个网关/scheduler 独立，任务再按风险与资源类型分成六个 Worker 组。
- 仅依赖 BullMQ 保存关键任务会把交易和支付正确性转移到 Redis；调整为 MySQL 业务事务与 outbox 权威，BullMQ 只负责投递和唤醒。
- 为减少代码，未引入通用事件总线框架、CQRS 总线或 DI 容器；同步调用使用显式 application port，异步副作用使用一个统一 outbox 机制。

第一轮结论：方案覆盖主站、交易实验室、后台、Bridge 与所有后台任务，隔离满足用户要求，同时没有引入当前不需要的微服务复杂度。

## 18. 第二轮复审

复审范围：数据迁移、并发、幂等、异常恢复、时间、安全、测试、回滚和连带 Bug。

发现与调整：

- BullMQ 队列要求 Redis `noeviction`，与普通缓存淘汰策略冲突；调整为 queue Redis 与 cache Redis 默认物理隔离，并分别配置连接和告警。
- API producer 和 Worker 对 Redis 断线的期望不同；调整为 API 快速失败、Worker 持续重连，且关键 outbox 使 producer 短暂失败不会丢工作。
- 单纯增加 Worker 并发可能让同一账户命令乱序；增加“同账户/终端串行、跨账户有界并发”的执行队列约束，具体状态转换留待阶段 6。
- 外部调用放入事务会放大锁等待和死锁；明确所有模型、Bridge、链、短信、邮件和存储 I/O 必须在事务外，并用状态机衔接。
- 进程优雅停机若只等待 Promise，可能无限阻塞；增加停止领取、限定排空、续租/释放和结果未知对账要求。
- 旧定时器直接切换会造成漏跑或双跑；增加影子对账与单一执行者切换门，删除仍留到阶段 17。

第二轮结论：调整后方案明确了任务隔离、数据权威、连接策略、顺序、故障恢复和迁移门，可作为后续实现基线。

## 19. 剩余风险与未验证项

- 本阶段没有安装 Fastify/BullMQ、没有运行新进程、没有修改数据库，也没有验证真实 Redis `noeviction`/AOF 配置。
- 具体 Worker 并发、连接池大小、任务超时和熔断阈值必须由阶段 16 的压力与故障测试确定。
- 交易执行状态、同账户串行键、未知结果和人工处置在阶段 6 详细冻结。
- outbox、operation、任务审计及旧表映射已在[数据库逐表迁移矩阵](./database-table-migration-matrix.md)中完成设计；当前仍不授权 DDL、回填或建库。
- 当前本地分支与远端历史存在分叉；本阶段不提交、不推送、不部署。
