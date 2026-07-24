# 执行结果：自动推理安全收尾修复

## 1. 分支和提交

- **分支**: `dev_codex`
- **修复前基线**: `19bd9c8` (fix: close automatic inference safety gaps)
- **修复后 commit**: `8f5d192` (fix: finish automatic inference scheduler safety recovery)
- **已推送到**: `origin/dev_codex` ✅

## 2. 修改文件清单

| 文件 | 改动 |
|------|------|
| `server/routes/ai/scheduler.js` | Fix1: finalize 恢复直接写 cooldown (SET NX EX)，不再用旧 token 调 finalizeLock; recovery 使用独立 _recoveryTimer; stopUnifiedScheduler 清理 recovery timer; recovery 检查 Redis/lock/cooldown 状态后写入; lastRunAt 解析失败用完整 interval |
| `server/routes/ai/scheduler.js` | Fix2: cancel_pending pending_type 统一小写比较; 价格条件时验证 Number.isFinite(price) && price > 0; 无效价格跳过 + 审计; ticket 非空验证 |
| `server/routes/ai/scheduler.js` | Fix3: supersede 撤单后重新 pending_list 确认真实剩余数量; remainingPendingCount + 1 <= MAX; 复查失败 = fail-closed |
| `server/routes/ai/scheduler.js` | 所有 rejection/skip 增加 execution_result JSON 含 reason |
| `tests/ai/scheduler-safety.test.js` | 修复 3 个 Promise 警告 (await 替代 .resolves) |

## 3. 四项修复详细说明

### Fix 1: finalize 恢复 — 直接写 cooldown

**问题**: `finalizeLock(key, lockToken, ...)` 用旧 token 调用 Lua，锁已不在时返回 false。
**修复**: 恢复流程直接用 `redis.set(key, '1', 'EX', seconds, 'NX')` 写 cooldown（NX 防覆盖）。独立 `_recoveryTimer` 与普通 tick 分离。`stopUnifiedScheduler` 清理三个 timer。

### Fix 2: cancel_pending 类型/价格安全

**实现**:
- `pending_type` 双方转小写后比较
- 价格条件时 `Number.isFinite(price) && price > 0`，否则跳过 + 审计 `invalid_pending_price`
- ticket 非空验证

### Fix 3: 挂单上限用复查真实数量

**实现**: supersede 撤单后重新 `pending_list` 确认同品种实际剩余。`remainingPendingCount + 1 <= MAX`（新订单占一个名额）。复查失败 = fail-closed。

### Fix 4: Promise 警告清零

**修复**: 3 个测试中 `expect(...).resolves.toBe()` 改为 `await` + `expect(result).toBe()`。

## 4. 验证结果

```
node --check server/routes/ai/scheduler.js    ✅
npm test                                      ✅ 484 passed
scheduler-safety.test.js Promise warnings     ✅ 0 warnings
git diff --check                              ✅
rg "RELEASE_LUA|releaseLock" server/routes/ai/scheduler.js  → 无匹配 ✅
```

## 5. 未完成项

- 手工实测需在有 MT5 桥接和 Redis 的环境验证
- finalize 恢复中的 Redis NX 写入行为已在代码逻辑中验证，端到端需 Redis 环境
- 挂单复查的"撤单后仍有旧 ticket"边界情况依赖 MT5 最终一致性行为
