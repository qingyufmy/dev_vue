# Mimo Code 任务：修复休市/行情停滞时自动推理仍可能运行的问题

## 背景

当前项目已重构为“统一自动推理调度器”：

- 调度器按 `prompt_type_id + symbol` 维度运行。
- 用户开启自动推理后，会订阅对应策略和品种的统一调度器。
- 调度器使用管理员当前桥接的 MT5 数据生成共享信号。
- 生成信号后，再分发给所有订阅该策略和品种的用户。
- 如果用户启用了自动交易，再按用户自己的桥接状态和风控配置执行交易。

现在发现一个必须修复的问题：

> 休市时，所有自动推理都必须暂停，不能生成信号，不能推送信号，不能自动执行交易。

同时，前一轮修复还涉及“用户桥接未连接时不应订阅/接收信号”。这两个问题有交叉，需要一起检查，避免只修了断连用户，但休市时调度器仍然继续跑。

## 当前代码观察

重点文件：

- `server/bridge-ws.js`
- `server/routes/ai/scheduler.js`
- `server/routes/ai/config.js`

目前已有一些市场状态逻辑：

1. `server/bridge-ws.js` 中，收到桥接 `msg.type === 'data'` 且包含 `msg.quote.time` 时，会记录：
   - `bridge.lastTickMs`
   - `bridge.mt5TimeStr`
   - `bridge.lastTradeMode`

2. 当 `quote.time` 变化时，会设置：
   - `bridge.lastTradeMode = 4`

3. 当 `quote.time` 长时间不变时，会设置：
   - `bridge.lastTradeMode = 0`

4. `server/routes/ai/scheduler.js` 的统一调度器 tick 中已有管理员桥接状态判断：
   - 无管理员桥接：暂停
   - `getOwnBridgeTradeMode(adminUserId)` 返回 `0` 或 `-1`：暂停

5. `runUnifiedAutoCycle()` 中也已有二次判断：
   - `tradeMode !== 4` 时直接返回，不进入 AI 推理。

但当前实现仍有风险：

- 注释写的是“tick time unchanged for 5 min”，实际代码是 `5000ms`，注释和实现不一致。
- 如果桥接仍然在线，但行情 `data` 不再推送，`lastTradeMode` 可能停留在之前的 `4`，调度器会误以为市场仍开放。
- 当前市场状态只返回一个数字，缺少 `lastTickMs`、行情年龄、暂停原因等状态，不利于调度器做可靠判断和前端展示。
- `reconcileAutoSchedulers()` 可能会创建/保留调度器，这本身可以接受，但调度器 tick 和 `runUnifiedAutoCycle()` 必须硬性阻止休市推理。

## 目标

实现统一、可靠的市场状态判断：

1. 管理员桥接离线时，所有统一自动推理暂停。
2. 管理员桥接在线但市场休市时，所有统一自动推理暂停。
3. 管理员桥接在线但行情 tick 停滞或长时间没有新行情时，所有统一自动推理暂停。
4. 暂停期间：
   - 不调用 AI。
   - 不写入 `ai_signals`。
   - 不写入 `auto_signal_deliveries`。
   - 不向用户推送 `new_signal`。
   - 不执行自动交易。
5. 恢复开市后，调度器自动继续，不需要用户重新开启自动推理。
6. 用户桥接离线时，不应作为有效订阅者接收信号；但管理员市场状态判断必须以管理员桥接为准。

## 建议设计

### 1. 在 `server/bridge-ws.js` 增加统一市场状态函数

新增导出函数，例如：

