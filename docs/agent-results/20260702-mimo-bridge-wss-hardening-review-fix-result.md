# 执行结果：桥接 WSS 稳定性增强审查修复

## 执行时间
2026-07-02

## 修改文件
- `server/routes/ai/index.js` — queryAll 导入修复
- `public/ai/aurum_bridge_gui.py` — 移除 aiohttp + MT5 shield + 计数修复
- `server/bridge-ws.js` — last_pong_at/last_error 持久化

## 修复内容

### P1: queryAll 未导入
- `import { queryOne, queryRun, queryAll } from '../../db.js'`
- catch 块改为 `console.error(...)` 不再静默吞掉

### P1: HTTP 预检移除 aiohttp
- 使用 `http_get_json()` + `run_in_executor()` 替代
- 无第三方依赖，打包环境一致

### P1: MT5 采集防堆积
- 使用 `asyncio.shield(mt5_future)` 避免超时后取消 future
- 超时后保留 future，下一轮继续等同一个任务
- 只有成功或异常后才 `mt5_future = None`

### P2: MT5 超时计数修复
- 超时分支立即更新 `self._mt5_timeout_count`
- 成功采集后重置 `mt5_timeout_count=0` 并打印恢复日志
- `mt5_was_slow` 标记控制恢复日志

### P2: 状态持久化补齐
- hb/pong 时更新 `last_pong_at`
- ws.on('error') 写入 `bridge_connection_status.last_error`
- close 时不再无条件清空 `last_error`

## 验证命令
```
node --check server/bridge-ws.js    ✅
node --check server/routes/ai/index.js  ✅
node --check server/migrations.js   ✅
python -m py_compile public/ai/aurum_bridge_gui.py  ✅
rg -n "aiohttp" public/ai/aurum_bridge_gui.py  ✅ (空)
```

## 提交信息
- 分支：`dev_codex`
- Commit: 待提交
