# Bridge 历史不可变、平仓时间统一与平台范围优先同步优化方案

> 文档状态：已完成两轮复审，可进入实施
>
> 编写日期：2026-08-11
>
> 最近修订：2026-08-11（允许查询平台接入前历史，并增加 `2000-01-01` 绝对安全下限）
>
> 适用范围：量见智桥 3.0、本地 SQLite 历史归档、网站 Bridge 历史接口、AI 交易实验室交易记录与历史统计
>
> 基线：`dev_codex` / `70de6d6fb76d42986b2991b62466341b73b0da9a`
>
> 本文只定义实施方案，不授权修改生产数据库、发布 Bridge、提交业务代码或部署网站。

## 1. 结论

本次优化采用以下最终口径：

1. 已完整取得并成功写入 SQLite 的历史记录视为不可变记录。之后所有列表、筛选、分页、导出、复盘证据和统计优先读取 SQLite，不再为了“验证旧历史”重复调用 MT4/MT5。
2. 交易历史的规范时间统一为平仓时间。范围过滤、排序、游标、前端显示、最近七天、平台接入后、每日交易聚合和图表都以平仓时间为准，不得回退到开仓时间或通用事件时间。
3. 内部比较和范围使用 `close_time_utc_msc`；用户可见时间使用该笔交易冻结的终端服务器时间证据；“当日”按平仓发生时对应的终端服务器自然日归属。
4. “平台首次接入时间”使用服务器端 `mt5_account_bindings.first_connected_at`，身份键为 `platform + broker_server + login`。切换绑定的网站用户或交易账户记录不得改变该时间。
5. Bridge 初始化优先准备 `[平台首次接入时间, 初始化固定结束点)`。该范围完成后，才以 P3 低优先级逐步补齐更早历史。
6. 不提高 250 条批次上限，不并行调用 MT5 历史接口，不让归档工作抢占实时行情、持仓、挂单或交易命令。
7. 对 596520 这类大账户，优先通过取消重复 MT5 查询和 SQLite 批量查重降低同步耗时，而不是硬性限速或扩大并发。
8. 前端把“统计范围”“明细平仓时间筛选”“最近 30 天图表窗口”作为三套独立状态：范围决定总体数据边界，筛选只收窄表格，图表点击只修改平仓时间筛选。
9. “平台接入后”只定义默认统计起点，不是历史查询硬下限。用户可将开始日期保存到平台接入时间之前；所有模式统一受 `2000-01-01`、Bridge/终端可信可查询下限和当前固定结束水位约束。

## 2. 已确认的现状

### 2.1 596520 实际基线

当前本机 Bridge SQLite 中，596520 账号包含：

| 类型 | 数量 |
| --- | ---: |
| 完整交易记录 | 25,895 |
| 成交记录 | 51,789 |
| 历史订单 | 52,045 |
| SQLite 归档物理行 | 129,729 |

最近 30 天初始化任务约 `0.685` 秒完成。一次完整后台同步的墙钟时间为 27 分 58 秒，但期间 Bridge 停止约 21 分 58 秒，因此实际运行时间上限约 6 分钟。按历史订单数量计算，250 条批次上限下理论最低需要 209 个响应分页。

### 2.2 当前已有能力

- Bridge 已将实时 Worker 与 Archive Worker 分离。
- 历史任务已有 P1/P2/P3 优先级、动态时间窗、覆盖范围、断点游标和崩溃恢复。
- SQLite 已有 `history_archive_items`、coverage、revision、daily summary 和 snapshot/cursor 读取能力。
- MT5 trade 对象已经输出 `entry_time_utc_msc`、`close_time_utc_msc`、`close_time_server_msc`。
- 服务端已有 `mt5_account_bindings.first_connected_at`，并以 `COALESCE(first_connected_at, VALUES(first_connected_at))` 保留首次值。
- 前端下拉框视觉默认值已经是“平台接入后”。

### 2.3 当前与新需求不一致的地方

1. `server/bridge-ws.js` 的平台范围仍使用当前绑定用户的 `users.created_at`，没有使用 `mt5_account_bindings.first_connected_at`。
2. `server/routes/ai/account-performance.js` 仍优先使用当前 `ownership.started_at`，用户换绑会改变绩效同步起点。
3. `public/ai/app.js` 的无 DOM/异常回退范围仍是 `all`，与页面默认的 `platform` 不一致。
4. SQLite 的 trade、deal、history_order 共用 `event_time_msc`；`history_time_msc()` 还按 `time_msc -> close_time_msc -> event_time_msc` 顺序选择，交易语义不够强制。
5. 每日摘要使用 UTC 日桶，不能明确表达“该笔交易平仓时所属的终端服务器自然日”。
6. tail refresh 会周期性重新扫描最近 48 小时，且冲突时允许更新既有归档行，与“入库后以 SQLite 为准”不一致。
7. MT5 continuation page 会再次批量调用 `history_orders_get()`；SQLite 每条归档记录执行一次 SELECT 和一次 UPSERT，大账户存在明显重复工作。
8. `performance_daily` 会重新从 MT5 按日期读取旧 deals，形成第二套历史统计来源。
9. “全部”和“平台接入后”当前不展示服务器解析后的实际起止日期，用户无法核对真正统计边界。
10. 下方表格只有开仓时间筛选，没有独立平仓时间筛选。
11. 当前柱状图点击会把 `historyRangeMode` 直接改成 `custom`，同时清除图表缓存并重新加载范围统计，违反“图表下钻不改变统计范围”的要求。

## 3. 业务定义与边界

### 3.1 交易账户稳定身份

稳定身份定义为：

```text
platform + normalize(broker_server) + login
```

- `platform` 必须区分 MT4 与 MT5。
- `broker_server` 比较时不区分大小写，持久化时保留可展示原值。
- `login` 使用字符串，不转浮点数，不去除可能有意义的前导零。
- `user_id`、`trading_account_id`、`terminal_instance_id` 和 Profile 名称都不是平台首次接入时间的身份组成部分。
- 当前用户和当前交易账户记录仍用于授权与路由，但不能重置历史起点。