```js
export function getOwnBridgeMarketState(userId) {
  const bridge = bridges.get(userId)
  if (!bridge || bridge.ws.readyState !== 1) {
    return {
      alive: false,
      isOpen: false,
      tradeMode: -1,
      reason: 'bridge_offline',
      lastTickMs: null,
      tickAgeMs: null,
      mt5TimeStr: null,
    }
  }

  const now = Date.now()
  const lastTickMs = bridge.lastTickMs || null
  const tickAgeMs = lastTickMs ? now - lastTickMs : null
  const tradeMode = typeof bridge.lastTradeMode === 'number' ? bridge.lastTradeMode : -1

  // 阈值可以先写成常量，避免魔法数字散落。
  // 建议默认 60 秒或 120 秒。不要继续使用注释为 5 分钟、实现为 5 秒的不一致写法。
  const staleMs = MARKET_TICK_STALE_MS

  if (!lastTickMs) {
    return { alive: true, isOpen: false, tradeMode, reason: 'market_unknown_no_tick', lastTickMs, tickAgeMs, mt5TimeStr: bridge.mt5TimeStr || null }
  }

  if (tickAgeMs > staleMs) {
    return { alive: true, isOpen: false, tradeMode, reason: 'market_stale_tick', lastTickMs, tickAgeMs, mt5TimeStr: bridge.mt5TimeStr || null }
  }

  if (tradeMode !== 4) {
    return { alive: true, isOpen: false, tradeMode, reason: tradeMode === 0 ? 'market_closed' : 'market_unknown', lastTickMs, tickAgeMs, mt5TimeStr: bridge.mt5TimeStr || null }
  }

  return { alive: true, isOpen: true, tradeMode: 4, reason: 'market_open', lastTickMs, tickAgeMs, mt5TimeStr: bridge.mt5TimeStr || null }
}
```

保留现有 `getOwnBridgeTradeMode(userId)`，但可以让它基于新函数返回 `tradeMode`，减少重复逻辑。

### 2. 统一修正 tick 停滞判断

在 `server/bridge-ws.js` 顶部定义常量，例如：

```js
const MARKET_SAME_TICK_CLOSED_MS = 60_000
const MARKET_TICK_STALE_MS = 120_000
```

或如果项目更希望快速暂停，也可以使用：

```js
const MARKET_SAME_TICK_CLOSED_MS = 15_000
const MARKET_TICK_STALE_MS = 60_000
```

要求：

- 不要出现“注释 5 分钟，代码 5 秒”的不一致。
- `quote.time` 不变超过 `MARKET_SAME_TICK_CLOSED_MS`，设置 `lastTradeMode = 0`。
- 距离最后一次收到行情数据超过 `MARKET_TICK_STALE_MS`，市场状态函数必须返回 `isOpen: false`。

注意：

- `MARKET_SAME_TICK_CLOSED_MS` 用于判断同一个 MT5 tick 时间是否停滞。
- `MARKET_TICK_STALE_MS` 用于判断桥接虽然在线，但服务器已经太久没有收到任何行情 data。
- 两者都应该导致自动推理暂停。

### 3. 在统一调度器 tick 前使用市场状态函数

修改 `server/routes/ai/scheduler.js`：

当前逻辑大致是：

```js
const adminTradeMode = getOwnBridgeTradeMode(adminUserId)
if (adminTradeMode === 0 || adminTradeMode === -1) {
  pause
}
```

改为：

```js
const marketState = getOwnBridgeMarketState(adminUserId)
if (!marketState.isOpen) {
  st._waitCount = (st._waitCount || 0) + 1
  st.lastError = marketState.reason
  st.marketState = marketState
  await updateSchedulerRedisState(key, st)
  autoSchedulerState[key].timer = setTimeout(tick, tickIntervalMs)
  return
}
```

要求：

- 管理员市场状态非 open 时，必须在 Redis lock/cooldown 前就返回。
- 休市/行情停滞期间，不应该占用 Redis cooldown，避免开市后还要等一轮间隔。
- `lastError` 要能区分：
  - `admin_bridge_offline`
  - `market_closed`
  - `market_unknown`
  - `market_unknown_no_tick`
  - `market_stale_tick`

### 4. 在 `runUnifiedAutoCycle()` 内再次硬性检查

`runUnifiedAutoCycle()` 是真正生成信号的位置，即使外层 tick 漏掉，也必须在这里兜底。

当前逻辑：

```js
const tradeMode = getOwnBridgeTradeMode(adminUserId)
if (tradeMode !== 4) { return }
```

改为：

