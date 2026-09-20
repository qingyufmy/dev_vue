# API V4、浏览器实时协议 V4 与 Bridge 设备协议 V4

> 状态：阶段 4 冻结稿
>
> 冻结日期：2026-09-02
>
> 适用范围：`www`、`trade`、`admin`、统一身份中心、模块化后端、量见智桥、MT4、MT5

## 1. 文档目标

本方案把全项目功能迁移矩阵转化为三套边界清晰、可生成类型、可独立演进的 V4 合同：

1. 浏览器与应用 BFF/后端之间的 HTTP API V4。
2. 服务端到浏览器的实时事件协议 V4。
3. 服务端与量见智桥之间的设备查询、流和确定性命令协议 V4。

本阶段只冻结合同，不实现路由、不修改数据库、不改 Bridge 客户端、不执行交易，也不删除旧接口。V4 全链路验收通过后，旧 `/api`、`/aurum-api`、浏览器 WebSocket RPC 和 Bridge V3 才能进入阶段 17 的候选删除门。

规范性关键词“必须”“不得”“应”“可”用于区分强制规则与可选实现。

## 2. 当前事实与 V4 结论

### 2.1 当前源码事实

- 后端同时注册 `/api` 与 `/aurum-api`，存在重复业务入口。
- 旧浏览器 WebSocket 在同一连接内处理心跳、账户、报价、持仓、历史、分析、设置和交易写命令。
- 旧浏览器可发送 `open`、`close`、`toggle_trade`、`set_quote_symbol` 等业务动作，查询和副作用边界不清晰。
- Bridge V3 已具备值得保留的终端身份、账户引用、连接代次、请求 ID、命令截止时间、结果确认和 revision 连续性校验。
- 仓库当前只有 `bridge/contracts/data-request-v1.json` 一份显式设备查询合同，没有统一 OpenAPI 或浏览器实时事件 Schema。

### 2.2 V4 冻结结论

| 边界 | V4 用途 | 明确禁止 |
| --- | --- | --- |
| HTTP API | 首次快照、详情、列表、筛选、分页、历史、配置、全部浏览器写操作 | 用 GET 产生副作用；把异步交易伪装为同步成功 |
| 浏览器 WebSocket | 服务端主动推送实时增量、状态变化、异步操作结果 | 查询历史/列表；上传配置；直接下单、改单、撤单、平仓 |
| Bridge 设备 WebSocket | 服务端精准查询终端数据、订阅必要数据流、发送确定性命令并接收结果 | 复用浏览器 SSO；由 Bridge 生成业务策略；执行无期限或无幂等键命令 |

三套协议共享命名和基础类型，但认证、权限、连接、流控和版本独立。

## 3. 版本与基础地址

### 3.1 HTTP

- 业务 API 基础路径固定为 `/api/v4`。
- 身份中心继续使用标准 OIDC/OAuth 2.1 路径；业务身份资料通过 `/api/v4/identity/*` 暴露。
- URL 只表达资源和作用域，不把版本放入查询参数。
- 破坏性变化发布新主版本；兼容性新增字段不提升主版本。
- V4 客户端必须忽略未知响应字段，但不得忽略未知枚举值后继续执行交易。

### 3.2 浏览器实时通道

- 同源升级路径固定为 `/realtime/v4`。
- 子协议固定为 `aurum.realtime.v4`。
- `trade`、`admin` 每个浏览器标签页各自最多保持一条统一连接；页面组件不得自行创建连接。
- 公共 `www` 页面不建立连接；登录后的 `www` 仅在需要通知或活跃支付订单时连接。

### 3.3 Bridge 设备通道

- 设备升级路径固定为 `/bridge/v4/ws`。
- 子协议固定为 `aurum.bridge.v4`。
- Bridge 的配对、刷新会话、更新清单和安装包下载使用 HTTPS；设备查询、订阅和命令使用设备 WebSocket。
- Bridge 会话不得复用浏览器 Cookie、OIDC 授权码或用户访问令牌。

## 4. 共享数据规则

### 4.1 标识符

- 数据库整数 ID 在 JSON 中一律序列化为不透明字符串，避免 JavaScript 精度丢失。
- 用户、账户、终端、策略、信号、操作、订单意图、Bridge 命令和事件均有独立 ID，不得互相替代。
- MT ticket 使用字符串；不得转换成 JavaScript `number` 后再回传。

### 4.2 数值

- 金额、价格、手数、比例、点差和指标精确值使用十进制定点字符串。
- 计数和受控序号可使用 JSON 整数，但必须在 JavaScript 安全整数范围内。
- 不可用值使用 `null`，不得用 `0`、空字符串或 `--` 冒充；`--` 只属于前端展示。

### 4.3 时间

- 数据库存储与 HTTP/浏览器事件的权威时间统一为 UTC，格式为带 `Z` 的 RFC 3339 字符串，精度到毫秒。
- Bridge 包络和需要与终端原始时间对账的字段使用 UTC epoch milliseconds，字段后缀固定为 `_utc_msc`。
- 终端业务时间必须携带 `terminal_instance_id`、`broker_server`、`login`、`timezone_offset_minutes`、`clock_status` 和校准来源。
- 服务端只在时区或校准状态变化时推送；前端按偏移计算终端时钟，不接收每秒时间广播。
- `www`、`admin` 默认显示北京时间；`trade` 的交易时间显示当前可信终端时间。API 原始值仍保留 UTC。

### 4.4 字段与枚举

- JSON 字段、路径参数和查询参数统一使用 `snake_case`。
- 可扩展状态枚举必须有明确的 `unknown` 展示分支；交易命令遇到未知关键枚举必须失败关闭。
- 布尔值必须是真布尔值，不接受 `0/1`、`yes/no` 或字符串布尔值。

## 5. HTTP API V4

### 5.1 成功响应

单资源：

```json
{
  "data": {
    "id": "sig_01K...",
    "revision": "rev_42"
  },
  "meta": {
    "request_id": "req_01K...",
    "generated_at": "2026-09-02T08:00:00.123Z"
  }
}
```

列表：

```json
{
  "data": [],
  "meta": {
    "request_id": "req_01K...",
    "generated_at": "2026-09-02T08:00:00.123Z",
    "page_size": 50,
    "next_cursor": null,
    "has_more": false
  }
}
```

规则：

- HTTP 状态码表达协议结果，不再附加 `ok: true` 或混用 `status: success`。
- `meta` 不承载业务数据。
- 返回可实时合并的资源时必须包含 `revision`。
- `ETag` 应与资源 `revision` 一致，允许条件请求和乐观并发控制。

