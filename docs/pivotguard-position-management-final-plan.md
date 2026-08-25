# PivotGuard 自动盯盘接入 AI 持仓管理最终方案

## 1. 目标与范围

将 `PivotGuard_EA.mq5` 中基于日内 Pivot 的确定性持仓管理规则抽取为 AURUM 服务端能力，接入现有“AI交易员 → AI持仓管理”页面和持仓管理任务、命令、事件、Bridge、MT5 对账链路。

本期明确要求：

- 不接入 AI 参数调整，不调用模型生成或修改参数。
- 删除“单笔最大亏损保护”和“盈利回撤保护”及其全部状态。
- 按用户的具体交易账号独立启用，用户可自行开启或关闭，默认关闭。
- 普通用户只能使用开关，不能查看或修改具体 PivotGuard 参数。
- 管理员可以查看并修改按标准品种维护的统一参数。
- 顶部状态栏在“自动分析”之后增加“自动盯盘”开关。
- AI 持仓管理设置区增加用户启用状态；管理员额外看到参数管理区。
- 只管理归属完整的 AURUM 系统持仓，不处理人工持仓、其他系统持仓和归属不明持仓。

## 2. 明确不做

- 不把 MQ5 文件作为生产运行入口，不要求用户安装或挂载新的 MT5 EA。
- 不迁移缺失的 `PivotGuard_Review.mqh`、昨日复盘、飞书推送、指定日期预览、画线和图表面板。
- 不保留最大亏损金额、最高浮盈或盈利回撤百分比。
- 不允许用户配置 Magic、轮询间隔、重试冷却、颜色或图表显示。
- 不处理人工订单、未归因订单、Magic 不匹配订单或其他策略系统之外的订单。
- 不实现 AI 调参、按行情自动切换参数或策略提示词。
- 不实现自动反手或新增风险。

## 3. 现有能力与接入原则

当前项目已经具备：

- AI 持仓管理页面、个人运行设置和管理员全局控制。
- `ai_position_management_tasks`、`ai_position_management_commands`、`ai_position_management_events`。
- 按用户、交易账号、归属历史、Bridge 代际、原始品种、ticket、方向、Magic、手数进行执行前校验。
- Bridge/MT5 Worker 的完整平仓、指定手数部分平仓和修改持仓 SL/TP 能力。
- 稳定 `operation_id`、命令发送前持久化、未知结果对账和恢复流程。
- Bridge V3 已将账户和持仓增量投影到 `bridge_v3_account_latest`、`bridge_v3_positions_latest`，无变化时不重复发送完整持仓。
- 已收盘 K 线已有 Redis 热缓存和 MySQL `market_candles` 持久缓存。
- 现有 Redis 单例已经提供 JSON TTL 缓存，并已有 `SET NX PX` 加令牌校验释放的分布式锁模式。

PivotGuard 只负责确定性计算和产生候选动作，不直接调用 Bridge。真实动作必须复用并扩展现有持仓管理命令状态机，禁止建立第二套交易发送器。

Redis 只作为减少重复读取和 Bridge 请求的加速层，不作为交易事实来源。缓存缺失、身份不匹配、数据陈旧或 Redis 不可用时必须回到权威数据源；权威数据也不可用时失败关闭，不得用旧缓存执行交易。

## 4. 管理范围

一个持仓只有同时满足以下条件才进入 PivotGuard：

1. 当前用户对 `trading_account_id` 的归属历史仍有效。
2. 用户已为该具体交易账号开启自动盯盘。
3. 平台 PivotGuard 总闸已开启，且对应标准品种存在有效参数版本。
4. `signal_outcomes.status = open`，归因状态完整且没有外部干预。
5. `position_id`、原始 broker symbol、方向、预期手数和系统 Magic 均可确定。
6. MT5 实时持仓与数据库归因在 ticket、symbol、方向、Magic、手数上完全一致。
7. Bridge 在线、账号身份一致、当前报价和 D1 数据新鲜。

任一条件不满足时只记录跳过原因，不创建交易命令。仅按 Magic 或标准品种匹配不构成管理授权。

用户开启账号盯盘时，确认窗口应显示当前符合条件的系统持仓数量。用户确认后，已有的合格系统持仓也会绑定当时有效的参数版本并开始管理。

## 5. 保留与删除的入口参数

### 5.1 管理员可配置参数

