# 桥接 WSS 稳定性增强方案：客户端 + 服务端 + 部署细则

## 背景

当前桥接链路：

```text
Python 桥接客户端 -> WSS /aurum-api/bridge/ws -> Nginx/宝塔反代 -> Node bridge-ws.js -> 浏览器/自动推理/交易命令
```

前面已完成的基础修复：

- 客户端断开后持续重连，不再 5 分钟后自动停止。
- 客户端连接失败日志增强。
- 服务端增加 WebSocket 连接、关闭、ping timeout 等日志。
- 服务端增加 `/api/bridge/ws-health` 诊断接口。
- 客户端日志增加脱敏、截断和降噪。

本方案继续增强“稳定连接 WSS 且长期稳定运行”的能力。

核心目标：

1. 区分“服务器不可达 / WSS 不通 / MT5 卡住 / Nginx 反代异常 / Node 重启”。
2. 避免 MT5 API 偶发卡住导致 WSS 会话被误判断线。
3. 服务端保留最近连接状态和断线原因，方便断线后追溯。
4. 部署侧明确 Nginx、PM2、时间同步和日志排查规则。

---

# 一、代码侧任务，交给 Mimo 执行

请只在 `dev_codex` 分支修改并提交。

## 修改范围

重点文件：

- `public/ai/aurum_bridge_gui.py`
- `server/bridge-ws.js`
- `server/db.js` 或现有 migrations 初始化位置
- `server/routes/ai/index.js`
- `DEPLOY.md`

结果文件：

```text
docs/agent-results/20260702-mimo-bridge-wss-stability-hardening-result.md
```

不要修改：

- 自动推理策略业务逻辑。
- 交易执行/风控逻辑。
- exe 打包、七牛上传、前端下载版本。

## 1. 客户端：连接前预检，区分 HTTP 不通和 WSS 不通

### 目标

现在桥接直接连 WSS，失败时只能看到 WebSocket 连接失败。建议连接 WSS 前先做轻量 HTTP 预检，明确服务器整体是否可达。

### 实现要求

在 `public/ai/aurum_bridge_gui.py` 的 `_run_async()` 连接循环中，在尝试 `websockets.connect()` 前增加预检。

预检接口优先使用：

```text
GET {server_url}/health
```

要求：

- 预检 timeout 建议 5 秒。
- 预检失败不要停止重连，只记录：

```text
服务器健康检查失败：TimeoutError/HTTP 503/...
```

- 预检成功但 WSS 失败时记录：

```text
HTTP 健康检查正常，但 WebSocket 连接失败，优先检查 Nginx WebSocket 反代。
```

- 不要每次都预检，避免增加请求量。
  - 建议：首次连接、连续失败第 3 次、第 10 次、之后每 10 次做一次。

### 注意

- 不打印 token。
- 普通健康检查失败不能阻断重连。
- 如果 `/health` 返回 503，要打印 database/redis 状态摘要，但不要当永久错误。

## 2. 客户端：重连超过阈值后重建 SSL context

### 目标

长时间运行后，TLS/代理链路可能进入半异常状态。每轮连接已经会新建 ws 对象，但 `ssl_ctx` 目前在 `_run_async()` 外层创建一次。建议在长期重连时重建 SSL context。

### 实现要求

当前类似：

```python
ssl_ctx = _get_ssl_context() if ws_url.startswith('wss://') else None
```

调整为：

- 每次开始连接前可以复用，但当 `retry_count in (1, 10, 30, 60)` 或每隔 30 次失败时重新创建。
- 日志：

```text
已重建 SSL 上下文，继续尝试连接 WebSocket。
```

注意：

- 不要禁用证书验证。
- 不要使用 `CERT_NONE`。
- 保留现有 `_get_ssl_context()` 的 TLS 1.2+ 配置。

## 3. 客户端：MT5 数据采集加超时保护

### 目标

当前 `_collect_mt5_data()` 通过 `run_in_executor()` 执行，避免阻塞 event loop。但如果 MT5 API 偶发卡住，发送循环会卡在等待 executor 结果上，导致：

