# AURUM AI 项目全面审计报告

**日期**: 2026-07-03  
**审计范围**: 全部服务端代码（29个JS文件）、前端代码（app.js 5000+行、HTML、CSS）、数据库结构（30+表、18个迁移）、依赖项、配置文件、安全问题  
**方法**: 5个并行探索代理分别审计服务端死代码、前端死代码、数据库结构、依赖配置、代码质量

---

## 一、CRITICAL — 必须修复

### 1. 旧版 AI 模块残留（1,725行死代码）
- **文件**: `server/routes/ai.js`
- **状态**: `server/index.js` 仅导入 `./routes/ai/index.js`，此文件零引用
- **内容**: 包含 `calculateMarketData`、`normalizeAiSignal`、`mt5Bridge`、`executeOrder`、`insertAudit` 等20+个函数的完整重复实现，与 `server/routes/ai/` 目录下7个模块完全重复
- **建议**: 直接删除此文件

### 2. Seed 数据硬编码密码
- **文件**: `server/db.js:681-688`
- **内容**: 管理员密码 `admin123`、演示账号 `demo123`，明文写在源码中
- **建议**: 改为随机生成密码，启动时打印到 stdout

### 3. 注册默认 Pro 权限
- **文件**: `server/routes/auth.js:39`
- **内容**: INSERT 硬编码 `plan = 'pro'` + 1月有效期，配合已禁用的支付端点（payment.js 返回503），无法变现
- **建议**: 默认改为 `'free'`，上线前启用支付网关

---

## 二、HIGH — 建议尽快处理

### 4. 未使用的 xlsx 依赖
- **文件**: `package.json`
- **内容**: `xlsx` 包在代码库中零引用，增加 ~3MB 安装体积

### 5. 仓库中提交了 76MB 二进制文件
- `public/ai/AURUM_Bridge.exe` — 64.2 MB
- `public/ai/aurum_updater.exe` — 11.7 MB
- 下载按钮已指向 CDN，这些文件在 web 根目录无引用，膨胀每次 git clone

### 6. JWT Token 在下载 URL 中暴露
- **文件**: `server/index.js:200-290`
- **内容**: 桥接下载端点将完整 JWT（7天有效期）作为 `?token=...` 查询参数嵌入生成的脚本，出现在服务器日志、浏览器历史、代理日志中
- **建议**: 改为一次性下载 token

### 7. Bilibili 代理潜在 SSRF
- **文件**: `server/index.js:103-142`
- **内容**: 验证了域名后缀 `.hdslb.com`，但无路径遍历检查、无响应体大小限制

### 8. 交易执行未等待完成
- **文件**: `server/routes/ai/strategy.js:169-228`
- **内容**: `handleAnalyze()` 中交易执行在函数返回后异步完成，前端收到 "success" 但交易可能仍在进行或失败

---

## 三、MEDIUM — 应当处理

### 死代码（服务端）

| 位置 | 问题 |
|------|------|
| `server/logger.js` | 整个模块从未被导入，完全无用（34行） |
| `server/db.js:3` | `uuid` 导入但从未调用 |
| `server/routes/payment.js:70-153` | early return 之后 84 行代码完全不可达 |
| `server/routes/ai/scheduler.js:1008` | `sendAutoProgress()` 从未被调用 |
| `server/routes/ai/scheduler.js:485` | `countSubscribers()` 从未被调用 |
| `server/bridge-ws.js:7-12` | `parseSymbols()` 定义但从未调用 |
| `server/bridge-ws.js:2004` | `getOwnBridgeTradeMode()` 导出但无调用方 |
| `server/bridge-ws.js:2059` | `getBridgeStatus()` 导出但无调用方 |
| `server/routes/ai/strategy.js:4` | `isBridgeAlive` 导入但未使用 |
| `server/services/sentiment.js:65` | `MARKETS`、`fetchOneMarket` 导出但外部无导入 |
| `server/bridge-ws.js:332-341` | `if (!shouldRestoreAuto)` 在已确保 `shouldRestoreAuto=true` 的代码块内，永远不可达 |
| `server/bridge-ws.js:475-476` | 空 else 分支 |

### 死代码（前端）

| 位置 | 问题 |
|------|------|
| `app.js:1294` `login()` | 从未调用 |
| `app.js:2010` `updatePositionRow()` | 从未调用 |
| `app.js:2325` `syncOverrideSection()` | 空函数体，从未调用 |
| `app.js:2327` `initOverrideSymbolsSelector()` | 已禁用功能残留 |
| `app.js:2704` `disableAdminPromptType()` | 从未调用 |
| `app.js:108-150` | `DEFAULT_CLOSE_PROMPT` 常量（42行），仅在注释代码中引用 |
| `app.js` 多处 | ~120行注释掉的 smart-close 功能代码 |

### 孤立文件

| 文件 | 问题 |
|------|------|
| `public/ai/aurum_bridge_gui.py` (132KB) | Python 桥接源码，部署走 CDN，不应在 web 根目录 |
| `public/ai/aurum_updater.py` (8.9KB) | 更新器源码，无前端引用 |
| `public/ai/aurum_icon.ico` (9.5KB) | 图标文件，HTML/CSS 中未引用 |
| `public/ai/AURUM_Bridge_Mac.command` (20.5KB) | Mac 启动脚本，前端未引用 |
| `public/ai/AURUM_EA_Bridge/config.json` | 空文件（服务端动态生成） |
| `public/tg-signal.jpg` (494KB) | 根目录孤立图片 |
| `.htaccess` | 空占位文件（项目用 Nginx 不用 Apache） |
| `server_stderr.log` / `server_stdout.log` | 运行时日志文件，未被 .gitignore 覆盖 |

