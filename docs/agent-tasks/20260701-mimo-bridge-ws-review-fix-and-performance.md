# Mimo 任务：修复桥接 WebSocket 审查问题 + 排查桥接客户端内存占用

## 背景

上一轮 Mimo 已提交：

```text
cc3dbca fix: 桥接 WebSocket 重连优化 + 诊断日志增强
```

Codex 审查发现：本次修改有运行时阻断问题，且桥接客户端可能存在性能/内存浪费点。用户明确说明：**打包问题暂时不用管**，本任务不处理 `AURUM_Bridge.exe` 是否重新打包、不处理七牛下载文件是否存在。

请只在 `dev_codex` 分支修复并提交。

## 必须修复的问题

### 1. P0：`server/bridge-ws.js` 中 `_initBridge()` 引用未定义变量 `user`

位置：

```js
console.log(`[BridgeWS] bridge connected user=${userId} plan=${user?.role || 'unknown'} replacedOld=${replacedOld}`)
```

问题：

- `_initBridge(ws, userId)` 作用域内没有 `user` 变量。
- JS 中 `user?.role` 对未声明变量仍会抛 `ReferenceError`。
- 这会导致桥接通过会员检查后，在注册连接时直接异常，最终连接失败。

修复要求：

- 不要在 `_initBridge()` 中引用未定义变量。
- 选择一种合理方案：
  - 方案 A：在 `handleBridge()` 查询到 user 后，把 user 传入 `_initBridge(ws, userId, user)`。
  - 方案 B：在 `_initBridge()` 内重新查询或只打印 `userId/isAdmin`，不要打印 plan/role。
- 推荐方案 A，因为后续日志需要 role/plan。
- 修改后日志至少包括：

```text
[BridgeWS] bridge connected user=123 role=admin plan=pro replacedOld=false
```

注意：

- 不要打印 token、邮箱、密码、JWT。
- 如果用户不存在或会员检查失败，保持原有拒绝逻辑。

### 2. P1：`/api/bridge/ws-health` 使用 `getAllBridges()` 的方式不正确

位置：

```js
router.get('/bridge/ws-health', authMiddleware, (req, res) => {
  ...
  const bridges = getAllBridges()
  ...
})
```

问题：

- 当前文件只有：

```js
export { ..., getAllBridges, ... } from '../../bridge-ws.js'
```

- re-export 不会创建本地变量，路由运行时会 `ReferenceError: getAllBridges is not defined`。

修复要求：

- 在 `server/routes/ai/index.js` 顶部显式 import 本地使用的函数，例如：

```js
import { getAllBridges } from '../../bridge-ws.js'
```

- 同时避免与底部 re-export 冲突。可以：
  - 顶部 import `getAllBridges as getBridgeDiagnostics`，路由使用别名；
  - 底部继续 re-export 原名。

### 3. P1：`getAllBridges()` 返回字段不够，健康接口拿不到真实诊断数据

当前 `server/bridge-ws.js` 的 `getAllBridges()` 只返回：

```js
{
  userId,
  connected,
  alive,
  lastSeen,
}
```

但 `/bridge/ws-health` 里读取：

```js
b.ws?.readyState
b._connectTime
b.lastPong
b._lastMessageType
b.tradeEnabled
b.autoReasoningEnabled
```

这些字段当前都不存在，因此健康接口即使不报错，也会返回大量无效默认值。

修复要求：

- 不要直接把 `ws` 对象返回给路由，避免暴露复杂对象和敏感内部状态。
- 修改 `getAllBridges()` 或新增 `getBridgeDiagnostics()`，返回经过脱敏和结构化的诊断数据。
- 推荐新增：

```js
export function getBridgeDiagnostics() {
  const now = Date.now()
  return Array.from(bridges.entries()).map(([userId, bridge]) => ({
    userId,
    readyState: bridge.ws?.readyState ?? -1,
    connected: bridge.ws?.readyState === 1,
    alive: !!(bridge.ws?.readyState === 1 && now - bridge.lastSeen < 20000),
    connectedSeconds: bridge._connectTime ? Math.round((now - bridge._connectTime) / 1000) : 0,
    lastSeenAgeSeconds: bridge.lastSeen ? Math.round((now - bridge.lastSeen) / 1000) : -1,
    lastPongAgeSeconds: bridge.lastPong ? Math.round((now - bridge.lastPong) / 1000) : -1,
    lastMessageType: bridge._lastMessageType || '?',
    tradeEnabled: !!bridge.tradeEnabled,
    autoReasoningEnabled: !!bridge.autoReasoningEnabled,
    lastTradeMode: typeof bridge.lastTradeMode === 'number' ? bridge.lastTradeMode : -1,
    mt5TimeStr: bridge.mt5TimeStr || null,
    lastTickAgeSeconds: bridge.lastTickMs ? Math.round((now - bridge.lastTickMs) / 1000) : -1,
  }))
}
```

- `/api/bridge/ws-health` 直接返回这个结构，不要再二次访问内部 `ws`。
- 保持管理员权限限制。
- 不返回邮箱、token、账号余额、持仓、订单等敏感信息。

### 4. P2：快速断开后的“延长重连间隔”没有实际生效

当前客户端逻辑：

```python
if rapid_fails >= MAX_RAPID_FAILS:
    self.log_signal.emit("连续多次快速断开，已延长重连间隔，仍会继续自动重连。")

retry_delay = get_backoff_delay()
```

问题：

- `get_backoff_delay()` 只看 `retry_count`。
- 一次连接成功后快速断开，`retry_count` 通常很小，所以仍然可能是 5 秒。
- 日志说延长了，但实际没有延长。

修复要求：

- 当 `rapid_fails >= MAX_RAPID_FAILS` 时，下一次会话级重连等待至少 30 秒，建议 60 秒封顶。
- 例如：

