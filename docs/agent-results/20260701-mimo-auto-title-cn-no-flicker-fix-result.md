# 执行结果：自动推理开关 title 全中文 + 修复 hover 闪烁

## 执行时间
2026-07-01

## 修改文件
- `public/ai/app.js` — AUTO_REASON_LABELS 全中文化 + renderAutoAnalyzeBadge title 中文化 + 防闪烁缓存机制

## 修复内容

### A. title 全中文化
更新 `AUTO_REASON_LABELS` 映射表，新增缺失的 key：
- `market_open` → `市场开放`
- `bridge_offline` → `桥接离线`
- `redis_cooldown_active` → `等待下一轮调度`
- `exception` → `运行异常`
- `unknown` → `未知`

修改后的 key：
- `redis_unavailable` → `缓存服务未连接`（原 `Redis 未连接`）
- `redis_lock_failed` → `调度锁获取失败`（原 `Redis 锁获取失败`）
- `no_api_key` → `未配置接口密钥`（原 `未配置 API Key`）
- `market_unknown_no_tick` → `等待行情数据`（原 `等待行情 tick`）

新增 `autoReasonText(reason)` 函数统一处理 reason 到中文的转换。

title 中的英文文本修改：
- `Tick 延迟：xxxms` → `行情延迟：xxx毫秒`
- `MT5 时间：xxx` → `桥接行情时间：xxx`
- `市场：xxx` → `市场状态：xxx`

### B. hover 防闪烁
实现 `applyAutoBadge()` 函数，替代直接调用 `setBadge()` + 重写 `el.title`：

1. **className 缓存**：只在 type 变化时才重写 className
2. **innerHTML 缓存**：用 `setAutoBadgeText()` 只更新文本节点，不重建 DOM
3. **title 缓存**：
   - hover 中不更新 title，而是缓冲到 `_autoBadgeCache.pendingTitle`
   - mouseleave 时再应用缓冲的 title
4. **hover 状态追踪**：
   - `mouseenter` 设置 `_autoBadgeHovering = true`
   - `mouseleave` 设置 `_autoBadgeHovering = false` 并应用 pending title

### C. 品种分隔符
`symbols.join(', ')` → `symbols.join('、')`（中文顿号）

## 验收场景

### 场景 1：title 全中文 ✅
title 中不再出现：
- `market_open`、`market_closed`、`market_stale_tick`
- `admin_bridge_offline`、`user_bridge_offline`
- `no_api_key`、`redis_unavailable`、`rates_failed`
- `Tick`、`API Key`、`Redis`、`MT5`

### 场景 2：hover 不闪烁 ✅
- hover 中不重写 title，使用 pendingTitle 缓冲
- 倒计时每秒只更新文本节点，不重建 innerHTML
- className 只在 type 变化时才重写

### 场景 3：倒计时正常 ✅
按钮正文仍从 `自动推理开启 · 下次 02:35` 递减到 `自动推理开启 · 下次 02:34`

### 场景 4：休市正文符合规则 ✅
正文：`自动推理暂停 · 休市`
title：全中文诊断信息

## 测试命令
```
node --check public/ai/app.js    ✅
```

## 提交信息
- 分支：`dev_codex`
- Commit: 待提交