### 5.2 错误响应

错误媒体类型固定为 `application/problem+json`：

```json
{
  "type": "https://errors.example.invalid/conflict/revision",
  "title": "资源已被其他操作更新",
  "status": 409,
  "code": "revision_conflict",
  "detail": "请刷新后重试。",
  "instance": "/api/v4/strategies/str_01K...",
  "correlation_id": "cor_01K...",
  "retryable": false,
  "errors": [
    { "field": "if-match", "code": "stale_revision", "message": "版本已过期" }
  ]
}
```

统一状态码：

| HTTP | 用途 |
| --- | --- |
| 400 | 语法、字段或组合参数无效 |
| 401 | 未登录、会话过期或设备凭据无效 |
| 403 | 已识别身份但无权访问当前作用域 |
| 404 | 资源不存在，或为避免越权泄露而隐藏 |
| 409 | revision、幂等键、账户归属或状态转换冲突 |
| 412 | `If-Match` 前置条件失败 |
| 422 | 语法正确但不符合业务合同 |
| 429 | 用户、会话、设备或资源级限流 |
| 503 | 依赖、Bridge、市场或模型暂时不可用 |

内部堆栈、SQL、供应商密钥和原始英文异常不得返回浏览器。可重试错误必须给出 `retryable`，必要时使用 `Retry-After` 或 `retry_after_ms`。

### 5.3 分页、筛选与排序

- 大列表统一使用不透明 cursor，不使用页码或可伪造的数据库 offset。
- `page_size` 默认 50，通用最大 200；审计和历史成交最大 500，由合同逐端点声明。
- cursor 必须绑定用户、筛选、排序、作用域和版本；参数变化后旧 cursor 失效。
- 排序字段由端点白名单声明，格式统一为 `sort=-created_at,id`。
- 时间范围使用 `from`、`to` 的 UTC RFC 3339 值，区间默认左闭右开。
- 多条件筛选必须是明确参数，不接收任意 SQL、表达式或对象路径。

### 5.4 幂等、并发与异步操作

- 会创建外部副作用的 `POST` 必须携带 `Idempotency-Key`，键由客户端生成且在用户/操作种类作用域内唯一。
- 相同键和相同规范化请求体重复提交，返回同一结果；相同键不同请求体返回 `409 idempotency_conflict`。
- 策略、风控、订阅、站点配置等可编辑资源必须使用 `If-Match`；不得采用最后写入覆盖。
- 下单、平仓、撤单、改单、分析、导出和发布等异步动作返回 `202 Accepted` 和 `operation`，不表示终端或模型已经成功。
- 操作状态仅允许 `accepted`、`queued`、`running`、`succeeded`、`partially_succeeded`、`rejected`、`failed`、`uncertain`、`cancelled`、`expired`。`partially_succeeded` 只用于一个批量父操作已经结束但子操作结果不一致的场景；单账户交易不得使用。
- `uncertain` 必须进入对账，不允许客户端自动重复创建另一笔交易命令。
- `rejected` 表示确定性业务拒绝，`failed` 表示已证明没有交易副作用的系统失败；只要可能已送达 MT 就必须使用 `uncertain`。
- 所有副作用必须记录 `correlation_id`、主体、作用域、幂等键、前后 revision 和最终状态。

### 5.5 安全与缓存

- 浏览器身份使用各应用 Host-only、`Secure`、`HttpOnly`、`SameSite=Strict` 会话 Cookie。
- 非安全方法必须通过精确 Origin 校验和 CSRF Token；CORS 只允许配置中明确的应用 Origin。
- 管理员权限在每个端点服务端校验，前端隐藏按钮不构成授权。
- 私有响应默认 `Cache-Control: no-store`；可重用静态字典可使用 ETag 和短时私有缓存。
- 公开课程、内容和 TDK 允许 CDN 缓存，但缓存键必须包含站点、语言和发布 revision。
- 请求体默认上限 256 KiB；上传和导入使用独立端点、媒体类型和更严格权限。

## 6. HTTP 领域资源目录

下表冻结业务命名空间与主要责任；精确字段在实现对应竖切时补入同一 OpenAPI 主合同，不再创建另一套临时接口。

| 领域 | `/api/v4` 资源 | 主要能力 |
| --- | --- | --- |
| identity | `/identity/me`、`/identity/security`、`/sessions` | 当前身份、安全设置、会话和退出 |
| sites | `/sites`、`/site-pages`、`/seo-entries`、`/domains` | 站点、TDK、域名和发布 revision |
| content | `/courses`、`/lessons`、`/learning-progress`、`/posts`、`/comments` | 课程、学习、内容和社区 |
| membership | `/plans`、`/memberships`、`/membership-reminders` | 套餐、权益、到期与提醒 |
| commerce | `/commerce-orders`、`/payments`、`/bridge-connection-products`、`/referrals` | 订单、TRC20 支付、Bridge 并发连接额度、返佣和对账 |
| notifications | `/notifications`、`/notification-preferences` | 三应用独立已读状态和偏好 |
| bridge | `/bridge/pairings`、`/bridge/connections`、`/bridge/connection-capacity`、`/bridge/terminal-profiles`、`/bridge/releases` | 配对、当前账户 WebSocket 额度、多终端档案、诊断、下载和更新 |
| trading context | `/trading-context`、`/trading-accounts` | 当前系统用户作用域、账户和观摩频道 |
| market | `/market/symbols`、`/market/quotes`、`/market/candles`、`/macro-snapshots` | 精准报价、历史 K 线和宏观数据 |
| execution | `/positions`、`/pending-orders`、`/trading-accounts/{account_id}/execution-context`、`/trading-accounts/{account_id}/execution-commands`、`/execution-distributions`、`/operations` | 当前交易资源、权威执行上下文、账户命令、策略分发和状态恢复 |
| analysis | `/market-analyses`、`/analysis-jobs` | 手动/自动行情分析、分析历史和完整推理；记录按系统用户归类 |
| trader | `/trade-decisions`、`/market-analyses/{analysis_id}/trader-evaluations` | 每个交易账户独立的二次判断和动作建议，不直接执行交易 |
| strategy | `/strategies`、`/strategy-versions`、`/strategy-subscriptions` | 私有/平台策略、版本和用户订阅 |
| models | `/model-profiles`、`/model-routes`、`/model-evaluations` | 个人/平台模型、默认模型和用途路由 |
| risk | `/risk-accounts`、`/risk-policies`、`/risk-snapshots`、`/risk-decisions` | 当前账户规则、快照、告警和决策 |
| review | `/review-cases`、`/manual-review-candidates`、`/manual-review-cases`、`/strategy-memories`、`/strategy-memory-updates` | 日/月/手动复盘、不可变版本、人工确认及可撤销的统一策略记忆 |
| records | `/trades`、`/audit-events`、`/exports` | 历史交易、系统审计和导出 |
| admin | `/admin/*` | 用户、会员、内容、商业、AI、风控、Bridge、集成、系统和审计 |