```js
const marketState = getOwnBridgeMarketState(adminUserId)
if (!marketState.isOpen) {
  l(`BLOCKED: market not open (${marketState.reason}, tradeMode=${marketState.tradeMode}, tickAgeMs=${marketState.tickAgeMs})`)
  return
}
```

要求：

- 这个判断必须发生在调用 `mt5Bridge(adminUserId, 'account')`、`positions`、`rates` 之前。
- 如果 marketState 非 open，不能写 `ai_signals`、不能推送、不能执行。

### 5. 更新 Redis 调度状态

`updateSchedulerRedisState()` 当前应该已经会写调度器状态。需要确认并补充字段：

- `lastError`
- `market_reason`
- `market_trade_mode`
- `market_tick_age_ms`
- `market_mt5_time`
- `lastRunAt`
- `subscriberCount`
- `running`

休市暂停时也要写 Redis state，方便之后前端或管理端查看“为什么没有跑”。

不要给这些状态设置过期时间。用户之前要求调度器状态和订阅关系可以长期保存在 Redis 中。

### 6. 订阅者过滤继续保留桥接在线判断

当前 `getAutoSubscribers(promptTypeId, symbol, bridgeAliveCheck)` 已支持传入桥接在线检查。

要求继续保持：

- `startUnifiedScheduler()` 调用 `getAutoSubscribers(promptTypeId, symbol, isBridgeAlive)`
- tick 刷新订阅时也调用 `getAutoSubscribers(promptTypeId, symbol, isBridgeAlive)`
- `runUnifiedAutoCycle()` 在真正写 delivery / push `new_signal` 前，最好再从当前 state 过滤一次 `isBridgeAlive(uid)`，避免用户刚刚断开桥接但 state 还没刷新。

建议：

```js
const subscribers = new Set(
  [...(st?.subscribers || [])].filter(uid => isBridgeAlive(uid))
)
```

这样可以避免离线用户收到新信号或写入 delivery。

### 7. 断连和重连行为

确认并修正以下行为：

#### 用户桥接断连

- 从运行态订阅中移除该用户。
- Redis 订阅集合中移除该用户，或至少下次 rebuild/reconcile 不把离线用户加入运行态。
- 不给该用户写新的 `auto_signal_deliveries`。
- 不给该用户推送 `new_signal`。

数据库中的 `auto_scheduler.enabled` 可以保留为 `1`，作为用户偏好。这样用户重连后可自动恢复。

#### 用户桥接重连

- 如果 DB 中 `auto_scheduler.enabled = 1`，且用户是 pro，且策略和品种有效，则恢复运行态订阅。
- 但是否恢复必须仍受管理员桥接市场状态控制：
  - 开市：可恢复并等待调度间隔。
  - 休市：恢复订阅，但调度器暂停，不生成信号。

#### 管理员桥接断连

- 所有统一调度器暂停。
- 不生成信号。
- 不推送。
- 不执行。

#### 管理员桥接重连

- 先等待市场状态变为 open。
- 如果市场状态为 unknown/no_tick/stale/closed，继续暂停。
- 市场状态 open 后，调度器继续按 Redis cooldown/lock 运行。

### 8. 前端/状态展示建议

如果当前前端已有自动推理状态显示，可以只做最小展示：

- 当调度器 `lastError` 为以下值时，显示“自动推理暂停”：
  - `admin_bridge_offline`
  - `market_closed`
  - `market_unknown`
  - `market_unknown_no_tick`
  - `market_stale_tick`

可以先不做复杂 UI，但后端返回或 Redis state 中必须有明确原因。

### 9. 不要改动的范围

本任务不要做以下事情：

- 不要改主分支。
- 不要改数据库表结构，除非确实必须。
- 不要重构整个自动推理模块。
- 不要改策略提示词管理 UI。
- 不要改自动交易风控逻辑。
- 不要把休市判断做成按用户桥接判断。统一自动推理的数据源是管理员 MT5，因此开/休市判断必须以管理员桥接为准。

## 关键验收场景

### 场景 1：管理员桥接未连接

步骤：