### 3.2 平台首次接入时间

权威字段：

```text
mt5_account_bindings.first_connected_at
```

写入规则：

- 首次完成账号身份验证时写入。
- 后续重连、换绑、接管或切换 `trading_account_id` 时只允许保留原值或修正为有证据的更早值，禁止向后移动。
- 迁移历史数据时可取同一身份全部已有 `trading_accounts` 的 `MIN(first_verified_at, identity_verified_at, created_at)`；无法证明时失败关闭，不使用当前用户注册时间代替。
- Bridge 客户端不自行猜测平台首次接入时间，由服务器解析后发起精确范围准备。

### 3.3 历史不可变

不可变针对已经满足以下条件的记录：

- 来源范围读取成功；
- 账号、平台和终端时钟证据有效；
- trade 所需的入场单、平仓成交和关联证据完整；
- 记录通过字段、大小、方向、票号和时间校验；
- SQLite 事务成功提交。

提交后：

- 同一作用域、item kind 和 item ID 的重复记录只做去重，不更新旧 payload。
- 若同一主键再次返回不同 payload，记录 `history_immutable_conflict` 诊断计数，不覆盖 SQLite，不自动刷新更早历史。
- 管理员“刷新”只重读 SQLite 并唤醒尚未封口的新尾部，不清库、不重拉已覆盖范围。
- 修复旧版本派生列或索引时，只能从 SQLite 已有 payload 离线重建，不得重新向 MT4/MT5验证。

### 3.4 新尾部与已封存历史

“旧历史不再验证”不等于忽略刚刚发生但终端尚未稳定返回的新平仓。同步分为：

- **未封口尾部**：最新平仓游标附近的短窗口，可由持仓消失、平仓命令完成、重连和 30 秒轻量检查唤醒；只用于发现新记录。
- **已封存覆盖**：成功完成并超过安全延迟边界的范围，之后不再访问 MT 源。

尾部使用 `(close_time_utc_msc, close_deal_ticket)` 复合游标。允许为了处理“同一毫秒多笔成交”读取游标所在的最后一个边界页，但只去重，不比较和更新旧记录。未知的券商事后修订、延迟回写到已封存旧时间的记录将不会被自动发现，这是本次业务决定明确接受的剩余风险。

### 3.5 非交易资金事件

入金、出金、信用和纯账户调整没有“平仓时间”，不能伪造 `close_time_utc_msc`：

- 交易列表、交易数量、盈亏、胜负、手数和交易日统计严格只使用 `item_kind='trade'` 的平仓时间。
- 资金事件单独使用 `event_time_utc_msc` 和事件所属终端服务器自然日。
- 资金事件不得进入交易笔数或胜负统计。
- 总资产/本金计算如需合并两类数据，API 必须分别返回 `trade_statistics` 与 `capital_events`，最后再显式组合，不能共用一个含糊的时间列。

## 4. 统一时间合同

### 4.1 规范字段

trade 必须具备：

| 字段 | 用途 |
| --- | --- |
| `entry_time_utc_msc` | 入场证据、持仓时长，不参与历史范围筛选 |
| `close_time_utc_msc` | 唯一的交易历史范围、排序、游标和比较字段 |
| `close_time_server_msc` | 冻结该笔交易的终端服务器时间证据 |
| `close_timezone_offset_minutes` | 平仓时采用的已验证终端时差 |
| `close_business_date` | 由平仓服务器时间得到的 `YYYY-MM-DD` |
| `close_deal_ticket` | 与平仓时间组成稳定游标 |

规则：

- `close_time_utc_msc` 缺失或非法时，trade 不得入库。
- 不再允许 trade 从 `time_msc`、`entry_time_msc` 或字符串时间猜测平仓时间。
- MT4 必须在 EA 输出层归一化出相同字段；终端“账户历史”不可见的范围保持 unavailable，不伪造 complete。
- 所有范围均采用半开区间 `[close_from, close_to)`。
- 同毫秒排序固定为 `close_time_utc_msc DESC, close_deal_ticket DESC, item_id DESC`。

### 4.2 每日聚合

每日交易统计按 `close_business_date` 聚合，不按入场日、不按 SQLite 写入日、不按网站服务器日，也不直接按 UTC 零点切分。

例如，一笔交易 UTC 时间为 21:30，但终端服务器时间已进入次日，则该交易归属终端服务器的次日。前端展示、历史日图、账户绩效和复盘筛选必须得到同一个日期。

### 4.3 API 输入输出

- 前端日期输入仍为用户可理解的终端业务日期。
- 服务端根据该账户已验证的终端时差转换为固定 UTC 半开范围。
- Bridge 快照冻结范围、时差证据和 revision；翻页期间不得重新使用当前时差解释旧游标。
- API 结果显式返回 `close_time_utc_msc`、`close_time_terminal`、`close_business_date`。
- 兼容旧 Bridge 时，服务器可以从明确的旧 `close_time_msc` 归一化一次；不能从通用 `time` 或开仓时间兜底。

## 5. 初始化优先级设计

### 5.1 初始化固定水位

服务器确认终端身份后，读取稳定账号绑定并固定：

```text
platform_start = max(Bridge 支持下限, mt5_account_bindings.first_connected_at)
captured_end   = 当前可信 UTC 时间向下取安全边界
```

启动阶段范围：

```text
平台范围：[platform_start, captured_end)
旧历史：  [Bridge 支持下限, platform_start)
新尾部：  [captured_end, 持续推进的可信当前时间)
```

### 5.2 调度顺序

1. 实时账户、持仓、挂单、报价和交易命令按现有流程就绪，不等待历史。
2. 服务器 `onTerminalReady` 完成账号身份同步，取得 `first_connected_at`。
3. 服务器使用现有 exact-range `history_page` 准备链路发起平台范围 P1 请求；不新增第二套下载协议。
4. Bridge planner 用 coverage subtraction 只创建未覆盖区间；已在 SQLite 的部分直接复用。
5. 当前正在执行的单个有界批次允许结束；下一个批次必须由 P1 平台范围抢占 P2/P3。
6. 平台范围完整后，前端默认统计立即变为 ready。
7. 更早历史继续使用 P3 后台补齐；P3 在实时活动或 P1 到达时于批次边界让路。