交易写命令统一通过服务端执行边界：

- `GET /trading-accounts/{account_id}/execution-context?symbol=...|ticket=...`：返回六类当前 revision、目标资源 revision、报价和合约约束，不返回内部风控策略正文。
- `POST /trading-accounts/{account_id}/execution-commands`：统一受理市价单、挂单、持仓/挂单修改、平仓和撤单；请求必须带完整 `expected_state` 与幂等键。
- `GET /execution-distributions/preview?strategy_id=...&symbol=...`：管理员只读预览当前目标资格；预览不是最终名单。
- `POST /execution-distributions`：管理员在受理事务内重新校验并冻结策略订阅目标。
- `GET /execution-distributions/{distribution_id}`：读取父操作、目标和归因结果。
- `POST /execution-distributions/{distribution_id}/close-commands`：只对原分发结果中仍可由 distribution、outcome 和 ticket 精确归因的持仓创建平仓命令。
- `POST /analysis-jobs`

这些端点只持久化和受理服务端意图。真实 MT 结果必须通过 `operations`、交易资源 revision、审计和 Bridge 结果共同确认。完整状态转换、分发父子操作和未知结果恢复以 [交易执行统一状态机](./trade-execution-state-machine.md) 为准。

## 7. 浏览器实时协议 V4

### 7.1 建立连接

1. 应用先通过 HTTP 获取当前页面的一致快照及 revision。
2. 应用调用 `POST /api/v4/realtime/tickets`；服务端设置短时、单次、仅限 `/realtime/v4` 的 `Secure`、`HttpOnly` Cookie，并返回允许的订阅能力和过期时间。
3. 浏览器以 `aurum.realtime.v4` 子协议建立同源连接，票据不可放入 URL、localStorage 或业务消息。
4. 服务端原子消费票据，校验应用、会话、Origin 和权限，发送 `system.welcome`。
5. 客户端提交订阅目标和其 HTTP 快照 revision。
6. 服务端返回 `subscription.ready`；若无法证明增量连续，返回 `subscription.resync_required`，客户端只重拉受影响资源。

单次票据默认 30 秒过期，只允许一次握手；握手成功后票据立即失效。WebSocket 的最长寿命受应用会话和权限变化约束。

### 7.2 包络

```json
{
  "v": 4,
  "event_id": "evt_01K...",
  "type": "market.quote.updated",
  "occurred_at": "2026-09-02T08:00:00.123Z",
  "sequence": 318,
  "scope": {
    "user_id": "usr_01K...",
    "trading_account_id": "acct_01K...",
    "terminal_instance_id": "term_01K...",
    "observer_channel_id": null
  },
  "resource": {
    "kind": "quote",
    "id": "acct_01K...:XAUUSD"
  },
  "revision": "rev_9821",
  "data": {},
  "correlation_id": "cor_01K..."
}
```

- `sequence` 在当前连接内严格递增，只用于发现连接内缺口，不作为跨重连游标。
- `revision` 属于资源或聚合根，必须与 HTTP 快照可比较；它是字符串，不假定连续数字。
- 事件只包含变化所需字段；完整推理、历史 K 线数组、审计正文和报表不得进入事件。
- 事件作用域与订阅授权必须由服务端生成，客户端提供的用户 ID 不参与授权。

### 7.3 客户端允许消息

浏览器只可发送：

- `subscription.subscribe`
- `subscription.unsubscribe`
- `system.ping`

客户端不得发送通用 `command` 或自定义 action。订阅目标使用受控对象，不允许拼接任意频道字符串：

```json
{
  "v": 4,
  "type": "subscription.subscribe",
  "request_id": "req_01K...",
  "targets": [
    {
      "kind": "market",
      "trading_account_id": "acct_01K...",
      "symbol": "XAUUSD",
      "timeframe": "M5",
      "after_revision": "rev_91"
    }
  ]
}
```

同一目标重复订阅必须幂等。作用域切换时先订阅新目标并得到 ready，再释放旧目标，避免界面空窗；旧作用域事件即使延迟到达也必须被 scope 检查丢弃。

AI、风控与执行资源使用以下受控目标，不能把任意 Redis 频道或用户 ID 传给服务端：

- 用户级行情分析：`kind=signals`，账户与观摩频道为空，`resource_id=analysis_jobs|market_analyses|all`；分析记录始终按系统用户归类，不随 MT4/MT5 账户切换。
- 账户级交易员：`kind=signals`，必须提供 `trading_account_id`，`resource_id=trader_jobs|trade_decisions`。
- 账户级风控：`kind=risk`，必须提供 `trading_account_id`，`resource_id=policy|summary|decisions|manual_release|all`。
- 用户级复盘与策略记忆：`kind=reviews`，账户与观摩频道为空，`resource_id=cases|memories|all`；事件只用于失效通知，完整复盘和记忆正文必须重新读取 HTTP。
- 账户级异步操作：`kind=operations`，提供 `trading_account_id`，`resource_id=all`。
- 用户级分发父操作：`kind=operations`，`trading_account_id=null`、`observer_channel_id=null`、`resource_id=all`；只匹配事件中的同一活动系统用户。观摩频道不能订阅该目标。

上述列表型目标的 `after_revision` 必须为 `null`：事件中的 revision 属于单个聚合根，而不是整张列表，不能伪造一个可比较的列表 revision。浏览器首次连接和每次重连先通过 HTTP 获取列表快照，再用 WebSocket 事件做小粒度失效通知；单个聚合收到旧 revision 时仍须丢弃。本人账户的报价、K 线、账户指标、持仓和挂单继续携带可与 HTTP 快照精确比较的 `after_revision`；观摩发布采用下述独立失效合同，不能把私有投影版本视作公开事件重放游标。

观摩目标仅允许 `account.metrics`、`market.quote`、`market.candle`、`positions`、`pending_orders`，必须有明确频道及来源账户，`after_revision=null`。列表、进入、HTTP 发布和 WS 统一使用动态受众授权。发布证明最长 30 秒，从查询开始计时；每次事件投递前重验，查询后再次确认未过期。到期、撤权、来源/归属版本变化或依赖失败后停止投递，发送 `subscription.resync_required(reason=authorization_changed)` 并关闭（当前 V4 实现为 `4403`）。到期任务仅关闭连接，不在网关中轮询数据库。P4B 的管理事务/outbox 负责更及时的撤权通知，不能以其尚未接入为由无限缓存旧授权。

