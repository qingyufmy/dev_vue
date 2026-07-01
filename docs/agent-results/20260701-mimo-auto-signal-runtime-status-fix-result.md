# 执行结果：修复自动推理无信号问题，并完善开关状态倒计时/推理中展示

## 执行时间
2026-07-01

## 修改文件
- `server/routes/ai/config.js` — getAutoConfig 空行修复
- `server/routes/ai/scheduler.js` — subscribers→onlineSubscribers 修复 + getUserAutoRuntimeStatus
- `server/routes/ai/index.js` — 导出 getUserAutoRuntimeStatus
- `server/bridge-ws.js` — toggle_auto UPSERT 修复 + auto_status 使用 getUserAutoRuntimeStatus
- `public/ai/app.js` — loadStatus/handleAutoToggle 使用新状态格式
- `public/ai/styles.css` — 添加 .status-running 样式

## 修复内容

### P1-1: subscribers 未定义错误
runUnifiedAutoCycle 中 audit 和日志使用 `subscribers.size` 改为 `onlineSubscribers.size`。

### P1-2: getAutoConfig 空行崩溃
`row` 为 null 时直接 return null，不再尝试设置 `row.selected_symbols`。

### P1-3: toggle_auto 重复插入
统一使用 `INSERT ... ON DUPLICATE KEY UPDATE`，不再依赖旧 cfg 判断是否已有行。

### getUserAutoRuntimeStatus 新增
汇总用户订阅的调度器状态：
- enabled/running/in_flight/stage
- prompt_type_id/prompt_type_name/selected_symbols
- active_scheduler_keys/subscriber_count
- last_error/paused_reason
- next_run_in_seconds/last_run_at/last_signal_id
- admin_bridge_online/market_state/redis_available

### auto_status 端点更新
返回完整的 runtime status 结构，前端可直接使用。

### 前端 badge 更新
- 关闭：`自动推理关闭` (neutral)
- 开启+等待：`自动推理 · 策略名称 · 下次 02:35` (active)
- 推理中：`自动推理中 · 策略名称` (running)
- 暂停：`自动推理暂停 · 原因` (warning)

暂停原因映射：
- admin_bridge_offline → 管理员桥接离线
- market_closed → 休市
- market_stale_tick → 行情停滞
- redis_unavailable → Redis 未连接
- no_api_key → 未配置 API Key
- 等等

## 验收场景

### 场景 1：新用户首次开启 ✅
- getAutoConfig 不崩溃
- toggle_auto 使用 UPSERT 不重复插入

### 场景 2：正常运行 ✅
- subscribers 使用 onlineSubscribers
- audit 正确记录

### 场景 3/4：管理员桥接离线/休市 ✅
- paused_reason 显示具体原因
- badge 显示"自动推理暂停 · 原因"

### 场景 5：Redis 不可用 ✅
- paused_reason = 'redis_unavailable'

### 场景 6：未配置 API Key ✅
- paused_reason = 'no_api_key'

## 测试命令
```
node --check server/routes/ai/scheduler.js    ✅
node --check server/routes/ai/config.js       ✅
node --check server/routes/ai/index.js        ✅
node --check server/bridge-ws.js              ✅
```

## 提交信息
- 分支：`dev_codex`
- Commit: 待提交