为了兼容服务器不可用但本地终端仍工作的场景，Bridge 可继续准备最近小窗口，但不得猜测平台首次接入时间，也不得把最近窗口伪装成“平台接入后完整”。

### 5.3 换绑行为

换绑只改变：

- 当前授权用户；
- 当前 `trading_account_id`；
- ownership 审计期；
- 实时浏览器路由、自动推理和交易权限。

换绑不改变：

- `first_connected_at`；
- Bridge SQLite 中该交易账号的历史覆盖；
- 平台范围起点；
- 已封存 trade 的平仓时间和业务日期；
- P3 旧历史断点。

新用户获得该账号权限后，仍需通过当前有效绑定和终端路由校验才能读取；稳定历史起点不代表绕过权限。

## 6. SQLite 数据与读取模型调整

### 6.1 兼容迁移

只追加新的本地 SQLite runtime migration，不修改已发布 schema migration 的历史内容。

`history_archive_items` 建议新增：

- `close_time_utc_msc INTEGER NULL`
- `close_time_server_msc INTEGER NULL`
- `close_timezone_offset_minutes INTEGER NULL`
- `close_business_date TEXT NULL`
- `immutable_state TEXT NOT NULL DEFAULT 'legacy'`

约束：

- trade 新写入必须为 `immutable_state='sealed'` 且上述 close 字段完整。
- deal/history_order 的 close 字段保持 NULL。
- 旧行迁移只读取本地 `payload_json`。字段足够时标记 sealed；字段不足时标记 `legacy_incomplete`，不重新访问 MT 源，也不悄悄纳入精确统计。

新增索引：

```text
(terminal_instance_id, broker_server, login_account, platform,
 item_kind, close_time_utc_msc DESC, item_id DESC)
```

### 6.2 日汇总 v2

现有 `history_daily_summary` 使用 UTC 日桶。为保证回滚和避免原地重定义主键，新增 `history_daily_summary_v2`，以 `close_business_date` 为日键。

- v2 只从 sealed trade 构建交易统计。
- 资金事件保持独立 item kind 和事件业务日期。
- generation 构建完成并通过原始 SQLite 行校验后原子激活。
- 构建失败继续读取旧 v1，但 API 标记 `time_semantics='legacy_utc_day'`；发布验收前 v2 必须 ready。
- 旧 v1 表暂不删除，至少保留一个 Bridge 发布周期用于回滚。

### 6.3 插入不可变语义

归档写入改为：

1. 每个 kind 一次批量预取本批最多 250 个 ID。
2. 新 ID 执行 INSERT。
3. 已存在且 payload 相同：跳过。
4. 已存在且 payload 不同：跳过并增加 conflict 指标。
5. 仅新 sealed trade 增加 `history_revision` 并增量更新对应 `close_business_date`。

不再为未变化行执行 UPSERT，也不再因为重复扫描刷新 `updated_at_utc_msc`。

### 6.4 统一查询帮助层

Bridge Store 增加单一 trade history query builder，所有消费者复用：

- close-time 范围；
- direction/profit/symbol 筛选；
- close-time keyset cursor；
- rowid/revision snapshot；
- sealed 状态；
- account scope。

禁止各接口自行拼接基于 `event_time_msc` 或 payload JSON 时间的 trade SQL。

## 7. MT4/MT5 源查询优化

### 7.1 取消旧历史验证

- coverage/backfill 范围首次 complete 后，不再生成相同范围的 refresh job。
- `force_refresh` 不得清除 coverage。
- 48 小时周期重扫改为“未封口尾部推进”；查询起点来自最后 sealed 复合游标，而不是固定回看 48 小时。
- expected close ticket 尚未出现时，仅重试当前未封口尾部，采用有界退避和截止时间。

### 7.2 复用 MT5 固定范围缓存

在同一个 fixed range/snapshot 中：

- 首次读取 deals 与 history orders 后缓存归一化结果。
- continuation page 直接读取缓存，不再对每一页重复执行范围型 `history_orders_get()`。
- 只有缺失入场单、保护单或来源成交时，继续使用现有最多 4 次按 ticket/position 的精确补查。
- Archive Worker 重启后缓存丢失是允许的；从持久化游标恢复时只重建当前未完成窗口，不重读已 complete coverage。

### 7.3 保持单并发和批次上限

- `HISTORY_BATCH_LIMIT=250` 保持不变。
- `Semaphore(1)` 保持不变。
- 动态时间窗保持 1 秒至 30 天的有界范围。
- P3 在 P1/实时活动到来时批次边界让路，不采用硬性带宽限速。

## 8. 服务端与前端统一改造

### 8.1 服务端范围解析

`resolveHistoryRange()` 先解析三个彼此独立的边界：

```text
absolute_floor = 2000-01-01 00:00:00（终端服务器业务日期）
query_floor    = MAX(absolute_floor,
                     Bridge 支持下限,
                     已可信确认的终端历史可见下限)
system_start(all)      = query_floor
system_start(platform) = MAX(query_floor,
                             mt5_account_bindings.first_connected_at)
```

删除 `users.created_at` 作为历史起点的临时逻辑。`ownership` 仅保留为隐藏审计兼容范围，不再用于默认交易历史和默认绩效。

其中 `system_start` 只表示该模式的默认起点。为支持用户保存更早或更晚的开始日期，同时不伪装或修改系统事实，API 增加受服务器校验的 `scope_start_override`（终端业务日期）参数：

```text
allowed_start   = query_floor
system_start    = all/platform 的权威默认起点
effective_start = validated_scope_start_override ?? system_start
captured_end    = 当前请求冻结的结束水位
```