观摩 WS 不转发源用户原始事件：只生成 `observer.publication.changed`，data 白名单为 `channel_id/source_revision/resource/resource_id`，scope 里的终端实例为 null。浏览器合并通知后回读经过授权和脱敏的 HTTP 投影；不携带登录号、服务器名、设备档案、信号关联、历史或执行指令。该通知不授予来源用户权限，也不适用于本人正常行情增量。

### 7.4 事件目录

| 事件 | 数据内容 | 恢复源 |
| --- | --- | --- |
| `runtime.bridge.changed` | 在线、暂停、版本、账户切换、心跳摘要 | Bridge connection HTTP |
| `runtime.market.changed` | 开市、闭市、只读、交易权限 | trading context HTTP |
| `runtime.analysis.changed` | 自动分析启停、阶段、失败、`next_run_at` | subscription/runtime HTTP |
| `terminal.timezone.changed` | 偏移、状态、校准来源和 revision | trading account HTTP |
| `account.metrics.changed` | balance、equity、margin、floating profit | account snapshot HTTP |
| `market.quote.updated` | bid、ask、last、spread、观察时间 | quote HTTP |
| `market.candle.updated` | 当前蜡烛 OHLC、tick volume | candle HTTP |
| `market.candle.closed` | 已收线蜡烛和下一根起点 | candle HTTP |
| `positions.changed` | upsert/remove 和账户 revision | positions HTTP |
| `pending_orders.changed` | upsert/remove 和账户 revision | pending orders HTTP |
| `observer.publication.changed` | 授权后的频道/source 版本与资源失效元数据，不含源事件正文 | 带 observer_channel_id 的发布 HTTP |
| `analysis.job.changed` | 分析任务排队、运行、完成、失败或过期 | analysis job HTTP |
| `market_analysis.created` | 最新市场分析摘要及 `opportunity`，不含完整推理 | market analyses HTTP |
| `trader.job.changed` | 单个交易账户的交易员任务状态及 `task_mode`（entry/manage/both） | trade decisions HTTP |
| `trade_decision.created` | 单个交易账户的动作建议摘要，不含完整正文 | trade decisions HTTP |
| `risk.policy.changed` | 当前规则版本和 revision，不含完整规则 | risk policy HTTP |
| `risk.summary.changed` | 风险摘要完整性和 revision，不含完整快照 | risk summary HTTP |
| `risk.decision.created` | 风控通过/拒绝与公开错误码，不含规则明细 | risk decisions HTTP |
| `risk.manual_release.changed` | 手动放开状态、失效原因和 revision | manual release HTTP |
| `review.case.changed` | 复盘 case 状态、当前版本 ID 和 revision，不含证据或完整正文 | review case HTTP |
| `strategy.memory.changed` | 策略记忆状态、待确认数量和 revision，不含记忆正文 | strategy memory HTTP |
| `operation.changed` | 异步命令或任务状态、错误摘要 | operation HTTP |
| `notification.created` | 新通知摘要和未读数 | notifications HTTP |
| `payment.status.changed` | 活跃订单到账、确认、完成、异常、过期 | payment HTTP |
| `admin.alert.created` | 后台任务、集成、异常和运营告警摘要 | admin HTTP |

### 7.5 断线、恢复与顺序

- 不承诺跨连接事件重放，不建设新的永久事件总线。
- AI、风控和 operation 事件由业务事务写入 Outbox；Dispatcher 必须等任务队列投递与 Redis 实时发布都成功后才标记该 Outbox 行完成。Redis 失败会重试同一 `event_id`，客户端按事件 ID 与聚合 revision 去重。
- 客户端发现 sequence 缺口、收到 `resync_required`、网络重连、账户切换、观摩频道切换或权限变化时，只通过 HTTP 重拉受影响资源。
- HTTP 快照必须在返回前读取统一 revision；订阅时携带该 revision，服务端只有在能证明没有缺口时才发 ready。
- 资源事件必须按 revision 幂等合并。旧 revision、旧账户和旧终端事件必须丢弃。
- 客户端重连采用带抖动的 1、2、5、10、20、30 秒退避；恢复后不得全应用刷新。
- 会话注销、权限撤销或账户归属变化时，服务端主动关闭连接；前端先清除敏感缓存，再重新完成 HTTP 身份检查。

### 7.6 心跳、流控与带宽

- 服务端每 25 秒发送一次轻量 heartbeat；60 秒无有效读写视为失活。
- 浏览器上行单帧最大 16 KiB，下行单帧最大 64 KiB；大结果必须改走 HTTP。
- 每连接待发送队列上限为 256 条或 1 MiB，任一达到即触发慢消费者保护。
- 报价和当前蜡烛可按“账户 + 品种”合并，只保留待发送的最新值；订单结果、风险告警和 operation 状态不得被报价覆盖。
- 默认报价面向前端最多每 250 ms 推送一次；没有可见订阅者时停止浏览器侧行情转发。
- K 线只推当前蜡烛变化和收线事件，不重复发送历史数组；倒计时由前端计算，不做每秒广播。
- 慢消费者关闭码为 `4008`，权限失效为 `4003`，票据无效为 `4002`，消息过大使用标准 `1009`。

## 8. Bridge 设备协议 V4

### 8.1 职责

Bridge 是用户本地 MT4/MT5 的受控数据与执行适配器：

- 接收服务端的精准资源查询并返回对应数据。
- 对已订阅的少量实时资源发送有 revision 的增量。
- 执行服务端已经完成权限、业务规则、额度、风控和参数决策后的确定性命令，不在 Bridge 内复制或修改业务判断。
- 保存未确认的命令结果，重连后继续对账。
- 报告终端能力、版本、账户身份、时区校准证据和更新状态。

Bridge 不负责生成策略、修改 AI 结论、替代服务端风控，也不判断会员、连接额度、允许品种、交易时段、手数或止盈止损业务规则。Bridge 只保留消息完整性、当前终端与账户路由、连接代次、截止时间、幂等和精确目标状态等本机才能完成的执行安全检查；这些检查不得推导或改写交易参数。终端接受或拒绝命令后，Bridge 必须回传成功、失败、原始终端代码和执行后的实际状态，也不主动批量上传服务端未请求的数据。

### 8.2 路由身份

每个终端相关消息必须绑定：