参数按 `standard_symbol` 建立版本化配置。首版没有有效品种配置时，用户不能开启该账号的自动盯盘。

| 规则 | 配置字段 | EA 默认值 | 说明 |
| --- | --- | ---: | --- |
| Pivot | `pivot_method` | `fibonacci` | `fibonacci` 或 `standard` |
| 突破止损 | `break_stop.enabled` | `true` | 是否启用 |
| 突破止损 | `break_stop.distance_price` | `9.0` | 反向突破关键位的价格距离 |
| 突破止损 | `break_stop.open_near_price` | `10.0` | 开仓价贴近关键位的最大距离 |
| P 点穿越止损 | `pivot_cross_stop.enabled` | `true` | 是否启用 |
| P 点穿越止损 | `pivot_cross_stop.distance_price` | `8.0` | 穿越 P 点的价格距离 |
| P 点穿越止损 | `pivot_cross_stop.min_duration_seconds` | `3` | 越线持续时间，`0` 表示立即确认 |
| 回踩止损 | `retrace_stop.enabled` | `true` | 是否启用 |
| 回踩止损 | `retrace_stop.distance_price` | `5.0` | 关键位回踩破位距离 |
| P 点止盈 | `pivot_take_profit.enabled` | `true` | 是否启用 |
| P 点止盈 | `pivot_take_profit.tolerance_price` | `3.0` | 到达 P 点的价格容差 |
| P 点止盈 | `pivot_take_profit.close_percent` | `50` | `100` 表示全平，其余表示部分平仓比例 |
| P 点止盈 | `pivot_take_profit.move_break_even` | `true` | 部分平仓后是否移保本 |
| 第一目标位 | `first_target_take_profit.enabled` | `true` | 是否启用 |
| 第一目标位 | `first_target_take_profit.tolerance_price` | `3.0` | 到达第一目标位的价格容差 |
| 第一目标位 | `first_target_take_profit.close_percent` | `50` | `100` 表示全平，其余表示部分平仓比例 |
| 第一目标位 | `first_target_take_profit.move_break_even` | `true` | 部分平仓后是否移保本 |
| 第一目标位 | `first_target_take_profit.break_even_offset_price` | `2.0` | 保本后锁定的价格距离 |

管理员界面不再保留“部分平仓/全平”两个重叠字段，统一用 `close_percent` 表达；选择 `100%` 时自动隐藏移保本设置。

### 5.2 固定为系统规则，不提供入口

- `InpTargetMagic`：删除。系统使用 `signal_outcomes + trading_account_id + ownership_history_id + ticket + system Magic` 精确归属。
- `InpCheckIntervalMs`：删除。由服务端监控 Worker 固定控制，不属于交易参数。
- `InpRetryCooldownSec`：删除。由持久化命令、幂等操作号、租约和结果对账替代。
- `InpPivotStopSameSideOnly`：固定为 `true`，防止 P 点规则作用于异侧盈利仓位。
- P 点止盈后的保本偏移：沿用经纪商允许的最小安全距离，不增加新的管理员参数。
- 手数归一化、tick size、最小手数、手数步长、stops level、freeze level：全部读取 MT5 合约规格。

### 5.3 删除

- `InpEnableMaxLoss`
- `InpMaxLossMoney`
- `InpEnableDrawdown`
- `InpDrawdownPercent`
- `maxProfit`、佣金驱动的最高浮盈状态和对应持久化逻辑
- 所有颜色、画线和图表面板参数

## 6. 参数配置与版本语义

参数必须采用不可变版本：

- 管理员修改时创建新版本，不覆盖旧版本正文。
- 保存时要求填写简短修改原因，记录操作者、旧版本、新版本和配置哈希。
- 新版本默认只绑定修改后新纳入监控的持仓。
- 已经绑定的活跃持仓继续使用原版本，首版不提供“批量套用到已有持仓”，避免追溯改变退出条件。
- 管理员可以停用某个品种配置；停用后不再接纳新持仓，已绑定持仓继续按原版本管理，除非平台总闸关闭。
- 配置中的价格距离必须为有限正数；百分比为 `1..100`；持续秒数为 `0..60`。
- 运行时按目标品种 tick size 规范化价格；无法规范化或合约规格缺失时失败关闭。

初期建议只为已验证的 `XAUUSD` 标准品种建立配置。其他品种没有配置时不得自动复用黄金参数。