- `scope_start_override` 只允许用于 `all/platform`，必须是合法终端业务日期，并满足 `allowed_start <= override_start < captured_end`。
- `platform` 的合法 override 可以早于 `first_connected_at`；这只扩展查询范围，不修改 `first_connected_at`、账号身份、ownership 或初始化默认优先范围。
- 不允许静默 clamp 非法日期。服务端返回稳定错误码和权威 `allowed_range`，前端保留用户输入并给出明确中文原因；旧的非法保存值则丢弃并恢复默认起点。
- custom 继续使用自身的 `close_from/close_to`，不与 override 混用。
- 首次请求、续页、chart、summary 和 export 均由服务器返回并冻结 `allowed_range`、`system_range` 与 `effective_range`。
- cursor token 同时绑定 scope、allowed start、system start、effective start、captured end 和筛选摘要。
- 客户端不得通过直接提交 `range_start_utc_msc` 绕过 `query_floor` 或固定水位；续页精确起点必须等于首次已验证的 effective start。
- 清除保存起点后，下一次首屏恢复 system start，不沿用旧 effective range。
- 当用户请求的平台接入前范围尚未进入 SQLite coverage 时，复用现有有界 exact-range 按需准备链路；该用户主动请求优先于 P3 旧历史后台补齐，但仍不得阻塞实时行情、持仓、挂单和交易命令。

### 8.2 前端默认范围

- HTML 默认选择继续为 `platform`。
- JS 的缺省值、重置、刷新、断线恢复和异常回退全部改为 `platform`。
- 首页和交易记录首次进入只请求平台范围第一页与 summary，不触发 `all`。
- “全部历史”仍可人工选择；范围未完成时显示后台补齐状态，不回退到不完整统计。
- 列表显示字段只使用服务端归一化后的平仓时间。
- 分页/筛选条件变化建立新 close-time snapshot，旧响应不得覆盖当前页面。

统计范围控件调整为始终显示实际开始和结束日期，不再只在 `custom` 时展开：

| 模式 | 系统开始日期 | 结束日期 | 可编辑与保存 |
| --- | --- | --- | --- |
| 全部 | `query_floor` | 本次固定统计水位 | 开始日期可在允许范围内调整并保存；结束日期只显示本次水位 |
| 平台接入后 | 稳定账号 `first_connected_at` 与 `query_floor` 中较晚者 | 本次固定统计水位 | 默认从接入时间开始，但允许向前扩展到 `query_floor` 或向后收窄并保存 |
| 自定义日期 | 用户输入且不早于 `query_floor` | 用户输入或当前固定水位 | 保持现有起止日期编辑能力 |

界面要求：

- 范围下拉框后始终显示“开始日期 ～ 结束日期”。
- `all/platform` 的 allowed/system/effective 值由第一次成功响应回填，加载时显示“正在确认范围”，不得先猜用户注册时间、平台接入时间或终端可见下限。
- 实际 UTC 毫秒边界和终端时区放在日期控件的可访问说明中，不向普通用户展示内部字段名。
- 日期控件使用服务端返回的 `query_floor` 作为 `min`，以当前固定结束水位所在的终端业务日期作为 `max`；底层仍按 `start_of_selected_terminal_day < captured_end` 校验，允许选择有数据的当天，禁止未来日期。
- 固定绝对安全下限为 `2000-01-01`，不使用 2020 或 2025 这类可能截断合法老账户历史的任意业务年份。若 Bridge/终端可信下限更晚，以更晚者为准。
- 前端 `min/max`、点击应用/保存时校验和服务端权威校验三层同时存在；不得仅靠 HTML 日期控件防越界。
- 用户修改 `all/platform` 的开始日期时，只改变查询范围，不修改账号真实首次接入时间、默认初始化范围或历史 coverage 事实。
- 保存值早于 platform system start 时，显示“已扩展至平台接入前：YYYY-MM-DD”；晚于默认起点时显示“已使用保存的开始日期”。“全部”被向后收窄时也必须明确显示实际起点，避免范围名称掩盖截断。
- 提供“恢复系统起点”，恢复后 `platform` 回到 `first_connected_at` 默认边界，`all` 回到 `query_floor`。
- “应用范围”只影响当前页面；“保存开始日期”才持久化，禁止输入时自动保存。
- `all/platform` 的结束日期随每次新首屏固定水位更新，不持久化旧结束日期。

### 8.3 范围偏好的安全持久化

本阶段不新增服务器偏好表，先使用现有前端 localStorage 能力保存非敏感日期偏好，避免为一个页面设置引入数据库和跨设备同步服务。

存储键必须包含：

```text
user_id + platform + normalize(broker_server) + login
```

存储值只允许 schema version、上次选择的范围模式、`all/platform` 各自保存的开始日期、custom 开始日期和更新时间。不得存储 token、终端路径、完整订单或服务器返回的授权信息。

恢复顺序为：

1. 等待当前用户和稳定账号身份确认。
2. 读取对应账号的偏好；账号切换不得复用前一个账号的日期。
3. 等待服务器返回当前 scope 的权威允许下限、系统默认起点和固定结束点。
4. 将保存日期作为 `scope_start_override` 发给服务器，由服务器再次校验并返回 allowed/system/effective range。
5. 只有服务端确认 `override_applied=true` 才显示为已保存范围；不合法则丢弃并提示已恢复系统范围。
6. 手工刷新、页面刷新和断线恢复保持已保存开始日期；退出登录后数据可以保留，但其他 user ID 无法命中该键。

该偏好只影响查询起点，不修改 `mt5_account_bindings.first_connected_at`、coverage、Bridge 同步策略或历史真相。跨浏览器/跨设备同步不在本次范围，避免过度设计。

### 8.4 下方明细筛选

表格工具栏保留现有开仓时间，并新增独立的“平仓时间”起止日期：

