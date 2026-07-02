# Mimo 任务：自动推理后续审查问题修复

## 背景

当前自动推理统一调度已经基本成型，测试也能通过：

- `npm.cmd test`：6 个测试文件，75 个测试通过。
- `node --check`：自动推理相关 JS 文件语法通过。

但是代码审查发现仍有一些运行时逻辑问题，测试尚未覆盖。请按本文件修复。

重要约束：

1. 不要改变“手动执行信号不走后端风控”的设计。
2. 不要取消观摩模式。
3. 用户未连接自己桥接时，可以读取管理员桥接数据观摩，但不能做写操作、不能订阅自动推理、不能执行交易。
4. 自动推理订阅和自动交易必须要求用户自己的桥接在线。
5. 不要重构无关模块，不要处理桥接客户端打包。

## 涉及文件

重点修改：

- `server/routes/ai/config.js`
- `server/routes/ai/scheduler.js`
- `server/bridge-ws.js`

可能涉及：

- `public/ai/app.js`
- `tests/ai/*.test.js`

## P0：修复 `upsertAutoConfig()` 事务使用错误

### 当前问题

`server/routes/ai/config.js` 中 `upsertAutoConfig()` 现在写法类似：

```js
await withTransaction(async (conn) => {
  await conn.query(...)
})
```

但 `server/db.js` 的 `withTransaction(fn)` 传给回调的是 `run(sql, params)` 函数，不是 mysql connection 对象：

```js
const runner = (sql, params = []) => conn.query(sql, params)
const result = await fn(runner)
```

因此 `upsertAutoConfig()` 运行时会报：

```text
conn.query is not a function
```

### 影响

会影响所有调用 `upsertAutoConfig()` 的路径，包括但不限于：

- 桥接恢复兼容逻辑中自动补默认自动推理配置。
- 旧 `save_auto` 兼容接口。
- 未来如果其他路径复用 `upsertAutoConfig()`，也会出错。

### 修改要求

把 `upsertAutoConfig()` 改成和其他模块一致的事务用法：

```js
await withTransaction(async (run) => {
  await run(sql, params)
  await run(sql2, params2)
})
```

不要直接使用 `conn.query`。

### 验收标准

1. 搜索全仓库，确认没有新增类似误用：

```bash
rg -n "withTransaction\\(async \\((conn|connection)" server
```

2. `upsertAutoConfig()` 能被单元测试或简单 mock 测试覆盖。
3. 不再出现 `conn.query is not a function`。

## P0：修复 `auto_status` 误把别人的调度器算作当前用户运行中

### 当前问题

`server/routes/ai/scheduler.js` 的 `getUserAutoRuntimeStatus(userId)` 中，逻辑大致是：

```js
for (const sym of selectedSymbols) {
  const key = buildSchedulerKey(scheduler.prompt_type_id, sym)
  const st = autoSchedulerState[key]
  if (st) {
    activeKeys.push(key)
    ...
  }
}
```

问题是：只要同一个策略 + 品种的统一调度器存在，就认为当前用户有 active scheduler，没有判断当前用户是否仍在：

```js
st.subscribers.has(userId)
```

### 影响

场景：

1. 用户 A 和用户 B 都开启了同一个策略 + 同一个品种。
2. 用户 A 的桥接断开，后端调用 `removeUserRuntimeAutoSubscription(A)`。
3. 用户 B 仍在线，所以统一调度器继续存在。
4. 用户 A 前端请求 `auto_status`。
5. 由于 `autoSchedulerState[key]` 存在，A 可能仍显示正在运行或有倒计时。

这会破坏业务要求：

- 用户桥接断开后不订阅。
- 不接收自动推理信号。
- 前端状态应说明等待连接后恢复订阅，而不是显示已经参与运行。

### 修改要求

在 `getUserAutoRuntimeStatus(userId)` 中，统计 runtime 状态时必须先确认当前用户实际在该调度器订阅集合中：

```js
const st = autoSchedulerState[key]
if (!st || !st.subscribers || !st.subscribers.has(userId)) {
  continue
}
```

只有当前用户在 `st.subscribers` 中，才允许：

