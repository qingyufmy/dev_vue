# Mimo 任务：自动推理流程一致性与稳定性优化

## 背景

当前项目已经完成自动推理从“按用户调度”到“按策略提示词 + 品种统一调度”的重构。现有主流程方向是正确的：

- 用户保存自动推理配置：选择策略提示词、选择该策略支持的品种、配置风控和是否自动交易。
- 用户开启自动推理：只有用户自己的 MT5 桥接在线时，才加入对应策略 + 品种的调度器订阅。
- 统一调度器：使用管理员当前桥接 MT5 的数据作为自动推理数据源。
- 信号写入：共享信号写入 `ai_signals`，`user_id = 0`，`source = 'auto_shared'`。
- 用户分发：对每个在线订阅用户写入 `auto_signal_deliveries`。
- 自动交易：只对用户自己的桥接在线、且开启自动交易和交易发送的用户执行。
- 观摩模式：用户未连接自己桥接时，可以读取管理员桥接数据做观摩，但不能做写操作、不能订阅自动推理、不能执行交易。

用户补充确认：

1. 手动执行信号不需要走后端风控，这是设计如此，不要修改为强制后端风控。
2. 用户桥接未连接时会进入观摩模式，观摩模式的数据来源是管理员账号桥接相关数据，但不可做任何操作。
3. 自动推理订阅和自动交易必须要求用户自己的桥接在线。

本任务只修复自动推理剩余逻辑不一致、状态语义和可观测性问题。不要改变手动执行的设计。

## 涉及文件

重点检查并修改：

- `server/routes/ai/scheduler.js`
- `server/routes/ai/config.js`
- `server/bridge-ws.js`
- `public/ai/app.js`
- 必要时修改 `server/index.js`

不要做无关重构，不要改桥接客户端打包。

## 任务 1：修复策略周期、行情周期、信号周期、TTL 不一致

### 当前问题

`server/routes/ai/scheduler.js` 中 `startUnifiedScheduler()` 固定调用：

```js
runUnifiedAutoCycle(promptTypeId, symbol, 'M5')
```

但 `runUnifiedAutoCycle()` 内部会从策略提示词中解析周期标签：

```js
const tags = parseTimeframeTags(prompt, 'auto')
const primaryTf = tags.length > 0 ? tags[0].tf : timeframe.toUpperCase()
```

实际行情使用 `primaryTf` 拉取，但信号入库和推送仍使用传入的 `timeframe`，通常是固定 `M5`：

- `ai_signals.timeframe`
- `signal.timeframe`
- `signalTtlSeconds(timeframe)`
- `new_signal.timeframe`
- audit 中的 `timeframe`

这会导致 M15/H1 策略按 M15/H1 推理，却在历史里显示成 M5，过期时间也按 M5 算。

### 多周期策略定义

自动推理策略允许调用多个周期的数据，但每条交易信号必须有一个明确的“主周期”，用于列表展示、筛选、TTL 和执行有效期判断。

规则如下：

1. `ai_signals.timeframe` 表示信号主周期，不表示本轮只使用了这一个周期。
2. 主周期取策略提示词中解析出的第一个周期标签。
   - 例如策略使用 `M15 + H1 + H4`，主周期是 `M15`。
   - 信号列表显示 `M15`。
   - TTL 按 `M15` 计算。
3. 如果策略没有周期标签，主周期默认 `M5`。
4. 本轮实际使用过的所有周期要写入 `market_data_json`，用于信号详情、排查和后续展示。
5. 建议在 `market_data_json` 中增加字段：

```json
{
  "primary_timeframe": "M15",
  "used_timeframes": ["M15", "H1", "H4"]
}
```

6. 如果当前实现暂时只按第一个周期拉取 K 线，也要先写入 `primary_timeframe` 和 `used_timeframes`：
   - `primary_timeframe` 为实际主周期。
   - `used_timeframes` 至少包含主周期。
   - 如果 `buildStrategyContextFromTags()` 内部已经使用多个周期，应把解析出的周期列表完整写入 `used_timeframes`。
7. 前端列表仍显示主周期；详情页后续可展示“参考周期：M15 / H1 / H4”。本任务不强制做详情页展示，重点是先把数据结构保存正确。

### 修改要求

