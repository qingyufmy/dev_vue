# Mimo Code 任务：修正自动推理开关显示规则，并补齐无信号原因闭环

## 分支要求

- 只在 `dev_codex` 分支开发。
- 不要合并 `main`。
- 完成后提交并推送到 `dev_codex`。
- 结果文件写入：

`docs/agent-results/20260701-mimo-auto-runtime-status-display-final-fix-result.md`

## 用户最新明确要求

自动推理开关按钮：

```html
id="autoAnalyzeMode"
```

状态显示规则必须调整为：

1. 状态文本中不要显示策略名称。
2. 策略名称改为鼠标移入时通过 `title` 显示。
3. 自动推理只要开启后，就一直显示开启状态。
4. 只有休市时，才显示暂停。

也就是说，像下面这种显示不要再出现：

```text
自动推理 · 趋势突破策略 · 下次 02:35
自动推理中 · 趋势突破策略
自动推理暂停 · 未配置 API Key
自动推理暂停 · Redis 未连接
自动推理暂停 · 管理员桥接离线
```

需要改成更稳定、更简单的用户视角：

```text
自动推理关闭
自动推理开启
自动推理开启 · 下次 02:35
自动推理中
自动推理暂停 · 休市
```

策略名称、品种、内部暂停/阻塞原因、Redis/API Key 等诊断信息放到 `title` 里，不要放在按钮正文里。

## 当前最新提交

当前最新提交大致是：

```text
bc104d6 fix: 修复自动推理无信号 + 完善状态展示
```

这次已经修了一些问题：

- `subscribers is not defined` 已改成 `onlineSubscribers.size`。
- `getAutoConfig()` 空 row 崩溃已修。
- `toggle_auto` 改成 UPSERT。
- 新增了 `getUserAutoRuntimeStatus()`。
- `auto_status` 返回了 `next_run_in_seconds / in_flight / paused_reason` 等字段。

但还有几个关键问题需要继续修。

## 需要修复的问题 A：按钮显示规则不符合用户最新要求

### 当前问题

文件：

- `public/ai/app.js`

当前 `loadStatus()` 中会把策略名和多种暂停原因显示到按钮正文里：

```js
label = `自动推理暂停 · ${reasonLabel}`
label = `自动推理 · ${ptName || '策略'} · 下次 ${countdown}`
label = `自动推理中 · ${ptName || '策略'}`
```

这不符合最新要求。

### 新显示规则

请统一封装一个函数，例如：

```js
function renderAutoAnalyzeBadge(scheduler) {
  // 只负责 id="autoAnalyzeMode" 的 text/title/status class
}
```

正文显示规则：

#### 关闭

条件：

```js
!scheduler.enabled
```

正文：

```text
自动推理关闭
```

状态：

```js
neutral
```

title：

```text
自动推理关闭
```

#### 开启，且非休市，非正在推理

条件：

```js
scheduler.enabled === true
!scheduler.in_flight
!isMarketClosedReason(scheduler.paused_reason, scheduler.market_state)
```

正文：

```text
自动推理开启
```

如果有倒计时：

```text
自动推理开启 · 下次 02:35
```

状态：

```js
active
```

注意：

- 即使 `paused_reason = redis_unavailable / no_api_key / admin_bridge_offline / rates_failed / no_runtime_scheduler`，正文仍显示“自动推理开启”，不要显示暂停。
- 这些内部阻塞原因写到 `title`，用于排查。

#### 正在推理

条件：

```js
scheduler.enabled === true
scheduler.in_flight === true
```

正文：

```text
自动推理中
```

状态：

```js
running
```

title：

包含：

- 策略名称
- 当前品种
- 当前阶段
- 诊断原因，如果有

例如：

```text
策略：趋势突破策略
品种：XAUUSD
状态：正在推理
阶段：AI 推理中
```

#### 休市暂停

只有以下原因才在正文显示暂停：

```js
market_closed
market_stale_tick
market_unknown_no_tick
market_unknown
```

或者：

```js
scheduler.market_state && scheduler.market_state.isOpen === false
```

但注意：`admin_bridge_offline` 不要在正文显示“暂停”，仍显示开启。因为用户最新要求是“除非休市才显示暂停”。管理员桥接离线是内部诊断，放 title。

正文：

```text
自动推理暂停 · 休市
```

如果是行情停滞：

```text
自动推理暂停 · 休市
```

用户只要求休市才显示暂停，所以不要显示“行情停滞”到正文；可以写进 title。

状态：

```js
warning
```

title：

包含：

- 策略名称
- 品种
- 市场状态原因，如 `market_stale_tick`
- tickAgeMs
- mt5TimeStr

### title 规则

按钮 `title` 里展示完整诊断信息，但要简洁。

建议：

```text
策略：趋势突破策略
品种：XAUUSD, NAS100
状态：开启
下次运行：02:35
内部状态：no_api_key
市场：market_open
```