- 开仓时间只作为二级条件，不得代替交易历史主范围。
- 平仓时间筛选参数建议使用 `filter_close_from/filter_close_to`，与 scope 的 `close_from/close_to` 分开命名。
- 服务端将平仓业务日期转换为 UTC 半开范围，并与统计范围取交集；超出统计范围时返回空结果或明确校验提示，不扩大统计范围。
- 筛选只影响表格 rows、filtered count 和分页，不影响范围总统计、最近 30 天图表或 Bridge coverage。
- 点击“重置筛选”同时清空开仓时间、平仓时间、方向和盈亏，并清除图表选中态；不重置统计范围和保存的开始日期。
- 平仓筛选变化只失效 table flight/cache；不得清除 chart/summary cache。

### 8.5 最近 30 天图表与柱状图下钻

图表固定展示当前统计范围固定结束点之前最近 30 个终端业务自然日：

```text
chart_range = intersection(statistics_scope_range,
                           [captured_end 对应业务日 - 29 天,
                            captured_end 对应业务日结束))
```

- 若统计范围不足 30 天，只展示交集内可用日期，不向范围外取数。
- 图表标题明确显示“最近 30 天”及实际日期，例如“最近 30 天（07-13 ～ 08-11）”。
- 图表内总交易、胜率、盈亏比和回撤使用同一个 30 天窗口；页面的范围累计统计继续使用完整统计范围，两者文案必须区分。
- daily bar 的日期使用 `close_business_date`。
- 点击柱状图的某一天，只把下方 `filterCloseFrom` 和 `filterCloseTo` 设为该日，页码重置为 1，并只重新加载表格。
- 柱状图点击不得修改 `historyRangeMode`、范围开始/结束日期、范围 summary、chart range 或保存偏好。
- 只有点击 bar dataset 才执行下钻；点击累计收益线、回撤线或空白区域不得改变筛选。
- 当前选中柱需要有边框/标签和文字状态，例如“明细正在显示 08-07 的平仓记录”，不能只靠颜色。
- 再点其他柱切换日期；点击“清除平仓筛选”或工具栏“重置筛选”恢复全部明细。
- canvas 提供键盘等价操作：获得焦点后左右键移动日期，Enter/Space 应用该日平仓筛选，并通过 `aria-live` 宣布结果；尊重 reduced motion，不做布局动画。

图表请求和总体 summary 可以由同一个 SQLite summary v2 快照返回，但响应需明确拆分 `scope_statistics` 与 `chart_30d`，避免前端把 30 天统计误当完整范围统计。

### 8.6 账户绩效与当日统计

`performance_daily` 不再从 MT5 重读历史 deals 作为默认交易统计来源。改为：

- Bridge 从 SQLite `history_daily_summary_v2` 返回平台范围 daily/aggregate。
- 服务端如需持久化运营快照，只缓存 Bridge SQLite 的 summary revision 和结果，不把 MySQL 缓存变成第二真相源。
- 用户可见的“平台接入后”累计数据以稳定账号 `first_connected_at` 为起点，不以 ownership 起点截断。
- ownership 维度统计只用于审计、归属期风控或运营核算，API 名称和 UI 必须明确标记，不能冒充账户完整历史。

### 8.7 消费者清单

以下链路都必须通过统一 close-time 读取模型：

- 交易记录列表、筛选、翻页和导出；
- 首页历史摘要；
- 历史图表与按日统计；
- 手动交易复盘最近七天筛选；
- 信号结果归因和订单号跳转；
- 模型复盘的冻结交易证据；
- 账户绩效展示；
- 管理端涉及已平仓交易的统计。

订单证据查询仍可按订单号和 deal ID 精确读取，但最终交易所属范围和日期由 trade 的平仓时间决定。

## 9. 可观测性

新增聚合指标，不记录完整订单 payload：

- `history_platform_range_prepare_msc`
- `history_platform_range_ready_msc`
- `history_old_backfill_started_after_platform_ready`
- `history_mt_deals_query_count/duration_msc`
- `history_mt_orders_query_count/duration_msc`
- `history_targeted_evidence_lookup_count`
- `history_sqlite_prefetch_msc`
- `history_sqlite_insert_count`
- `history_sqlite_duplicate_count`
- `history_immutable_conflict_count`
- `history_summary_v2_build_msc`
- `history_close_to_visible_msc`
- `history_platform_rows_ready/total_estimate`

状态必须区分：

- 实时数据已就绪；
- 平台范围准备中/已完成；
- 更早历史后台补齐中/已完成；
- 未封口尾部等待来源；
- 本地迁移或 summary v2 不可用。

## 10. 分阶段实施

### 阶段 A：契约与服务器范围修正

涉及：

- `server/bridge-ws.js`
- `server/routes/ai/account-performance.js`
- 对应 server/frontend tests

内容：

1. 平台起点改用 `bindings.first_connected_at`。
2. 账号换绑保持起点不变。
3. `onTerminalReady` 主动准备平台 exact range。
4. 前端默认和回退统一为 platform。
5. API 返回 scope 权威 allowed/system/effective 范围和固定水位，供全部/平台模式显示与偏好校验。
6. 平台接入前的用户主动查询复用有界 exact-range 按需准备，不改变初始化 P1 的默认平台范围。

验收门：同一 broker/login 从用户 A 换绑到用户 B 后，平台默认范围起点逐毫秒一致；合法的平台接入前 override 能建立独立快照并按需补齐，且 `first_connected_at` 不发生变化。

### 阶段 B：平仓时间强类型与 SQLite v2

涉及：

- `bridge/native/workers/mt5/worker.py`
- MT4 EA 历史输出模块
- `bridge/native/crates/bridge-store/src/schema.sql`
- `bridge/native/crates/bridge-store/src/lib.rs`

内容：

1. trade 强制 close-time 字段。
2. 本地 append-only migration 和本地 payload 派生回填。
3. close-time 索引、cursor 和 summary v2。
4. 旧 cursor 版本失效后要求前端重开第一页。

验收门：同一笔交易在列表、日图、统计和复盘中的平仓时间与业务日期完全一致。

### 阶段 C：不可变写入与尾部推进

内容：

1. 新行 INSERT、重复跳过、冲突只告警。
2. complete coverage 不再重扫。
3. 48 小时旧历史验证改为未封口尾部推进。
4. expected ticket 有界重试。

