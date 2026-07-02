# Mimo Code 任务：修复自动推理无信号问题，并完善开关状态倒计时/推理中展示

## 分支要求

- 只在 `dev_codex` 分支开发。
- 不要合并 `main`。
- 完成后提交并推送到 `dev_codex`。
- 结果文件写入 `docs/agent-results/20260701-mimo-auto-signal-runtime-status-fix-result.md`。

## 背景

当前项目的自动推理已经改成统一调度：

- 用户在自动推理配置里选择策略提示词。
- 策略提示词绑定一个或多个品种。
- 用户可以选择该策略支持的部分或全部品种。
- 开启自动推理后，用户订阅对应的 `prompt_type_id + symbol` 调度器。
- 调度器使用管理员当前桥接的 MT5 行情数据统一推理。
- 生成共享信号后，分发给所有在线订阅用户。
- 用户若开启自动交易，再使用用户自己的桥接并行执行交易。
- 休市、管理员桥接断开、行情 tick 停滞时，自动推理必须暂停。

现在用户遇到的问题：

1. 自动推理已经开启，但一直没有信号。
2. 顶部开关按钮 `id="autoAnalyzeMode"` 现在状态不够清楚，需要显示：
   - 当前是否开启。
   - 当前是否暂停以及暂停原因。
   - 正在推理中。
   - 下次运行倒计时。

## 已发现的明确问题

### P1：自动推理成功后 audit 阶段会抛运行时错误

文件：

- `server/routes/ai/scheduler.js`

当前 `runUnifiedAutoCycle()` 中，前面已经把订阅用户过滤成：

```js
const onlineSubscribers = new Set()
```

但后面写审计时仍然使用旧变量：

```js
subscriber_count: subscribers.size
```

以及日志：