1. 在 `runUnifiedAutoCycle()` 内确定主周期 `primaryTf` 后，后续本轮所有信号主周期字段都使用 `primaryTf.toUpperCase()`。
2. 保存到 `ai_signals.timeframe` 时使用主周期。
3. `signal.timeframe` 使用主周期。
4. `signalTtlSeconds()` 使用主周期。
5. `new_signal` 推送中的 `timeframe` 使用主周期。
6. audit 入参中的 `timeframe` 使用主周期。
7. 如果策略提示词没有周期标签，主周期默认仍为 `M5`。
8. 在 `market_data_json` 中保存：
   - `primary_timeframe`
   - `used_timeframes`
9. 不要把多周期策略拆成多条信号。多周期只是分析上下文，一条自动推理结果仍是一条信号。

### 验收标准

- 策略提示词带 M15 标签时，自动推理生成的信号历史显示 M15。
- M15 信号 TTL 使用 `signalTtlSeconds('M15')`。
- 策略提示词带 `M15 + H1 + H4` 时，`ai_signals.timeframe` 为 `M15`，`market_data_json.primary_timeframe` 为 `M15`，`market_data_json.used_timeframes` 至少包含 `M15`、`H1`、`H4`。
- `market.timeframe`、`ai_signals.timeframe`、前端列表展示周期一致，均表示主周期。

## 任务 2：失败不应消耗完整调度间隔

### 当前问题

调度器 tick 中先设置 Redis cooldown：

```js
const cooldownSet = await setCooldown(key, st.intervalMinutes * 60)
```

然后才执行 `runUnifiedAutoCycle()`。如果后续因为行情失败、桥接命令超时、AI 异常等原因失败，也会进入完整调度间隔等待。

这会造成“明明只是短暂失败，却要等 5 分钟甚至更久才重试”。

### 修改要求

1. Redis lock 仍可在执行前获取，用于防止并发。
2. 完整 cooldown 不要在执行前设置。
3. `runUnifiedAutoCycle()` 返回 `success` 且完成一次实际推理后，再设置完整 cooldown。
4. 如果 `runUnifiedAutoCycle()` 返回 `blocked` 或 `error`，不要设置完整 cooldown。
5. 对不同失败原因使用短重试：
   - `admin_bridge_offline`：5 秒。
   - `market_closed`、`market_stale_tick`、`market_unknown_no_tick`、`market_unknown`：5 秒。
   - `redis_unavailable`：5 秒。
   - `rates_failed`、`rates_empty`、`exception`：15-30 秒。
   - `no_api_key`、`strategy_disabled`、`symbol_not_supported`：30-60 秒，避免刷日志。
6. 可新增一个 helper，例如：

```js
function retryDelayMs(reason) {
  // 按 reason 返回短重试毫秒数
}
```

7. 正常完整间隔只用于成功完成一轮推理后。

### 验收标准

- 管理员桥接恢复后，不需要等待完整策略间隔才运行。
- 行情短暂失败后，几十秒内会重试。
- 成功生成信号后才进入完整倒计时。

## 任务 3：拆分 lastError 与正常等待状态

### 当前问题

当前 `redis_cooldown_active` 是正常等待下一轮，但会写入 `lastError`：

```js
st.lastError = 'redis_cooldown_active'
```

这会让 runtime 状态和管理员排查信息把正常等待误判为错误或暂停。

### 修改要求

1. `lastError` 只记录真正异常或阻断，例如：
   - `exception`
   - `rates_failed`
   - `rates_empty`
   - `no_api_key`
   - `strategy_disabled`
   - `symbol_not_supported`
2. 正常等待使用新字段：
   - `waitReason`
   - `cooldownActive`
   - `nextRunInSeconds`
3. Redis scheduler state 中增加或维护：
   - `last_error`
   - `wait_reason`
   - `next_run_in_seconds`
   - `last_block_reason`
4. `getUserAutoRuntimeStatus()` 中：
   - 正常 cooldown 不应导致 `paused_reason = redis_cooldown_active`。
   - `paused_reason` 只用于真正暂停/阻断原因。
5. 前端展示：
   - 正常倒计时显示“自动推理开启 · 下次 mm:ss”。
   - title 可以显示“等待下一轮调度”。
   - 不要显示为异常。

### 验收标准

- 正常等待下一轮时，`last_error` 为空。
- 前端显示倒计时，不显示错误或暂停。
- 管理员 scheduler state 能区分等待、阻断和异常。

## 任务 4：自动推理状态语义修正

### 业务规则

