# AURUM 代码审查标准与流程

> 版本 1.0 · 2026-06-24 · 基于项目 608 次提交 + 74 项历史问题分析制定

---

## 一、审查等级

| 等级 | 标记 | 含义 | 示例 |
|---|---|---|---|
| 🔴 **阻断** | blocker | 必须修复才能合并 | 安全漏洞、数据丢失、崩溃、AI 调用余额耗尽 |
| 🟡 **重要** | important | 应该修复，合并前讨论 | 缺少错误处理、性能退化、裸异常捕获 |
| 🔵 **建议** | suggestion | 推荐改进，不阻塞合并 | 命名优化、提取公共函数、加注释 |
| ⚪ **信息** | info | 仅做说明，无需行动 | 架构决策背景、已知限制 |

---

## 二、通用审查清单（所有 PR 必须通过）

### 安全

- [ ] 🔴 **SQL 注入**：所有用户输入是否通过参数化查询（`?` 占位符），无字符串拼接
- [ ] 🔴 **XSS**：前端 `innerHTML` 是否有转义，用户生成内容是否经过 `textContent` 或显式 escape
- [ ] 🔴 **鉴权**：新增路由是否正确使用 `authMiddleware` / `adminOnly`，无鉴权路由是否在 `PUBLIC_CATEGORIES` 中登记
- [ ] 🔴 **密钥**：API Key、密码是否加密存储，日志中是否打码，文件内是否硬编码
- [ ] 🟡 **JWT**：`verify` 是否有 try/catch 且失败时记录原因，无静默吞错
- [ ] 🟡 **限流**：新增的认证/AI 调用路由是否在 `express-rate-limit` 范围内

### 正确性

- [ ] 🔴 **空异常捕获**：JS 是否出现 `catch {}`（空块），Python 是否出现 `except:` 或 `except: pass`（裸 except）
- [ ] 🔴 **变量未定义**：引用前是否已赋值（如 `_order_send_with_retry` 的 `req` 陷阱）
- [ ] 🔴 **None/null 传播**：`None` 是否会在 `str()` / 模板拼接 / 数据库写入时变成字符串 `"None"`
- [ ] 🟡 **资源释放**：MT5 连接、DB 连接、文件句柄是否在所有退出路径释放（含错误路径）
- [ ] 🟡 **异步竞态**：WebSocket 并发消息是否会导致状态错乱，定时器是否在 `stopAutoScheduler` 中正确清理
- [ ] 🟡 **边界条件**：空数组、空字符串、`0`、`false` 是否被正确处理（注意 `||` 默认值的坑）

### 数据库

- [ ] 🔴 **破坏性迁移**：`ALTER TABLE` 是否幂等（先检查列/表是否存在再执行）
- [ ] 🟡 **N+1 查询**：循环内是否有独立查询，批量操作是否可合并为单条 SQL
- [ ] 🟡 **索引**：新列是否可能需要索引（特别是 `user_id`、`symbol`、`created_at` 等高频过滤字段）
- [ ] 🟡 **连接池**：是否使用了 `pool.query()` 而非自行创建连接，异常时是否 `release()`

### 跨层一致性

- [ ] 🟡 **DB ↔ 桥接标志**：`bridge-ws.js` 状态变更是否同步写入数据库（如 `auto_scheduler.enabled`、`user_bridge_settings`）
- [ ] 🟡 **版本同步**：修改了 API 返回值结构 (`/api/bridge/version`)、下载文件、MD5 时，是否三处同步（接口 + EXE + 前端）
- [ ] 🟡 **`package.json`**：`version` 字段是否与 tag/CHANGELOG 一致

### 可维护性

- [ ] 🟡 **重复定义**：鉴权中间件是否复用 `middleware/auth.js` 而非在路由内复制
- [ ] 🟡 **大文件膨胀**：是否在巨型文件（>500 行）中追加代码而非拆分新模块
- [ ] 🔵 **commnet**：裸 `catch {}` / `except: pass` 若确为有意设计，是否加了注释说明原因
- [ ] 🔵 **命名**：变量/函数名是否自解释，`data`/`result`/`tmp` 等泛用名是否可替换

---

## 三、语言专项清单

### Node.js / Express

| 检查项 | 等级 | 说明 |
|---|---|---|
| `JSON.parse` 无 try/catch | 🔴 | 外部输入（WebSocket 消息、HTTP body）解析失败会导致进程崩溃 |
| `fs.readFileSync` 无 try/catch | 🟡 | 配置文件/证书读取失败应有降级 |
| `process.exit()` 在非 `db.js` 初始化外使用 | 🟡 | 优雅关闭优于强制退出 |
| `.env` 变量无默认值 + 长度校验 | 🟡 | `JWT_SECRET` 长度 < 32 应启动失败 |
| `setInterval` 回调内无 try/catch | 🟡 | 单次异常会导致定时器永久停止（auto scheduler 陷阱） |
| 路由 handler 内 `return` 漏写 | 🔴 | 忘记 `return res.json(...)` 会导致 `Can't set headers after sent` |
| `multer` 文件名未转码 | 🟡 | 中文/特殊字符文件名可能存储为 `latin1` 乱码 |
| `express-rate-limit` 对 WebSocket 无效 | 🔵 | 已知限制，高频 WS 消息需在 `bridge-ws.js` 内自行限流 |

### Python / PySide6

