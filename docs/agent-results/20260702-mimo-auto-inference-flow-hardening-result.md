# 自动推理流程一致性与稳定性优化 — 执行结果

## 修改文件

1. `server/routes/ai/scheduler.js` — 核心调度器修改
2. `server/routes/ai/config.js` — 新增 `parsePromptSymbols` 辅助函数
3. `server/bridge-ws.js` — auto_state 发送修正
4. `public/ai/app.js` — 前端 auto_state / auto_progress_done 处理

## 任务完成情况

### 任务 1：修复策略周期、行情周期、信号周期、TTL 不一致 ✅

- `runUnifiedAutoCycle()` 不再接收 `timeframe` 参数
- 从策略提示词解析 `primaryTf` 和 `usedTimeframes`
- `ai_signals.timeframe`、`signal.timeframe`、`signalTtlSeconds()`、`new_signal` 推送、audit 入参全部使用 `primaryTf`
- `market_data_json` 增加 `primary_timeframe` 和 `used_timeframes` 字段
- 策略无周期标签时默认 `M5`

### 任务 2：失败不应消耗完整调度间隔 ✅

- 新增 `retryDelayMs(reason)` 辅助函数
  - `admin_bridge_offline` / `market_*` / `redis_unavailable` → 5s
  - `rates_failed` / `rates_empty` / `exception` → 20s
  - `no_api_key` / `strategy_disabled` / `symbol_not_supported` → 45s
- Redis cooldown 只在成功完成推理后设置
- 失败时使用短重试间隔

### 任务 3：拆分 lastError 与正常等待状态 ✅

- `lastError` 只记录真正异常（`exception`、`rates_failed` 等）
- 新增 `waitReason` 字段记录正常等待原因
- `getUserAutoRuntimeStatus()` 返回新增 `wait_reason` 字段
- `updateSchedulerRedisState()` 新增 `wait_reason` 和 `next_run_in_seconds` 字段

### 任务 4：自动推理状态语义修正 ✅

- `bridge-ws.js` 断开时查询 DB 获取真实 enabled 状态，不硬编码 `enabled: false`
- `auto_state` 新增 `runtime_subscribed` 字段
- 前端收到 `auto_state` 后调用 `renderAutoAnalyzeBadge()`，不误显示"关闭"
- 桥接断开时 toast 提示"等待连接后自动恢复订阅"

### 任务 5：补充自动推理进度结束事件 ✅

- 新增 `broadcastAutoProgressDone()` 函数
- 每轮结束（成功/阻塞/异常）都推送 `auto_progress_done` 事件
- 前端收到后清除 `in_flight`，更新 `paused_reason`，重新渲染 badge

### 任务 6：策略品种校验改为 JSON 精确匹配 ✅

- 新增 `parsePromptSymbols(symbolsJson)` 辅助函数：JSON.parse → trim → uppercase → 去重
- `runUnifiedAutoCycle()` 使用 `parsePromptSymbols` + `includes` 精确匹配
- `saveAutoPromptType()` 拒空品种策略
- `getAutoSubscribers()` 使用 uppercase 匹配

### 任务 7：增加调度器自愈 reconcile ✅

- 新增 `startAutoSchedulerReconciler()`，每 60 秒执行一次
- 在 `initAutoSchedulers()` 中自动启动
- 幂等设计，不会重复创建调度器

### 任务 8：确认观摩模式边界 ✅

- `toggle_auto` 开启时要求用户桥接在线（已有）
- `getAutoSubscribers` 过滤离线用户（已有）
- `executeDelivery` 检查 `isBridgeAlive`（已有）
- `reconcileAutoSchedulers` 不添加离线用户到订阅（已有）
- 观摩模式读操作不受影响

## 验证结果

- `node --check server/routes/ai/scheduler.js` ✅
- `node --check server/bridge-ws.js` ✅
- `node --check server/routes/ai/config.js` ✅
- `node --check public/ai/app.js` ✅
- `vitest run` — 6 files, 75 tests 全部通过 ✅

## 未完成项

无。所有 8 个任务点均已完成。

## 新增风险

1. **reconcile 频率**：60 秒一次可能在高并发时产生额外 DB 查询，但 reconcile 本身是幂等的，影响可控。
2. **retryDelayMs 默认值**：未知 reason 默认 15s，如果出现新的 reason 类型可能需要调整。