- 加入 `activeKeys`
- 累计 `subscriber_count`
- 读取 `inFlight`
- 读取 `lastError`
- 读取 `waitReason`
- 读取 `lastRunAt`
- 读取 `lastSignalId`
- 读取 Redis cooldown TTL

如果用户已开启自动推理，但没有任何实际 runtime 订阅：

- 若用户桥接离线：`paused_reason = 'user_bridge_offline'`
- 若用户桥接在线但无调度器：`paused_reason = 'no_runtime_scheduler'`

### 验收标准

1. 用户 A/B 同策略同品种，A 断桥、B 在线时：
   - A 的 `auto_status.active_scheduler_keys` 为空。
   - A 的 `paused_reason = user_bridge_offline`。
   - A 前端主状态仍是“自动推理开启”，title 说明桥接离线/等待恢复订阅。
   - B 正常运行。
2. A 重新连接桥接后：
   - A 被重新加入订阅。
   - `active_scheduler_keys` 恢复。

## P1：澄清 Redis 配置状态与 runtime 订阅状态，避免离线用户污染订阅数

### 当前问题

`server/routes/ai/scheduler.js` 的 `rebuildRedisSubscriptions()` 会把数据库中所有 `auto_scheduler.enabled = 1` 的用户写入 Redis scheduler subs：

```js
auto:scheduler:{promptTypeId}:{symbol}:subs
```

但真正运行时 `startUnifiedScheduler()` 又通过 `getAutoSubscribers(..., isBridgeAlive)` 过滤，只把在线桥接用户放进内存 `st.subscribers`。

这导致 Redis 中的 `subs` 和内存 runtime subscribers 语义不一致：

- Redis subs 可能包含离线用户。
- 内存 subscribers 只包含在线用户。
- 管理面板如果从 Redis `SCARD` 读订阅数，会把离线用户也算进去。
- 未来如果有人按 Redis subs 分发信号，会有误推送风险。

### 目标语义

请明确区分两类状态：

1. **配置状态**：用户在数据库中已开启自动推理，选择了策略和品种。
2. **runtime 订阅状态**：用户当前桥接在线，并且实际加入了统一调度器。

业务规则：

- `auto:scheduler:*:subs` 应表示 runtime 订阅者，不应包含桥接离线用户。
- 用户配置状态可以保留在 `auto:user:{userId}:auto`，但不要把它和 runtime subs 混为一谈。

### 修改要求

推荐方案：

1. `rebuildRedisSubscriptions()` 恢复为只写入桥接在线用户到 `auto:scheduler:*:subs`。
2. 如果需要保留所有 enabled 用户配置，可单独保存在：

```text
auto:user:{userId}:auto
```

或者新增配置索引 key，例如：

```text
auto:configured:keys
auto:configured:{promptTypeId}:{symbol}:users
```

但本任务不强制新增配置索引。优先保证 `auto:scheduler:*:subs` 只代表 runtime 在线订阅。

3. `syncUserRedisSubscription()` 仍用于用户桥接在线、开启自动推理、保存配置后同步 runtime 订阅。
4. `removeUserRuntimeAutoSubscription()` 断桥时必须从 runtime subs 移除用户。
5. `admin_dashboard` 中如果展示“实时订阅者数”，应从 runtime subs 或内存状态取值，不要把 DB enabled 用户当 runtime 订阅者。
6. 如果还想展示“配置开启人数”，请另命名为“已开启配置人数”，不要叫订阅者数。

### 验收标准

1. 服务重启后，桥接离线用户不会出现在 `auto:scheduler:*:subs`。
2. 用户桥接连接后，如果 DB 中 enabled=1，会加入 runtime subs。
3. 用户桥接断开后，会从 runtime subs 删除。
4. 管理面板“订阅者数”只统计在线 runtime 订阅用户。
5. 不影响观摩模式读数据。

## P1：多周期 `used_timeframes` 应反映实际成功使用的周期

### 当前问题

`runUnifiedAutoCycle()` 当前可能这样写：

```js
const tags = parseTimeframeTags(prompt, 'auto')
const usedTimeframes = tags.length > 0 ? tags.map(t => t.tf) : ['M5']
market.strategy_context = await buildStrategyContextFromTags(...)
market.used_timeframes = usedTimeframes
```

