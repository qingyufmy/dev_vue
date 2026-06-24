# 开发者技术提升指南

> 基于AURUM项目真实问题 · 2026-06-24

---

## 一、反模式速查：看到这些写法，立即警惕

以下每一项都来自本项目的真实代码，附修复示例。

### 1. 🔴 空异常吞噬（全项目 30+ 处）

```python
# ❌ 永远不要这样写
try:
    result = risky_operation()
except:
    pass              # 吞掉了所有异常，包括 SystemExit、KeyboardInterrupt
```

```python
# ✅ 正确写法：至少明确类型 + 记录日志
try:
    result = risky_operation()
except Exception as e:
    logger.warning(f"risky_operation failed: {e}（非致命，跳过）")
```

> **规则**：`except:` 裸异常永远不允许（除非你写得比 `KeyboardInterrupt` 异常中断更懂得怎么叫停 Python）。
> 允许 `except Exception`，但必须至少打一行日志。

```javascript
// ❌ JS 端的等价反模式
try { jwt.verify(token, SECRET) } catch {}   // 无日志，无 fallback
```

```javascript
// ✅ 正确写法
try {
    const { userId } = jwt.verify(token, SECRET)
} catch (err) {
    console.error(`[Auth] JWT verify failed: ${err.message}`)
    ws.close(4002, 'invalid_token')
    return
}
```

---

### 2. 🔴 变量引用前的定义顺序错误

```python
# ❌ 真实 Bug（v1.9.9 → 所有开仓失败）
def _order_send_with_retry(self, build_req_fn):
    tick = self.mt5.symbol_info_tick(req.get("symbol"))  # req 还没定义！
    req = build_req_fn(tick)                              # req 在这里才赋值
```

```python
# ✅ 修复：参数前置
def _order_send_with_retry(self, symbol, build_req_fn):
    tick = self.mt5.symbol_info_tick(symbol)
    req = build_req_fn(tick)
    ...
```

> **规则**：如果一个变量不是 `global`/`nonlocal`，那它一定在当前函数内被赋值过，写之前确认一眼。

---

### 3. 🟡 None 到 "None" 字符串转换

```python
# ❌ 真实 Bug
def _resolve_symbol(self, symbol):
    symbol = symbol or self.current_symbol
    return str(symbol)        # symbol=None → DB 存入了字符串 "None"
```

```python
# ✅ 修复：显式检查
def _resolve_symbol(self, symbol):
    if symbol is None and not self.current_symbol:
        return 'XAUUSD'
    return str(symbol or self.current_symbol)
```

> **规则**：`str(None)` 返回 `"None"`，这个值一旦进数据库就很难清。所有数据库入库路径都要检查。

---

### 4. 🔴 资源不释放

```python
# ❌ 真实 Bug（两条 4003 路径未 shutdown，累计后 MT5 连接池耗尽）
if ws_status == 4003:
    self.mt5_status_changed.emit("disconnected")
    return          # ← mt5 未关闭
```

```python
# ✅ 修复：每个退出点都释放
if ws_status == 4003:
    self.mt5_status_changed.emit("disconnected")
    if self.mt5:
        self.mt5.shutdown()
    return
```

> **规则**：任何 `return`/`break`/`raise` 之前，检查你打开了什么没关。MT5、DB 连接、文件句柄、WebSocket。

---

### 5. 🟡 状态不一致（多存储层不同步）

```javascript
// ❌ 真实 Bug：toggle_auto 写双表，save_auto 只写 auto_scheduler
// → 重启后 user_bridge_settings.auto_reasoning_enabled=0，
//   initAutoSchedulers 查 auto_scheduler 找不到人
```

```javascript
// ✅ 修复：所有状态修改必须双写
async function save_auto(db, params, userId) {
    await queryOne('INSERT INTO auto_scheduler ...')
    await queryOne(
        'INSERT INTO user_bridge_settings (auto_reasoning_enabled) VALUES (?)
         ON DUPLICATE KEY UPDATE auto_reasoning_enabled = ?',
        [enabled, enabled]
    )
}
```

