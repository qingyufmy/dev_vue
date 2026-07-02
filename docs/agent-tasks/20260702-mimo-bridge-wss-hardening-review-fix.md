# Mimo 任务：修复桥接 WSS 稳定性增强审查问题

## 背景

上一轮 Mimo 完成了两个任务：

```text
67bf43b fix: 桥接客户端脱敏支持 dict/Mapping + 补充正则覆盖
14b267a feat: 桥接 WSS 稳定性增强
```

Codex 审查后确认，大方向已经完成：

- 脱敏支持 Mapping/dict。
- WSS 连接增加 HTTP 预检、SSL context 重建。
- 客户端 heartbeat 带状态字段。
- 服务端增加 `bridge_connection_status` 表。
- `/api/bridge/ws-health` 增加 `recentStatus`。

但仍有几个会影响新功能可用性或稳定性的缺陷，需要继续修一轮。

请只在 `dev_codex` 分支修复并提交。

## 修改范围

重点文件：

- `server/routes/ai/index.js`
- `public/ai/aurum_bridge_gui.py`
- `server/bridge-ws.js`

可能涉及：

- `server/migrations.js`，仅当字段或索引确实需要补充时。
- `DEPLOY.md`，仅当实现方式变化需要同步说明。

结果文件：

```text
docs/agent-results/20260702-mimo-bridge-wss-hardening-review-fix-result.md
```

不要修改：

- 自动推理业务逻辑。
- 交易执行/风控逻辑。
- exe 打包、七牛上传、前端下载版本。

---

## 必须修复的问题

### 1. P1：`/api/bridge/ws-health` 使用 `queryAll` 但没有导入

位置：

```text
server/routes/ai/index.js
```

当前顶部类似：

```js
import { queryOne, queryRun } from '../../db.js'
```

但路由里使用：

```js
recentStatus = await queryAll(...)
```

问题：

- `queryAll` 未导入。
- 因为外层 `catch {}` 静默吞掉错误，接口不会报错，但 `recentStatus` 会一直是空数组。
- 断线追溯功能失效。

修复要求：

- 改成：

```js
import { queryOne, queryRun, queryAll } from '../../db.js'
```

- 不要静默吞掉错误。至少：

```js
} catch (e) {
  console.error('[BridgeWS] ws-health recentStatus query failed:', e.message)
}
```

- 保持普通用户访问 403。
- 保持只返回最近 50 条。

验证要求：

- `node --check server/routes/ai/index.js`
- 静态确认文件里有 `queryAll` import。

---

### 2. P1：客户端 HTTP 预检依赖未声明的 `aiohttp`，打包环境可能静默失效

位置：

```text
public/ai/aurum_bridge_gui.py
```

当前实现：

```python
try:
    import aiohttp
    ...
except ImportError:
    pass
```

问题：

- 项目现有桥接依赖/安装脚本没有声明 `aiohttp`。
- 本地开发环境可能有 `aiohttp`，但用户下载的桥接包未必包含。
- `ImportError` 直接 `pass`，用户不会知道 HTTP 预检实际没运行。
- 这违背了“连接前预检，区分 HTTP 不通和 WSS 不通”的目标。

修复要求：

- 不要依赖 `aiohttp`。
- 复用现有同步函数 `http_get_json(url, timeout=5)`，放到 executor 中执行，避免阻塞 event loop。

示例：

```python
async def _health_check(self, http_base):
    loop = asyncio.get_running_loop()
    try:
        status_code, data = await loop.run_in_executor(
            None,
            lambda: http_get_json(f"{http_base}/health", timeout=5)
        )
        if status_code == 200:
            return True, data
        return False, {"status_code": status_code, "data": data}
    except Exception as e:
        return False, {"error": BridgeWorker._brief_ws_error(e)}
```

或在 `_run_async()` 内部实现同等逻辑。

日志要求：

- 健康检查失败：

```text
服务器健康检查失败：TimeoutError/HTTP 503/...
```

- 健康检查成功但后续 WSS 失败，在 WSS 失败日志附近补充：

```text
HTTP 健康检查正常，但 WebSocket 连接失败，优先检查 Nginx WebSocket 反代。
```

日志需要降噪：

- 只在做健康检查的轮次输出。
- 不要每 5 秒刷。

验证要求：

- `rg -n "aiohttp" public/ai/aurum_bridge_gui.py` 应为空。
- `python -m py_compile public/ai/aurum_bridge_gui.py`

---

### 3. P1：MT5 采集超时保护没有真正防止 executor 任务堆积

位置：

```text
public/ai/aurum_bridge_gui.py
```

当前实现逻辑：

```python
mt5_inflight = True
try:
    dm = await asyncio.wait_for(
        loop.run_in_executor(None, self._collect_mt5_data),
        timeout=MT5_COLLECT_TIMEOUT_SEC
    )
except asyncio.TimeoutError:
    ...
finally:
    mt5_inflight = False
```

问题：

- `asyncio.wait_for(run_in_executor(...))` 超时后，底层线程中的 MT5 调用不一定停止。
- `finally` 立即把 `mt5_inflight` 设回 `False`，下一轮又提交新的 executor 任务。
- 如果 MT5 API 卡住，会持续堆积后台线程任务，反而增加内存/线程压力。

修复目标：

- 同一时刻最多允许一个 MT5 采集任务在跑。
- 如果上一轮 future 没真正完成，下一轮跳过，不再提交新任务。
- future 真正完成后再清理 inflight。

推荐实现：

在 `_async_send_loop()` 内维护：

```python
mt5_future = None
mt5_timeout_count = 0
mt5_was_slow = False
```

每轮：