1. 至少一个 pro 用户开启自动推理。
2. 管理员桥接断开。
3. 等待超过一个调度 tick。

期望：

- 不调用 AI。
- 不新增 `ai_signals`。
- 不新增 `auto_signal_deliveries`。
- 不推送 `new_signal`。
- 调度器状态中 `lastError = admin_bridge_offline`。

### 场景 2：管理员桥接在线，但没有收到行情 tick

步骤：

1. 管理员桥接 WebSocket 在线。
2. 停止发送 `msg.type = data` 或停止发送 `quote.time`。
3. 等待超过 `MARKET_TICK_STALE_MS`。

期望：

- 自动推理暂停。
- 不调用 AI。
- `lastError = market_stale_tick` 或 `market_unknown_no_tick`。

### 场景 3：管理员桥接在线，但 `quote.time` 长时间不变

步骤：

1. 管理员桥接持续发送 data。
2. `quote.time` 始终不变。
3. 等待超过 `MARKET_SAME_TICK_CLOSED_MS`。

期望：

- `bridge.lastTradeMode = 0`。
- 调度器暂停。
- 不生成信号。
- `lastError = market_closed`。

### 场景 4：市场重新开市

步骤：

1. 先让市场进入 closed/stale 状态。
2. 再恢复发送变化的 `quote.time`。

期望：

- `bridge.lastTradeMode = 4`。
- 调度器不需要用户重新开启。
- 后续按 Redis cooldown/interval 正常运行。

### 场景 5：普通用户桥接断开

步骤：

1. 用户 A、用户 B 都订阅同一策略和品种。
2. 用户 A 桥接断开。
3. 用户 B 桥接保持在线。
4. 管理员桥接开市。

期望：

- 用户 A 不收到新的 `new_signal`。
- 用户 A 不新增 `auto_signal_deliveries`。
- 用户 B 正常收到信号。
- 调度器继续运行，因为仍有有效订阅者。

### 场景 6：所有订阅用户都断开

步骤：

1. 某个 `prompt_type_id + symbol` 只有一个或多个用户订阅。
2. 这些用户全部桥接断开。

期望：

- 调度器停止或保持无订阅暂停状态。
- 不继续生成共享信号。
- Redis state 中 subscriberCount 应为 0 或调度器 state 被清理。

## 建议增加的测试

如果项目现有测试方便覆盖，建议增加以下单元/集成测试：

1. `getOwnBridgeMarketState()`：
   - bridge offline => `isOpen=false`, reason=`bridge_offline`
   - no tick => `isOpen=false`, reason=`market_unknown_no_tick`
   - stale tick => `isOpen=false`, reason=`market_stale_tick`
   - tradeMode 0 => `isOpen=false`, reason=`market_closed`
   - tradeMode 4 + recent tick => `isOpen=true`

2. `runUnifiedAutoCycle()`：
   - market closed 时不会调用 `maybeAiSignal`
   - market closed 时不会写 `ai_signals`
   - market closed 时不会写 `auto_signal_deliveries`

3. `startUnifiedScheduler()` tick：
   - market closed 时不会执行 Redis cooldown
   - market closed 时 `lastError` 更新为对应原因

如果现有测试结构不方便 mock WebSocket/bridge，可以至少用 `node --check` 和手工模拟日志验证，但需要在结果文档中说明未覆盖的测试缺口。

## 完成后请输出

请在 `docs/agent-results/` 下新增结果文件，例如：

`docs/agent-results/20260701-mimo-auto-market-closed-pause-fix-result.md`

结果文件需要包含：

- 修改了哪些文件。
- 具体实现了哪些逻辑。
- 是否新增测试。
- 执行过哪些检查命令。
- 是否存在遗留风险。
- 如果没有实现某一项验收场景，需要明确说明原因。

## 推荐检查命令

至少执行：

```powershell
node --check server/bridge-ws.js
node --check server/routes/ai/scheduler.js
node --check server/routes/ai/config.js
npm test
```

如果 `npm test` 因环境或依赖失败，请记录失败原因，不要忽略。