- 客户端无法按时发数据。
- 客户端主动心跳仍可能正常，但行情数据停滞。
- 自动推理可能误判行情停滞。
- 长期卡住时会造成线程池任务堆积或资源占用。

### 实现要求

在 `_async_send_loop()` 中给 MT5 数据采集加超时：

```python
future = loop.run_in_executor(None, self._collect_mt5_data)
try:
    dm = await asyncio.wait_for(future, timeout=3)
except asyncio.TimeoutError:
    ...
```

建议 timeout：

- 默认 3 秒。
- 可定义常量：

```python
MT5_COLLECT_TIMEOUT_SEC = 3
```

超时处理：

- 不要断开 WSS。
- 不要无限刷日志。
- 每次超时更新计数：

```python
self._mt5_collect_timeout_count += 1
```

- 第 1、2、3 次打印完整日志，之后每 10 次打印一次：

```text
MT5 数据采集超时（第 N 次），本轮跳过发送。
```

- 连续超时达到阈值，例如 10 次，状态显示：

```text
MT5响应慢
```

- 如果后续恢复，打印一次：

```text
MT5 数据采集已恢复。
```

注意：

- Python 线程池中的阻塞任务无法被真正杀掉，`wait_for` 超时只是让当前协程继续。因此要避免每秒继续堆积新阻塞任务。
- 建议增加一个 `_mt5_collect_inflight` 标记，上一轮采集未完成时，本轮直接跳过，不再提交新的 executor 任务。
- 或者使用单线程 executor 专门采集 MT5 数据，避免堆积。

推荐简单方案：

```python
if self._mt5_collect_inflight:
    await asyncio.sleep(1)
    continue
self._mt5_collect_inflight = True
try:
    ...
finally:
    self._mt5_collect_inflight = False
```

但注意：如果底层线程真的卡死，finally 可能不会等到；更稳妥是 future 完成回调清理 inflight。

可接受的实现：

- 超时后设置 `self._mt5_collect_inflight = False`，但同时限制连续超时日志。
- 不要因一次 MT5 超时断开 WSS。

## 4. 客户端：主动心跳中带运行状态摘要

### 目标

服务端需要知道桥接客户端还活着，但 MT5 可能卡住或行情停滞。当前 heartbeat 只发：

```json
{"type":"hb","ts":...,"client_version":"v2.1.2"}
```

建议增加轻量状态字段，便于服务端诊断。

### 实现要求

客户端 `_async_heartbeat_loop()` 发送：

```json
{
  "type": "hb",
  "ts": 1234567890,
  "client_version": "v2.1.2",
  "mt5_collect_timeout_count": 0,
  "last_data_sent_age_sec": 2,
  "last_quote_time": "2026-07-02 12:00:00"
}
```

字段要求：

- 不包含账号、余额、持仓、token。
- 只用于诊断。
- 如果没有数据，字段可为 `null` 或 `-1`。

服务端 `bridge-ws.js` 收到 `hb` 时保存到 bridge entry：

```js
bridge._clientHeartbeat = {
  ts,
  client_version,
  mt5_collect_timeout_count,
  last_data_sent_age_sec,
  last_quote_time,
  receivedAt: Date.now(),
}
```

并在 `getBridgeDiagnostics()` 返回这些字段。

## 5. 服务端：WebSocket upgrade 异常兜底日志

### 目标

当前已记录 upgrade 到达，但 `wss.handleUpgrade()` 如果抛异常，日志不够完整。

### 实现要求

在 `server/bridge-ws.js` 的 `server.on('upgrade')` 中包裹：

```js
try {
  wss.handleUpgrade(...)
} catch (e) {
  console.error(`[BridgeWS] upgrade failed path=... type=... ip=... error=${e.message}`)
  try { socket.destroy() } catch {}
}
```

要求：

- 不打印 token。
- 打印 type、ip、path。
- path 固定输出 `/aurum-api/bridge/ws`，不要带 query。

## 6. 服务端：保存最近桥接状态，断线后可追溯

### 目标