```python
retry_delay = get_backoff_delay()
if rapid_fails >= MAX_RAPID_FAILS:
    retry_delay = max(retry_delay, 30)
```

- 如果连续快速断开次数持续增加，可以逐步退避：

```python
retry_delay = min(60, max(retry_delay, 30 + (rapid_fails - MAX_RAPID_FAILS) * 5))
```

- 仍然不要永久停止重连。

## 桥接客户端性能/内存排查与优化

用户反馈：桥接软件当前感觉内存占用偏高，怀疑是否因为日志问题。

Codex 初步判断：

- UI 日志区有 `MAX_LOG_LINES = 500` 裁剪，文件日志有 7 天清理，所以普通日志不是唯一内存来源。
- 但 Mimo 新增的异常格式化可能把 `headers`、`response` 等大对象直接字符串化，重连失败时会放大 UI 日志和内存压力。
- `_async_send_loop()` 每秒对完整 MT5 数据 `json.dumps()` 至少两次：
  - 一次用于 `data_hash = hash(json.dumps(...))`
  - 一次用于 `await ws.send(json.dumps(dm))`
- 当持仓数量较多或数据结构变大时，这会造成 CPU 和短期内存分配浪费。

请重点检查并优化以下点。

### 5. 限制 `_format_ws_error()` 的输出长度与字段

当前 `_format_ws_error(e)` 会尝试输出：

```python
headers
response
args
```

问题：

- `headers` / `response` 可能很长。
- `args` 也可能包含大对象。
- 重连循环中每次失败都写 UI 日志，过长日志会增加 QTextEdit 压力。

修复要求：

- 新增安全截断函数，例如：

```python
def _short_text(value, limit=300):
    ...
```

- `_format_ws_error()` 的最终字符串建议限制在 800-1200 字符以内。
- headers/response 只保留摘要，不要完整输出。
- token、Authorization、Cookie 必须脱敏。
- 如果异常信息为空，保留 `无详细信息`。

### 6. 优化 `_async_send_loop()` 的 JSON 序列化

当前：

```python
data_hash = hash(json.dumps(dm, sort_keys=True, default=str))
...
await ws.send(json.dumps(dm))
```

要求：

- 每轮最多序列化一次主要数据。
- 可改为：

```python
payload = json.dumps(dm, sort_keys=True, default=str, ensure_ascii=False, separators=(',', ':'))
data_hash = hash(payload)
...
await ws.send(payload)
```

注意：

- 如果服务端依赖中文可读性，`ensure_ascii=False` 可以保留；否则默认也可。
- 不要改变业务字段结构。
- 不要为了 hash 做深拷贝。

### 7. 控制 UI 日志更新频率

现有 `_log()` 每条日志都直接 `QTextEdit.append()`。

要求：

- 不必大改 UI，但要避免重连失败时每 5 秒刷一条很长日志。
- 至少做到：
  - 单条日志最大长度限制，例如 1000 字符。
  - 高频重复连接失败日志可以压缩，例如只完整打印第 1 次、第 2 次、第 3 次，之后每 N 次打印摘要。
- 保留用户排查需要的信息：异常类型、重试次数、等待秒数。

### 8. 检查线程池/任务退出是否会残留

当前会话使用：

```python
await asyncio.gather(
    self._async_send_loop(ws),
    self._async_recv_loop(ws),
    self._async_heartbeat_loop(ws),
)
```

要求：

- 确认任一任务因连接断开退出后，其它任务不会长时间挂住导致无法进入下一轮重连。
- 如果需要，可改为：
  - 创建 tasks；
  - `asyncio.wait(..., return_when=asyncio.FIRST_COMPLETED)`；
  - 取消未完成任务并 `await asyncio.gather(..., return_exceptions=True)`。
- 目标：断开后快速释放当前 ws 会话相关任务，避免累计任务或内存。

### 9. 不要在桥接客户端保存不必要历史数据

检查是否有新增列表、缓存、历史日志对象未清理。

要求：

- 不要引入长期增长的 list/dict。
- 如果需要统计重连信息，只保存计数和最近一次摘要，不保存完整异常对象。

## 不处理范围

用户明确要求：打包问题不用管。

因此本任务不要求：

- 重新打包 `public/ai/AURUM_Bridge.exe`。
- 上传 `AURUM_Bridge_v2.1.2.exe` 到七牛。
- 修复 `public/ai/app.js` 中手动下载 v2.1.1 的硬编码。

但不要新增新的版本不一致问题。

## 验证要求

必须执行并在结果文件中记录：

```bash
node --check server/bridge-ws.js
node --check server/routes/ai/index.js
python -m py_compile public/ai/aurum_bridge_gui.py
```

建议补充手工/模拟验证：

1. 桥接连接成功时服务端不会再因 `user` 未定义崩溃。
2. 管理员访问 `/api/bridge/ws-health` 能返回真实字段：
   - `readyState`
   - `connectedSeconds`
   - `lastSeenAgeSeconds`
   - `lastPongAgeSeconds`
   - `lastMessageType`
3. 普通用户访问 `/api/bridge/ws-health` 返回 403。
4. 模拟 WebSocket 地址不可达，客户端日志不会无限输出超长 headers/response。
5. 快速断开 5 次后，下一次重连等待时间确实 >= 30 秒。

## 结果文件要求

完成后写入：

```text
docs/agent-results/20260701-mimo-bridge-ws-review-fix-and-performance-result.md
```

结果文件必须包含：

- 修复了哪些审查问题。
- 桥接客户端内存/性能方面做了哪些优化。
- 是否发现日志是高内存主因。
- 执行的验证命令和结果。
- 未完成项与剩余风险。