但 `buildStrategyContextFromTags()` 内部如果某个周期行情为空，会跳过该周期：

```js
if (rates.length === 0) continue
```

因此 `market.used_timeframes` 可能写了 `M15/H1/H4`，但实际 `strategy_context.timeframes` 里只有 `M15`。

### 修改要求

1. 保存三个字段，语义明确：

```js
market.primary_timeframe = primaryTf
market.requested_timeframes = requestedTimeframes
market.used_timeframes = actualUsedTimeframes
market.missing_timeframes = missingTimeframes
```

2. `requested_timeframes` 来自策略标签：

```js
const requestedTimeframes = tags.length > 0 ? tags.map(t => t.tf) : ['M5']
```

3. `used_timeframes` 必须来自实际成功构建出来的上下文：

```js
const actualUsedTimeframes = Object.keys(market.strategy_context?.timeframes || {})
```

4. `missing_timeframes` 为：

```js
requestedTimeframes.filter(tf => !actualUsedTimeframes.includes(tf))
```

5. 是否因为缺失周期而阻断本轮，由你结合现有逻辑判断。建议：
   - 如果主周期行情都取不到，已有 `rates_failed/rates_empty` 阻断。
   - 如果非主周期缺失，可以不阻断，但必须记录 `missing_timeframes`。
   - 如果后续希望强制多周期完整，再单独做策略配置项。

### 验收标准

1. 策略标签 `M15 + H1 + H4`，但 H4 获取失败：
   - `requested_timeframes = ['M15','H1','H4']`
   - `used_timeframes` 只包含实际成功的周期。
   - `missing_timeframes` 包含 `H4`。
2. 信号列表仍显示主周期 `M15`。
3. TTL 仍按主周期计算。

## P1：统一策略品种解析，避免大小写/空格/后缀误判

### 当前问题

已经新增了 `parsePromptSymbols(symbolsJson)`，但仍有几处直接：

```js
JSON.parse(pt.symbols_json || '[]')
strategySymbols.includes(s)
```

例如：

- `saveUserAutoConfig()` 校验用户选择品种时。
- `reconcileAutoSchedulers()` 计算用户选择和策略支持品种交集时。

如果历史数据里存在大小写、空格、后缀等格式差异，可能误判。

### 修改要求

1. 所有解析 `auto_prompt_types.symbols_json` 的地方统一使用 `parsePromptSymbols()`。
2. 用户选择品种也统一标准化：

```js
String(s).toUpperCase().trim()
```

3. 交集判断必须基于标准化后的数组。
4. 不要破坏带后缀品种：

- `XAUUSD`
- `XAUUSD.S`
- `XAUUSD.C`

这些应被视为不同品种，不能模糊匹配。

### 验收标准

1. 策略品种保存为 `xauusd.s `，用户选择 `XAUUSD.S`，校验通过。
2. 策略只支持 `XAUUSD.S`，用户选择 `XAUUSD`，校验失败。
3. reconcile 不会因为大小写或空格导致调度器没启动。

## P1：自动交易读操作应强制使用用户自己的桥接

### 当前问题

`executeDelivery()` 在自动交易前检查了：

```js
if (!isBridgeAlive(userId)) return
```

但后续 `executeOrder()` 中读取：

```js
mt5Bridge(userId, 'account', {})
mt5Bridge(userId, 'positions', {})
mt5Bridge(userId, 'quote', ...)
```

而 `sendBridgeCommand()` 对读操作支持管理员桥接 fallback：

```js
const readActions = ['account', 'positions', 'rates', 'symbols', 'quote']
```

在用户桥接刚断开的竞态下，风控读取可能 fallback 到管理员桥接数据。最终 `open` 不会 fallback，但风控输入不纯。

### 修改要求

自动交易执行路径应强制使用用户自己的桥接读取 account/positions/quote。

可选实现：

1. 给 `mt5Bridge()` / `sendBridgeCommand()` 增加参数，例如：

```js
mt5Bridge(userId, action, params, { noFallback: true })
```

或

```js
sendBridgeCommand(userId, action, params, timeoutMs, { noFallback: true })
```

2. `executeOrder()` 增加参数：

```js
async function executeOrder(userId, config, request, action, options = {})
```

3. `executeDelivery()` 调用：