1. 用户未开启自动推理：显示“自动推理关闭”。
2. 用户已开启自动推理：
   - 非休市情况下，主状态一直显示“自动推理开启”。
   - 正在推理时显示“自动推理中”。
   - 只有休市、行情停滞、行情未知等市场原因，才显示“自动推理暂停 · 休市”。
3. 用户桥接断开：
   - 不订阅调度器。
   - 不接收自动推理信号。
   - 不执行自动交易。
   - 前端主状态不要显示“关闭”，应保持“自动推理开启”，title 中说明“用户桥接离线，等待连接后订阅”。
4. Redis/API Key/管理员桥接离线等不是用户主动关闭，不要把按钮显示为关闭。

### 修改要求

#### 后端

1. `bridge-ws.js` 桥接断开时可以继续调用：

```js
await ai.removeUserRuntimeAutoSubscription(userId)
```

2. 但发送 `auto_state` 时不要让前端误以为用户关闭了自动推理。
3. 建议 `auto_state` 增加字段：

```js
{
  type: 'auto_state',
  enabled: schedulerEnabledFromDb,
  runtime_subscribed: false,
  reason: 'user_bridge_offline'
}
```

4. 如果拿不到 DB 状态，也不要直接硬编码 `enabled: false` 导致 UI 误导。可让前端随后 `loadStatus()` 获取真实状态。

#### 前端

1. `public/ai/app.js` 中处理 `auto_state` 时，不要因为 `reason === 'bridge_disconnected'` 直接：

```js
setBadge("autoAnalyzeMode", "自动推理关闭", "neutral")
```

2. 应调用统一的 `renderAutoAnalyzeBadge()`。
3. 当 `enabled=true` 且 `reason=user_bridge_offline`：
   - label 显示“自动推理开启”。
   - title 显示“用户桥接离线，等待连接后订阅”。
4. 当 `enabled=false` 才显示“自动推理关闭”。

### 验收标准

- 用户开启自动推理后断开桥接，按钮不显示关闭。
- 断桥时不会订阅调度器、不会收到自动推理信号、不会自动交易。
- 重新连接桥接后自动恢复订阅。

## 任务 5：补充自动推理进度结束事件

### 当前问题

前端收到 `auto_progress` 后会设置：

```js
state.autoRuntime.in_flight = true
```

如果本轮被阻塞或异常，没有 `new_signal`，前端只能等 15 秒轮询刷新，可能短暂卡在“自动推理中”。

### 修改要求

1. 后端每一轮结束都推送最终进度事件，例如：

```js
{
  type: 'auto_progress_done',
  status: 'success' | 'blocked' | 'error',
  reason,
  prompt_type_id,
  symbol,
  next_run_in_seconds
}
```

2. 成功、blocked、error 都要推。
3. 前端收到 `auto_progress_done` 后：
   - `in_flight = false`
   - 清理 `stage_label`
   - 更新 `paused_reason` 或 `last_error`
   - 立即调用 `renderAutoAnalyzeBadge()`
   - 必要时触发一次 `loadStatus()`

### 验收标准

- 行情失败、API 失败、休市阻塞后，前端不会长时间停留在“自动推理中”。
- 成功生成信号后也能正常回到开启/倒计时状态。

## 任务 6：策略品种校验改为 JSON 精确匹配

### 当前问题

`runUnifiedAutoCycle()` 中有类似逻辑：

```js
if (!pt.symbols_json.includes(symbol)) ...
```

这是字符串包含判断，不够严谨。

### 修改要求

1. 新增或复用 helper，将 `symbols_json` 解析成标准数组：
   - JSON.parse
   - trim
   - uppercase
   - 去重
2. `runUnifiedAutoCycle()` 中用数组精确匹配：

```js
const supportedSymbols = parsePromptSymbols(pt.symbols_json)
if (!supportedSymbols.includes(symbol.toUpperCase())) ...
```

3. `saveAutoPromptType()` 中禁止管理员保存空品种策略。
4. `saveUserAutoConfig()` 中继续校验 `selected_symbols` 必须属于策略支持品种。
5. 注意不要误伤带后缀品种，例如 `XAUUSD.s`、`XAUUSD.c`。

### 验收标准

- 策略支持 `XAUUSD.s` 时，不会误匹配 `XAUUSD`。
- 空品种策略无法保存。
- 用户不能保存策略不支持的品种。