## 7. 确定性计算引擎

新增纯函数模块，输入完整快照，输出零个或一个候选动作：

```text
输入：参数版本、前一根已收盘 D1、当前 D1 开盘时间、实时持仓、Bid/Ask、合约规格、持仓阶段状态
输出：observe | full_exit | partial_exit | move_protection
```

计算保持 EA 的核心语义：

1. 使用交易账号对应终端服务器时间判断 D1 换日。
2. 使用前一根完整 D1 的 H/L/C 计算 P、R1-R3、S1-S3。
3. D1 新 K 线尚未完成同步时不切换 Pivot，继续等待并记录状态。
4. 按当前交易日 Pivot 管理跨日持仓，与 EA v1.34 的每日刷新行为一致。
5. 第一目标位从盈利方向的七档 Pivot 中选择距离开仓价最近的一档。

动作优先级：

```text
P 点穿越止损
→ 关键位回踩止损
→ 突破止损
→ P 点止盈
→ 第一目标位止盈
→ 无动作
```

同一 ticket 一个评估周期最多产生一个副作用。命令完成并对账后重新读取持仓，再评估下一阶段，禁止同一快照连续发送两次部分平仓或平仓后立即改单。

移保本必须满足单调保护：

- 多单的新 SL 必须高于现有有效 SL。
- 空单的新 SL 必须低于现有有效 SL。
- 任何情况下不得删除或放宽用户已经设置得更有利的保护价。
- 报价、最小止损距离或冻结区不允许时进入等待重试，不得先标记为完成。

## 8. 数据模型

在 `server/migrations.js` 追加迁移，不修改既有迁移正文。

### 8.1 用户账号开关

新增 `user_position_guard_settings`：

| 字段 | 说明 |
| --- | --- |
| `user_id`、`trading_account_id` | 联合唯一键 |
| `enabled` | `TINYINT NOT NULL DEFAULT 0` |
| `enabled_at`、`disabled_at` | 用户动作时间 |
| `updated_at` | 最后更新时间 |

账号切换、重新绑定或被其他用户接管时，不继承旧账号开关。新的 `trading_account_id` 默认关闭。旧设置保留审计，但不再有管理资格。

### 8.2 管理员参数版本

新增：

- `position_guard_profiles`：标准品种、当前有效版本、状态。
- `position_guard_profile_versions`：版本号、`config_json`、配置哈希、修改原因、操作者和创建时间。

### 8.3 每笔持仓状态

新增 `position_guard_position_states`，以 `outcome_id` 唯一绑定：

- 用户、交易账号、归属历史、ticket、原始/标准品种。
- 参数版本 ID 和配置哈希。
- 当前 Pivot 交易日、P/R/S 计算快照和 D1 来源时间。
- `pivot_tp_done`、`first_target_done`、`break_even_done`。
- `pivot_cross_since_utc_ms`。
- `pending_task_id`、`state_version`、最近评估和完成时间。

阶段标记只能在 Bridge 结果完成对账后写入。进程重启必须从数据库恢复，不能依赖内存。

### 8.4 复用持仓管理账本

扩展现有任务/命令，而不是新增第二套执行表：

- 任务增加 `decision_source = pivot_guard`、`position_guard_state_id`、`trigger_code` 和确定性计算证据。
- 候选动作支持 `full_exit`、`partial_exit`、`move_protection`。
- 命令类型支持完整平仓、指定手数部分平仓和修改保护价。
- `operation_id` 由状态 ID、规则阶段、参数版本和动作序号稳定生成。
- 未知结果只能进入对账，禁止自动重发。

## 9. 服务与 Worker

新增：

```text
server/routes/ai/position-guard-engine.js
server/routes/ai/position-guard-policy.js
server/routes/ai/position-guard.js
server/workers/position-guard-monitor-worker.js
```

### 9.1 分层运行间隔

不采用“所有用户、所有数据每 5 秒全量拉取”。首版按状态分层调度：

| 状态 | 调度间隔 | 行为 |
| --- | ---: | --- |
| 已启用且存在合格持仓 | 5 秒 | 评估活跃 ticket，共享同账号同品种报价 |
| 已启用但没有合格持仓 | 30～60 秒 | 只复查资格；持仓增量、账号变化可立即唤醒 |
| 休市、Bridge 离线 | 60 秒 | 不请求高频报价，等待恢复事件或下一轮 |
| D1 换日尚未确认 | 60 秒 | 每账号行情源、品种合并一次 D1 同步 |
| 合约规格 | 5～10 分钟 | 账号、终端或 `connection_epoch` 变化时立即失效 |
| 用户开关、管理员参数 | 修改时主动失效 | 兜底 30～60 秒刷新 |