### 数据库结构问题

| 问题 | 详情 |
|------|------|
| `notifications` 表死列 | `` `read` `` 列从未使用——重命名为 `is_read` 后旧列残留 |
| `quiz_questions` 冗余列 | `answer` 和 `correct_index` 始终存储相同数据 |
| `auto_scheduler` 重复索引 | 3个重叠索引：`(enabled)`、`(enabled, prompt_type_id)`、`(prompt_type_id, enabled)`，后两者已覆盖前者 |
| 类型不一致 | `bridge_connection_status.user_id` 为 BIGINT，其他所有表 INT |
| `bridge_connection_status` 缺失 | 仅在迁移016创建，未纳入 `initDB()`，新库如迁移失败会崩溃 |

### 无用数据库表/列

| 对象 | 说明 |
|------|------|
| `user_notices` 表 | 零 SQL 引用 |
| `broadcast_messages` 表 | 零 SQL 引用 |
| `ui_configs` 表 | 仅用户删除时防御性 DELETE，无实际功能 |
| `users.current_view` 列 | 零引用 |
| `users.telegram_chat_id` 列 | SELECT 读取但从未使用 |
| `trades.image_url` 列 | 零引用，实际用的是 `screenshot_url` |
| `courses.structure_count` 列 | 永远为默认值0，从未被写入 |

### 安全与质量

| 问题 | 位置 | 说明 |
|------|------|------|
| 35+ 处空 catch 块 | 遍布 bridge-ws.js、scheduler.js 等 | 静默吞掉错误，违反项目编码规范 |
| 评论暴露 email | `comments.js:14,42` | 公开评论 API 返回用户邮箱 |
| 错误信息泄露 | `config.js` 多处 | `err.message` 直接返回客户端 |
| 限流器遗漏 | `index.js:89-94` | `/aurum-api` 前缀无任何限流保护 |
| 重复认证逻辑 | `feedback.js:17-35` | 自定义 `withAuth` 复制了 `authMiddleware`，未复用 |
| N+1 查询 | `db.js:102-115` | `logAudit()` 每次额外 SELECT 查 email/nickname |
| Dashboard 查询碎片化 | `admin.js:39-64` | 11个独立 COUNT 查询可合并为2-3个 |

### 配置问题

| 问题 | 说明 |
|------|------|
| `.env.example` 不完整 | 缺少 REDIS_HOST/PORT/PASSWORD、CORS_ORIGINS、DEBUG_LLM_PAYLOAD 等变量 |
| 日志文件未 gitignore | `server_stderr.log`、`server_stdout.log` 在项目根目录 |
| `.mimocode/` 未 gitignore | Agent 会话数据可能被提交 |
| `requestTimeout = 0` | 禁用 HTTP 超时，慢客户端可无限占用连接 |

---

## 四、LOW — 可选优化

| 问题 | 说明 |
|------|------|
| 情绪数据顺序获取 | `sentiment.js:57-62` 23个市场串行请求（46-115秒），可并行化至15-30秒 |
| authMiddleware 无缓存 | 每次请求都 SELECT 用户数据，可用短 TTL Map 缓存 |
| `bridge-ws.js` 过大 | 2,109行，承担 WebSocket、桥接管理、浏览器管理、命令路由等多重职责 |
| 硬编码 API URL | `https://api.deepseek.com` 在 9+ 处硬编码，应提取为配置 |
| 时区工具重复 | `beijingNow()` 在 `db.js` 和 `logger.js` 各实现一次 |
| 迁移015 强制开启自动交易 | 无条件 UPDATE 所有用户 `enable_auto_trade = 1` |
| `_bridgeInitGen` 内存泄漏 | Map 条目从不清理，每次桥接连接累积 |
| `closeSchedulerState` 累积 null | stop 时设为 null 而非 delete |
| 测试覆盖仅30% | 仅覆盖 AI 模块（7个测试文件），auth/admin/routes/bridge 无测试 |

---

## 五、建议优先级

### 立即执行（无风险清理）
1. 删除 `server/routes/ai.js`（1,725行死代码）
2. 删除 `server/logger.js`（34行未使用模块）
3. 从 `package.json` 移除 `xlsx` 依赖
4. 清理 `app.js` 中5个无用函数和~120行注释代码
5. 清理孤立文件（`.htaccess`、日志文件）

### 短期执行（低风险改进）
6. 移除 `db.js` 中未使用的 `uuid` 导入
7. 删除 `bridge-ws.js` 中未使用的导入（`logAudit`、`query`）和函数（`parseSymbols`、`getOwnBridgeTradeMode`、`getBridgeStatus`）
8. 删除前端孤立文件（从 web 根目录移除 py/exe/ico/command 文件）
9. 补全 `.gitignore`（日志文件、.mimocode/、coverage/）
10. 更新 `.env.example` 补充缺失的环境变量

### 中期执行（需测试验证）
11. 数据库清理：删除 `notifications.\`read\`` 死列、`trades.image_url` 死列、无用表
12. 合并重复索引（auto_scheduler 保留1-2个即可）
13. 修复空 catch 块，添加错误日志
14. 移除评论 API 中的 email 暴露
15. 为 `/aurum-api` 添加限流保护

### 长期执行（架构优化）
16. 拆分 `bridge-ws.js`（2,109行）为多个模块
17. 将注册默认权限从 Pro 改为 Free
18. 补充非 AI 模块的测试覆盖
19. 引入结构化日志替代 console.log
20. authMiddleware 添加短 TTL 缓存
