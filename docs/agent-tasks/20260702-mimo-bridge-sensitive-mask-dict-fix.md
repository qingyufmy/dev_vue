# Mimo 任务：补齐桥接客户端日志脱敏规则，修复 dict headers 中 Cookie 泄露

## 背景

上一轮 Mimo 提交：

```text
d632e29 fix: 桥接客户端日志运行时错误修复 + 敏感信息脱敏 + 日志降噪
```

Codex 审查确认：

- `WsBridgeThread` 运行时名称错误已修复。
- `_log()` 已增加单条日志长度限制。
- 连接失败日志已做降噪。
- 基础语法检查通过。

但仍发现一个脱敏边界问题：当前 `_mask_sensitive_text()` 对普通文本形式有效，例如：

```text
Authorization: Bearer abc
token=abc
Cookie: sid=123
```

但对 Python `dict` 字符串形式覆盖不完整。WebSocket / HTTP 异常里的 headers 很可能是 dict、Mapping 或类似对象，例如：

```python
{
  "Authorization": "Bearer abc",
  "Cookie": "sid=123",
  "X": "token=zzz"
}
```

当前规则处理后仍可能留下：

```text
'Cookie': 'sid=123'
```

这会造成日志里泄露 session/cookie 片段。

请只在 `dev_codex` 分支修复并提交。

## 修改范围

主要文件：

```text
public/ai/aurum_bridge_gui.py
```

结果文件：

```text
docs/agent-results/20260702-mimo-bridge-sensitive-mask-dict-fix-result.md
```

不要修改：

- 自动推理逻辑。
- 交易执行逻辑。
- 服务端 WebSocket 逻辑，除非发现必须配合改动。
- exe 打包、七牛上传、前端下载版本。

## 必须修复的问题

### 1. `_mask_sensitive_text()` 必须覆盖 dict / Mapping 形式

当前实现是先 `str(value)`，再用正则替换。这个方式对 dict 字符串不够稳。

建议优先实现结构化脱敏：

```python
from collections.abc import Mapping
```

如果 `value` 是 Mapping：

```python
if isinstance(value, Mapping):
    masked = {}
    for k, v in value.items():
        key = str(k)
        if key.lower() in ("authorization", "cookie", "set-cookie"):
            masked[key] = "[已脱敏]"
        elif "token" in key.lower():
            masked[key] = "[已脱敏]"
        else:
            masked[key] = BridgeWorker._mask_sensitive_text(v)
    return str(masked)
```

注意：

- `Authorization`、`Cookie`、`Set-Cookie` 的值必须完全替换。
- `token`、`access_token`、`refresh_token` 这类 key 的值必须完全替换。
- 非敏感字段可以保留，但其 value 里如果包含 token/cookie 文本，也要递归脱敏。
- 不要引入第三方依赖。

如果不想引入 `Mapping` import，也可以用 `hasattr(value, "items")`，但要避免误判。

### 2. 字符串形式必须覆盖带引号的 dict 文本

即使先处理 Mapping，也仍然要覆盖字符串形式，因为某些异常可能已经把 headers 转成字符串。

必须覆盖这些形态：

```text
{'Authorization': 'Bearer abc'}
{"Authorization": "Bearer abc"}
{'Cookie': 'sid=123'}
{"Cookie": "sid=123"}
{'Set-Cookie': 'sid=123; Path=/'}
{"token": "abc"}
{'access_token': 'abc'}
{'refresh_token': 'abc'}
```

建议在原有 patterns 基础上补充：

```python
(r'(?i)([\\'"]?(?:authorization|cookie|set-cookie|access_token|refresh_token|token)[\\'"]?\\s*:\\s*[\\'"])[^\\'"]+([\\'"])', r'\\1[已脱敏]\\2')
```

同时保留原有覆盖普通文本的规则：

```text
Authorization: Bearer xxx
Authorization=Bearer xxx
Cookie: xxx
Cookie=xxx
token=xxx
access_token=xxx
refresh_token=xxx
Bearer xxx
```

注意正则转义，确保 Python 字符串语法正确。

### 3. `_short_text()` 必须仍然先脱敏再截断

保持当前顺序：

```python
s = BridgeWorker._mask_sensitive_text(value)
if len(s) > limit:
    s = s[:limit] + "..."
```

不要改成先截断再脱敏，否则敏感值可能在截断前半段泄露。

### 4. `_log()` 入口必须继续复用脱敏

保持或强化：

```python
msg = BridgeWorker._mask_sensitive_text(str(msg))
```

如果 `_mask_sensitive_text()` 已经支持字符串和 Mapping，则 `_log()` 仍然只需传入字符串即可。

不要移除：

```python
MAX_LOG_MESSAGE_CHARS = 1000
```

不要移除现有 500 行裁剪逻辑。

## 推荐实现细节

可以把敏感字段判断提成 helper：

```python
@staticmethod
def _is_sensitive_key(key):
    key = str(key).lower()
    return (
        key in ("authorization", "cookie", "set-cookie")
        or "token" in key
    )
```

然后：

```python
@staticmethod
def _mask_sensitive_text(value):
    import re
    from collections.abc import Mapping

    if isinstance(value, Mapping):
        masked = {}
        for k, v in value.items():
            key = str(k)
            if BridgeWorker._is_sensitive_key(key):
                masked[key] = "[已脱敏]"
            else:
                masked[key] = BridgeWorker._mask_sensitive_text(v)
        return str(masked)

    s = str(value)
    patterns = [...]
    for pattern, repl in patterns:
        s = re.sub(pattern, repl, s)
    return s
```

如果担心递归处理复杂对象，做一层即可，但要确保 headers dict 的敏感值不泄露。

## 验证要求

必须执行：

```bash
python -m py_compile public/ai/aurum_bridge_gui.py
rg -n "WsBridgeThread" public/ai/aurum_bridge_gui.py
```

`WsBridgeThread` 搜索应为空。

必须做最小脱敏验证。可以用临时代码，不要求保留测试文件，但结果文件必须写明验证输出不包含原始敏感值。

建议验证输入：

```python
samples = [
    {"Authorization": "Bearer abc123", "Cookie": "sid=secret", "X": "token=tok123"},
    "{'Authorization': 'Bearer abc123', 'Cookie': 'sid=secret'}",
    '{"Authorization": "Bearer abc123", "Cookie": "sid=secret"}',
    "Authorization: Bearer abc123",
    "Cookie: sid=secret; Path=/",
    "token=tok123&x=1",
    "access_token=aaa refresh_token=bbb",
    "Bearer rawtoken",
]
```

验证目标：

- 输出不包含：

```text
abc123
sid=secret
tok123
aaa
bbb
rawtoken
```

- 输出应包含：

```text
[已脱敏]
```

- `_short_text()` 输出长度不超过传入 limit + 3。
- `_format_ws_error()` 输出长度不超过 800。

### 额外建议验证

构造假异常：

```python
class DummyError(Exception):
    headers = {"Authorization": "Bearer abc123", "Cookie": "sid=secret"}
    response = "{'token': 'tok123'}"

out = BridgeWorker._format_ws_error(DummyError("failed"))
```

要求：

- 不抛异常。
- 输出包含 `DummyError`。
- 输出不包含 `abc123`、`sid=secret`、`tok123`。

## 结果文件要求

完成后写入：

```text
docs/agent-results/20260702-mimo-bridge-sensitive-mask-dict-fix-result.md
```

结果文件必须包含：

- 修改文件列表。
- 具体新增/调整的脱敏规则。
- 是否支持 Mapping/dict 形式。
- 验证命令和结果。
- 最小脱敏验证的结论。
- 未完成项或剩余风险。