```python
loop = asyncio.get_running_loop()

if mt5_future is None:
    mt5_future = loop.run_in_executor(None, self._collect_mt5_data)

try:
    dm = await asyncio.wait_for(asyncio.shield(mt5_future), timeout=MT5_COLLECT_TIMEOUT_SEC)
    mt5_future = None
except asyncio.TimeoutError:
    mt5_timeout_count += 1
    self._mt5_timeout_count = mt5_timeout_count
    mt5_was_slow = True
    # 不要把 mt5_future 置空，因为底层任务仍可能在跑
    await asyncio.sleep(1)
    continue
except Exception:
    mt5_future = None
    raise
```

关键点：

- 使用 `asyncio.shield(mt5_future)`，避免 `wait_for` 超时后取消 future。
- 超时后保留 `mt5_future`，下一轮继续等同一个 future。
- 只有成功拿到结果或 future 抛异常后，才 `mt5_future = None`。
- 如果 future 长时间不完成，不会新增更多 executor 任务。

如果担心同一个 future 永远卡死：

- 不能安全杀线程，但可以持续跳过，并通过日志/状态提示 `MT5响应慢`。
- 不要提交新任务堆积。

验证要求：

- 静态确认使用了 `asyncio.shield(...)` 或等效逻辑。
- 静态确认超时分支不再立即清理 inflight 并提交新任务。

---

### 4. P2：MT5 超时计数和恢复逻辑不成立，heartbeat 拿不到实时超时状态

当前问题：

- `mt5_timeout_count += 1` 后，成功采集时没有重置为 0。
- `last_mt5_timeout_count > 0 and mt5_timeout_count == 0` 这个恢复判断基本不会触发。
- `self._mt5_timeout_count` 只在成功发送数据后更新，连续超时时 heartbeat 仍可能显示旧值。

修复要求：

- 区分：
  - 连续超时次数：`mt5_timeout_count`
  - 是否处于慢响应状态：`mt5_was_slow`
- 超时分支立即更新：

```python
self._mt5_timeout_count = mt5_timeout_count
```

- 成功采集后：

```python
if mt5_was_slow:
    self.log_signal.emit("MT5 数据采集已恢复。")
mt5_timeout_count = 0
self._mt5_timeout_count = 0
mt5_was_slow = False
```

- 成功拿到 `dm` 但 `dm is None` 时，也应视为 MT5 可调用但无数据，不应继续累积 timeout。

Heartbeat 要能实时反映：

```json
"mt5_collect_timeout_count": 当前连续超时次数
```

验证要求：

- 静态确认超时分支会更新 `self._mt5_timeout_count`。
- 静态确认成功分支会重置 `mt5_timeout_count` 并打印恢复日志。

---

### 5. P2：服务端状态持久化字段不完整

位置：

```text
server/bridge-ws.js
```

当前问题：

- `bridge_connection_status` 表包含：
  - `last_pong_at`
  - `last_error`
- 但消息更新只写：
  - `last_seen_at`
  - `last_message_type`
  - `client_version`
  - `mt5_collect_timeout_count`
- `last_pong_at` 没随 `pong/hb` 更新。
- `ws.on('error')` 没把 `last_error` 写入表。

修复要求：

#### 5.1 更新 `last_pong_at`

在收到：

```js
msg.type === 'hb' || msg.type === 'pong'
```

时，节流或直接更新：

```sql
last_pong_at = NOW()
```

建议仍使用节流，避免频繁写库：

- 可以复用 `_lastDbWrite`，但要注意如果只收到 hb，也能更新。
- 或增加 `_lastStatusDbWrite`。

至少确保：

- 收到 `hb/pong` 后 60 秒内会写一次 `last_pong_at`。

#### 5.2 持久化 `last_error`

在：

```js
ws.on('error', (err) => { ... })
```

中 upsert/update：

```sql
last_error = err.message.slice(0, 255)
updated_at = NOW()
```

DB 写入失败不能影响桥接主流程。

#### 5.3 close 时保留 last_error 语义

当前 close 时写：

```js
last_error = ''
```

建议：

- close 不要无条件清空 `last_error`。
- 如果 close 是正常关闭，可以不改 last_error。
- 如果 reason 明确异常，可写入 `last_error` 或只写 close code/reason。

推荐：

```sql
last_close_code = ?
last_close_reason = ?
```

不要设置 `last_error=''`。

验证要求：

- 静态确认 `last_pong_at` 被写入。
- 静态确认 `ws.on('error')` 写入 `bridge_connection_status.last_error`。
- 静态确认 close 不再无条件清空 last_error。

---

## 验证命令

必须执行并记录：

```bash
node --check server/bridge-ws.js
node --check server/routes/ai/index.js
node --check server/migrations.js
python -m py_compile public/ai/aurum_bridge_gui.py
rg -n "aiohttp" public/ai/aurum_bridge_gui.py
```

期望：

- 所有 check 通过。
- `aiohttp` 搜索为空。

建议补充静态检查：

```bash
rg -n "queryAll" server/routes/ai/index.js
rg -n "asyncio.shield|mt5_future|_mt5_timeout_count|MT5 数据采集已恢复" public/ai/aurum_bridge_gui.py
rg -n "last_pong_at|last_error" server/bridge-ws.js
```

---

## 结果文件要求

完成后写入：

```text
docs/agent-results/20260702-mimo-bridge-wss-hardening-review-fix-result.md
```

必须包含：

- 修改文件列表。
- `queryAll` import 修复说明。
- HTTP 预检移除 `aiohttp` 的说明。
- MT5 executor 防堆积策略说明。
- MT5 超时计数/恢复逻辑说明。
- 状态持久化补齐字段说明。
- 验证命令和结果。
- 未完成项或剩余风险。

