# 执行结果：桥接客户端日志运行时错误修复 + 敏感信息/长日志控制

## 执行时间
2026-07-01

## 修改文件
- `public/ai/aurum_bridge_gui.py` — 修复 WsBridgeThread 引用 + 脱敏 + 日志长度限制 + 降噪

## 修复内容

### P1: WsBridgeThread 引用错误
- `_format_ws_error()` 中 `WsBridgeThread._short_text` → `BridgeWorker._short_text`
- 搜索确认无残留 `WsBridgeThread` 引用

### P2: 敏感信息脱敏
新增 `_mask_sensitive_text(value)` 静态方法，使用正则替换：
- `Authorization: Bearer xxx` → `Authorization: Bearer [已脱敏]`
- `Cookie: sid=xxx` → `Cookie: [已脱敏]`
- `token=xxx` → `token=[已脱敏]`
- `access_token=xxx` / `refresh_token=xxx` → `[已脱敏]`
- `Bearer xxx` → `Bearer [已脱敏]`

`_short_text()` 先调用 `_mask_sensitive_text()` 再截断。

### P2: UI 日志长度限制
新增常量 `MAX_LOG_MESSAGE_CHARS = 1000`
`_log()` 入口：
1. 调用 `_mask_sensitive_text()` 脱敏
2. 超过 1000 字符截断并追加 `...[日志过长，已截断]`
3. 保留现有 500 行裁剪逻辑

### P2: 连接失败日志降噪
新增 `_brief_ws_error(e)` 返回异常类名（如 `TimeoutError`）
策略：
- 第 1/2/3 次：完整 `_format_ws_error(e)`
- 之后每 10 次：完整错误
- 其它：只显示 `_brief_ws_error(e)`（异常类名）

## 验证命令
```
python -m py_compile public/ai/aurum_bridge_gui.py  ✅
rg -n "WsBridgeThread" public/ai/aurum_bridge_gui.py  ✅ (空)
rg -n "_mask_sensitive_text|MAX_LOG_MESSAGE_CHARS|_brief_ws_error|_format_ws_error|def _log"  ✅
```

## 提交信息
- 分支：`dev_codex`
- Commit: 待提交