5 秒是活跃持仓的折中值，不提供给用户或管理员修改。该服务端模式不承诺复现 EA 的 300ms 本地响应；硬性灾难止损仍应依赖 MT5 已设置的 broker-side SL。本期不把策略逻辑放入 Bridge 或 MT5 本地常驻 Worker。

现有持仓管理执行 Worker 默认周期较长。PivotGuard 创建候选任务后必须主动唤醒执行 Worker，不能再被动等待完整扫描周期；执行 Worker 仍需重读权威状态并完成发送前校验。

### 9.2 数据来源与缓存使用

| 数据 | 权威来源 | 缓存与读取策略 |
| --- | --- | --- |
| 账户、持仓 | Bridge V3 增量投影 | 每轮读 MySQL 最新投影和 freshness，不再向 Bridge 全量拉持仓 |
| 实时报价 | 账号对应 Bridge/MT5 | 使用 Redis 5 秒共享缓存；真正执行前绕过缓存复核 |
| 前一根已收盘 D1 | Bridge/MT5 行情源 | 复用 Redis 24 小时热缓存和 MySQL `market_candles`；仅首次绑定、换日或缺口恢复时请求 Bridge |
| 当日 Pivot | D1 + 参数版本纯计算 | 写入持仓状态用于审计，可附加 Redis 派生缓存至下次换日 |
| 合约规格 | Bridge/MT5 | 复用 Bridge 本地缓存，服务端按终端代际和品种短缓存 |
| 用户开关、参数版本 | MySQL | 修改时主动失效；不可变参数版本继续绑定活跃持仓 |

普通 5 秒评估不得每轮调用 `platformRates`。D1 和 Pivot 按“行情来源身份 + 终端交易日 + broker symbol + 参数版本”共享；同一来源、品种和交易日只做一次计算。

### 9.3 Redis 报价共享缓存

新增后台专用报价缓存服务，不直接复用依赖浏览器订阅生命周期的 `observerQuoteFeeds`。缓存键必须绑定完整路由身份：

```text
position_guard:quote:v1:{terminal_instance_id}:{connection_epoch}:{trading_account_id}:{broker_symbol}
position_guard:quote_lock:v1:{terminal_instance_id}:{connection_epoch}:{trading_account_id}:{broker_symbol}
```

报价缓存 TTL 为 5 秒，后台 Bridge 报价请求超时固定为 3 秒，锁 TTL 为 5 秒且必须覆盖请求超时。同一 Node 进程先用内存 `inFlight` 合并并发请求，多实例之间再用 Redis `SET NX PX` 合并。锁释放必须校验随机令牌，禁止直接删除他人持有的锁。

缓存正文至少保存 `bid`、`ask`、`observed_at_utc_msc`、终端 ID、`connection_epoch`、交易账号 ID、broker symbol、`clock_status` 和 `symbol_trade_mode`。命中缓存时仍须验证：

- 路由身份和终端代际完全一致。
- Bid/Ask 为有限正数且价差合法。
- 行情源时间不晚于允许的新鲜度上限。
- 终端时钟可信，品种允许交易。

Redis miss 时，抢到锁的实例向 Bridge 请求并回填；未抢到锁的实例只做短暂有界等待后重读缓存。若缓存仍未出现且锁仍存在，则跳过本轮，不能并发直拉；若锁已消失，可再尝试抢锁一次。Redis 不可用时退回进程内 singleflight 和直接 Bridge 请求；Bridge 也不可用时本轮只记录 `quote_unavailable`，不得使用最后价格触发。

Redis 不持久化为交易证据。候选动作触发后必须绕过普通报价缓存，重新读取实时 Bridge 报价和精确 ticket；任务证据只保存本次评估实际使用的快照及其时间。首版不新增高频 MySQL 报价表，避免把网络压力转换成数据库写放大。

需要记录 `quote_cache_hit`、`quote_cache_miss`、`quote_bridge_fetch`、`quote_coalesced_wait`、`quote_stale_rejected`、Redis 错误率和按账号品种的请求频率，用于确认缓存确实降低带宽。

