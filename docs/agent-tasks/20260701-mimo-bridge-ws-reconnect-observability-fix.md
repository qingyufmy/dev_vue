# Mimo 任务：修复桥接 WebSocket 偶发断开后长期连不上与诊断日志不足

## 背景

用户反馈：桥接软件偶发突然断开，之后一直显示重连失败，持续重试到超时后自动停止。截图中关键日志类似：

```text
[20:15:55] 完成: {"status":"success","symbol":"XAUUSD.s","timeframe":"M5","count":1,...}
[20:16:14] WebSocket 连接已断开 (code=1006)
[20:16:14] 连接断开，5秒后自动重连...
[20:16:29] 连接失败（第1次）：5秒后重试...
...
[20:20:29] 连接失败（第49次）：5秒后重试...
```

用户已检查服务器日志，未发现明显的 `Ping timeout`、进程崩溃、PM2 重启等信息。

需要注意：当前代码本身没有记录足够多的 WebSocket 关键事件，因此“日志没有异常”不能证明服务端没有异常。现有实现里很多关键异常被吞掉或没有打印。

## 当前代码位置

重点检查和修改：

- `public/ai/aurum_bridge_gui.py`
  - 桥接桌面客户端。
  - `_run_async()` 负责 WebSocket 连接、重连、会话循环。
  - `_async_send_loop()` 负责采集 MT5 数据并发送。
  - `_async_recv_loop()` 负责接收服务端命令和 `ping`。
- `server/bridge-ws.js`
  - 服务端 WebSocket 入口。
  - `initBridgeWS(server)` 处理 HTTP upgrade。
  - `handleBridge()` / `_initBridge()` 管理桥接连接。
  - 当前服务端每 15 秒发送应用层 `ping`，30 秒未收到 `pong` 后 `ws.close(4003, 'Ping timeout')`。
- `server/index.js`
  - HTTP server 创建位置，可补充 server timeout 相关配置或健康检查路由。
- `server/routes/ai/index.js`
  - 桥接客户端版本信息，需要在客户端行为变更后更新 changelog/version/download 说明。
- `public/ai/app.js`
  - 下载桥接客户端的版本 URL 如有需要需同步。

## 问题判断

这次不要只修一个点。需要同时解决两个层面：

1. **可观测性不足**
   - 服务端没有记录桥接连接成功、关闭 code/reason、连接持续时长。
   - 服务端 `Ping timeout` 当前只是 close，没有日志。
   - `ws.send()` 失败被吞掉。
   - upgrade 请求是否到达 Node 没有记录。
   - 客户端连接失败时只打印 `str(e)`，很多 timeout 异常字符串为空，导致用户看到“连接失败：5秒后重试”，没有真实原因。

2. **重连策略不可靠**
   - 客户端 `MAX_RETRY = 300`，5 分钟后自动停止。
   - 对交易桥接来说，除非用户手动停止、token 失效、会员失效，否则应该持续重连。
   - 快速断开 circuit breaker 当前会在连续快速断开后停止，也可能导致短暂服务端/代理抖动后不再恢复。

## 修复目标

完成后需要达到：

1. 桥接软件断开后不会因为普通网络/代理/服务端短暂异常而永久停止。
2. 重连失败日志必须能看出异常类型，例如：
   - `TimeoutError`
   - `ConnectionRefusedError`
   - `InvalidHandshake`
   - `InvalidStatus`
   - `SSLError`
   - `ConnectionClosedError code=1006`
3. 服务端日志必须能回答：
   - 客户端是否到达了 Node 的 upgrade 入口？
   - 是否通过 JWT / 会员检查？
   - 是否进入 `_initBridge()`？
   - 是否是 ping timeout？
   - close code/reason 是什么？
   - 断开前最后一次收到 bridge 消息是什么时候？
   - 断开前最后一次收到 pong 是什么时候？
4. 心跳逻辑要更稳，不要在桥接持续发送数据时误判离线。
5. 不改变自动推理、交易执行、风控逻辑的业务语义。

## 具体修复要求

### 1. 客户端：连接失败日志增强

修改 `public/ai/aurum_bridge_gui.py`。

新增一个辅助函数，例如：

```python
def _format_ws_error(e):
    ...
```

要求输出至少包含：

- 异常类名：`type(e).__name__`
- `str(e)`，为空时显示 `无详细信息`
- `repr(e)`
- `args`
- 如果是 websockets 相关异常，尽量提取：
  - `status_code`
  - `status`
  - `headers`
  - `response`
  - `code`
  - `reason`

连接失败日志从：

```python
self.log_signal.emit(f"连接失败 (第{rc}次): {e}，{RETRY_INT}秒后重试...")
```

改为类似：

```python
self.log_signal.emit(f"连接失败（第{rc}次）：{self._format_ws_error(e)}，{delay}秒后重试...")
```

注意：

- 日志必须中文为主。
- token 不允许打印。
- ws_url 只能打印不带 token 的路径，例如 `/aurum-api/bridge/ws`。

### 2. 客户端：取消 5 分钟停止重连