```json
{
  "terminal_instance_id": "term_01K...",
  "account_ref": {
    "broker_server": "Broker-Demo",
    "login": "596520"
  },
  "connection_epoch": 14
}
```

- `broker_server + login` 是交易账户身份，`terminal_instance_id + connection_epoch` 是当前连接路由。
- 服务端必须同时校验账户归属、当前活跃路由和连接代次；任一不匹配即拒绝。
- 普通用户默认拥有 1 条 MT4/MT5 共用账户 WebSocket 并发连接额度，并可购买额外并发额度。用户可以保存、删除和更换任意终端档案，只有当前有效账户 WebSocket 占用额度；每个档案、Worker 和 WebSocket 只绑定一个账户，同一稳定交易账户同一时刻仍只有一个可交易 route。管理员观摩源使用独立并发额度和隔离档案，不占用户额度。
- 新连接接管后，旧连接的命令、响应和增量全部失效，但旧命令结果仍保留用于审计和对账。

并发连接额度、跨设备 lease、删除/更换和账户级策略订阅以 [Bridge 并发连接额度与账户级策略订阅模型](./bridge-connection-quota-and-account-subscription-model.md) 为准。

### 8.3 包络与消息类型

```json
{
  "v": 4,
  "message_id": "msg_01K...",
  "type": "query.request",
  "sent_at_utc_msc": 1788336000123,
  "correlation_id": "cor_01K...",
  "route": {
    "terminal_instance_id": "term_01K...",
    "account_ref": {
      "broker_server": "Broker-Demo",
      "login": "596520"
    },
    "connection_epoch": 14
  },
  "payload": {}
}
```

消息族：

| 类型 | 方向 | 用途 |
| --- | --- | --- |
| `session.hello` / `session.welcome` | 双向 | 版本、能力、档案、终端和限额协商 |
| `system.heartbeat` / `system.heartbeat_ack` | 双向 | 活性和队列摘要，不传业务快照 |
| `query.request` / `query.response` / `query.error` | 双向 | 精准读取一个资源窗口 |
| `stream.subscribe` / `stream.unsubscribe` | 服务端→Bridge | 开启或停止明确数据流 |
| `stream.event` / `stream.ack` | Bridge→服务端 | revision 增量、全量基线和确认 |
| `command.request` | 服务端→Bridge | 确定性命令 |
| `command.accepted` | Bridge→服务端 | 本地命令账本已持久化确认 |
| `command.result` | Bridge→服务端 | 最终或不确定执行结果 |
| `command.result_ack` | 服务端→Bridge | 结果已持久化确认 |
| `command.reconcile` | 服务端→Bridge | 按命令 ID 或 ticket 查询未知结果 |
| `release.available` / `release.status` | 双向 | 已签名更新通知和健康/回滚结果 |

`release.available` 必须携带 `restart_not_before_utc_msc`。该时间由服务端结合自动分析计划计算，Bridge 不接收完整策略调度表，也不自行推算分析触发时间；客户端仅在更新已暂存且本机执行/对账/关键写入为空闲时自动切换并重启。
| `protocol.error` | 双向 | 包络、权限、容量或状态错误 |

### 8.4 精准查询

V4 查询只允许以下资源：

- `terminal.info`
- `terminal.clock`
- `account.snapshot`
- `market.symbols`
- `market.instrument`
- `market.quote`
- `market.candles`
- `trading.positions`
- `trading.pending_orders`
- `history.orders`
- `history.trades`
- `history.deals`
- `execution.lookup`
- `diagnostics.health`

阶段 8 已将查询收窄为 `resource + params + deadline_utc_msc`。分页、筛选和新鲜度要求是各资源 `params` 的明确字段，不存在第二套通用 `page/freshness` 包络。每个资源只允许自身需要的品种、周期、UTC 半开区间、ticket、cursor 和有界数量；不再暴露类 SQL 的通用 `select/filter/sort`。不得传 SQL、脚本、任意表达式或跨账户 join；服务端不得用“以后可能需要”为由请求完整历史或完整品种表。风险快照、日报、统计、图表和策略输入由服务器组合基础资源，不作为 Bridge 资源。

```json
{
  "request_id": "qry_01K...",
  "resource": "market.candles",
  "params": {
    "symbol": "XAUUSD",
    "timeframe": "M5",
    "count": 300
  },
  "deadline_utc_msc": 1788336005123
}
```

`contracts/bridge-v4.schema.json` 已按阶段 8 修订为窄资源合同，不再接受通用查询表达式；其响应字段仍须在 MT4/MT5 实机矩阵后最终冻结。实现必须持续运行 Schema 正反例、帧上限和能力协商验证。详细技术边界见 [Bridge V4 Windows 7 架构、安装与更新技术冻结方案](./bridge-v4-win7-architecture-and-packaging-plan.md)。

- Bridge 查询页上限 500 条；响应解压后最大 512 KiB。超限必须分页，不得截断后伪装成功。
- 响应必须返回 `observed_at_utc_msc`、`source_revision`、`has_more` 和 `next_cursor`。
- Bridge 本地 SQLite 是 K 线、历史订单、历史成交、资金事件、同步覆盖和命令对账的可重建读取投影；响应必须声明 `source: terminal|local_projection`、覆盖范围、完整性和新鲜度。已覆盖范围优先读 SQLite，缺失范围才按有界时间片唤醒终端补齐。
- MT4 与 MT5 的原始响应在客户端适配层统一为 closed candle、order、deal、normalized trade 和 funds event；MT ticket/order/position 一律按十进制文本保存，出金金额保持负数。历史中间页可先幂等写入事实表，但只有当前 UTC 时间窗枚举完毕后才能发布 `complete` coverage；包含未闭合 K 线的窗口继续刷新，禁止先标完整后补数据。
- MT4 的 `OrdersHistoryTotal` 只证明终端当前可见的账户历史，不自动证明经纪商全量历史。服务端在依赖更早区间前必须检查 Bridge 返回的来源与覆盖证据；正式客户端还需提供“账户历史范围不足”的诊断，不得把空页等同于账户从未交易。
- 大体量数据不得通过单帧全量回传。分页和帧上限只用于内存、网络和故障隔离，不得静默丢数据；客户端必须用不透明稳定游标继续读取，直至明确 `has_more=false` 且完整性证据成立。
- 查询 deadline 过期后不得继续占用终端线程；服务端不自动把超时查询升级为全量同步。
- 本地清理只允许处理可重建缓存，或已经获得服务端持久化 ACK 且超过保留期的数据。未 ACK 的历史、命令、回执、Outbox 和 `uncertain` 对账不得由 TTL 或磁盘水位删除。
- 服务器仅在目标数据已经提交到服务端数据库后发送 `data.persisted.ack`；该消息只允许确认 `market.candles`、`history.orders`、`history.trades` 或 `history.deals` 的明确半开区间和 source revision，普通查询成功、WebSocket 收到或页面展示都不能替代它。
- 清理 K 线后必须同步收缩本地覆盖范围；命中缺口时返回 `incomplete/refreshing` 并重新补齐。任何响应都不得引用已清理数据继续声明旧 `complete` revision。
- cursor/snapshot lease 在有效期内保护其读取范围；过期后若底层数据已清理，Bridge 返回稳定 `cursor_expired`，服务端重新建立快照，不尝试 OFFSET 猜测续页。

