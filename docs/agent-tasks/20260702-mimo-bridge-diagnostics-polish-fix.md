# Mimo 任务：修复桥接 WSS 诊断准确性两个小问题

## 背景

上一轮 Mimo 提交：

```text
30faac9 fix: 桥接 WSS 稳定性增强审查修复
```

Codex 审查确认：当前没有发现阻断桥接连接的错误，可以进入部署/实测。但还有两个诊断准确性问题，建议补齐：

1. `last_pong_at` 可能被普通 `data` 消息的 DB 节流挡住，导致健康接口里的最近心跳时间偏旧。
2. 客户端 HTTP 健康检查成功但 WSS 失败时，没有明确提示“HTTP 正常但 WebSocket 失败”。

请只在 `dev_codex` 分支做小范围修复并提交。

## 修改范围

重点文件：

- `server/bridge-ws.js`
- `public/ai/aurum_bridge_gui.py`

结果文件：

```text
docs/agent-results/20260702-mimo-bridge-diagnostics-polish-fix-result.md
```

不要修改：

- 自动推理逻辑。
- 交易执行/风控逻辑。
- 数据库 schema，除非确认现有字段不足。本任务不需要新增字段。
- exe 打包、七牛上传、前端下载版本。

---

## 问题 1：`last_pong_at` 可能长期不更新

### 当前问题

位置：

```text
server/bridge-ws.js
```

当前 `bridge_connection_status` 的 DB 更新逻辑类似：

```js
if (bridge && (!bridge._lastDbWrite || Date.now() - bridge._lastDbWrite > 60000)) {
  bridge._lastDbWrite = Date.now()
  queryRun('UPDATE users SET bridge_heartbeat = NOW() WHERE id = ?', [userId]).catch(() => {})

  const hb = bridge._clientHeartbeat || {}
  const isHeartbeat = msg.type === 'hb' || msg.type === 'pong'
  const pongUpdate = isHeartbeat ? ', last_pong_at=NOW()' : ''
  queryRun(
    `UPDATE bridge_connection_status SET last_seen_at=NOW(), last_message_type=?, client_version=?, mt5_collect_timeout_count=?${pongUpdate}, updated_at=NOW() WHERE user_id=?`,
    [...]
  ).catch(() => {})
}
```

问题：

- 普通 `data` 消息每秒都有。
- 如果 60 秒节流窗口被 `data` 消息先触发，则 `_lastDbWrite` 被刷新。
- 后续 60 秒内的 `hb/pong` 消息不会进入 DB 更新分支。
- 结果：`last_pong_at` 可能长期偏旧，不利于诊断，但不影响连接本身。

### 修复目标

- 普通 `last_seen_at/last_message_type` 更新继续保持节流。
- `last_pong_at` 使用单独节流，不被普通 `data` 消息抢占。
- 收到 `hb/pong` 后，最多 60 秒内能写一次 `last_pong_at`。

### 推荐实现

在 `ws.on('message')` 内拆成两个节流：

#### 1. 普通状态写入节流

保留现有 `_lastDbWrite`，负责：

- `users.bridge_heartbeat`
- `bridge_connection_status.last_seen_at`
- `bridge_connection_status.last_message_type`
- `client_version`
- `mt5_collect_timeout_count`

示意：

```js
if (bridge && (!bridge._lastDbWrite || Date.now() - bridge._lastDbWrite > 60000)) {
  bridge._lastDbWrite = Date.now()
  queryRun('UPDATE users SET bridge_heartbeat = NOW() WHERE id = ?', [userId]).catch(() => {})

  const hb = bridge._clientHeartbeat || {}
  queryRun(
    `UPDATE bridge_connection_status
     SET last_seen_at=NOW(),
         last_message_type=?,
         client_version=?,
         mt5_collect_timeout_count=?,
         updated_at=NOW()
     WHERE user_id=?`,
    [msg.type || '?', hb.client_version || null, hb.mt5_collect_timeout_count || 0, userId]
  ).catch(() => {})
}
```

#### 2. 心跳时间写入单独节流

新增：