## 任务 7：增加调度器自愈 reconcile

### 当前问题

当前 reconcile 主要在服务启动、桥接恢复、配置保存、策略修改时触发。如果某次事件失败，调度器可能长期和 DB/Redis 状态不一致。

### 修改要求

1. 服务启动后保留 `initAutoSchedulers()`。
2. 增加周期性自愈任务，例如每 60 秒执行一次：

```js
reconcileAutoSchedulers()
```

3. reconcile 必须幂等，不得重复创建相同调度器。
4. 如果 Redis 不可用，不要抛出导致服务异常，只记录状态。
5. 离线用户不能被 reconcile 重新加入 runtime 订阅。
6. 推荐在 `scheduler.js` 中导出一个 `startAutoSchedulerReconciler()`，在 `server/index.js` 初始化时调用。
7. 避免重复启动多个 interval。

### 验收标准

- 某次配置保存或桥接恢复事件失败后，最多 60 秒能恢复正确调度状态。
- 不会重复创建多个相同调度器。
- 用户桥接离线时不会被重新加入订阅。

## 任务 8：确认观摩模式边界，不破坏现有设计

### 保留设计

用户未连接自己桥接时，可以读取管理员桥接数据进入观摩模式。

观摩模式允许读：

- `account`
- `quote`
- `positions`
- `rates`
- `history`
- `signal_detail`
- 历史信号列表

观摩模式禁止写：

- `open`
- `close`
- `toggle_trade`
- `toggle_auto`
- `execute`
- 自动推理 runtime 订阅
- 自动交易执行

### 修改要求

1. 不要取消观摩模式。
2. 不要把所有读操作都改成必须用户桥接在线。
3. 只确保自动推理订阅和自动交易执行必须要求用户自己的桥接在线。
4. `save_user_auto_config` 可以允许保存配置，但如果用户桥接不在线，不得加入 runtime 订阅。
5. `toggle_auto` 开启时继续要求用户桥接在线。

### 验收标准

- 未连接桥接用户能看管理员桥接观摩数据。
- 未连接桥接用户不能开启自动推理 runtime 订阅。
- 未连接桥接用户不会收到自动推理信号。
- 未连接桥接用户不能交易。

## 不要修改的内容

1. 不要强制手动执行走后端风控。手动执行不走后端风控是当前设计。
2. 不要取消观摩模式。
3. 不要改为每个用户单独调度。
4. 不要把自动推理数据源改回用户自己的行情数据。
5. 不要处理桥接客户端打包问题。
6. 不要做大范围 UI 重构。

## 建议验证命令

至少执行：

```bash
node --check server/routes/ai/scheduler.js
node --check server/bridge-ws.js
node --check public/ai/app.js
```

如项目有可运行测试，也请补充运行相关测试。

## 人工验收清单

1. 管理员桥接在线、市场开放、Redis 正常、API Key 正常：
   - 用户开启自动推理后能生成信号。
2. 策略使用 M15/H1 标签：
   - 信号 timeframe 与 TTL 正确。
3. 管理员桥接断开：
   - 不生成自动推理信号。
   - 状态 title 显示管理员桥接离线。
4. 用户桥接断开：
   - 不订阅调度器。
   - 不收自动推理信号。
   - 自动推理按钮不误显示关闭。
5. 用户桥接断开但观摩模式可用：
   - 可以看管理员桥接行情/账户/持仓/历史。
   - 不能交易。
   - 不能开启自动推理 runtime 订阅。
6. 休市或行情停滞：
   - 显示“自动推理暂停 · 休市”。
   - 不生成信号。
7. rates 临时失败：
   - 不等待完整 interval。
   - 短时间内重试。
8. 正常 cooldown：
   - 不写入 `lastError`。
   - 前端显示下次运行倒计时。
9. 自动推理 blocked/error：
   - 前端不会长时间卡在“自动推理中”。
10. 多策略、多品种：
    - 每个策略 + 品种只存在一个统一调度器。
    - 用户只收到自己已开启且已选择品种的信号。

## Mimo 输出要求

请在完成后写结果文件：

`docs/agent-results/20260702-mimo-auto-inference-flow-hardening-result.md`

结果文件需要包含：

1. 修改了哪些文件。
2. 每个任务点是否完成。
3. 未完成项或需要人工确认的项。
4. 执行过的检查命令和结果。
5. 若发现新增风险，请明确列出。
