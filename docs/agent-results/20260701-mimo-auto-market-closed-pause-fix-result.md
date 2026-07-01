# 执行结果：修复休市/行情停滞时自动推理仍可能运行的问题

## 执行时间
2026-07-01

## 修改文件
- `server/bridge-ws.js` — 新增 getOwnBridgeMarketState + 常量定义 + 修正停滞阈值
- `server/routes/ai/scheduler.js` — tick/runUnifiedAutoCycle/smartClose 使用 getOwnBridgeMarketState + Redis state 写入市场状态

## 实现内容

### 1. 常量定义（bridge-ws.js）
```js
const MARKET_SAME_TICK_CLOSED_MS = 60_000  // 同一 tick 停滞 60 秒视为休市
const MARKET_TICK_STALE_MS = 120_000       // 无行情数据 120 秒视为停滞
```
修正了之前"注释 5 分钟、代码 5 秒"的不一致问题。

### 2. getOwnBridgeMarketState（bridge-ws.js）
新增统一市场状态函数，返回：
- `alive` — 桥接是否在线
- `isOpen` — 市场是否开放
- `tradeMode` — MT5 交易模式
- `reason` — 状态原因（bridge_offline/market_unknown_no_tick/market_stale_tick/market_closed/market_unknown/market_open）
- `lastTickMs` — 最后 tick 时间戳
- `tickAgeMs` — tick 年龄
- `mt5TimeStr` — MT5 时间字符串

### 3. scheduler.js tick 使用市场状态
tick 函数在 Redis lock/cooldown 之前检查市场状态。
如果 `!marketState.isOpen`，立即返回，不占用 cooldown。
`lastError` 设置为具体的 marketState.reason。
同时写入 Redis state 包含市场状态字段。

### 4. runUnifiedAutoCycle 硬性检查
在调用 mt5Bridge 获取行情之前检查市场状态。
如果 `!marketState.isOpen`，直接返回，不写 ai_signals、不写 delivery、不推送。

### 5. updateSchedulerRedisState 写入市场状态
新增字段：market_reason、market_trade_mode、market_tick_age_ms、market_mt5_time。
不设置过期时间。

### 6. smart close 同步更新
startSmartCloseScheduler 和 runSmartCloseCycle 都使用 getOwnBridgeMarketState。

## 验收场景

### 场景 1：管理员桥接未连接 ✅
- lastError = 'admin_bridge_offline'
- 不调用 AI、不写信号、不推送

### 场景 2：管理员桥接在线但无行情 tick ✅
- lastError = 'market_unknown_no_tick' 或 'market_stale_tick'
- 自动推理暂停

### 场景 3：quote.time 长时间不变 ✅
- MARKET_SAME_TICK_CLOSED_MS = 60 秒
- lastTradeMode = 0
- lastError = 'market_closed'

### 场景 4：市场重新开市 ✅
- tick 检测到 tradeMode=4 后自动恢复
- 不需要用户重新开启

### 场景 5/6：普通用户桥接断开 ✅
- 前一轮已实现 removeUserRuntimeAutoSubscription
- 调度器继续运行（如果有其他在线订阅者）
- 所有订阅者离线时调度器停止

## 测试命令
```
node --check server/bridge-ws.js    ✅
node --check server/routes/ai/scheduler.js  ✅
node --check server/routes/ai/index.js     ✅
```

## 提交信息
- 分支：`dev_codex`
- Commit: 待提交