### 9.4 每轮处理流程

每轮流程：

1. 读取启用账号及有效归属。
2. 查询仍为 `open` 且归因完整的系统持仓结果。
3. 从 Bridge V3 数据库投影读取账号和持仓，只为活跃账号品种获取 Redis 共享报价。
4. 复用持仓状态中的当日 Pivot；仅在首次绑定、D1 换日或缓存缺口时获取并校验 D1。
5. 对每个精确 ticket 调用纯计算引擎。
6. 无动作时只更新评估时间；有动作时持久化任务和稳定命令。
7. 主动唤醒现有执行 Worker；其获取租约、绕过报价缓存重读真实状态、发送 Bridge 命令并对账。
8. 对账完成后更新 PivotGuard 阶段状态并广播前端事件。

自动分析开关与自动盯盘开关相互独立：

- 自动分析关闭后，已经存在的合格系统持仓仍可继续盯盘。
- 自动盯盘关闭后，不再创建新动作；已经发出的命令继续对账，不能伪装成已撤销。
- Bridge 离线、账号归属变化、平台总闸关闭或参数版本不可用时暂停盯盘并显示具体原因。

## 10. API 与权限

普通用户：

- `GET /api/ai/position-guard/settings?trading_account_id=...`
- `PUT /api/ai/position-guard/settings`
- 请求体只允许 `trading_account_id` 和 `enabled`。
- 后端必须确认账号属于当前用户；普通用户响应不返回完整参数 JSON。

管理员：

- `GET /api/ai/admin/position-guard/profiles`
- `GET /api/ai/admin/position-guard/profiles/:standardSymbol`
- `PUT /api/ai/admin/position-guard/profiles/:standardSymbol`
- `PUT /api/ai/admin/position-guard/control`
- 参数修改、启停和总闸变化全部写入审计日志。

所有路由保持 `/api` 与 `/aurum-api` 兼容，不向普通用户暴露内部错误码、其他用户设置或账号身份。

## 11. 前端方案

### 11.1 顶部状态栏

在现有 `autoAnalyzeMode` 之后、`tradeMode` 之前增加 `positionGuardMode`：

```text
交易平台状态 → 自动分析 → 自动盯盘 → 交易状态
```

状态文案：

- `自动盯盘 关闭`
- `自动盯盘 运行中`
- `自动盯盘 已暂停`：Bridge 离线、平台总闸关闭或账号状态异常。
- `自动盯盘 不可用`：无有效交易账号、无品种配置或无权限。

点击开关时使用当前有效交易账号。开启确认必须说明：

- 功能可能自动全平、部分平仓或修改止损。
- 只处理可精确归属的 AURUM 系统仓。
- 显示当前符合条件的持仓数量和账号。
- 自动分析开关与该功能相互独立。

关闭时说明不再产生新动作，但已经发送的命令仍会完成对账。

### 11.2 AI 持仓管理设置区

在现有“自动平仓”设置之后增加“PivotGuard 自动盯盘”设置行：

- 当前交易账号。
- 开启/关闭开关。
- 当前状态和最后一次检查时间。
- 暂停或不可用的自然中文原因。
- 普通用户只显示“参数由平台管理员统一维护”，不显示数值、技术 JSON 或修改入口。

管理员在同一页面额外看到“PivotGuard 参数”区域：

- 标准品种选择。
- 当前版本、状态和最后修改信息。
- 按“Pivot / 止损规则 / 止盈规则”分组的参数表单。
- `close_percent = 100` 时隐藏对应移保本字段。
- 保存前展示参数差异和修改原因输入。
- 保存后创建新版本，并明确提示“只影响之后新纳入监控的持仓”。

界面沿用现有深色工作台、标准表单、状态摘要和渐进披露，不增加新的全屏页面或多层卡片。

## 12. 异常与恢复

- D1 尚未同步：不更新 Pivot，不执行依赖 Pivot 的动作，后续继续检查。
- 报价或持仓陈旧：暂停该 ticket，不使用最后价格猜测触发。
- Redis 不可用：退回进程内合并和实时 Bridge；不得因为缓存故障使用过期报价。
- Redis 锁等待超时：锁仍存在时跳过本轮；锁已消失时最多重抢一次，不能无限等待、并发直拉或绕过账号路由校验。
- Bridge 断线：暂停并显示离线；恢复后先重新读取全部前置条件。
- 账号切换或接管：旧账号立即失去管理资格，新账号默认关闭。
- 管理员停用配置：不接纳新持仓；已绑定持仓继续使用原版本。
- 用户关闭：停止新动作；保留状态和审计，不删除历史。
- 部分平仓：只有确认剩余手数符合预期才标记阶段完成。
- 修改保护：只有确认 MT5 当前 SL/TP 等于预期才标记完成。
- 结果未知：进入 `reconciling/manual_review`，不得重复平仓或改单。