验收门：对已覆盖范围连续刷新 10 次，MT 历史查询次数为 0、SQLite 行和 revision 不变。

### 阶段 D：MT5 与 SQLite 性能优化

内容：

1. continuation page 复用 orders 缓存。
2. 每 kind 批量预取现有 ID。
3. 只插入新行。
4. 增加分阶段耗时指标。

验收门：596520 同数据副本在相同机器上的 active-runtime 全量导入时间较当前上限至少下降 30%，且实时命令 p95 不劣化超过 10%。

### 阶段 E：消费者收敛与真实端验收

内容：

1. 前端、导出、复盘、信号归因、账户绩效全部切换统一帮助层。
2. 全部/平台/自定义模式始终显示实际起止日期，接入账号作用域的保存开始日期偏好。
3. 增加平仓时间筛选，并把图表固定为范围内最近 30 天。
4. 柱状图下钻只改变表格平仓时间筛选，不改变统计范围、summary 或图表缓存。
5. 移除 `performance_daily` 对旧历史的 MT5 重读调用；保留一个版本兼容但不再作为默认路径。
6. 完成 MT4/MT5 真终端、换绑和断线恢复测试。

验收门：代码搜索和运行时指标均不存在 trade 以 `event_time_msc` 或 entry time 进行范围查询的路径。

## 11. 测试方案

### 11.1 确定性单元测试

- trade 缺少 close time 拒绝入库。
- 同毫秒多笔平仓按 close ticket 稳定翻页，无重复、无漏项。
- 开仓跨日、平仓次日，只计入平仓日。
- UTC 日与终端业务日不同，统一计入终端平仓日。
- 入金/信用事件不进入交易笔数。
- 相同 payload 重放不更新 revision。
- 不同 payload 同主键不覆盖，产生 immutable conflict。
- coverage complete 后 force refresh 不产生 source job。
- 未封口尾部 expected ticket 尚未出现时有界重试。
- summary v2 构建失败不激活坏 generation。
- 旧 cursor 在 close-time contract 升级后明确失效。

### 11.2 绑定与权限测试

- 同一账号 A→B 换绑，`first_connected_at` 不变。
- 当前 ownership 起点变化不影响 platform range。
- 新持有人可以读取当前授权账号的连续历史，但旧持有人立即失去读取和交易权限。
- broker 相同/login 不同、login 相同/broker 不同、MT4/MT5 相同登录号都严格隔离。
- 无当前有效绑定时 fail closed。

### 11.3 前端与接口测试

- HTML、JS fallback、重置和刷新默认均为 platform。
- 列表、summary、chart、export 使用相同 frozen range。
- 筛选和翻页只传 close-time cursor。
- 平台范围 pending 时不显示伪零。
- 更早历史 backfill 不阻塞已完成的平台统计。
- 长时间停留、重连、换绑后旧响应不能覆盖新账号页面。
- all/platform/custom 三种模式都显示服务器确认后的实际开始和结束日期。
- all/platform 保存的开始日期按 user + platform + broker + login 隔离，刷新后恢复，账号切换不串值。
- platform 保存日期早于系统默认起点但不早于 `query_floor` 时允许，并明确显示“已扩展至平台接入前”。
- 保存日期早于 `2000-01-01`、早于可信 `query_floor`、晚于结束点、格式非法或 schema 版本不支持时丢弃并恢复系统值。
- all/platform 的 override 不能通过原始 `range_start_utc_msc` 绕过 allowed range；续页必须绑定首次冻结的 allowed/system/effective range。
- all/platform 固定结束点刷新到新水位，但不会覆盖保存的合法开始日期。
- 日期输入 `min/max`、应用、保存、刷新恢复和服务端校验均使用终端业务日期；浏览器本地时区不得导致前后偏移一天。
- 平仓时间筛选与开仓时间筛选可以组合，筛选范围不能扩大统计 scope。
- 图表只返回 scope 内最近 30 个终端业务日。
- 点击 bar 只更新平仓筛选和表格，不修改 range mode、范围日期、summary 或 chart cache。
- 点击线条/空白不筛选；键盘左右键和 Enter/Space 与鼠标点击等价。
- 重置筛选清除图表选中态，但保留统计范围和保存开始日期。

### 11.4 性能测试

使用 596520 的脱敏 SQLite 副本或相同规模生成夹具，不清理真实运行库：

- 25,895 trades / 约 13 万物理行首次导入；
- 平台范围优先完成时间；
- P3 开始时点；
- MT5 deals/orders 调用次数；
- SQLite SELECT/INSERT 数量；
- Core、Archive Worker CPU/内存峰值；
- 行情、持仓和交易命令 p50/p95/p99。

完整 native tests、MT5 Worker tests、Node/Vitest 受影响测试与真实 Windows MT4/MT5 E2E 均为发布前硬门。

## 12. 兼容、迁移与发布

- 服务器先兼容新旧 Bridge：新 Bridge 返回显式 close-time contract；旧 Bridge 只接受明确的 `close_time_msc` 兼容字段。
- Bridge SQLite migration 必须可重复执行、失败可诊断，不删除旧表或真实历史。
- summary v1/v2 双读一个发布周期；新写只进入 v2 激活流程。
- 发布顺序：兼容服务器 → 新 Bridge 灰度 → 前端切换 → 观察 → 扩大发布。
- Bridge 更新必须生成新的不可变 ReleaseId、哈希和签名材料；网站部署与 Bridge 发布分别授权。
- 生产 MySQL 如不新增字段，则本方案不要求数据库迁移。若实施中发现必须新增服务端字段，必须追加 migration，并在执行生产迁移前单独取得授权。

## 13. 回滚

可分别关闭：

- startup platform P1 主动准备；
- platform-before-access 范围 override；
- immutable insert-only；
- summary v2 读取；
- continuation orders cache；
- SQLite batch prefetch。

回滚原则：