如果正在推理：

```text
策略：趋势突破策略
品种：XAUUSD
状态：正在推理
阶段：AI 推理中
```

如果休市：

```text
策略：趋势突破策略
品种：XAUUSD
状态：休市暂停
市场：market_stale_tick
Tick 延迟：130000ms
MT5 时间：2026.07.01 16:59:00
```

## 需要修复的问题 B：倒计时显示方式

### 当前问题

`loadStatus()` 从后端读取一次：

```js
next_run_in_seconds
```

然后直接显示。

但本地 UI timer 只每 15 秒调用一次 `loadStatus()`，没有每秒递减 `autoAnalyzeMode` 的倒计时。

### 要求

- 后端仍返回 `next_run_in_seconds`。
- 前端每次 `loadStatus()` 后记录一个本地时间戳，例如：

```js
state.autoRuntime = {
  ...scheduler,
  receivedAtMs: Date.now()
}
```

- UI timer 每秒调用：

```js
renderAutoAnalyzeBadge(state.autoRuntime)
```

- 倒计时通过：

```js
remaining = scheduler.next_run_in_seconds - Math.floor((Date.now() - receivedAtMs) / 1000)
```

实时递减。

- 如果 remaining <= 0，但还没收到新的状态，显示：

```text
自动推理开启
```

或短暂显示：

```text
自动推理开启 · 等待调度
```

不要显示负数。

## 需要修复的问题 C：auto_progress 的显示

### 当前问题

文件：

- `public/ai/app.js`

当前收到：

```js
msg.type === 'auto_progress'
```

只是：

```js
badge.textContent = msg.label
```

没有使用 `status-running`，也没有写入 `state.autoRuntime`。

### 要求

收到 `auto_progress` 时：

1. 更新 `state.autoRuntime.in_flight = true`
2. 更新 `state.autoRuntime.stage = msg.stage`
3. 更新 `state.autoRuntime.stage_label = msg.label`
4. 调用 `renderAutoAnalyzeBadge(state.autoRuntime)`

正文只显示：

```text
自动推理中
```

不要显示阶段文字到正文。

阶段文字放到 title。

收到 `new_signal` 后：

- 调用 `loadStatus()` 刷新下一次运行倒计时。
- 状态回到“自动推理开启 · 下次 xx:xx”。

## 需要修复的问题 D：无信号原因仍没有闭环

这是用户当前最关心的问题之一：“自动推理开启后，一直没有信号”。

上一轮 Mimo 已增加 `getUserAutoRuntimeStatus()`，但还没有真正把阻塞原因写完整。

### D1：无 API Key / rates 失败等仍在 cooldown 后才发生

文件：

- `server/routes/ai/scheduler.js`

当前流程：

1. 检查管理员桥接
2. 检查市场状态
3. 检查 Redis
4. acquire lock
5. set cooldown
6. `runUnifiedAutoCycle()`
7. `runUnifiedAutoCycle()` 内部才检查：
   - 策略是否可用
   - API Key 是否存在
   - rates 是否失败/为空

问题：

- 没有 API Key 时，会占用一整个 cooldown。
- 用户看到倒计时，但不会有信号。
- `auto_status` 可能看不到 `no_api_key`。

要求：

在 set cooldown 之前做 preflight，至少检查：

- 策略存在且启用。
- 策略支持 symbol。
- 全局 API Key 已配置。
- 管理员桥接在线。
- 市场状态 open。
- Redis 可用。

如果 preflight 失败：

- 不设置 cooldown。
- `st.lastError = reason`
- `st.stage = 'blocked'`
- `await updateSchedulerRedisState(key, st)`
- 下次 tick 5 秒后重试。

原因值：

```text
strategy_disabled
symbol_not_supported
no_api_key
admin_bridge_offline
market_closed
market_unknown
market_unknown_no_tick
market_stale_tick
redis_unavailable
```

### D2：`runUnifiedAutoCycle()` 不要静默 return

当前 `runUnifiedAutoCycle()` 大量场景直接 `return`。

要求改为返回结构化结果：

```js
return { status: 'blocked', reason: 'no_api_key' }
return { status: 'blocked', reason: 'rates_failed' }
return { status: 'blocked', reason: 'rates_empty' }
return { status: 'success', signalId, subscriberCount, createdAt }
return { status: 'error', reason: 'exception', message: err.message }
```

外层 tick 根据结果更新：

- `st.lastError`
- `st.stage`
- `st.lastRunAt`
- `st.lastSignalId`
- `st.subscriberCount`
- Redis state
- DB `auto_scheduler.last_run_at`

注意：

- `rates_failed` / `rates_empty` 可以发生在 cooldown 后，因为已经开始尝试拉行情。但它们必须写入状态，让用户能在 title 或管理端看到。

### D3：成功运行后更新状态

成功生成信号后必须更新：