### 8.5 实时流

仅允许订阅：

- `account`
- `positions`
- `pending_orders`
- `quotes`
- `current_candle`
- `terminal.status`
- `terminal.clock`

`history.*`、诊断和报表不得持续流式上传。`stream.event` 使用 `revision`、`base_revision`、`full_snapshot`、`upserts` 和 `deletes`；revision 不连续时，服务端请求一次明确全量基线，不清库、不猜测缺失事件。

行情可合并和限频；账户、持仓、挂单的结构变化不得被丢弃。终端时区只在可信校准值或状态变化时发送。

阶段 12G 将交易状态流进一步收窄：一个已认证 V4 WebSocket 只承载一个终端档案和一个账户 route，多账户客户端通过多个独立档案连接；额度按活跃 WebSocket/档案而不是保存的账户数量计算。`positions` 与 `pending_orders` 首版只接受 `full_snapshot=true` 且 `deletes=[]` 的完整基线，增量帧返回 `resync_required`，避免用不完整集合证明平仓或撤单。两类 `upserts` 已在 `contracts/bridge-v4.schema.json` 固定为拒绝未知字段的规范化条目：ticket 为十进制文本，价格/手数为十进制定点文本，并完整携带 direction、order type、magic、止损止盈、stop-limit 与到期时间。账户身份从认证 route 注入，Bridge 条目不得自报或覆盖 `account_id`。

服务端只有在以下证据同时成立时，才把成功命令的风险预留从 `committed` 转为 `absorbed`：当前未被替换的 session、严格递增的投影 revision、快照观测时间不早于终端结果、命令结果 ticket 与快照实体精确相符，或完整快照明确证明已平仓/撤单。证据不足继续保留 committed 容量，不按超时猜测吸收。

### 8.6 确定性命令

命令只允许：

- `order.place`
- `position.protection.set`
- `position.close`
- `pending_order.modify`
- `pending_order.cancel`
- `execution.lookup`

每条命令必须包含：

- 全局唯一 `command_id`
- 服务端持久化的 `idempotency_key`
- 当前 route
- `issued_at_utc_msc`
- `deadline_utc_msc`
- 按 action 固定且拒绝未知字段的规范化参数
- 管理已有持仓/挂单时完整且非空的 `expected_state`

交易数量与价格使用十进制定点字符串，ticket 使用十进制字符串，避免 JavaScript 浮点和大整数损失。修改保护或挂单时，字段缺失表示“不修改”；明确移除必须使用 `remove_stop_loss`、`remove_take_profit` 或 `remove_expiration`，不得用 `0`、`null` 或缺失混用。`order.place` 与 `execution.lookup` 的 `expected_state` 必须为 `null`；其余管理动作必须携带 ticket、品种、方向、订单类型、magic、手数、开仓价、当前止损止盈和到期时间的完整预期状态。

Bridge 必须先把命令写入本地命令账本，再回复 `command.accepted`，之后才能操作终端。同一 `command_id` 或幂等键不得再次执行。deadline 已过、route 变化、账户不符、能力不支持或 expected state 不符时必须拒绝。

结果状态固定为：

- `succeeded`
- `rejected`
- `failed`
- `uncertain`

网络断开不能把已提交给 MT 的命令直接标记为 failed；无法确认时使用 `uncertain`，等待 `command.reconcile`。服务端持久化结果后发送 `command.result_ack`，Bridge 收到确认前必须保留结果。

重连恢复每个账户同一时刻最多发送一条 `command.reconcile`。收到并持久化该结果、发送 ACK 后，才处理下一条未知命令；恢复流程永远不进入普通 `command.request` 投递路径。执行 Worker 以 Redis 短租约串行进入账户边界，并由数据库活动命令门阻止前一条命令尚在 queued/dispatched/accepted/uncertain/reconciling 时投递另一个 intent。Worker 崩溃在 queued 之后时只能恢复原 durable command；已经进入 dispatched 的命令不得再次发送。

### 8.7 能力与 MT4/MT5 差异

`session.hello` 必须报告 `platform`、Bridge 版本、协议版本、安装 ID、档案 ID、可用资源、可用命令、最大页大小和功能标志。服务端按能力精准降级，不按客户端版本猜测。

2026-09-06 首次账户登记扩展：终端项可携带 `account_facts: { currency, login, broker_server, observed_at_utc_msc }`，字段以 `contracts/bridge-v4.schema.json` 为准。缺少该扩展的旧客户端只能连接已有有效 owner 的账户。新版生产客户端每次连接（含重连）在申请服务器通道前直接查询 `account.snapshot`，MT4 使用 `login/broker_server/currency/connected`，MT5 使用 `login/server/currency/terminal_connected`；适配器校验终端路线，客户端再次将快照 login/server 与档案精确比较，不使用缓存或手填币种。失败或离线不发送 hello。

服务端验证 facts 路线与 hello 一致，币种为 1–12 个 ASCII 字符（字母/数字开头，后续可含 `._-`），事实时间距接收最多 60 秒且不超前 5 秒。既有账户币种与新事实不一致时返回冲突，保留原数据，不自动修改财务语义。这是受认证设备提交的终端事实，不是券商签名的账户产权证明；只允许创建从未登记的新账户及首次 owner，不能补领已有无主、撤销、软删除或他人账户，也不凭终端字符串转移归属。账户、owner 区间与当前投影、档案/绑定、pending session 在同一短事务内落库，失败全部回滚；区间起点使用服务端时间，历史数据不能反向扩张授权区间。Redis 额度申请在事务外，额度失败不删除已经成立的账户历史。发布顺序为支持扩展的服务端先行、客户端后行，旧服务端的严格 hello 校验不保证接受新版扩展。