```js
const isHeartbeat = msg.type === 'hb' || msg.type === 'pong'
if (bridge && isHeartbeat && (!bridge._lastPongDbWrite || Date.now() - bridge._lastPongDbWrite > 60000)) {
  bridge._lastPongDbWrite = Date.now()
  queryRun(
    `UPDATE bridge_connection_status
     SET last_pong_at=NOW(), updated_at=NOW()
     WHERE user_id=?`,
    [userId]
  ).catch(() => {})
}
```

注意：

- 不要每 15 秒都写 DB，避免无意义写入。
- 使用 60 秒节流即可。
- 不要依赖 `_lastDbWrite`。
- 不要删除现有内存态 `bridge.lastPong = Date.now()`。

### 验证要求

静态验证：

```bash
rg -n "_lastPongDbWrite|last_pong_at|_lastDbWrite" server/bridge-ws.js
```

确认：

- 存在 `_lastPongDbWrite`。
- `last_pong_at` 不再拼接到 `_lastDbWrite` 的 SQL 里。
- `last_pong_at` 有独立 update。

---

## 问题 2：HTTP 健康检查成功但 WSS 失败时没有明确提示

### 当前问题

位置：

```text
public/ai/aurum_bridge_gui.py
```

当前 HTTP 健康检查成功时只设置：

```python
self._last_health_ok = True
```

但后续 `websockets.connect()` 失败时，没有输出：

```text
HTTP 健康检查正常，但 WebSocket 连接失败，优先检查 Nginx WebSocket 反代。
```

这导致用户仍然无法区分：

- 服务器整体不可达；
- HTTP 正常但 WSS upgrade/反代异常。

### 修复目标

- 只有在最近一次做过健康检查且成功的情况下，WSS 失败时打印明确提示。
- 不能每次失败都重复刷同一条提示。
- 不改变重连策略。

### 推荐实现

在 `_run_async()` 中维护两个局部变量：

```python
last_health_ok = False
last_health_check_retry = 0
last_wss_hint_retry = 0
```

健康检查成功时：

```python
last_health_ok = True
last_health_check_retry = retry_count
```

健康检查失败时：

```python
last_health_ok = False
last_health_check_retry = retry_count
```

WSS 连接失败的 `except Exception as e:` 中，在输出连接失败日志前或后增加：

```python
if last_health_ok and last_wss_hint_retry != retry_count:
    self.log_signal.emit("HTTP 健康检查正常，但 WebSocket 连接失败，优先检查 Nginx WebSocket 反代。")
    last_wss_hint_retry = retry_count
```

为了避免重复刷屏，可以更严格：

- 只在做健康检查的同一轮失败时提示：

```python
if last_health_ok and last_health_check_retry == retry_count:
    ...
```

推荐使用这个更严格的条件。

注意：

- 不要使用实例字段 `self._last_health_ok`，局部变量更清晰，避免跨会话残留。
- 不要打印 token。
- 不要改变会员/权限错误立即停止逻辑。
- 如果 HTTP 健康检查失败，不要打印“HTTP 正常”提示。

### 验证要求

静态验证：

```bash
rg -n "HTTP 健康检查正常|last_health_ok|last_health_check_retry|last_wss_hint_retry" public/ai/aurum_bridge_gui.py
```

确认：

- 有 `HTTP 健康检查正常，但 WebSocket 连接失败...` 日志。
- 该日志只在 WSS 失败路径中出现。
- 有防重复逻辑。

---

## 必须执行的验证命令

```bash
node --check server/bridge-ws.js
python -m py_compile public/ai/aurum_bridge_gui.py
```

建议也跑：

```bash
node --check server/routes/ai/index.js
node --check server/migrations.js
```

---

## 结果文件要求

完成后写入：

```text
docs/agent-results/20260702-mimo-bridge-diagnostics-polish-fix-result.md
```

结果文件必须包含：

- 修改文件列表。
- `last_pong_at` 独立节流的实现说明。
- HTTP 正常但 WSS 失败提示的实现说明。
- 执行的验证命令和结果。
- 未完成项或剩余风险。

