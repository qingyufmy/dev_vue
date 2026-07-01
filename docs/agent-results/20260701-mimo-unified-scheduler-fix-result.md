# 统一调度重构审查修复结果

## 提交信息

- **提交号**: `6464c1a`
- **分支**: `dev_codex`
- **提交信息**: `fix: 修复统一调度重构审查问题`

## 修改文件列表

| 文件 | 修改类型 |
|------|----------|
| `server/migrations.js` | 修复 queryAll 解构错误 + 静默 catch |
| `server/routes/ai/scheduler.js` | Redis 不可用时 fail closed + 信号字段补齐 |
| `server/routes/ai/config.js` | saveUserAutoConfig 部分更新 + 删除无效函数 |
| `server/bridge-ws.js` | 信号分页合并 + signals_latest_id + admin_user_status + await reconcileAutoSchedulers |

## P0 修复说明

### P0-1: 数据库迁移 queryAll 解构错误

**问题**: `migrations.js` 中多处使用 `const [existing] = await queryAll(...)` 解构，但 `queryAll()` 直接返回 rows 数组，导致 `existing` 为 undefined。

**修复**:
- 011 迁移: `const [existing] = await queryAll(...)` → `const existing = await queryAll(...)`
- 012 迁移: 同上修复
- 014 迁移: `const [cnt] = await queryAll(...)` → `const cnt = await queryAll(...)`，`[defaultPt]` → `defaultPt`，`[overrides]` → `overrides`
- 003/004/005/006/010 迁移: 同步修复旧迁移中的相同问题
- 所有迁移的空 `catch {}` 改为 `catch (e) { if (!e.message?.includes('Duplicate column')) console.error(...) }`，确保非重复字段错误能暴露

### P0-2: Redis 不可用时调度未 fail closed

**问题**: `scheduler.js` 中当 Redis 未配置或不可用时，跳过锁和 cooldown，直接执行 AI 推理。

**修复**:
- 导入 `isRedisAvailable()` 检查连接状态
- Redis 未配置、未连接时，记录 `redis_unavailable` 状态，暂停本轮不执行 AI
- `acquireLock()` 失败记录 `redis_lock_failed`
- `setCooldown()` 失败记录 `redis_cooldown_active`
- 保持 5 秒 tick 重试但不调用 `runUnifiedAutoCycle`

## P1 修复说明

### P1-1: 用户首次开启自动推理失败

**问题**: `saveUserAutoConfig()` 对未传字段（如 `max_position_size`）进行非法校验，导致新用户只传 `prompt_type_id` 时报错。

**修复**:
- 改为先读取现有配置，与传入参数合并
- 未传字段使用已有值或默认值（`risk_level='medium'`, `max_position_size=0.05`, `selected_take_profit=2`, `enable_auto_trade=0`）
- `selected_take_profit` 和 `max_position_size` 仅在参数存在时校验
- `enable_auto_trade` 支持显式 `false` 保存

### P1-2: 自动交易信号对象字段不完整

**问题**: `runUnifiedAutoCycle` 写入信号后未回填 `signal.id`、`signal.symbol` 等字段，导致 `executeDelivery()` 生成 `undefined` 订单参数。

**修复**: 在 `INSERT INTO ai_signals` 成功后立即补齐信号对象：
```js
signal.id = signalId
signal.symbol = symbol
signal.timeframe = timeframe.toUpperCase()
signal.created_at = createdAt
signal.market_data = market
signal.is_executed = false
// ... 其他必要字段
attachSignalTiming(signal)
```

### P1-3: 信号分页合并逻辑错误

**问题**: 旧信号和共享信号分别 LIMIT/OFFSET 后合并，导致第二页漏数据、重复数据、`has_more`/`total_count` 不准。

**修复**: 使用 `UNION ALL` 包装两个子查询，在合并后的全集上进行 `ORDER BY` + `LIMIT/OFFSET` 分页，`total_count` 通过 `SELECT COUNT(*) FROM (union) t` 获取。

## P2 修复说明

### P2-1: signals_latest_id 未接入共享投递表

**修复**: 分别查询旧信号和共享投递的最新一条，取 ID 较大的返回。

### P2-2: admin_user_status 未统计共享投递表

**修复**: 分别统计旧信号和 delivery 的 total/today/executed 数，合并后返回。

### P2-3: 无效辅助函数清理

**修复**: 删除 `isAutoSchedulerKeyRunningForUser()`（ESM 下无效的伪 `require`），`getUserAutoConfig()` 不再依赖运行状态。

## 额外回归修复

- `bridge-ws.js` 中所有 `ai.reconcileAutoSchedulers()` 调用已改为 `await`，确保调度状态同步完成。

## 测试命令和结果

```powershell
node --check server/routes/ai/scheduler.js    # OK
node --check server/routes/ai/config.js       # OK
node --check server/bridge-ws.js              # OK
node --check server/migrations.js             # OK
node --check public/ai/app.js                 # OK
npm.cmd test                                  # 75 tests passed (6 files)
git diff --check HEAD                         # OK (only CRLF warnings)
```

## 未完成项或风险

1. **信号分页 UNION ALL 的 SQL 兼容性**: 使用了 MySQL 标准 UNION ALL 子查询语法，MySQL 5.7+ 和 8.0+ 均支持。如有更低版本需验证。
2. **`getAutoSubscribers` 的 `symbol` 参数未使用**: 调度器已在 key 层校验策略绑定品种，参数保留但不参与 SQL 过滤。
3. **前端测试**: 未启动本地服务进行端到端 UI 验证，仅验证语法和单元测试。
4. **Redis 集成测试**: Redis fail closed 逻辑依赖 `isRedisAvailable()` 函数，已通过代码审查确认正确，未做集成测试。