> **规则**：如果两个表存了同一个逻辑状态，修改时两个都改，读取时两个都查。做不到就合并成一个权威源。

---

### 6. 🟡 路由鉴权重复定义

```javascript
// ❌ 每个路由文件里都写一遍：
if (req.user.role !== 'admin') return res.status(403).json({ error: 'Forbidden' })
```

```javascript
// ✅ middleware/auth.js 导出后复用
const { adminOnly } = require('../middleware/auth')
router.post('/admin/xxx', adminOnly, handler)
```

> **规则**：同一段鉴权逻辑出现 2 次以上 → 提取到 middleware。

---

### 7. 🟡 静默吞掉的定时器异常

```javascript
// ❌ 定时器内无 try/catch → 一次异常，定时器永久停摆
setInterval(async () => {
    await runAutoCycle(userId, symbol, 'M5')
}, 300000)
```

```javascript
// ✅ 定时器回调必须加 try/catch
setInterval(async () => {
    try {
        await runAutoCycle(userId, symbol, 'M5')
    } catch (e) {
        console.error(`[Scheduler] Tick failed for user ${userId}:`, e.message)
        // 不重新抛出，让下一个 tick 正常执行
    }
}, 300000)
```

> **规则**：`setInterval` / `setTimeout` / `QTimer` 的回调函数必须自己兜底，进程不会替你重启定时器。

---

### 8. 🟡 硬编码魔法值

```javascript
// ❌ 分散在 16 处
'XAUUSD', 'deepseek', 'deepseek-chat', 'M5', 'pro', 'admin', 'plus', 'free'
```

```javascript
// ✅ 集中定义
// constants.js
module.exports = {
    PLAN: { FREE: 'free', PLUS: 'plus', PRO: 'pro' },
    ROLE: { USER: 'user', ADMIN: 'admin' },
    DEFAULT_SYMBOL: 'XAUUSD',
    DEFAULT_API: { provider: 'deepseek', model: 'deepseek-chat', base_url: 'https://api.deepseek.com' },
    DEFAULT_TIMEFRAME: 'M5',
}
```

> **规则**：字符串字面量出现 3 次以上 → 提常量。

---

## 二、每种技术栈的正确模式

### Node.js / Express

| 场景 | ❌ 坏模式 | ✅ 好模式 |
|---|---|---|
| 查询单行 | `db.query('SELECT * FROM users WHERE id=' + id)` | `queryOne('SELECT * FROM users WHERE id = ?', [id])` |
| 批量操作 | `for (item of items) { await insert(item) }` | `await Promise.all(items.map(item => insert(item)))` |
| 错误处理 | `catch {}` | `catch (err) { logger.error('opName', err.message); return fallback }` |
| JSON 解析外部输入 | `JSON.parse(data)` | `try { JSON.parse(data) } catch { return null }` |
| 路由返回值 | `res.json(data); doSomething()` | `return res.json(data)` |
| 定时器清理 | `setInterval(...)` 不存引用 | `this._timer = setInterval(...); clearInterval(this._timer)` |

### Python / PySide6

| 场景 | ❌ 坏模式 | ✅ 好模式 |
|---|---|---|
| 子线程操作 GUI | `self.label.setText("x")` 在 Worker 线程 | 发射 `Signal` → 主线程槽函数更新 |
| 配置持久化 | `self.config["key"] = value` | `update_config({"key": value})` |
| 文件路径 | `path + "/" + filename` | `os.path.join(path, filename)` 或 `Path(path) / filename` |
| 数据库连接 | 每次新建连接 | 调用统一封装的 `self.db.query()` |
| 异常处理 | `except:` | `except Exception as e: logger.exception(...)` |
| QThread 退出 | 不调用 wait() | `self.thread.quit(); self.thread.wait(5000)` |

---

## 三、分阶段能力提升路线

### 第 1–2 周：止血（消除 🔴 级问题）

**目标**：提交的代码不会再引入致命 Bug

