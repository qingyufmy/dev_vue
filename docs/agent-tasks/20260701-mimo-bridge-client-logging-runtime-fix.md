# Mimo 任务：修复桥接客户端日志运行时错误与敏感信息/长日志控制

## 背景

上一轮 Mimo 提交：

```text
1eefbef fix: 桥接 WebSocket 审查修复 + 性能优化
```

Codex 审查后确认，之前的服务端阻断问题大部分已修复：

- `server/bridge-ws.js` 中 `_initBridge()` 未定义 `user` 的问题已修。
- `/api/bridge/ws-health` 的 `getAllBridges()` 作用域问题已修。
- 新增 `getBridgeDiagnostics()` 后，健康接口已能返回结构化诊断数据。
- 快速断开后的退避逻辑已实际提升到至少 30 秒。
- MT5 数据发送已从每轮两次 JSON 序列化优化为一次。

但桥接客户端仍有几个必须修复的问题，尤其是连接失败路径上的运行时错误。用户明确说明：**打包问题不用管**，本任务仍然不处理 exe 重新打包、不处理七牛上传、不处理前端下载版本。

请只在 `dev_codex` 分支修复并提交。

## 必须修复的问题

### 1. P1：`_format_ws_error()` 引用不存在的类名，连接失败时可能导致桥接线程异常退出

位置：

```text
public/ai/aurum_bridge_gui.py
```

当前代码类似：

```python
parts.append(f'{attr}={WsBridgeThread._short_text(val, 150)}')
```

问题：

- 当前类名是 `BridgeWorker`，项目里没有 `WsBridgeThread`。
- 当 WebSocket 异常对象带有 `headers` 或 `response` 属性时，`_format_ws_error()` 会抛 `NameError`。
- 这个错误发生在重连失败日志路径上，会让桥接软件在最需要持续重连的时候反而异常退出。
- `python -m py_compile` 查不出这种运行时名称错误，所以必须人工修正并补充最小运行验证。

修复要求：

- 改为正确引用：

```python
BridgeWorker._short_text(val, 150)
```

或把 `_format_ws_error()` 改为实例方法并使用：

```python
self._short_text(val, 150)
```

- 推荐保持静态方法结构，使用 `BridgeWorker._short_text(...)`，改动最小。
- 搜索全文件，确保没有其它 `WsBridgeThread` 残留。

验证要求：

- 构造一个带 `headers` 和 `response` 属性的假异常，调用 `_format_ws_error()` 不应抛异常。
- 如果不方便写正式测试，可在结果文件中说明用手工/临时代码验证过。

示例验证逻辑，不要求原样保留：

```python
class DummyError(Exception):
    headers = {"Authorization": "Bearer abc", "Cookie": "sid=123"}
    response = "token=abc&x=1"

print(BridgeWorker._format_ws_error(DummyError("test")))
```

输出应包含异常类型和摘要，但不包含 `abc` 或 `sid=123`。

### 2. P2：敏感信息脱敏方式仍可能泄露 token/Authorization/Cookie 前缀内容

当前 `_short_text()` 逻辑类似：

```python
s = str(value)
if 'Authorization' in s or 'Cookie' in s or 'token' in s.lower():
    s = s[:80] + '...[敏感信息已脱敏]'
```

问题：

- 这是先保留前 80 个字符，再追加“已脱敏”。
- 如果前 80 个字符里已经包含 `Authorization: Bearer <token>`、`Cookie: sid=...`、`token=...`，日志仍会泄露敏感值的一部分。
- WebSocket 握手失败时，headers/response 中很可能包含这些字段。

修复要求：

- 先脱敏，再截断。
- 使用正则或明确替换规则，把敏感字段的值替换掉。
- 至少覆盖以下形式：

```text
Authorization: Bearer xxxxxx
Authorization=Bearer xxxxxx
Cookie: sid=xxxx; other=...
Cookie=xxxx
token=xxxx
token: xxxx
access_token=xxxx
refresh_token=xxxx
Bearer xxxxxx
```

建议实现：

```python
import re

@staticmethod
def _mask_sensitive_text(value):
    s = str(value)
    patterns = [
        (r'(?i)(authorization\s*[:=]\s*bearer\s+)[^\s,;]+', r'\1[已脱敏]'),
        (r'(?i)(authorization\s*[:=]\s*)[^\s,;]+', r'\1[已脱敏]'),
        (r'(?i)(cookie\s*[:=]\s*)[^,\n\r]+', r'\1[已脱敏]'),
        (r'(?i)((?:access_token|refresh_token|token)\s*[:=]\s*)[^&\s,;]+', r'\1[已脱敏]'),
        (r'(?i)(bearer\s+)[^\s,;]+', r'\1[已脱敏]'),
    ]
    for pattern, repl in patterns:
        s = re.sub(pattern, repl, s)
    return s
```

然后 `_short_text()` 应当：