| 检查项 | 等级 | 说明 |
|---|---|---|
| `except:`（裸异常，不包括 `except Exception`） | 🔴 | 会捕获 `SystemExit`、`KeyboardInterrupt`，导致进程无法正常终止 |
| `except: pass` | 🔴 | 等同于吞掉所有错误，线上问题无法定位 |
| Qt 线程安全：子线程直接操作 GUI 控件 | 🔴 | 必须通过 `Signal` 发射到主线程 |
| `os.add_dll_directory()` / `os.environ['PATH']` 注入 | 🔴 | 已证实导致 `numpy._core.multiarray` 导入失败（v1.9.8→v1.9.9 修复） |
| `QThread` 未正确 `wait()` / `quit()` | 🟡 | 程序退出时卡死 |
| `MetaTrader5` 资源泄露 | 🔴 | 每条 `mt5.shutdown()` 缺失都会池化连接耗尽 |
| 配置 `save_config` 不持久 | 🟡 | 必须是 `update_config()` 写入 JSON，非仅内存修改 |
| 文件路径拼接用 `os.path.join` 或 `pathlib` | 🔵 | 不用字符串 `+ '/' +` |

---

## 四、审查流程

### 日常开发

```
开发 → 提交到 dev → AI 协作者记录 .workbuddy/memory/YYYY-MM-DD.md
```

当前状态：单人开发为主，审查方式为自审 + AI 审查。

### 发版审查（每次 tag 前必须执行）

```
1. 开发者完成 dev 分支代码
2. 运行审查清单（本文件第一节 + 第三节）
3. 修复所有 🔴 阻断项
4. 🟡 重要项：修复或记录到 MEMORY.md 延后处理
5. 确认 package.json 版本 + 接口版本 + EXE 版本一致
6. 执行发版提交流程：dev → main → tag
```

### 未来多人协作（按需启用）

```
1. 开发者从 dev 创建 feature/xxx 分支
2. 开发完成后发起 PR → dev
3. PR 模板（见附录）
4. 至少 1 人审查，所有 🔴 resolved
5. 审查者 Approve → 合并
```

### 审查产出

每次审查（含日常自审），将发现写入：

- **即刻修复的**：直接提交
- **延后处理的**：写入 `D:/web/.workbuddy/memory/MEMORY.md`，按等级标注

---

## 五、历史问题速查（防回归）

本项目从 608 次提交中提炼出的坑，**回归即视为 🔴**：

| 问题 | 出现文件 | 版本 |
|---|---|---|
| `_order_send_with_retry` 中 `req` 变量未定义 → 所有开仓失败 | `aurum_bridge_gui.py` | v1.9.9 |
| MT5 DLL 目录注入导致 `numpy._core.multiarray` 导入失败 | `aurum_bridge_gui.py` | v1.9.8 |
| 桥接断开时重置 `auto_scheduler.enabled=0` → 重启后自动推理失效 | `bridge-ws.js` | v1.9.7 |
| `"记住密码"` 勾选后不实际保存 | `aurum_bridge_gui.py` | v1.9.8 |
| MT5 路径不持久化到 config JSON | `aurum_bridge_gui.py` | v1.9.9 |
| MT5 4003 错误后未 `shutdown()` 资源泄露 | `aurum_bridge_gui.py` | v1.9.9 |
| `None` 传入 `str()` → DB 存入 `"None"` 字符串 | `aurum_bridge_gui.py` | v1.9.9 |
| JWT verify 静默失败 + 不记录原因 | `bridge-ws.js` | v1.9.7 |
| 批量平仓无重试机制 | `aurum_bridge_gui.py` | v1.9.9 |

---

## 六、基础设施补齐路线图

| 阶段 | 任务 | 预期效果 |
|---|---|---|
| **第 1 周** | ✅ ESLint + Prettier + Ruff + `.editorconfig` | 提交前自动拦截空 catch / 风格问题 |
| **第 2 周** | ✅ 为 `db.js` `bridge-ws.js` `auth.js` 补核心单元测试 | 重构有安全网 |
| **第 3 周** | ✅ GitHub Actions CI（lint + test + 版本矩阵） | PR 自动检查 |
| **第 4 周** | ✅ Pre-commit Hook（Husky + lint-staged） | 提交时自动跑 lint |
| **第 5 周** | ⚪ TypeScript 渐进迁移（`tsconfig.json` + `allowJs`） | 类型安全 |
| **持续** | ⚪ 每周全量审查 + 周报 | 趋势追踪 |

---

## 附录 A：PR 模板（`.github/pull_request_template.md`）

```markdown
## 变更概述
简要描述做了什么。

## 审查自检
- [ ] 无 SQL 注入 / XSS / 硬编码密钥
- [ ] 无裸 `except:` / 空 `catch {}`
- [ ] 鉴权中间件已复用（未在路由内重复定义）
- [ ] 涉及 DB 变更已检查幂等性
- [ ] 涉及 MT5 已检查资源释放 + 路径持久化
- [ ] 接口返回结构变更已同步版本号

## 影响范围
- 影响的路由/组件：
- 数据库表结构变更（如有）：
- 是否影响打包/七牛云：

## 测试
- [ ] 本地自测通过
- [ ] 历史问题防回归确认（CODE_REVIEW.md 第五节）
```

## 附录 B：裸异常白名单

以下场景允许使用带注释的空 catch，但必须在代码中写清楚原因：

| 位置 | 原因 |
|---|---|
| `db.js` `initDB()` 中的 `ALTER TABLE` 容错 | 幂等迁移，列可能已存在 → 已注释 `try {} catch {}` |
| `bridge-ws.js` WebSocket 心跳清理 | 连接可能已断开，清理失败是预期的 |
| video.js 临时文件清理 | 文件可能已被系统回收，删除失败无害 |

其他所有 `catch {}` / `except: pass` 均视为 🔴 需改写为具体异常类型 + 日志。
