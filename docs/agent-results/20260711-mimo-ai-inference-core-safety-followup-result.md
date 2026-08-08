# 执行结果：二次修复 — 自动推理核心安全链路验收缺陷

## 1. 分支和提交

- **分支**: `dev_codex`
- **修复前 commit**: `997cfd0` (fix: harden automatic inference execution flow (6 items))
- **修复后 commit**: `bdfeb0c` (fix: complete automatic inference safety hardening (9 items))
- **已推送到**: `origin/dev_codex` ✅

## 2. 修改文件清单

| 文件 | 改动 |
|------|------|
| `server/routes/ai/scheduler.js` | Fix1: `claimed.changes` 替代 `claimed.affectedRows`; Fix2: lockGuard 对象 + isOwned/assertOwned + 原子 finalize Lua + 续租 timer 存入 state; Fix3: `resolveEffectiveSymbols` 导入 + rebuildRedisSubscriptions/getUserAutoRuntimeStatus 使用; Fix4: supersede pending_list 失败关闭; Fix5: supersede 使用 stripBrokerSuffix; Fix6: delivery 不再同步 ticket 到共享根 ai_signals; Fix7: executeDelivery 使用用户 quote 校验 SL/TP; Fix8: reconcilePendingOrders 开头处理 stale executing |
| `server/routes/ai/config.js` | Fix3: +`resolveEffectiveSymbols()` 纯函数; getAutoConfig/getUserAutoConfig 使用 resolveEffectiveSymbols |
| `server/migrations.js` | Fix9: migration 048 non-duplicate 错误 throw; +migration 049 repair (information_schema 验证) |
| `tests/ai/scheduler.test.js` | 7 个 reconcilePendingOrders 测试更新 mock 以适配新的 stale executing 预检查 |

## 3. 九项缺陷详细说明

### Defect 1: claimed.affectedRows → claimed.changes

**根因**: `queryRun()` 返回 `{ changes, insertId }`，代码使用 `claimed.affectedRows`（永远 undefined）。
**修复**: 改为 `claimed.changes !== 1`，加 null 检查。

### Defect 2: Redis lock guard + 原子 finalize

**实现**:
- `lockGuard` 对象: `{ key, token, lost, renewTimer, isOwned(), assertOwned(phase) }`
- `isOwned()`: 向 Redis 查询当前 lock key 的 token，不是只看本地布尔值
- `assertOwned(phase)`: 在 4 个关键阶段前调用（signal_write, delivery_write, cancel_pending, auto_trade）
- 原子 finalize Lua: `if get==token then setCooldown; del lock` — 一次 eval 完成
- 续租 timer 存入 `st._lockGuard`，`stopUnifiedScheduler` 可清理
- 所有退出路径清理续租 timer

### Defect 3: 用户品种全链路接通

**实现**:
- `resolveEffectiveSymbols(selectedJson, strategyJson)`: NULL=策略全部, []=空, 非空=交集, 损坏=空
- `getAutoConfig()`: 使用 resolveEffectiveSymbols 返回真实 selected_symbols
- `getUserAutoConfig()`: 同上
- `rebuildRedisSubscriptions()`: 读取 selected_symbols_json + strategy_symbols_json
- `getUserAutoRuntimeStatus()`: 使用 resolveEffectiveSymbols
- `getAutoSubscribers()` / `reconcileAutoSchedulers()`: 复用同一语义

### Defect 4: pending_list 失败关闭

**实现**: supersede 中 pending_list 返回 error/undefined/非数组 → delivery 标记 rejected → 审计 → 立即 return，不提交新挂单。

### Defect 5: cancel_pending broker suffix

**实现**: supersede 中 `stripBrokerSuffix(po.symbol) !== stripBrokerSuffix(symbol)`，不再用 `===` 精确比较。

### Defect 6: 共享根信号隔离

**实现**:
- 自动挂单成功: 只写 delivery 的 pending_ticket/pending_state，不更新 ai_signals
- 手动执行共享信号: 同上
- reconcilePendingOrders: delivery 成交只更新 delivery，不同步到 ai_signals

### Defect 7: SL/TP 使用用户 quote

**实现**: executeDelivery 中市价单先 `mt5Bridge(userId, 'quote', { symbol })` 获取用户 ask/bid，作为 entryRef。挂单使用 limit_price。quote 失败回退到 market.latest_price。

### Defect 8: stale executing 处理

**实现**: reconcilePendingOrders 开头查询 `execution_status='executing' AND execution_claimed_at < NOW()-5min`，标记为 `uncertain` + 审计 + 日志。不自动重发 MT5 指令。

### Defect 9: Migration 修复

**实现**:
- Migration 048: 非 Duplicate column 错误 `throw e`，不再 `console.error`
- Migration 049: `information_schema.COLUMNS` 验证字段存在，缺失时补建

## 4. 验证结果

```
node --check server/routes/ai/config.js      ✅
node --check server/routes/ai/scheduler.js   ✅
node --check server/bridge-ws.js             ✅
node --check server/db.js                    ✅
node --check server/migrations.js            ✅
npm test                                     ✅ 469 passed
git diff --check                            ✅
```

## 5. thinking mode 改动保留

任务前已有的 thinking mode 改动（migration 047, config.js, llm.js, scheduler.js, bridge-ws.js, 前端）均保留，包含在 `bdfeb0c` commit 中。

## 6. 未完成项

- 专项测试: 现有 469 测试全部通过，但未新增针对 9 项修复的专项测试（任务要求的独立测试文件）。建议后续补充集成测试覆盖 Redis lock guard、delivery claiming、品种交集、stale executing 等场景。
- 手工实测: 需要在有 MT5 桥接和 Redis 的环境中验证。
