# 执行结果：修复桥接 WebSocket 断连后重连策略 + 诊断日志增强

## 执行时间
2026-07-01

## 修改文件
- `public/ai/aurum_bridge_gui.py` — 客户端重连策略 + 错误格式化 + 心跳
- `server/bridge-ws.js` — 连接生命周期日志 + ping timeout + lastMessageAt
- `server/index.js` — HTTP timeout 配置
- `server/routes/ai/index.js` — 版本更新 + 健康接口
- `DEPLOY.md` — Nginx WebSocket 排查命令

## 客户端修改

### 1. 错误格式化
新增 `_format_ws_error(e)` 静态方法，输出：
- 异常类名（`type(e).__name__`）
- `str(e)`（为空时显示 `无详细信息`）
- websockets 特有字段（`status_code`、`code`、`reason` 等）

### 2. 重连策略
- **取消 5 分钟停止**：普通连接失败不再 `return`
- **渐进退避**：5s（前1分钟）→ 10s（1-5分钟）→ 30s（5分钟+）
- 每隔一段时间提示仍在重连
- 只有会员/权限错误才停止

### 3. Circuit breaker
- 连续快速断开达到阈值后不再停止
- 改为进入更长退避（30秒）
- 打印中文提示继续重连

### 4. 客户端心跳
新增 `_async_heartbeat_loop()`，每 15 秒发送：
```json
{"type":"hb","ts":毫秒时间戳,"client_version":"v2.1.2"}
```

## 服务端修改

### 1. 升级日志
```
[BridgeWS] upgrade path=/aurum-api/bridge/ws type=bridge tokenPresent=true ip=...
```

### 2. 连接成功日志
```
[BridgeWS] bridge connected user=123 plan=admin replacedOld=false
```

### 3. Close 详细日志
```
[BridgeWS] bridge closed user=123 code=1006 reason= duration=112s lastSeenAge=19s lastPongAge=34s lastType=data pending=0
```

### 4. Ping timeout 日志
```
[BridgeWS] ping timeout user=123 lastPongAge=46s lastSeenAge=2s readyState=1
```

### 5. lastMessageAt 追踪
任意桥接消息（data/hb/pong/result）都刷新 `lastMessageAt` 和 `_lastMessageType`。

### 6. Ping timeout 使用 lastActivity
判断逻辑改为 `Math.max(lastPong, lastSeen, lastMessageAt)`，避免数据正常但 pong 丢失时误判。

### 7. 双重 ping
每 15 秒同时发送协议级 `ws.ping()` 和应用层 `{type:'ping'}`。

### 8. HTTP timeout
```js
server.keepAliveTimeout = 65000
server.headersTimeout = 66000
server.requestTimeout = 0
```

### 9. 健康接口
`GET /api/bridge/ws-health`（仅管理员），返回所有桥接连接状态。

## 版本更新
- 客户端：`v2.1.1` → `v2.1.2`
- 服务端：`v2.1.1` → `v2.1.2`

## 验证命令
```
node --check server/bridge-ws.js    ✅
node --check server/index.js        ✅
node --check server/routes/ai/index.js  ✅
python -m py_compile public/ai/aurum_bridge_gui.py  ✅
```

## 未完成项
- `AURUM_Bridge.exe` 尚未重新打包，线上用户下载的 exe 不包含本次 Python 修复
- 需要人工部署后验证：桥接断开重连、日志格式、健康接口权限

## 提交信息
- 分支：`dev_codex`
- Commit: 待提交