1. `s = BridgeWorker._mask_sensitive_text(value)`
2. 再按长度截断。

注意：

- 不要把完整 headers/response 打到日志。
- 不要引入第三方依赖，使用标准库 `re` 即可。

### 3. P2：UI 日志入口 `_log()` 仍没有统一单条长度限制

位置：

```text
public/ai/aurum_bridge_gui.py
```

当前 `_log()` 类似：

```python
self.log_area.append(f"[{ts}] {msg}")
```

问题：

- `_format_ws_error()` 虽然限制了错误日志长度，但 `_log()` 是 UI 日志的统一入口。
- 其它路径仍可能传入长消息，例如：
  - 命令结果；
  - 异常堆栈；
  - MT5 返回内容；
  - 后续新增日志；
  - 服务端返回的超长错误信息。
- QTextEdit 频繁 append 长文本会明显放大内存和 UI 压力。

修复要求：

- 在 `_log()` 入口统一限制单条消息长度。
- 建议新增常量：

```python
MAX_LOG_MESSAGE_CHARS = 1000
```

- `_log()` 中处理：

```python
msg = str(msg)
if len(msg) > MAX_LOG_MESSAGE_CHARS:
    msg = msg[:MAX_LOG_MESSAGE_CHARS] + "...[日志过长，已截断]"
```

- 截断前也应做敏感信息脱敏。可以复用 `BridgeWorker._mask_sensitive_text()`。
- 保留现有 `MAX_LOG_LINES = 500` 行数裁剪逻辑。
- 不要把 500 行裁剪删掉。

### 4. P2：重连失败日志可以进一步降噪，避免长期每次输出完整异常

当前连接失败时每次都输出完整：

```python
self.log_signal.emit(f"连接失败（第{retry_count}次）：{self._format_ws_error(e)}，{delay}秒后重试...")
```

问题：

- 即使单条日志限制到 800-1000 字符，长期断网或服务端不可达时，每 5/10/30 秒仍会向 QTextEdit 写入完整错误。
- 用户需要知道仍在重连，但不需要每次都重复相同的完整 headers/response 摘要。

修复要求：

- 保留排查价值，同时减少重复长日志。
- 建议策略：
  - 第 1、2、3 次连接失败：打印完整 `_format_ws_error(e)`。
  - 之后每 10 次打印一次完整错误。
  - 其它次数只打印摘要：

```text
连接失败（第 N 次）：TimeoutError，30秒后重试...
```

- 可以新增：

```python
def _brief_ws_error(e):
    return type(e).__name__ or "UnknownError"
```

- 不要影响会员/权限错误立即停止的逻辑。

## 保持已有修复，不要回退

请不要回退以下已完成改动：

- `_initBridge(ws, userId, user)` 传入 user。
- `getBridgeDiagnostics()`。
- `/bridge/ws-health` 使用 `getBridgeDiagnostics()`。
- 快速断开后至少 30 秒退避。
- `_async_send_loop()` 单次 JSON 序列化发送。
- `asyncio.wait(FIRST_COMPLETED)` 取消残留任务。

## 不处理范围

本任务不处理：

- `AURUM_Bridge.exe` 重新打包。
- 七牛 `AURUM_Bridge_v2.1.2.exe` 上传。
- `public/ai/app.js` 中下载 v2.1.1 的硬编码。
- 自动推理逻辑。
- 交易执行和风控逻辑。

## 验证要求

必须执行并记录：

```bash
node --check server/bridge-ws.js
node --check server/routes/ai/index.js
python -m py_compile public/ai/aurum_bridge_gui.py
```

必须补充运行时验证：

1. 搜索确认没有 `WsBridgeThread`：

```bash
rg -n "WsBridgeThread" public/ai/aurum_bridge_gui.py
```

结果应为空。

2. 用假异常验证 `_format_ws_error()`：

- 异常对象包含 `headers` 和 `response`。
- 不抛 `NameError`。
- 输出不包含原始 token/cookie/authorization 值。
- 输出长度不超过 800 字符。

3. 验证 `_log()`：

- 输入超过 2000 字符的消息。
- UI 实际 append 的消息应被截断到约 1000 字符。
- 不破坏现有 500 行裁剪逻辑。

4. 最低限度静态确认：

```bash
rg -n "_mask_sensitive_text|MAX_LOG_MESSAGE_CHARS|_brief_ws_error|_format_ws_error|def _log" public/ai/aurum_bridge_gui.py
```

## 结果文件要求

完成后写入：

```text
docs/agent-results/20260701-mimo-bridge-client-logging-runtime-fix-result.md
```

结果文件必须包含：

- 修复了哪些文件。
- `WsBridgeThread` 问题如何修复。
- 脱敏规则覆盖哪些字段。
- UI 日志单条长度限制是多少。
- 是否做了连接失败日志降噪。
- 验证命令和结果。
- 未完成项或剩余风险。