- 不删除 SQLite 新列、v2 summary 或已归档历史。
- 不恢复旧用户注册时间作为 platform 起点。
- 不恢复 ownership 起点作为默认历史起点。
- 若临时关闭 platform-before-access override，保留用户本地偏好但不应用，并明确显示“当前版本暂不支持扩展到平台接入前”；不得删除或改写 `first_connected_at`。
- 如果 immutable 写入出现漏单，只暂停新封口并恢复未封口尾部采集；不得直接清库重同步。
- 如果 summary v2 失败，显示不可用或临时读取 v1 并明确标记旧时间语义，不能返回伪零。

## 14. 不实施的过度设计

本方案明确不做：

- 新建远程历史数据库替代 SQLite；
- 给每个前端页面建立独立历史缓存；
- 多 Archive Worker 并行读取同一 MT5；
- 提高 WebSocket 最大包体或一次返回全部历史；
- 提高 250 批次上限；
- 为了性能硬性限速；
- 自动清库或在启动时重建全部历史；
- 为平台首次接入时间再建立一套重复服务端表；
- 对已封存历史做哈希巡检、定期抽样或后台验证。

## 15. 第一轮复审：需求覆盖、最小改动与过度设计

### 15.1 检查结论

初稿覆盖了历史不可变、平仓时间统一、平台范围优先和换绑不重置四项核心要求；加入前端范围展示、保存、平台接入前查询和图表下钻需求后，共发现七个需要调整的问题：

1. 若把所有数据都强制解释为平仓时间，入金、出金和信用事件会失真。
2. 若在 Bridge 新增一套“平台首次接入元数据表”，会与已有 `mt5_account_bindings.first_connected_at` 形成双真相源。
3. 若完全取消最新尾部的短暂重试，刚平仓但 MT 尚未返回的记录可能永久漏掉。
4. 若把用户保存的开始日期直接写回 `first_connected_at`，会破坏稳定账号接入事实。
5. 若点击图表继续复用 custom scope，会让一次下钻永久改变范围统计和同步请求。
6. 若为日期偏好立即新增服务器表和跨设备同步，会扩大迁移、权限和并发范围，超过本次需求。
7. 若仍用 `max(system_start, override)` 校验保存日期，用户即使输入平台接入前日期也会被静默抬回 `first_connected_at`，与补充需求冲突。

### 15.2 已做调整

- 将 trade 与 capital event 分开：交易只按平仓时间，资金事件按自身事件时间且不进入交易统计。
- 平台首次接入时间只由现有服务器 binding 表权威提供；Bridge 通过现有 exact-range 请求和 coverage 持久化，不新增重复业务表。
- 引入“未封口尾部/已封存覆盖”边界，只重试新尾部，不验证旧历史。
- 复用现有 P1/P2/P3、coverage、cursor、summary generation 和 `history_page` 准备链路，不新增调度服务。
- 保留单 Worker、250 批次和单 MT 历史并发，避免性能优化演变为实时链路风险。
- 将保存开始日期定义为按用户与稳定账号隔离的前端查询偏好，不修改服务端首次接入事实；首期使用 localStorage，避免新增偏好表。
- 将模式默认起点与查询允许下限拆开：`platform` 默认仍是 `first_connected_at`，合法 override 可向前扩展到 `query_floor`；增加 `2000-01-01` 绝对安全下限，避免无意义年份而不截断 2020 年前的真实历史。
- 将前端状态拆成 statistics scope、table close filter、chart 30-day window；柱状图下钻只触发表格读取。
- all/platform 的结束点始终由服务器新快照刷新，不保存陈旧结束日期。

第一轮结论：调整后符合需求，且没有为“不可变历史”增加远程存储、额外服务或重复服务端真相源；设计规模与现有 Bridge 架构匹配。

## 16. 第二轮复审：兼容、数据、并发、恢复、时间与连带 Bug

### 16.1 兼容与迁移

- 不能原地修改已发布 SQLite schema 或 summary 主键，采用 append-only runtime migration 和 summary v2。
- 旧 cursor 必须版本隔离；不能让旧 `event_time_msc` cursor 继续读取新 close-time 排序。
- 旧 Bridge 兼容仅允许明确 `close_time_msc`，禁止从通用 `time` 猜测。
- 不要求当前方案直接执行生产 MySQL 迁移。
- 日期偏好带 schema version 且严格校验；前端升级可以安全丢弃旧偏好，不影响历史数据。
- 现有 cursor 校验要求 all/platform 使用固定系统起点；实施时必须升级为“固定的已验证 effective 起点”，并在 token 中同时保留 allowed start、system start，禁止只放宽客户端起点判断。

### 16.2 并发与幂等

- P1 到达时允许当前单个有界 P3 批次完成，随后必须抢占；避免中断 MT5 调用导致未知状态。
- coverage subtraction、批量预取和 INSERT 必须在同一 SQLite 事务内判断与提交。
- 相同新平仓的命令唤醒、持仓消失和周期检查必须合并为同一尾部 flight。
- immutable conflict 不得推进 revision 或覆盖 summary。
- scope override 的首次解析与 cursor 创建必须是同一请求快照；保存偏好变化只能创建新首屏，不能修改正在翻页的 snapshot。
- 同一个 scope 的 platform-before-access override 与默认 platform 请求不得复用错误的首屏缓存键；cache key 必须包含 effective start 和账号稳定身份。

### 16.3 异常恢复

- 未完成窗口按持久化游标恢复；已 complete coverage 不恢复 source 查询。
- Archive Worker 崩溃只重建当前窗口缓存，不回退到全范围。
- 服务器无法提供 first_connected 时，platform 状态保持 unavailable；Bridge 最近窗口可继续本地采集，但不得声明平台范围 ready。
- summary v2 构建失败保留旧 active generation。

### 16.4 时间语义