```js
executeOrder(userId, riskConfig, order, 'ai_auto_execute', { noFallback: true })
```

4. 手动执行和观摩模式读操作不要受影响。
5. 如果用户桥接在读取 account/positions/quote 期间断开，自动执行应失败/跳过，不得读取管理员桥接数据。

### 验收标准

1. 自动交易执行过程中，用户桥接断开时：
   - 不 fallback 管理员桥接。
   - delivery execution_status 记录 skipped/failed。
2. 手动观摩读行情、账户、持仓仍可 fallback 管理员桥接。
3. 手动执行设计不变。

## P2：修正调度器订阅者数量统计口径

### 当前问题

`reconcileAutoSchedulers()` 中更新已有调度器时：

```js
autoSchedulerState[k].subscriberCount = countSubscribers(meta.promptTypeId)
```

`countSubscribers(promptTypeId)` 是按策略累计，不是当前策略 + 当前品种。

### 影响

管理面板或状态中，某个具体品种调度器的订阅者数可能显示成整个策略的订阅者总数。

### 修改要求

1. 对单个调度器，`subscriberCount` 应等于：

```js
st.subscribers.size
```

2. 如果需要策略总订阅数，另起字段名，例如：

```js
promptSubscriberCount
```

3. 不要把策略总数写进单个 symbol 调度器的 `subscriberCount`。

### 验收标准

同一策略下：

- XAUUSD 有 2 个订阅者。
- BTCUSD 有 1 个订阅者。

管理面板应分别显示 2 和 1，不要都显示 3。

## P2：优化 `getAutoSubscribers()` 查询，避免 LIKE 语义不清

### 当前问题

当前查询中包含：

```sql
AND (s.symbols LIKE ? OR s.symbols LIKE ?)
```

然后再在 JS 中 JSON.parse 精确过滤。

这个 LIKE 只是预过滤，但语义容易误导，且不可稳定使用索引。

### 修改建议

短期可以保留，但建议至少：

1. 注释说明 LIKE 只是减少候选行，最终以 JS 精确 JSON 匹配为准。
2. 不要依赖 LIKE 做正确性判断。

中期建议：

1. 新增规范化订阅表，例如：

```text
auto_scheduler_symbols(user_id, prompt_type_id, symbol, enabled)
```

2. 用户保存配置时同步这张表。
3. `getAutoSubscribers()` 直接按 `(prompt_type_id, symbol, enabled)` 查询。

本任务不强制新增表，先修正确性问题。

## 不要修改的内容

1. 不要让手动执行强制走后端风控。
2. 不要取消观摩模式。
3. 不要把自动推理改回按用户调度。
4. 不要让离线用户接收自动推理信号。
5. 不要让离线用户开启 runtime 自动推理订阅。
6. 不要处理桥接客户端打包。

## 建议补充测试

建议至少补充以下单元测试或轻量 mock 测试：

1. `upsertAutoConfig()` 使用 `withTransaction(run)` 不报错。
2. `getUserAutoRuntimeStatus()`：
   - 有同策略/品种调度器，但当前 userId 不在 `st.subscribers` 时，不应返回 active scheduler。
3. `parsePromptSymbols()`：
   - 大小写归一。
   - trim。
   - 去重。
   - `XAUUSD` 与 `XAUUSD.S` 不混淆。
4. 多周期字段：
   - `requested_timeframes`
   - `used_timeframes`
   - `missing_timeframes`
5. 自动交易 noFallback：
   - 用户桥接断开时，不读取管理员桥接 account/positions/quote。

## 验证命令

至少执行：

```bash
node --check server/routes/ai/config.js
node --check server/routes/ai/scheduler.js
node --check server/bridge-ws.js
node --check public/ai/app.js
npm.cmd test
```

如果在非 Windows shell 下执行，可用：

```bash
npm test
```

## Mimo 输出要求

完成后写结果文件：

`docs/agent-results/20260702-mimo-auto-inference-followup-fix-result.md`

结果文件必须包含：

1. 修改文件列表。
2. 每个 P0/P1/P2 项是否完成。
3. 未完成项和原因。
4. 执行过的验证命令和结果。
5. 是否改动了手动执行或观摩模式，如有必须说明原因。