MT4 不支持的 stop-limit、字段或历史证据必须明确返回 `capability_not_supported`；不得静默改成另一种订单。MT4/MT5 的枚举和字段差异在 Bridge 内转换成 V4 统一语义，同时保留原始代码供审计。终端自身对价格、手数、权限或市场状态的拒绝属于执行结果，Bridge 原样回传，不在客户端再维护一套经纪商交易规则。

### 8.8 设备认证、流控和更新

2026-09-06 精确设备撤销：`POST /api/v4/bridge/credential-revocations` 接收 `refresh_token`、`installation_id`、`profile_id`，以 token 哈希定位单个 V4 凭据当前代次。成功 HTTP 200 返回 `data: { credential_type: "bridge_revocation", installation_id, profile_id, generation, revoked: true }` 及标准 meta；完整合同见 OpenAPI。匹配已撤销凭据可重复确认，保持原撤销时间；会员到期不阻止撤销。旧 token 不能撤销后来轮换的新 token，错误身份不返回成功，不以用户级 revoke-all 代替。请求中的设备凭据承担认证，不使用浏览器会话或 Cookie。

撤销事务不删账户、owner、绑定、会话历史或交易证据。已签发票据在网关当前凭据检查处拒绝，现有 route 的后续授权检查失败；HTTP 成功表示撤销持久化，不表示远端 socket/Redis lease 已同步关闭，清理仍由 socket close、心跳及 TTL 处理。配对重取必须继续检查凭据未撤销，不能复活旧授权。

客户端先保存待移除标志并关闭自动连接，再停止当前连接、请求撤销；严格确认回执身份后才从目录移除。网络、停止或保存失败时保留待移除档案及 DPAPI 凭据，重启可重试。普通档案保存时省略 `RemovalPending=false`，维持旧 V4 目录形状；待移除档案携带新字段，旧版严格读取器会拒绝该目录，不能回退旧程序绕过撤销流程。没有引入缓存/账本删除。

活跃连接每 10 秒复用账户快照检查当前终端身份；身份不匹配、离线或事实过期则停止旧路线，不自动改档案或登录其他账号。25 秒是源事实新鲜度的过期判断阈值，迟到快照按其真实年龄扣减有效期；I/O 与线程调度可能延迟实际断连，不能将阈值解释为硬实时关闭上限。远端仍有最后有效心跳后 45 秒的租约 TTL。检测线程未退出前保留运行时，身份失效后禁止迟到响应触发尚未执行的旧命令。

- 配对码只用于建立设备身份；后续使用可轮换的设备刷新会话换取短时连接凭据。
- 设备凭据绑定安装 ID、档案 ID和用户，不写入 URL或日志。
- V3 到 V4 过渡只允许调用 `POST /api/v4/bridge/legacy-credential-exchanges`：请求携带原用户上下文解密出的 V3 refresh token、安装 ID、档案 ID 和只读迁移快照指纹；服务端只保存 token 哈希，并把一个 V3 session 唯一映射到一个 V4 设备 session。同一映射重试只轮换同一行并递增 generation，换安装或档案重用同一 V3 session 返回 409。
- 迁移交换不会撤销或改写 V3 refresh session，保证 V4 客户端本地导入失败时仍可回到 V3。V4 本地全部档案成功并通过后续升级健康门之前，不得清理 V3 凭据或数据。
- V4 客户端只用 DPAPI 保存长期 refresh token；每次连接前调用 `POST /api/v4/bridge/session-tokens`，换取最长 60 秒、单次消费且绑定用户、安装、档案和 generation 的短时 token。长期 refresh token 禁止直接进入 WebSocket `Authorization`。
- V4 设备 refresh token 沿用显式撤销语义，不设置会让无人值守客户端定期失联的固定到期日；用户失效、会员资格失效、设备撤销或 generation 轮换都会使后续换票失败。连接本身始终只使用短时单次 token。
- 设备上行和下行默认单帧最大 512 KiB；命令和命令结果目标上限 64 KiB。
- 待处理命令、结果、查询和流分别设置有界队列；优先级为命令结果、命令、心跳、账户/订单增量、行情、普通查询。
- Bridge 自动更新继续使用签名清单、签名模块、SHA-256、大小、版本、健康确认和失败回滚；协议 V4 与应用/EA 版本分别管理。
- 更新通知不等于安装授权；发布、灰度和回滚仍执行独立发布流程。

## 9. 类型生成与合同治理

- `contracts/openapi-v4.json` 是 HTTP 公共包络和首个 trade 竖切的机器合同骨架。
- `contracts/realtime-v4.schema.json` 是浏览器消息包络、订阅消息和事件联合类型。
- `contracts/bridge-v4.schema.json` 是 Bridge 包络、查询、流和命令联合类型。
- OpenAPI/JSON Schema 生成的 TypeScript、Node 和 Bridge DTO 只能由生成任务更新，不允许三端手抄出不同字段。
- 合同变更必须先修改源 Schema、生成类型、运行兼容性检查，再修改实现。
- 兼容新增字段必须可选；删除字段、收紧约束、改枚举语义或改变默认值属于破坏性变更。
- 浏览器和 Bridge 在收到未知重大版本时必须拒绝连接；未知非关键事件可以记录并忽略。

本阶段的 OpenAPI 只冻结公共语义和首个 `trade` 端到端竖切所需路径；后续已完成的数据库逐表设计不会被提前伪造成尚未实现的接口字段。各领域实施必须按[数据库逐表迁移矩阵](./database-table-migration-matrix.md)扩展同一 `/api/v4` 主合同，不得另建临时 V4 路由。

## 10. 验收清单

### 10.1 HTTP

- 所有浏览器写操作都有 HTTP 端点、权限、CSRF、幂等和审计规则。
- 异步交易只返回 accepted/operation，不提前宣称 MT 成功。
- cursor 绑定筛选和作用域，资源修改使用 `If-Match`。
- 精确小数、ID、UTC、终端时间和空值语义明确。

### 10.2 浏览器实时通道

- 浏览器无法通过 WebSocket 查询历史、读取任意资源或发交易写命令。
- HTTP snapshot + WS revision 在订阅、重连、账户切换和观摩切换时无串号。
- 报价、当前 K 线与成交量秒级更新；完整历史和推理正文不进实时帧。
- 慢消费者、断线、权限撤销和丢 revision 都能精准恢复。

### 10.3 Bridge

- 普通账号/终端唯一性、管理员观摩档案隔离和账户接管均按 route 校验。
- MT4/MT5 查询分页、能力差异、时区和命令结果语义明确。
- 命令本地入账、幂等、deadline、expected state、uncertain 和 result ack 可验证。
- 更新通道保留签名、哈希、健康检查和回滚。

## 11. 第一轮复审：需求覆盖与最小设计