现在桥接状态主要在内存 Map 中，断开后信息容易丢失。建议增加轻量持久化或 Redis 状态，用于排查：

- 最近连接时间。
- 最近断开时间。
- 最近 close code/reason。
- 最近 lastSeen/lastPong。
- 最近错误摘要。

### 推荐方案 A：数据库表，优先推荐

在 DB 初始化/migration 中增加表：

```sql
CREATE TABLE IF NOT EXISTS bridge_connection_status (
  user_id BIGINT PRIMARY KEY,
  connected TINYINT DEFAULT 0,
  connected_at DATETIME NULL,
  disconnected_at DATETIME NULL,
  last_seen_at DATETIME NULL,
  last_pong_at DATETIME NULL,
  last_message_type VARCHAR(32) NULL,
  last_close_code INT NULL,
  last_close_reason VARCHAR(255) NULL,
  last_error VARCHAR(255) NULL,
  client_version VARCHAR(32) NULL,
  mt5_collect_timeout_count INT DEFAULT 0,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
);
```

要求：

- 桥接连接成功时 upsert：
  - `connected=1`
  - `connected_at=NOW()`
  - 清空 `last_close_code/last_close_reason/last_error`
- 收到消息/心跳时节流更新：
  - `last_seen_at`
  - `last_pong_at`
  - `last_message_type`
  - `client_version`
  - `mt5_collect_timeout_count`
  - 节流：每 30-60 秒写一次，避免每秒写 DB。
- close 时 upsert：
  - `connected=0`
  - `disconnected_at=NOW()`
  - `last_close_code`
  - `last_close_reason`
- error 时：
  - `last_error`

注意：

- 不存 token、账号余额、持仓、订单。
- reason/error 截断到 255 字符。
- DB 写入失败不能影响桥接主流程，只打印错误。

### 方案 B：Redis 状态，作为补充

如果项目 Redis 可用，可以额外写：

```text
bridge:status:{userId}
```

不设置过短过期，或设置 7 天过期。

但 Redis 不稳定时不能影响主流程。

本任务可以只做 DB 方案；Redis 可作为后续。

## 7. 服务端：健康接口返回最近断线状态

### 目标

当前 `/api/bridge/ws-health` 只能看在线 Map。断线后就查不到刚才为什么断。

### 实现要求

管理员访问 `/api/bridge/ws-health` 时返回：

```json
{
  "ok": true,
  "serverTime": "...",
  "bridges": [...在线桥接...],
  "recentStatus": [
    {
      "userId": 1,
      "connected": false,
      "connectedAt": "...",
      "disconnectedAt": "...",
      "lastCloseCode": 1006,
      "lastCloseReason": "",
      "lastError": "...",
      "clientVersion": "v2.1.2",
      "mt5CollectTimeoutCount": 3,
      "updatedAt": "..."
    }
  ]
}
```

要求：

- 只允许管理员访问。
- 默认返回最近 50 条，可按更新时间排序。
- 不返回敏感字段。

## 8. 文档：补充部署侧检查说明

修改 `DEPLOY.md`，增加“桥接 WSS 稳定性部署检查”章节。

内容参考本文第二部分部署细则。

## 验证要求

必须执行：

```bash
node --check server/bridge-ws.js
node --check server/routes/ai/index.js
node --check server/db.js
python -m py_compile public/ai/aurum_bridge_gui.py
```

如果修改 migration 文件，也要检查对应文件。

手工/模拟验证：

1. WSS 地址错误时，客户端先能打印 HTTP 健康检查结果，再打印 WSS 失败。
2. MT5 数据采集超时时，不断开 WSS，不堆积大量日志。
3. 服务端 `/api/bridge/ws-health` 能看到客户端 heartbeat 摘要。
4. 桥接断开后，DB 表中能看到最近 close code/reason。
5. 普通用户访问 `/api/bridge/ws-health` 仍然 403。

## 结果文件要求

写入：

```text
docs/agent-results/20260702-mimo-bridge-wss-stability-hardening-result.md
```

必须包含：