```js
st.lastRunAt = createdAt
st.lastSignalId = signalId
st.lastError = ''
st.stage = 'idle'
```

同时：

```sql
UPDATE auto_scheduler SET last_run_at = ? WHERE enabled = 1 AND prompt_type_id = ? AND symbols 包含当前 symbol 的用户
```

如果不方便精确按 JSON contains，可至少更新订阅当前 key 的在线用户：

```sql
UPDATE auto_scheduler SET last_run_at = ? WHERE user_id IN (...)
```

### D4：没有运行态调度器时要给出诊断原因

当前 `getUserAutoRuntimeStatus()` 里：

```js
const running = activeKeys.length > 0 && !pausedReason
```

但如果 `activeKeys.length === 0` 且没有其他 pausedReason，会出现：

```js
enabled: true,
running: false,
paused_reason: ''
```

前端会显示开启，但实际没有调度器。

要求：

如果自动推理已开启，但 `activeKeys.length === 0`：

- 如果用户桥接不在线：`paused_reason = 'user_bridge_offline'`
- 如果没有在线订阅者：`paused_reason = 'no_online_subscribers'`
- 如果策略/品种无效：`paused_reason = 'no_runtime_scheduler'`

这些原因不要显示到按钮正文里，只写 title。

## 需要修复的问题 E：状态字段写入不完整

`updateSchedulerRedisState()` 建议增加：

- `in_flight`
- `stage`
- `last_signal_id`
- `last_success_at`
- `last_blocked_reason`
- `market_reason`
- `market_trade_mode`
- `market_tick_age_ms`
- `market_mt5_time`

并确保以下状态变化都调用它：

- admin bridge offline
- market closed / stale
- redis unavailable
- lock failed
- cooldown active
- preflight blocked
- cycle success
- cycle blocked
- cycle error

## 前端 title 诊断原因映射

在 `public/ai/app.js` 中保留原因映射，但只用于 title。

建议：

```js
const AUTO_REASON_LABELS = {
  admin_bridge_offline: '管理员桥接离线',
  user_bridge_offline: '用户桥接离线',
  market_closed: '休市',
  market_unknown: '市场状态未知',
  market_unknown_no_tick: '等待行情 tick',
  market_stale_tick: '行情停滞',
  redis_unavailable: 'Redis 未连接',
  redis_lock_failed: 'Redis 锁获取失败',
  redis_cooldown_active: '调度冷却中',
  no_api_key: '未配置 API Key',
  strategy_disabled: '策略已停用',
  symbol_not_supported: '品种不支持',
  no_runtime_scheduler: '调度器未运行',
  no_online_subscribers: '无在线订阅者',
  rates_failed: '行情获取失败',
  rates_empty: '行情为空',
}
```

但按钮正文只允许以下几类：

```text
自动推理关闭
自动推理开启
自动推理开启 · 下次 mm:ss
自动推理中
自动推理暂停 · 休市
```

## 验收标准

### 场景 1：关闭

按钮正文：

```text
自动推理关闭
```

### 场景 2：开启，正常等待

按钮正文：

```text
自动推理开启
```

或：

```text
自动推理开启 · 下次 02:35
```

正文不出现策略名称。

title 出现策略名称。

### 场景 3：正在推理

按钮正文：

```text
自动推理中
```

正文不出现策略名称、不出现阶段文字。

title 出现策略名称、品种、阶段。

### 场景 4：休市或行情停滞

按钮正文：

```text
自动推理暂停 · 休市
```

title 出现真实原因：

```text
market_closed
market_stale_tick
market_unknown_no_tick
```

### 场景 5：管理员桥接离线

按钮正文仍显示：

```text
自动推理开启
```

不要显示“暂停”。

title 显示：

```text
内部状态：管理员桥接离线
```

### 场景 6：未配置 API Key

按钮正文仍显示：

```text
自动推理开启
```

title 显示：

```text
内部状态：未配置 API Key
```

不要占用一整个 cooldown。

### 场景 7：Redis 不可用

按钮正文仍显示：

```text
自动推理开启
```

title 显示：

```text
内部状态：Redis 未连接
```

### 场景 8：无信号可排查

如果自动推理开启后一直没信号，`auto_status.scheduler` 必须能返回明确诊断字段：

- `paused_reason`
- `last_error`
- `stage`
- `market_state`
- `redis_available`
- `active_scheduler_keys`
- `subscriber_count`
- `next_run_in_seconds`
- `last_run_at`
- `last_signal_id`

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

`docs/agent-results/20260701-mimo-auto-runtime-status-display-final-fix-result.md`

结果文件必须包含：

- 修改文件列表。
- 自动推理按钮正文显示规则说明。
- title 中包含哪些诊断信息。
- 无信号原因闭环修复说明。
- 是否新增测试。
- 实际执行的验证命令。
- commit id。
- 仍未解决的风险。