## 13. 验证方案

### 13.1 纯计算测试

- Fibonacci 与 Standard Pivot 金值测试。
- 多空各规则边界、等于阈值、报价方向和容差。
- P 点同侧过滤固定生效。
- 七档第一目标位选择。
- D1 换日、前一根 D1 未就绪和跨日持仓。
- 同一快照最多一个动作。
- `close_percent = 100` 全平和部分手数步长归一化。
- 移保本永不放宽已有 SL。
- 明确验证最大亏损和盈利回撤逻辑不存在。

### 13.2 权限与隔离测试

- 默认无设置行时为关闭。
- 用户只能更新本人账号，不能修改参数或其他用户设置。
- 管理员可以版本化修改参数，普通用户响应不包含配置正文。
- 一个用户开启不影响其他用户。
- 账号接管、切换和解绑后不继承开关。
- 人工仓、Magic 不匹配、归因不完整和外部干预仓不会产生任务。

### 13.3 执行与恢复测试

- 完整平仓、部分平仓、修改 SL 的准备、发送、完成、部分完成和未知结果。
- 稳定 `operation_id` 与重复 Worker 竞争。
- Bridge 重连代际变化、进程重启和租约过期恢复。
- 套期保值按精确 ticket；净持仓要求同品种唯一且归属完整。
- 用户关闭时已发送命令继续对账但不产生后续新动作。
- 候选动作创建后立即唤醒执行 Worker，不额外等待默认扫描周期。

### 13.4 缓存与带宽测试

- Redis 命中、miss、TTL 过期、错误 JSON、连接中断和恢复。
- 同进程 `inFlight` 与多实例 `SET NX PX` 均只产生一次 Bridge 报价请求。
- 锁持有者异常退出后按 TTL 恢复；令牌不匹配时不能释放他人锁。
- Bridge 报价请求超时小于锁 TTL，慢请求期间不会因锁提前过期产生第二次请求。
- 终端、账号、`connection_epoch` 或 broker symbol 不一致时拒绝缓存。
- 报价超过新鲜度时即使 Redis key 未过期也拒绝使用。
- Redis 和 Bridge 同时不可用时不产生交易任务。
- 一个账号同品种多笔持仓只请求一次报价，不同账号不得共享报价。
- 普通 5 秒评估不重复请求 D1；换日时同来源品种只请求一次。
- 真正执行前绕过普通缓存，实时价格和精确持仓复核仍然生效。
- 以启用账号数、活跃账号品种数和持仓数分档压测，验证 Bridge 请求量约随“活跃账号品种”增长，而不是随持仓笔数增长。

### 13.5 前端测试

- 顶部开关位于自动分析之后，状态与当前账号一致。
- 开启真实动作前有明确确认和账号/持仓范围。
- AI 持仓管理普通用户只看到账号开关。
- 管理员看到参数表单、版本、差异和修改原因。
- 键盘、焦点、加载、错误、禁用和窄屏状态完整。

### 13.6 回归

- `node --check` 覆盖修改的 JavaScript。
- 定向 Vitest 覆盖 PivotGuard、持仓管理、路由、前端和 Bridge 合同。
- `npm test`。
- `powershell -File scripts/bridge-native/test-native.ps1 -SkipRelease`。
- 启动项目后检查 `/health`，使用真实测试账号验证只读状态，再进行显式授权的模拟/测试仓动作。

## 14. 分阶段上线与回滚

1. **计算对照阶段**：Worker 只记录触发结果，不创建交易任务；与 EA 历史样本逐事件对照。
2. **管理员测试账号阶段**：平台总闸只允许测试账号，验证全平、部分平仓、移保本和重启恢复。
3. **用户可见但默认关闭**：发布顶部和 AI 持仓管理开关，所有账号保持关闭。
4. **正式开放**：管理员启用平台总闸，用户自行逐账号开启。

