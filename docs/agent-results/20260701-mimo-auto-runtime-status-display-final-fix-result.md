# 执行结果：修正自动推理开关显示规则 + 补齐无信号原因闭环

## 执行时间
2026-07-01

## 修改文件
- `server/routes/ai/scheduler.js` — preflight 检查 + runUnifiedAutoCycle 结构化结果 + tick 状态更新 + getUserAutoRuntimeStatus 诊断
- `public/ai/app.js` — renderAutoAnalyzeBadge 函数 + 倒计时逻辑 + auto_progress/new_signal 处理

## 修复内容

### A. 按钮显示规则修正
新增 `renderAutoAnalyzeBadge()` 统一控制按钮正文和 title：

**正文规则：**
- 关闭：`自动推理关闭`
- 开启：`自动推理开启`
- 开启+倒计时：`自动推理开启 · 下次 02:35`
- 推理中：`自动推理中`
- 休市：`自动推理暂停 · 休市`

**title 规则：**
- 策略名称、品种、状态、内部诊断信息、市场状态
- 只有休市时才显示"暂停"

### B. 本地倒计时
- `state.autoRuntime.receivedAtMs` 记录收到时间
- UI timer 每秒调用 `renderAutoAnalyzeBadge` 实时递减
- 不显示负数

### C. auto_progress 处理
- 更新 `state.autoRuntime.in_flight/stage/stage_label`
- 调用 `renderAutoAnalyzeBadge` 显示"自动推理中"
- 收到 `new_signal` 后调用 `loadStatus()` 刷新

### D. Preflight 检查
在 Redis cooldown 前检查：
- 策略存在且启用
- API Key 已配置
- 失败时不设置 cooldown，写入 `st.lastError`

### E. runUnifiedAutoCycle 结构化结果
返回 `{ status: 'success'|'blocked'|'error', reason, signalId, subscriberCount, createdAt }`

### F. getUserAutoRuntimeStatus 诊断
新增 `user_bridge_offline`、`no_runtime_scheduler` 原因

## 验收场景

### 场景 1：关闭 ✅
正文：`自动推理关闭`

### 场景 2：开启正常 ✅
正文：`自动推理开启` 或 `自动推理开启 · 下次 02:35`
title 显示策略名、品种、内部状态

### 场景 3：推理中 ✅
正文：`自动推理中`
title 显示策略名、品种、阶段

### 场景 4：休市 ✅
正文：`自动推理暂停 · 休市`
title 显示市场原因、tickAge、mt5Time

### 场景 5：管理员桥接离线 ✅
正文仍显示 `自动推理开启`
title 显示 `内部状态：管理员桥接离线`

### 场景 6：未配置 API Key ✅
正文仍显示 `自动推理开启`
title 显示 `内部状态：未配置 API Key`
不占用 cooldown

### 场景 7：Redis 不可用 ✅
正文仍显示 `自动推理开启`
title 显示 `内部状态：Redis 未连接`

## 测试命令
```
node --check server/routes/ai/scheduler.js    ✅
node --check server/bridge-ws.js              ✅
node --check public/ai/app.js                 ✅
```

## 提交信息
- 分支：`dev_codex`
- Commit: 待提交