- 修改文件列表。
- 客户端预检策略。
- MT5 采集超时策略。
- 服务端状态持久化设计。
- 健康接口返回字段。
- 验证命令和结果。
- 未完成项和剩余风险。

---

# 二、部署侧细则，人工执行

下面是线上部署时需要你检查/配置的内容，不需要 Mimo 自动执行。

## 1. Nginx WebSocket location 必须放在通用反代前面

在站点 Nginx 配置中，确保下面这个 location 在通用 `location /` 前面：

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

如果还有通用反代：

```nginx
location / {
    proxy_pass http://127.0.0.1:3000;
}
```

必须放在 WebSocket location 后面。

## 2. 检查 Nginx 配置并重载

```bash
nginx -t
nginx -s reload
```

宝塔环境也可以在面板里保存配置并重载 Nginx。

## 3. 检查 Nginx 日志

错误日志：

```bash
tail -n 300 /www/wwwlogs/你的站点.error.log
```

访问日志：

```bash
tail -n 300 /www/wwwlogs/你的站点.log
```

重点看：

```text
upstream timed out
connect() failed
prematurely closed connection
400/499/502/504
```

## 4. PM2 / Node 进程检查

查看进程：

```bash
pm2 list
```

查看日志：

```bash
pm2 logs --lines 300
```

查看最近重启：

```bash
pm2 describe aurum-ai
```

重点看：

- `restart_time` 是否持续增长。
- `memory` 是否接近限制。
- 桥接断线时间是否刚好对应 PM2 restart。

## 5. Node 启动参数建议

保持之前的内存限制：

```bash
--max-old-space-size=256
```

如果桥接用户数增多、日志和自动推理压力变大，可以观察后调整到：

```bash
--max-old-space-size=512
```

不要盲目调太大。先看 PM2 memory 和服务器总内存。

## 6. 服务器时间同步

检查时间：

```bash
date
timedatectl
```

启用 NTP：

```bash
timedatectl set-ntp true
```

如果系统没有 `timedatectl`，使用服务器面板或安装 chrony。

时间不同步可能影响：

- TLS 证书判断。
- JWT。
- 会员过期判断。
- 日志时间对齐。

## 7. 防火墙和端口

如果 Nginx 反代到本机 Node：

- 外网只需要开放 80/443。
- 3000 可以只监听本机或不对外开放。

检查 Node 是否监听：

```bash
ss -lntp | grep 3000
```

## 8. WebSocket 连通性验证

普通浏览器访问正常不代表 WebSocket 正常。

部署后检查服务端日志中是否出现：

```text
[BridgeWS] upgrade path=/aurum-api/bridge/ws type=bridge tokenPresent=true ip=...
[BridgeWS] bridge connected user=...
```

如果客户端显示一直重连，但服务端没有 upgrade 日志：

- 优先查 Nginx location 是否匹配。
- 查 SSL/域名。
- 查是否被 CDN/防火墙拦截 WebSocket。

如果有 upgrade，但没有 connected：

- 查 JWT/会员检查。
- 查服务端 `[BridgeWS] bridge auth failed` 或 `Plan check error`。

如果 connected 后又断：

- 查 close code/reason。
- 查 ping timeout。
- 查 PM2 是否重启。

## 9. 不建议使用会干扰 WebSocket 的 CDN 设置

如果前面套了 CDN，要确认：

- CDN 支持 WebSocket。
- WebSocket timeout 足够长。
- 没有对 `/aurum-api/bridge/ws` 做缓存、WAF 拦截或请求体限制。

如果不确定，先让桥接域名直连源站验证。

## 10. 上线后观察顺序

上线后建议按这个顺序看：

1. 桥接客户端日志：是否 HTTP 健康正常、WSS 连接成功。
2. PM2 日志：是否有 upgrade、connected、closed。
3. `/api/bridge/ws-health`：是否看到在线桥接和 client heartbeat。
4. DB `bridge_connection_status`：断开后是否记录 close code/reason。
5. Nginx error/access log：是否有 499/502/504 或 upstream timeout。