复审重点：功能覆盖、业务边界、现有能力复用、最小实现和设计过度。

发现与调整：

1. 初稿若只设计浏览器 API，会遗漏 Bridge 精准查询和命令恢复，因此把设备协议纳入同一阶段，但保持独立认证和包络。
2. 没有照搬旧 WebSocket action；保留其有效业务能力，把查询迁到 HTTP、把浏览器写命令迁到幂等 HTTP，把实时变化留在 WebSocket。
3. 没有引入 Kafka、永久事件存储或微服务。浏览器跨连接恢复使用精准 HTTP 重拉，满足可靠性同时减少复杂度。
4. 没有为全部旧路由逐一机械生成 OpenAPI；先冻结公共合同、领域命名和首个 trade 竖切，后续按领域扩展同一主合同。
5. Bridge V3 的 route、connection epoch、deadline、result ack 和 revision 连续性被保留，避免重构丢失已验证的安全属性。

第一轮结论：方案覆盖三个前端、后端和 Bridge 的传输需求，且没有为了规范化引入无明确收益的基础设施。

## 12. 第二轮复审：安全、恢复与连带影响

复审重点：兼容性、数据与迁移、并发与幂等、异常恢复、时间语义、安全、测试、回滚和连带 Bug。

发现与调整：

1. 浏览器原本无法安全设置自定义 WebSocket Header；改为 HTTP 设置短时、单次、Path 限定的 HttpOnly 连接票据 Cookie，避免 URL 泄露和长期令牌暴露。
2. 只定义 sequence 无法跨重连恢复；新增 HTTP revision 握手、`resync_required` 和资源级重拉，不把 sequence 当永久游标。
3. 高频报价可能阻塞交易结果；新增队列上限、报价合并、事件优先级和大对象 HTTP 化规则。
4. 网络断线发生在 MT 已受理之后可能重复下单；冻结 `uncertain + reconcile + result_ack`，禁止客户端自动重试交易。
5. 终端切换可能让旧响应写入新账户；所有 Bridge 消息强制 route，浏览器事件强制 scope，旧 epoch/revision 必须丢弃。
6. 直接把所有 ID 和金融数值定义为 JSON number 会造成精度问题；统一改为 opaque ID 与 decimal string。
7. V4 不兼容旧协议，但删除与切换被保留到独立删除门；阶段 4 不隐含授权清理旧接口或客户端。

第二轮结论：调整后已覆盖权限、时间、带宽、重复执行、断线恢复、账户串号和升级回滚风险；可作为后续后端架构、状态机、数据库和 Bridge 原型的合同基线。

## 13. 剩余风险与后续输入

- OpenAPI 中各业务域的完整字段必须在对应竖切前，结合阶段 7 逐表迁移设计继续扩展。
- 浏览器 WebSocket 的真实带宽阈值需要在阶段 16 用报价峰值、弱网和多标签页压测校准。
- Bridge 帧上限、队列容量和 Win7 WebSocket/TLS 行为必须在阶段 8 双原型中实测。
- 交易命令的全部状态转换、分发平仓和人工确认边界已由阶段 6 [交易执行统一状态机](./trade-execution-state-machine.md) 冻结；阶段 7 继续落实逐表映射。
- 设备票据轮换、吊销和升级兼容窗口需要阶段 8 与发布方案共同验证。
- 当前仅完成源码合同审查，未对真实数据库、Redis、MT4、MT5、Bridge、浏览器或生产流量执行验证。

## 14. 验证记录

本节历史基线数字仅对应最初协议评审；后续扩展以各阶段实施记录为准。

- `npx --yes @redocly/cli lint contracts/openapi-v4.json`：通过，OpenAPI 3.1 合同无错误和警告。
- Python `jsonschema` Draft 2020-12 元 Schema 检查：浏览器 realtime 与 Bridge 两份 Schema 均通过。
- 三份合同内部 `$ref` 完整性检查：通过，无悬空引用。
- OpenAPI 骨架检查：13 个 operation ID 唯一，基础地址和首个 trade 竖切路径完整。
- 浏览器协议负例检查：通用 `command` 业务消息无法通过 realtime V4 Schema。
- Bridge 资源目录检查：13 类精准查询与 6 类确定性命令与正式方案一致。
- 本地文档相对链接检查和 `git diff --check`：通过。
- 本阶段没有修改可执行代码，因此没有把旧源码单元测试当作 V4 实现证明；真实端到端验证分别留在路线图阶段 8、10、11、15 和 16。

## 15. P4B 观摩管理控制事件（2026-09-05）

管理 HTTP 位于 `/api/v4/admin/observer`，仅 admin-web 会话和精确 admin Host 可访问；写入还需 CSRF、幂等键及更新版本。接口与严格 DTO 见 `contracts/openapi-v4.json`，范围见 [P4B 报告](./stage-m1-b2-p4b-observer-management-report.md)。

事务 outbox 的 `observer.authorization.changed` 由独立 dispatcher 发布到内部 Redis 频道 `aurum:v4:observer-authorization`，不进入浏览器通用事件频道。机器合同为 `contracts/observer-authorization-control-v4.schema.json`，只含 nullable `source_id/channel_id/user_id` 与安全整数 `registry_revision`，不含审计、个人数据或大正文。匹配维度采用 AND；默认频道切换使用全部空维度使全部观摩订阅重新鉴权，不影响 owner 订阅。

网关清理匹配观摩订阅队列并发 resync/close；初次异步鉴权期间收到控制事件也不安装旧证明。重复控制事件允许保守失效；Redis Pub/Sub 不是持久确认通道，成功发布不能证明每个网关已接收。丢失消息仍依赖既有最长 30 秒授权 TTL 和后续鉴权兜底；不得宣称零延迟吊销或端到端已验收。


2026-09-07 时间口径补充：遵循[时间存储与显示规则](time-storage-and-display-policy.md)，时刻存储/传输统一 UTC，实验室显示终端时间，其它应用显示北京时间。


### 持仓历史关联标识（2026-09-10，服务端兼容扩展）

Bridge V4 PositionStreamItem可选position_identifier用于传递终端稳定持仓标识，以十进制字符串保留UINT64精度；null或缺失表示未知。它与当前ticket不同，禁止用于命令目标或替换expected_state中的ticket。该字段只进入内部OpenPosition.positionIdentifier和JSON快照，不添加到当前HTTP/实时持仓DTO。旧客户端无此字段仍兼容；本次没有更新生产者，后续Bridge必须确认服务端支持该扩展后再发送。不能从ticket、magic或signal_id猜测缺失值。
