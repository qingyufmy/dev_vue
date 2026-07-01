# 执行结果：自动推理策略品种选择 + 信号查询修复 + Redis 订阅态

## 执行时间
2026-07-01

## 修改文件
- `server/bridge-ws.js` — 修复 signals UNION ALL 列对齐 + signals_latest_id 用户维度查询 + get_auto_config 返回 selected_symbols + toggle_auto 自动填充品种
- `server/routes/ai/config.js` — getAutoConfig 解析 selected_symbols、saveUserAutoConfig 验证并保存 selected_symbols
- `server/routes/ai/scheduler.js` — initAutoSchedulers 启动时调用 rebuildRedisSubscriptions

## 修复说明

### 1. 信号列表 UNION ALL 修复（bridge-ws.js）
**问题**：`signals` action 中旧信号子查询和共享信号子查询列名不一致（`delivery_is_executed` vs `is_executed`），导致 MySQL UNION ALL 报错。

**修复**：
- 提取公共列名常量 `selectCols`
- 两个子查询输出完全一致的列名和列序
- 旧信号：`NULL as delivery_id, NULL as execution_status`
- 共享信号：`d.is_executed` 直接映射为 `is_executed`，`d.id as delivery_id`
- 简化映射逻辑：不再需要 `delivery_*` 前缀字段的重映射
- dataSql 改用显式列名而非 `SELECT *`

### 2. signals_latest_id 修复（bridge-ws.js）
**问题**：查询共享信号时使用 admin userId 替代当前用户，且未按 session_id 过滤。

**修复**：
- 旧信号和共享信号都始终查询 `userId`（当前用户）
- 共享信号增加 `s.session_id` 过滤条件
- 排序改为 `created_at DESC, id DESC`
- 最新一条比较改为按 `created_at` 比较

### 3. 用户选择品种子集（config.js + bridge-ws.js）
**数据模型**：
- `auto_prompt_types.symbols_json`：策略支持品种全集
- `auto_scheduler.symbols`：用户选择品种 JSON 数组

**getAutoConfig**：解析 `symbols` 字段为 `selected_symbols` 数组返回给前端。

**saveUserAutoConfig**：
- 验证 `selected_symbols` 为非空数组
- 大写化、trim、去重
- 校验每个品种必须存在于策略 `symbols_json`
- 保存为 JSON 字符串到 `auto_scheduler.symbols`

**toggle_auto**：
- 开启时若无 prompt_type_id，自动选择第一个策略并全选品种
- 若有策略但无 selected_symbols，自动填充策略全部品种

**get_auto_config 响应**：config 对象增加 `selected_symbols` 字段。

### 4. getAutoSubscribers 已正确实现
已有逻辑通过 JSON.parse 解析用户 `symbols` 并 filter 品种，无需修改。

### 5. reconcileAutoSchedulers 已正确实现
已有逻辑使用 `auto_scheduler.symbols`（用户选择）与 `auto_prompt_types.symbols_json`（策略全集）求交集。

### 6. 前端多选组件（已存在）
- `renderSymbolsChips()` — 渲染品种 chip 多选组件
- `getSelectedSymbols()` — 获取选中品种
- HTML: `autoSymbolsField` / `autoSymbolsChips` 容器
- CSS: `.symbol-chip` / `.symbol-chip.active` 样式
- 策略选择联动：切换策略时自动刷新品种多选
- 单品种策略隐藏多选组件

### 7. autoAnalyzeMode Badge 已正确实现
已使用策略标题 `prompt_type_name` 替代旧的品种+间隔文案，在 heartbeat、handleAutoToggle、loadStatus 中统一使用。

### 8. Redis 订阅态（已存在，补全启动重建）
- `syncUserRedisSubscription()` — 开启/关闭时同步 Redis
- `rebuildRedisSubscriptions()` — 启动时从 DB 重建索引
- **本次修改**：`initAutoSchedulers()` 增加调用 `rebuildRedisSubscriptions()` 确保启动时重建

## 测试命令和结果

```
node --check server/routes/ai/scheduler.js    ✅
node --check server/routes/ai/config.js       ✅
node --check server/bridge-ws.js              ✅
node --check server/migrations.js             ✅
node --check public/ai/app.js                 ✅
npm test                                       ✅ 6 files, 75 tests passed
git diff --check HEAD                          ✅ (only CRLF warnings)
```

## 提交信息
- 分支：`dev_codex`
- Commit: 待提交

## 风险和未完成项
- 前端 UI 无法在此环境做端到端浏览器测试，多选组件需手动验证
- Redis 订阅态的 `cacheDel` 函数在 redis.js 中不存在（但现有实现使用 `redis.del` 直接调用，无影响）
- 所有修改遵循 AGENTS.md 规范：未回退已有改动、未合并 main