```js
l(`<<< cycle complete (signal=#${signalId}, subscribers=${subscribers.size})`)
```

这里的 `subscribers` 已不存在，会导致成功生成信号、写入 delivery、推送甚至执行交易之后，在 audit 阶段抛：

```text
ReferenceError: subscribers is not defined
```

要求：

- 全部改为 `onlineSubscribers.size`。
- 避免成功周期被错误记录成异常。

### P1：新用户没有 `auto_scheduler` 行时，`getAutoConfig()` 会崩

文件：

- `server/routes/ai/config.js`

当前逻辑：

```js
const row = await queryOne('SELECT * FROM auto_scheduler WHERE user_id = ?', [userId])
if (row && row.symbols) {
  ...
} else {
  row.selected_symbols = []
}
return row
```

如果 `row === null`，会执行 `row.selected_symbols = []` 并抛异常。

影响：

- `toggle_auto`
- `auto_status`
- 部分新用户第一次打开/开启自动推理

要求：

- `row` 为空时直接返回 `null`，或返回一个结构明确的默认对象。
- 如果返回默认对象，注意不要让 `toggle_auto` 误以为数据库已有行。

### P1：首次开启自动推理时，`toggle_auto` 可能重复插入 `auto_scheduler`

文件：

- `server/bridge-ws.js`

当前流程大致是：

1. `const cfg = await ai.getAutoConfig(null, userId)`
2. 如果 `cfg` 不存在，进入新用户初始化。
3. `saveUserAutoConfig()` 会 `INSERT INTO auto_scheduler ... ON DUPLICATE KEY UPDATE ...`
4. 之后 `toggle_auto` 仍然按旧的 `cfg` 判断：

```js
if (cfg) {
  UPDATE auto_scheduler SET enabled = ...
} else {
  INSERT INTO auto_scheduler ...
}
```

如果 `saveUserAutoConfig()` 已经插入了行，这里的 `INSERT` 会触发 `user_id` 唯一键冲突。

要求：

- `toggle_auto` 在调用 `saveUserAutoConfig()` 后重新读取最新配置。
- 开启/关闭统一使用 `UPDATE` 或 `INSERT ... ON DUPLICATE KEY UPDATE`。
- 不要依赖最开始的旧 `cfg` 判断数据库是否已有行。

## 自动推理一直没有信号的重点排查方向

请按下面顺序检查并修复可修项。

### 1. 调度器是否真的启动

检查：

- `auto_scheduler.enabled = 1`
- 用户 `plan = 'pro'`
- 用户桥接在线：`isBridgeAlive(userId) === true`
- `prompt_type_id` 不为空
- 策略存在且启用：`auto_prompt_types.is_active = 1` 且 `deleted_at IS NULL`
- 用户选择的 `symbols` 与策略 `symbols_json` 有交集

相关文件：

- `server/routes/ai/scheduler.js`
- `server/routes/ai/config.js`

注意：

- `reconcileAutoSchedulers()` 目前按 DB 找需要的 key。
- `startUnifiedScheduler()` 再用 `getAutoSubscribers(promptTypeId, symbol, isBridgeAlive)` 过滤在线用户。
- 如果没有在线订阅者，调度器不会启动。

要求：

- 在 `auto_status` 或 `get_auto_config` 返回中暴露用户当前订阅状态：
  - `enabled`
  - `running`
  - `selected_symbols`
  - `active_scheduler_keys`
  - `subscriber_count`
  - `paused_reason`

### 2. 管理员桥接和市场状态是否阻塞

自动推理统一使用管理员 MT5 数据。

当前如果以下任一条件成立，调度器不会生成信号：

- 没有管理员桥接在线。
- 管理员桥接在线但没有收到行情 tick。
- 管理员行情 tick 长时间不变。
- 市场状态不是 open。

相关函数：

- `getActiveAdminBridgeUserId()`
- `getOwnBridgeMarketState(adminUserId)`

要求：

- `auto_status` 返回管理员市场状态：
  - `admin_bridge_online`
  - `market_state.isOpen`
  - `market_state.reason`
  - `market_state.tradeMode`
  - `market_state.tickAgeMs`
  - `market_state.mt5TimeStr`

### 3. Redis 是否阻塞

当前调度器依赖 Redis lock/cooldown。

如果 Redis 不可用：

- `startUnifiedScheduler()` 可以存在。
- tick 会停在 `redis_unavailable`。
- 不会调用 AI。

要求：

- `auto_status` 返回：
  - `redis_available`
  - `last_error`
  - `next_run_in_seconds`
  - `cooldown_ttl_seconds`

### 4. 全局模型/API Key 是否缺失

当前 `runUnifiedAutoCycle()` 会读取：

```js
getUnifiedAutoInferenceConfig(promptTypeId)
```

如果 `global_auto_config.api_key_encrypted` 缺失：

- 不会调用 AI。
- 不会生成信号。

但目前这个阻塞发生在 `runUnifiedAutoCycle()` 内，外层 tick 可能已经设置了 Redis cooldown，导致用户还要等一个周期才再次检查。

要求：

- 在设置 Redis cooldown 之前做轻量 preflight：
  - 策略存在且启用。
  - 策略支持当前 symbol。
  - 全局 API key 已配置。
  - 管理员桥接和市场状态 open。
- 如果 preflight 不通过：
  - 不设置 Redis cooldown。
  - 写入 `st.lastError`。
  - 写入 Redis state。
  - `auto_status` 能显示具体原因。

建议暂停原因：

- `admin_bridge_offline`
- `market_closed`
- `market_unknown`
- `market_unknown_no_tick`
- `market_stale_tick`
- `redis_unavailable`
- `no_api_key`
- `strategy_disabled`
- `symbol_not_supported`
- `no_subscribers`
- `rates_failed`
- `rates_empty`

### 5. MT5 rates 是否失败

如果 `mt5Bridge(adminUserId, 'rates', ...)` 返回失败或空数组：

- 也不会生成信号。

要求：

- `runUnifiedAutoCycle()` 不要只 `return`，应返回结构化结果：

```js
return { status: 'blocked', reason: 'rates_failed' }
return { status: 'blocked', reason: 'rates_empty' }
return { status: 'success', signalId, subscriberCount }
```

- 外层 tick 根据结果更新：
  - `st.lastError`
  - `st.lastRunAt`
  - `st.lastSignalId`
  - Redis state

## 需要新增/调整的运行状态接口

### 后端：扩展 `auto_status`

文件：

- `server/bridge-ws.js`
- `server/routes/ai/scheduler.js`

建议新增 scheduler helper：

```js
export async function getUserAutoRuntimeStatus(userId) {
  // 读取用户 auto_scheduler
  // 找到用户选择的 prompt_type_id 和 symbols
  // 对每个 symbol 生成 scheduler key
  // 从 autoSchedulerState + Redis TTL 汇总状态
  // 返回最早的 next_run_in_seconds，以及是否 in_flight
}
```

`auto_status` 返回建议结构：

```js
{
  status: 'success',
  scheduler: {
    enabled: true,
    running: true,
    prompt_type_id: 1,
    prompt_type_name: '趋势突破策略',
    selected_symbols: ['XAUUSD', 'NAS100'],
    active_symbol: 'XAUUSD',
    active_scheduler_key: '1:XAUUSD',
    in_flight: false,
    stage: 'idle',
    last_error: '',
    paused_reason: '',
    next_run_in_seconds: 183,
    cooldown_ttl_seconds: 183,
    last_run_at: '2026-07-01 17:30:00',
    last_signal_id: 123,
    subscriber_count: 2,
    admin_bridge_online: true,
    market_state: {
      isOpen: true,
      reason: 'market_open',
      tradeMode: 4,
      tickAgeMs: 820,
      mt5TimeStr: '2026.07.01 09:30:12'
    },
    redis_available: true
  }
}
```

多品种时：

- 如果任一 symbol 正在推理，整体显示正在推理。
- 否则取最早 `next_run_in_seconds`。
- 如果所有 symbol 都暂停，显示最关键暂停原因。

### 后端：完善 Redis state

文件：

- `server/routes/ai/scheduler.js`

`updateSchedulerRedisState()` 建议增加字段：

- `in_flight`
- `stage`
- `last_signal_id`
- `last_success_at`
- `last_blocked_reason`
- `next_run_in_seconds`
- `cooldown_ttl_seconds`
- `market_reason`
- `market_trade_mode`
- `market_tick_age_ms`
- `market_mt5_time`

注意：

- Redis state 不设置过期时间。
- cooldown key 本身仍然可以用 EX 控制间隔。

## 前端需求：`id="autoAnalyzeMode"` 状态显示

文件：

- `public/ai/app.js`
- `public/ai/index.html`
- `public/ai/styles.css`

目标：

顶部按钮 `id="autoAnalyzeMode"` 显示更明确：

### 关闭时

```text
自动推理关闭
```

### 开启且等待下次运行

```text
自动推理 · 策略名称 · 下次 02:35
```

如果多品种：

```text
自动推理 · 策略名称 · XAUUSD 下次 02:35
```

### 正在推理中

```text
自动推理中 · 策略名称 · XAUUSD
```

样式使用 active 或 warning 之外，建议加一个 running 状态，例如：

```css
.status-badge.status-running { ... }
```

可以沿用现有 `auto_progress` 推送：

- 收到 `auto_progress` 时立即显示正在推理阶段。
- 例如：

```text
自动推理中 · 获取行情
自动推理中 · AI 推理中
```

### 暂停时

```text
自动推理暂停 · 休市
自动推理暂停 · 管理员桥接离线
自动推理暂停 · Redis 未连接
自动推理暂停 · 未配置 API Key
```

暂停原因映射：

- `admin_bridge_offline` => `管理员桥接离线`
- `market_closed` => `休市`
- `market_unknown` => `市场状态未知`
- `market_unknown_no_tick` => `等待行情 tick`
- `market_stale_tick` => `行情停滞`
- `redis_unavailable` => `Redis 未连接`
- `no_api_key` => `未配置 API Key`
- `strategy_disabled` => `策略已停用`
- `symbol_not_supported` => `品种不支持`
- `no_subscribers` => `无在线订阅者`
- `rates_failed` => `行情获取失败`
- `rates_empty` => `行情为空`

### 倒计时刷新方式

建议：

- 前端 `loadStatus()` 或单独 `refreshAutoRuntimeStatus()` 每 5 秒拉一次 `auto_status`。
- 如果后端返回 `next_run_in_seconds`，前端本地每 1 秒递减显示，不需要每秒请求后端。
- 收到 `auto_progress` 时暂停本地倒计时，显示“正在推理中”。
- 收到 `new_signal` 后刷新 `auto_status`，重新开始下一轮倒计时。

## 需要修复的现有前端显示问题

当前 `autoAnalyzeMode` 主要依赖：

- `state.marketTradeMode !== 4`
- `auto_status.scheduler.running`
- `auto_progress`

但 `state.marketTradeMode` 来自 `health.gateway.trade_mode`，而 `getBridgeTradeMode()` 目前没有使用新的 `getOwnBridgeMarketState()`，所以行情 stale 时前端可能还显示 open。

要求：

- 后端 `health` 或 `auto_status` 返回 `market_state`。
- 前端判断暂停优先使用 `auto_status.scheduler.market_state.isOpen` 和 `paused_reason`，不要只依赖 `state.marketTradeMode`。

## 需要补充的测试

如果项目测试结构允许，至少新增或扩展测试：

1. `getAutoConfig()`：
   - 无 `auto_scheduler` 行时不抛异常。

2. `toggle_auto` 首次开启：
   - 无旧配置时不会重复插入。
   - 会保存默认策略和默认 symbols。
   - 会设置 `enabled = 1`。

3. `runUnifiedAutoCycle()` 成功路径：
   - 使用 `onlineSubscribers.size` 写 audit。
   - 不出现 `subscribers is not defined`。

4. preflight blocked：
   - no API key 不设置 cooldown。
   - admin bridge offline 不设置 cooldown。
   - market closed 不设置 cooldown。

5. `auto_status`：
   - 返回 `next_run_in_seconds`。
   - 返回 `in_flight`。
   - 返回 `paused_reason`。

如果不方便写完整集成测试，至少补充关键纯函数测试和手工验证记录。

## 推荐实现顺序

1. 修 P1：
   - `subscribers` 改为 `onlineSubscribers`。
   - `getAutoConfig()` 空 row 修复。
   - `toggle_auto` 首次开启重复插入修复。

2. 增加调度器结构化状态：
   - `runUnifiedAutoCycle()` 返回结构化结果。
   - tick 根据结果更新 `lastError/lastRunAt/lastSignalId/stage/inFlight`。
   - Redis state 写完整。

3. 增加 runtime status：
   - scheduler helper 汇总用户订阅 key 状态。
   - `auto_status` 返回倒计时、推理中、暂停原因、市场状态。

4. 前端展示：
   - `autoAnalyzeMode` 显示关闭/暂停/倒计时/推理中。
   - 本地倒计时每秒刷新。
   - `auto_progress` 和 `new_signal` 触发状态刷新。

5. 测试和验证。

## 验收标准

### 场景 1：新用户首次开启自动推理

期望：

- 不报错。
- 创建或更新 `auto_scheduler`。
- `enabled = 1`。
- 有默认策略和默认品种。
- Redis 订阅同步成功。
- `autoAnalyzeMode` 显示开启状态或暂停原因。

### 场景 2：管理员桥接在线、市场开市、Redis 正常、API Key 已配置

期望：

- 自动推理按调度间隔运行。
- 运行中按钮显示：

```text
自动推理中 · 策略名称 · 品种
```

- 推理结束后生成 `ai_signals` 和 `auto_signal_deliveries`。
- 不出现 `subscribers is not defined`。
- audit 为 success。
- 按钮显示下一次倒计时。

### 场景 3：管理员桥接离线

期望：

- 不调用 AI。
- 不生成信号。
- 不设置 cooldown。
- `autoAnalyzeMode` 显示：

```text
自动推理暂停 · 管理员桥接离线
```

### 场景 4：休市或行情停滞

期望：

- 不调用 AI。
- 不生成信号。
- 不设置 cooldown。
- `autoAnalyzeMode` 显示：

```text
自动推理暂停 · 休市
```

或：

```text
自动推理暂停 · 行情停滞
```

### 场景 5：Redis 不可用

期望：

- 自动推理暂停。
- 不调用 AI。
- `autoAnalyzeMode` 显示：

```text
自动推理暂停 · Redis 未连接
```

### 场景 6：未配置全局 API Key

期望：

- 不调用 AI。
- 不生成信号。
- 不设置 cooldown。
- `autoAnalyzeMode` 显示：

```text
自动推理暂停 · 未配置 API Key
```

### 场景 7：多品种策略

期望：

- 用户选择多个品种后，每个品种对应独立调度 key。
- `autoAnalyzeMode` 显示最早下次运行的品种倒计时。
- 如果某个品种正在推理，优先显示正在推理中的品种。

## 推荐检查命令

```powershell
node --check server/bridge-ws.js
node --check server/routes/ai/scheduler.js
node --check server/routes/ai/config.js
node --check server/routes/ai/index.js
node --check public/ai/app.js
npm test
```

## 结果文件要求

完成后请写：

`docs/agent-results/20260701-mimo-auto-signal-runtime-status-fix-result.md`

内容必须包含：

- 修改文件列表。
- 修复了哪些“无信号”原因。
- `autoAnalyzeMode` 新状态展示说明。
- 是否新增测试。
- 实际执行的验证命令。
- 提交 commit id。
- 仍未解决的风险。