当前：

```python
MAX_RETRY = 300
...
if elapsed >= MAX_RETRY:
    self.log_signal.emit("连接失败：已重试5分钟，停止")
    self.status_signal.emit("连接失败", "#ef4444", "")
    return
```

需要改成：

- 普通连接失败不再 `return`。
- 5 分钟后只提示一次或每隔一段时间提示：

```text
已连续重连 5 分钟，仍在继续尝试。请检查服务器 WebSocket 或反向代理状态。
```

- 重连应持续到：
  - 用户手动停止；
  - 登录 token 确认无效；
  - 会员/权限确认不允许；
  - 软件退出。

建议退避策略：

- 前 1 分钟：5 秒一次。
- 1 到 5 分钟：10 秒一次。
- 5 分钟以后：30 秒一次。
- 最大不要超过 60 秒。

状态显示可为：

```text
重连中...（第 N 次）
```

### 3. 客户端：快速断开 circuit breaker 不要直接停止

当前 `MAX_RAPID_FAILS = 5` 后会停止。

调整为：

- 连续快速断开达到阈值后，不要 `return`。
- 改为进入更长退避，例如 30 秒或 60 秒。
- 打印中文提示：

```text
连续多次快速断开，已延长重连间隔，仍会继续自动重连。
```

只有明确永久性错误才停止：

- JWT/token 无效。
- 会员失效或权限不足。
- 用户手动停止。

### 4. 客户端：增加主动心跳

当前客户端只在收到服务端 `ping` 时回 `pong`。

建议增加客户端主动心跳：

- 在 `_async_send_loop()` 或单独 `_async_heartbeat_loop()` 中每 10-15 秒发送：

```json
{"type":"hb","ts":当前毫秒时间戳,"client_version":"v..."}
```

服务端收到 `hb` 时刷新 `lastSeen` 和 `lastPong`。

如果实现单独 heartbeat loop，则会话 gather 从两个任务改为三个任务：

```python
await asyncio.gather(
    self._async_send_loop(ws),
    self._async_recv_loop(ws),
    self._async_heartbeat_loop(ws),
)
```

注意：

- 任意任务发现连接关闭后，不能造成其它任务长时间挂住。
- 可用 `asyncio.wait(..., return_when=asyncio.FIRST_EXCEPTION)` 或保持现有 gather，但要验证断开后能退出重连。

### 5. 服务端：补全桥接连接生命周期日志

修改 `server/bridge-ws.js`。

在以下位置增加日志，统一前缀 `[BridgeWS]`：

1. upgrade 收到时：

```text
[BridgeWS] upgrade path=/aurum-api/bridge/ws type=bridge ip=...
```

要求：

- 不打印 token。
- 可以打印 token 是否存在：`tokenPresent=true/false`。

2. JWT 验证失败：

```text
[BridgeWS] bridge auth failed: ...
```

3. 会员检查拒绝：

已有日志，但中文乱码/文本可能不稳定，整理为清晰中文或英文均可，至少包括 userId 和 reason。

4. `_initBridge()` 成功注册：

```text
[BridgeWS] bridge connected user=123 role=... plan=... replacedOld=true
```

5. close 事件：

必须打印：

- userId
- code
- reason
- connected duration
- lastSeen age
- lastPong age
- lastMessageType
- pending command count for user

示例：

```text
[BridgeWS] bridge closed user=123 code=1006 reason= duration=112s lastSeenAge=19s lastPongAge=34s lastType=data pending=0
```

6. error 事件：

当前已有 `Bridge error`，保留并补充 userId、readyState。

### 6. 服务端：补全 ping timeout 日志，不要静默 close

当前：

```js
if (Date.now() - bridge.lastPong > 30000) {
  try { ws.close(4003, 'Ping timeout') } catch {}
  clearInterval(bridgeEntry._pingInterval)
  return
}
```

必须改为先打印日志：

```text
[BridgeWS] ping timeout user=123 lastPongAge=... lastSeenAge=... readyState=...
```

并且 close 失败时也要打印：

```text
[BridgeWS] ping timeout close failed user=123 error=...
```

### 7. 服务端：收到任意有效 bridge 消息都刷新存活状态

当前收到任意消息会刷新 `lastSeen`，只有 `hb` 或 `pong` 才刷新 `lastPong`。

建议调整：

- 收到任何来自 bridge 的有效 JSON 消息，都说明连接可用，应刷新一个通用 `lastMessageAt`。
- 对于 `data`、`hb`、`pong`、`result` 均可以刷新 `lastSeen`。
- `lastPong` 可以保留为心跳专用，但 ping timeout 判断不要只看 `lastPong`，否则在某些情况下可能误判。

推荐判断：

```js
const lastActivity = Math.max(bridge.lastPong || 0, bridge.lastSeen || 0, bridge.lastMessageAt || 0)
if (Date.now() - lastActivity > 45000) {
  ...
}
```

说明：

- 桥接正常每秒发 `data`，只要数据还在来，就不应该因为没收到 `pong` 被关闭。
- 仍然保留 `lastPong` 日志，方便看心跳是否异常。