| 行动 | 产出 |
|---|---|
| ESLint 配置（`eslintrc` + `no-empty` / `no-unused-vars`） | 提交前拦截空 catch、未用变量 |
| Python：Ruff 配置 + `E722`（裸 except）规则 | 提交前拦截 `except:` |
| 整治现有 30+ 处 `catch {}` / `except: pass` | 全部改为具体异常 + 日志 |
| **代码审查日**：每次提交前，对照 `CODE_REVIEW.md` 速查 | 提交附带自检结果 |

### 第 3–4 周：固本（减少 🟡 级问题）

**目标**：写出有防御力的代码，不出低级错误

| 行动 | 产出 |
|---|---|
| 提取 `constants.js` 统一魔法值 | 消除 16 处 `XAUUSD` 硬编码 |
| 排查所有 N+1 查询 → 改为批量 | DB 压力明显下降 |
| 所有 `setInterval` 回调加 try/catch | 定时器不再神秘停摆 |
| Pre-commit Hook（Husky + lint-staged） | 不通过 lint 不能提交 |
| 搭建 GitHub Actions CI（lint + test） | PR 自动检查 |

### 第 5–6 周：进阶（写出可维护的代码）

**目标**：代码逻辑清晰，新人能快速接手

| 行动 | 产出 |
|---|---|
| 拆分巨型文件（`aurum_bridge_gui.py` 2100+ 行） | 按功能模块：bridge.py / settings.py / trading.py |
| 中间件复用（鉴权日志限流） | 路由文件减轻 40% 重复代码 |
| `bridge-ws.js` 状态机重构 | 用独立 StateManager 管理双表同步 |
| 结构化日志（winston / pino）代替 `console.log` | 可按级别/模块过滤 |
| 核心路径单元测试（`test/auth.test.js`、`test/bridge-state.test.js`） | 重构有安全网 |

### 持续改进

- **每周三 30min 代码走查**：挑一个最近修改的文件，团队一起看
- **Bug 后补测试**：任何一个线上 Bug 修完后，加一条回归测试
- **技术分享**：轮流讲一个踩过的坑和怎么修的（2 周一次，15 分钟）

---

## 四、写出好代码的六个准则

> 不是教条，是你们项目里血的教训。

1. **异常要么处理，要么传播，绝不吞掉** — 每一条 `catch {}` 都意味着一行日志的缺失
2. **状态只有一个权威源** — 不要在同一件事的真假存两个地方，如果必须存，读的时候两个都查
3. **边界条件先写** — 空数组、`null`、`undefined`、网络断开，先处理这些再写主逻辑
4. **资源谁打开谁关闭** — 一个函数里 `open`/`connect`/`initialize`，同一个函数里就要有对应的 `close`/`disconnect`/`shutdown`
5. **输入在边界就做校验** — HTTP body、WebSocket 消息、文件内容，一进来就 `typeof`/`isinstance` 校验
6. **不要信任"不会出错"的代码** — 网络会断、磁盘会满、API 会改返回格式，每行外部调用都要有 fallback

---

## 五、如何用 AI 提升效率

你们已经在用了，再提几个高效用法：

| 场景 | 用 AI 的方法 |
|---|---|
| 写新功能前 | "帮我 review 这个设计，有什么边界情况没考虑到？" |
| 修 Bug 前 | "这个错误堆栈可能是什么原因？给我 3 个排查方向" |
| 提交前 | "按 `CODE_REVIEW.md` 的标准，review 这个 diff" |
| 每周 | "分析本周提交，有没有重复出现的反模式？" |
| 新人接手老模块 | "解释这个函数的核心逻辑，画出流程图" |

---

## 六、检查项清单（每周自检用）

- [ ] 本周提交有无 `catch {}` / `except: pass`？
- [ ] 新增路由是否用了参数化查询（`?` 占位符）？
- [ ] 修改了状态写入，是否所有存储层都同步了？
- [ ] 新增 `setInterval` 回调有无 try/catch？
- [ ] `return`/`break` 前是否释放了资源？
- [ ] 是否用了魔法字符串？（出现 3 次就提常量）
- [ ] 配置变更后，EXE / API / 前端三处版本是否一致？