- UTC 只负责内部顺序和半开范围；终端服务器自然日负责“当日”。
- 平仓时差必须随记录冻结，不能用今天的时差重新解释历史日期。
- MT4 历史可见范围不足时不能把最早可见时间误当平台首次接入时间。
- platform start 是账号首次接入系统的时间，不是用户注册、ownership、终端实例或 Profile 创建时间。
- `first_connected_at` 只定义 platform 默认起点；用户向前扩展使用终端业务日期并受 `query_floor` 约束，不得反写或重解释该事实时间。
- scope、表格平仓筛选和图表窗口都使用同一 frozen terminal-day/UTC 映射，但三者状态相互独立。
- 最近 30 天以 scope 固定结束点为准，不随浏览器本地午夜或点击柱状图重新计算。

### 16.5 安全与权限

- 稳定账号历史连续不代表跨用户公开；每次请求仍校验当前 binding、用户权限和唯一终端路由。
- 换绑时旧用户的订阅、自动推理和交易发送继续立即停用。
- 日志只记录计数、耗时、范围和稳定错误码，不记录完整订单、凭据或用户敏感信息。

### 16.6 可能的连带 Bug 与防护

| 风险 | 防护 |
| --- | --- |
| 部分平仓被当成整个 position 唯一记录 | 以 close deal ticket 为 trade item ID，允许同一 position 多条退出 trade |
| 旧 summary 与新列表日期不一致 | v2 未 ready 时明确标记，不静默混用 |
| 换绑后旧浏览器响应覆盖新账号 | snapshot 绑定账号稳定身份、用户授权 revision 和 close-time range |
| 平仓发生在时差变化附近被分错日 | 冻结 close server time、UTC 和 offset，不用当前 offset 回算 |
| conflict 被忽略造成无提示错误 | 指标、告警和诊断页展示；不自动覆盖但可人工审计 |
| 取消 48 小时重扫后券商事后修订不可见 | 作为明确产品取舍写入验收和发布说明，不以隐藏扫描恢复 |
| P3 抢在平台范围前运行 | terminal ready 立即规划 P1；批次边界抢占；指标验证 P3 顺序 |
| MySQL account performance 继续重读 MT | 默认用户统计切到 SQLite summary v2，旧 action 仅兼容且受指标监控 |
| 保存日期在用户或账号之间串用 | localStorage key 绑定 user + platform + broker + login，身份确认后才读取 |
| 保存起点早于平台接入 | 允许；标记为“已扩展至平台接入前”，按需准备缺失 coverage，但不修改首次接入事实 |
| 保存起点早于 2000-01-01 或可信 Bridge/终端下限 | 服务端按 `query_floor` 拒绝，前端丢弃旧保存值并恢复系统默认 |
| 用户选择极早日期造成大范围同步 | 仍使用 250 条有界批次、单历史并发和实时优先调度；首屏显示准备进度，不一次返回或一次同步全量历史 |
| 图表点击污染总体范围 | table filter 使用独立字段与独立 cache key，禁止写 range controls |
| 最近 30 天与范围累计指标混淆 | UI 和响应分别命名 `chart_30d`、`scope_statistics` 并标明日期 |

第二轮在加入前端保存起点后曾发现一个实质兼容问题：现有 all/platform continuation 校验要求请求起点严格等于系统起点，若只保存前端日期会导致新首屏或续页被判为非法。补充“允许平台接入前查询”后又重新核对该问题，确认不能使用 `max(system_start, override)`，否则需求会在服务端被抵消。最终方案改为服务端分别校验 `allowed_start`、`system_start` 和 `effective_start`，响应和 cursor 同时冻结 allowed/system/effective range；随后重新检查了绝对年份下限、终端业务日、平台前按需补齐、旧 cursor、账号切换、并发翻页、缓存隔离和清除偏好的路径，未再发现需要扩大架构的缺口。

第二轮结论：方案在兼容迁移、幂等并发、异常恢复、时间语义、账户换绑、安全、测试与回滚方面闭环，可以实施。不能由静态方案消除的剩余风险有三类：真实 MT4/MT5 对最新平仓的可见延迟、业务明确接受的券商事后修订不再自动回查，以及用户首次选择极早日期时需要等待有界历史补齐。三者必须在灰度发布说明和真实终端验收中明确记录；第三类只能通过进度反馈和实时优先调度缓解，不得用一次性全量响应或硬性提高并发解决。

## 17. 最终验收清单

- [ ] platform 默认范围严格使用稳定 binding 的 `first_connected_at`。
- [ ] 用户换绑前后 platform start 完全不变。
- [ ] platform 保存起点可以早于 `first_connected_at`，且只改变查询范围、不改变首次接入事实与初始化默认范围。
- [ ] 所有日期输入不得早于 `max(2000-01-01, Bridge/终端可信下限)`，不得晚于当前固定结束水位，并由服务端权威校验。
- [ ] 平台接入前的大范围查询保持 250 条有界批次、单历史并发、实时优先和可见准备进度。
- [ ] 平台范围 P1 在旧历史 P3 前完成或于单批次边界抢占。
- [ ] 已 complete 范围刷新不产生 MT 历史查询。
- [ ] trade 所有筛选、排序、游标、展示和聚合只使用 close time。
- [ ] 每日交易统计按 close business date。
- [ ] capital event 与 trade 统计分离。
- [ ] SQLite 重放不更新旧行和 revision。
- [ ] continuation page 不重复批量查询 history orders。
- [ ] 596520 规模基准 active-runtime 至少改善 30%。
- [ ] 行情、持仓、挂单和交易命令 p95 不劣化超过 10%。
- [ ] 全部、平台接入后和自定义模式始终显示权威实际起止日期。
- [ ] 保存开始日期刷新后恢复，且按用户和稳定账号隔离。
- [ ] 下方平仓时间筛选只收窄表格，不改变统计范围和图表。
- [ ] 图表固定显示 scope 内最近 30 个终端业务日。
- [ ] 点击柱状图只设置该日平仓筛选；范围、summary、图表和保存偏好均不变。
- [ ] 图表柱状下钻支持键盘并有非颜色文字反馈。
- [ ] MT4 可见范围不足、时钟不可信和 first_connected 缺失时均失败关闭。
- [ ] 完整测试、真实 Windows MT4/MT5、换绑、重连与回滚验收通过。
