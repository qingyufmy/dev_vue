# 自动推理后续审查问题修复结果

## 修改文件列表

1. `server/routes/ai/config.js` — P0 事务修复 + P1 品种解析统一 + P2 LIKE 注释
2. `server/routes/ai/scheduler.js` — P0 订阅者检查 + P1 多周期字段 + P1 Redis 重建 + P2 统计口径
3. `server/bridge-ws.js` — P0 auto_status 观摩模式修复 + P1 noFallback 参数
4. `server/routes/ai/market-data.js` — P1 noFallback 参数透传
5. `public/ai/app.js` — 观摩模式 UI 同步修复（前置任务）

## P0 完成情况

### P0-1: upsertAutoConfig() 事务使用错误 ✅

- 将 `withTransaction(async (conn) => { await conn.query(...) })` 改为 `withTransaction(async (run) => { await run(...) })`
- 验证全仓库无其他类似误用

### P0-2: auto_status 误把别人的调度器算作当前用户运行中 ✅

- `getUserAutoRuntimeStatus()` 中增加 `st.subscribers.has(userId)` 检查
- 只有用户实际在 `st.subscribers` 中才计入 activeKeys
- 用户已开启但无 runtime 订阅时，根据桥接状态设置 `paused_reason`

## P1 完成情况

### P1-1: Redis 配置状态与 runtime 订阅状态区分 ✅

- `rebuildRedisSubscriptions()` 现在只写入 `isBridgeAlive()` 的用户到 `auto:scheduler:*:subs`
- 离线用户不污染 Redis runtime subs

### P1-2: 多周期 used_timeframes 反映实际成功使用的周期 ✅

- 新增 `requested_timeframes`（来自策略标签）
- `used_timeframes` 改为从 `strategy_context.timeframes` 实际构建结果取值
- 新增 `missing_timeframes`（requested - used）

### P1-3: 统一策略品种解析 ✅

- `reconcileAutoSchedulers()` 中改用 `parsePromptSymbols()` 替代直接 `JSON.parse`
- `saveUserAutoConfig()` 中改用 `parsePromptSymbols()` 校验品种
- 所有品种比较基于标准化后的数组（UPPERCASE + TRIM）

### P1-4: 自动交易读操作强制使用用户自己的桥接 ✅

- `sendBridgeCommand()` 增加 `options.noFallback` 参数
- `mt5Bridge()` / `executeViaBridge()` 透传 options
- `executeOrder()` 增加 options 参数
- `executeDelivery()` 调用时传 `{ noFallback: true }`
- 手动执行和观摩模式读操作不受影响

## P2 完成情况

### P2-1: 修正调度器订阅者数量统计口径 ✅

- `reconcileAutoSchedulers()` 中改为 `st.subscribers.size` 替代 `countSubscribers(promptTypeId)`
- 每个 symbol 调度器的 subscriberCount 只统计自己调度器的订阅者

### P2-2: 优化 getAutoSubscribers() LIKE 查询注释 ✅

- 添加注释说明 LIKE 只是预过滤，最终以 JS 精确 JSON 匹配为准

## 验证命令和结果

| 命令 | 结果 |
|------|------|
| `node --check server/routes/ai/config.js` | 通过 |
| `node --check server/routes/ai/scheduler.js` | 通过 |
| `node --check server/bridge-ws.js` | 通过 |
| `node --check server/routes/ai/market-data.js` | 通过 |
| `node --check public/ai/app.js` | 通过 |
| `vitest run` | 6 文件 75 测试全部通过 |
| `rg "withTransaction\(async \((conn\|connection)" server` | 无匹配（无其他误用） |

## 手动执行/观摩模式影响说明

- 未改变手动执行信号不走后端风控的设计
- 未取消观摩模式
- 观摩模式读操作（行情、账户、持仓）仍可 fallback 管理员桥接
- 手动执行信号仍使用 `mt5Bridge()` 默认行为（可 fallback）
- 自动交易执行路径（`executeDelivery` → `executeOrder`）强制使用用户自己的桥接