### 8. 服务端：使用协议级 ping 增强稳定性

当前服务端发送的是应用层 JSON：

```js
ws.send(JSON.stringify({ type: 'ping', ts: Date.now() }))
```

建议兼容保留应用层 ping，同时增加 WebSocket 协议级 ping：

```js
try { ws.ping() } catch (e) { ... }
```

Python `websockets` 客户端会自动响应协议级 ping。

注意：

- 不要只改成协议级 ping，否则旧客户端的应用层 pong 诊断会变少。
- 可以每 15 秒同时做：
  - `ws.ping()`
  - `ws.send({type:'ping'})`

### 9. 服务端：增加 bridge WebSocket 诊断健康接口

新增一个只读接口，便于线上排查。

建议路径：

```text
GET /api/bridge/ws-health
```

返回示例：

```json
{
  "ok": true,
  "serverTime": "2026-07-01T...",
  "bridges": [
    {
      "userId": 1,
      "readyState": 1,
      "connectedSeconds": 123,
      "lastSeenAgeSeconds": 1,
      "lastPongAgeSeconds": 12,
      "lastMessageType": "data",
      "tradeEnabled": true,
      "autoReasoningEnabled": true
    }
  ]
}
```

权限要求：

- 只允许管理员访问。
- 不返回 token、邮箱、敏感账户信息。

如果现有路由结构不方便，可在 `server/bridge-ws.js` export 一个 `getBridgeDiagnostics()`，然后在合适的 routes 文件里挂接口。

### 10. 服务端 HTTP timeout 配置检查

在 `server/index.js` 的 `const server = http.createServer(app)` 后确认是否需要设置：

```js
server.keepAliveTimeout = 65000
server.headersTimeout = 66000
server.requestTimeout = 0
```

注意：

- 不要盲目改坏普通 HTTP 行为。
- 如果添加，写清楚原因：避免长连接/反代环境下 Node 默认 timeout 与 WebSocket 行为产生意外影响。
- WebSocket upgrade 后通常不受普通 request timeout 影响，但这里可作为部署稳定性补充。

### 11. Nginx/部署文档补充

修改 `DEPLOY.md`，补充 WebSocket 排查建议：

必须包含：

```nginx
location /aurum-api/bridge/ws {
    proxy_pass http://127.0.0.1:3000;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_read_timeout 86400s;
    proxy_send_timeout 86400s;
    proxy_buffering off;
}
```

补充排查命令：

```bash
pm2 logs --lines 300
tail -n 300 /www/wwwlogs/站点.error.log
tail -n 300 /www/wwwlogs/站点.log
```

说明：普通 HTTPS/API 正常不代表 WebSocket upgrade 正常。

### 12. 版本信息更新

如果修改了桥接客户端行为，需要更新：

- `APP_VERSION`
- `server/routes/ai/index.js` 中桥接版本 changelog。
- `public/ai/app.js` 中下载提示/URL，如项目内维护固定版本 URL。

如果暂时不重新打包 exe，也必须在结果文件说明：

```text
已修改 Python 源码，但 public/ai/AURUM_Bridge.exe 尚未重新打包，线上用户下载的 exe 不包含本次修复。
```

## 不要做的事

- 不要改自动推理业务逻辑。
- 不要改交易执行逻辑。
- 不要打印 token、密码、JWT 全文。
- 不要把普通网络抖动当成永久错误直接停止桥接。
- 不要删除用户现有配置。
- 不要改主分支，只在当前 `dev_codex` 分支工作。

## 验证要求

至少完成以下验证：

1. 语法检查：

```bash
node --check server/bridge-ws.js
node --check server/index.js
node --check server/routes/ai/index.js
python -m py_compile public/ai/aurum_bridge_gui.py
```

2. 模拟异常日志格式：

- 人为让 WebSocket 地址不可达，确认客户端日志包含异常类型，例如 `TimeoutError`。
- 人为断开服务端，确认客户端不会 5 分钟后停止，而是持续重连。

3. 服务端日志验证：

- 桥接连接成功时有日志。
- 桥接断开时有 close code/reason。
- ping timeout 时有明确日志。
- 不打印 token。

4. 健康接口验证：

- 管理员可访问 `/api/bridge/ws-health`。
- 普通用户不可访问。
- 返回内容不包含敏感信息。

5. 回归验证：

- 桥接连接成功后，浏览器仍能收到行情数据。
- 手动交易命令仍能发送到 MT5。
- 自动推理不因本次修改改变开启/关闭语义。

## 结果文件要求

完成后写结果到：

```text
docs/agent-results/20260701-mimo-bridge-ws-reconnect-observability-fix-result.md
```

结果文件必须包含：

- 修改了哪些文件。
- 客户端重连策略具体变成什么。
- 服务端新增了哪些日志字段。
- 是否重新打包了 `AURUM_Bridge.exe`。
- 执行了哪些验证命令及结果。
- 未完成项或需要人工部署检查的内容。