回滚顺序：

1. 关闭平台 PivotGuard 总闸，停止创建新动作。
2. 保持执行 Worker 运行，完成已发送命令的对账。
3. 停止 PivotGuard 监控 Worker。
4. 前端显示“平台已暂停”，保留用户设置、参数版本、持仓状态、任务和事件。
5. 不回滚已执行的交易，不删除审计数据，不自动重新开启已关闭账号。

## 15. 第一轮复审：需求覆盖、复用与最小改动

### 结论

- 已覆盖删除两项保护、用户按账号启用、默认关闭、顶部开关、AI 持仓管理入口和管理员参数权限。
- 复用现有持仓管理任务、命令、事件和 Bridge，未建立第二套执行链路。
- 把 EA 的显示参数、Magic、检查间隔和重试冷却移出业务入口，保留的均为会改变 Pivot 或离场结果的参数。

### 调整

- 将“部分/全平开关 + 百分比”合并为 `close_percent`，减少重叠状态。
- 将 P 点同侧过滤固定为安全规则，不允许管理员关闭。
- 参数改为按标准品种配置，禁止其他品种静默复用 XAUUSD 裸价格距离。
- 普通用户不显示参数数值，只控制自己的具体账号开关。
- 自动分析与自动盯盘解耦，避免关闭新信号分析时同时失去已有持仓管理。
- 活跃持仓保持 5 秒评估，但账户/持仓复用增量投影、D1 复用既有缓存、报价通过 Redis 按账号品种合并，避免每轮全量 Bridge 请求。

### 剩余风险

- 原 EA 的复盘 include 缺失，本期明确不迁移。
- 服务端 5 秒监控不能等价于 MT5 本地 300ms Tick 响应。
- 裸价格距离仍需按品种由管理员维护，首期应限制为已验证品种。
- Redis 只能减少重复请求，不能消除每个活跃账号品种对新鲜报价的最低带宽需求。

## 16. 第二轮复审：兼容性、状态、并发、安全与回滚

### 结论

- 用户开关绑定 `trading_account_id`，账号接管不会继承，满足多用户隔离。
- 活跃持仓绑定不可变参数版本，管理员修改不会追溯改变已有仓位。
- D1 使用终端服务器时间，命令、租约和跨系统比较继续使用 UTC。
- 部分平仓和改单必须进入持久化命令与对账，不复用 EA 的内存布尔值。
- 移保本加入单调保护，修复原 EA 可能覆盖更有利 SL 的风险。
- 关闭与回滚均停止新副作用但继续未知结果对账，避免把外部交易结果伪装成已取消。
- Redis 缓存键绑定终端、代际、账号和 broker symbol；执行前仍绕过缓存复核，缓存不会扩大交易授权。

### 调整

- 增加平台总闸和分阶段开放，部署后所有用户账号仍保持关闭。
- 增加每笔持仓状态表，阶段标记必须在 MT5 对账成功后更新。
- 限制同一 ticket 每轮最多一个副作用，命令完成后重新读取再进入下一阶段。
- 新增管理员保存原因、配置哈希和差异预览，确保参数修改可审计和可回退。
- 明确净持仓账户只有在同品种唯一、手数和归属完全一致时才允许自动动作。
- 增加分层调度、Redis 报价 singleflight、分布式锁、D1 共享和带宽指标；无持仓、休市和离线账号不维持 5 秒高频请求。
- 将报价请求超时限制为 3 秒、锁 TTL 设为 5 秒；未抢到锁且锁仍有效时跳过本轮，避免慢请求导致锁提前失效和重复拉取。

### 剩余风险

- 高频波动或断网期间，服务端监控可能晚于本地 EA；不能把它替代 broker-side SL 宣传。
- 管理员错误参数仍可能造成真实离场，需要对照期、测试账号和品种级开放。
- 当前持仓管理服务端主要面向完整平仓，部分平仓和修改保护价需要扩展状态机并完成 Bridge 回归后才能正式开放。
- 真实经纪商的 D1 切分、成交模式、最小手数和冻结区必须在测试账号验证，静态测试不能替代真实 MT5 证据。
- 多实例 Redis 锁、短暂网络抖动和高活跃账号量仍需上线前压测；缓存命中率不能代替真实 Bridge 请求量监控。

第二轮未发现需要再次修改的实质性架构冲突，方案可进入实现拆分阶段。
