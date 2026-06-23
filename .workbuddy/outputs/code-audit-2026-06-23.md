# AURUM AI 交易系统 — 全面代码审计报告

**审计日期**: 2026-06-23  
**审计范围**: Server 端 (Express.js) + 前端 (HTML/CSS/JS/app.js) + 桥接软件 (Python)  
**审计维度**: Bug/逻辑错误 · 性能缺陷 · 安全问题 · 资源泄漏 · 错误处理 · 代码质量

---

## 一、致命问题 (CRITICAL) — 共 12 个

### 🔴 C1. 验证码登录 / 密码重置绕过
- **位置**: `server/routes/auth.js` 第 78-81 行、第 189-217 行
- **问题**: 代码登录模式只需要 `verifyToken` 不为空即通过认证，完全不验证 token 有效性。攻击者只需传递任意非空字符串即可登录任意已注册邮箱，或重置任意用户密码。
- **影响**: 认证体系完全失效

### 🔴 C2. CORS 完全开放
- **位置**: `server/index.js` 第 51 行 — `app.use(cors())`
- **问题**: 任意来源可跨域访问所有接口，结合无 CSRF 保护和 `trust proxy`，恶意网站可劫持已登录用户会话
- **影响**: CSRF 攻击、未授权操作

### 🔴 C3. JWT Secret 硬编码（5 处）
- **位置**: `server/index.js:239`、`server/bridge-ws.js:30`、`server/middleware/auth.js:4`、`server/routes/ai.js:8`、`server/routes/feedback.js:6`
- **问题**: 5 个文件各自持有 JWT Secret 默认值 `wall-street-skill-secret`，生产环境若忘记设置环境变量，所有 token 可被伪造。`index.js:239` 甚至完全硬编码不可覆盖
- **影响**: JWT 可被伪造，所有用户身份可被劫持

### 🔴 C4. XSS — bvid 未转义
- **位置**: `public/src/main.js` 第 1271—1283 行
- **问题**: `initBiliPlayer(bvid)` 将 API 返回的 `bilibiliId` 拼接进 `innerHTML`，未调用 `escapeHtml()`
- **影响**: 攻击者控制后端 API 响应即可注入任意 JS

### 🔴 C5. XSS — innerHTML + onclick 内联事件
- **位置**: `public/src/main.js` 第 2420、2429 行
- **问题**: 视频加载失败处理使用 `innerHTML` + `onclick="location.reload()"` 模式
- **影响**: 若未来代码重构在此拼接参数，即构成 XSS 入口

### 🔴 C6. 全局缺少 CSP 头
- **位置**: `public/ai/index.html`、`public/index.html`
- **问题**: 两个 HTML 文件均无 `Content-Security-Policy`
- **影响**: 任意 XSS 可利用，无法限制脚本来源

### 🔴 C7. CSRF 保护缺失
- **位置**: 全局 API 请求
- **问题**: API 请求仅使用 Bearer token，无 CSRF token 机制
- **影响**: Token 在 localStorage 中可被 XSS 直接读取

### 🔴 C8. Token 通过 URL query string 明文传输
- **位置**: `public/ai/aurum_bridge_gui.py` 第 624 行
- **问题**: `ws_url = f"{server}/aurum-api/bridge/ws?type=bridge&token={self.token}"`
- **影响**: Token 可能泄露在代理日志、服务器日志中

### 🔴 C9. 用户密码明文存储
- **位置**: `public/ai/aurum_bridge_gui.py` 第 1039-1042 行
- **问题**: 密码和 Token 明文写入 `%APPDATA%\AURUM_Bridge\config.json`
- **影响**: 任何可访问该文件的进程/用户可读取凭据

### 🔴 C10. SSL 证书验证静默降级
- **位置**: `aurum_bridge_gui.py` 4 处、`aurum_updater.py` 1 处
- **问题**: `certifi` 未安装时静默降级为 `ssl.CERT_NONE`，完全跳过验证
- **影响**: 中间人攻击可拦截所有通信、窃取 Token、篡改交易指令

### 🔴 C11. localStorage 存储认证 Token
- **位置**: `public/ai/app.js` 第 2、611-612 行
- **问题**: Token 存储在 localStorage，任意 XSS 都可读取
- **影响**: Token 泄露 → 账户被劫持

### 🔴 C12. Chart.js 数据索引不对应
- **位置**: `public/ai/app.js` 第 2991 行 `barLabelPlugin`
- **问题**: 使用 `meta.data.forEach` 的循环索引访问 `chart.data.datasets[0].data[i]`，Chart.js 可能隐藏/过滤数据点导致索引错位
- **影响**: 柱状图标签显示错误数据

---

## 二、高危问题 (HIGH) — 共 13 个

### 🟠 H1. N+1 查询 — 管理员用户列表
- **位置**: `server/routes/admin.js` 第 79-155 行
- **问题**: 每个用户执行 11 次 DB 查询，50 个用户 = 550 次往返，且串行 await
- **影响**: 管理员后台严重卡顿

### 🟠 H2. 同步阻塞 I/O — 请求处理中
- **位置**: `server/index.js` 第 222 行（`readFileSync`）、`server/routes/video.js` 第 112/128 行（`execSync ffprobe/ffmpeg`）、第 154 行（`statSync`）
- **问题**: 同步 I/O 阻塞整个事件循环
- **影响**: 高并发时所有请求延迟

### 🟠 H3. _bridgeLocks 竞态条件
- **位置**: `server/routes/ai.js` 第 224-242 行
- **问题**: `_bridgeLocks[userId]` 的读取和写入之间非原子，两次并发调用可能并行执行
- **影响**: MT5 桥接指令可能错序执行

### 🟠 H4. 全局限速缺失
- **位置**: 全部路由
- **问题**: 无任何速率限制，登录/注册/发帖/发邮件接口可被暴力攻击
- **影响**: 暴力破解、邮件轰炸、垃圾内容

### 🟠 H5. 进程崩溃保护缺失
- **位置**: `server/index.js`
- **问题**: 未注册 `uncaughtException` / `unhandledRejection` 处理器
- **影响**: 单次未捕获异常导致整个进程崩溃

### 🟠 H6. DB 连接断开无重连
- **位置**: `server/db.js`
- **问题**: 未监听连接池 error/acquire 事件，DB 宕机恢复后可能不一致

### 🟠 H7. bcrypt.hashSync 阻塞事件循环
- **位置**: `server/routes/auth.js` 6 处、`server/db.js` 2 处
- **问题**: 在 async handler 中使用同步 bcrypt
- **影响**: 登录/注册时阻塞事件循环

### 🟠 H8. JSON.parse 缺少 try-catch
- **位置**: `server/routes/posts.js` 第 25、42、128 行
- **问题**: `JSON.parse(post.tags || '[]')` 无异常保护
- **影响**: 脏数据导致 500 错误

### 🟠 H9. 广播消息无限流
- **位置**: `server/bridge-ws.js` 第 267-294 行
- **问题**: MT5 tick 数据毫秒级广播给所有浏览器客户端
- **影响**: 高频 tick 下浏览器被消息淹没

### 🟠 H10. 会员过期后无限重连
- **位置**: `public/ai/aurum_bridge_gui.py` 第 720-726 行
- **问题**: `break` 只跳出内层循环，外层 while 继续重连
- **影响**: 后台线程持续重连浪费资源

### 🟠 H11. MT5 资源泄漏 — 会员不足时未 disconnect
- **位置**: `public/ai/aurum_bridge_gui.py` 第 646-649、749-751 行
- **问题**: 两处 `return` 跳过 `mt5.shutdown()`
- **影响**: MT5 连接数耗尽

### 🟠 H12. GUI 线程阻塞 HTTP 请求
- **位置**: `public/ai/aurum_bridge_gui.py` 6 处（登录/设置/更新检查）
- **问题**: GUI 主线程发起阻塞 HTTP 请求，网络超时时 GUI 冻结 5-10 秒

### 🟠 H13. 定时器在窗口隐藏后继续运行
- **位置**: `public/ai/aurum_bridge_gui.py` 第 1662 行
- **问题**: `_update_timer` 在最小化到托盘时未停止，仍每 30 分钟发起网络请求

---

## 三、中危问题 (MEDIUM) — 共 17 个

### 🟡 M1-M6: Server 端
| ID | 位置 | 问题 | 影响 |
|----|------|------|------|
| M1 | `requests` all | 请求无超时机制 | 卡住请求永久占用连接 |
| M2 | `bridge-ws.js` 160-165 | bridges Map 并发安全不足 | close 回调可能读到新连接 |
| M3 | `routes/feedback.js` 8-26 | 独立鉴权实现，与全局 middleware 不一致 | JWT Secret 重复，维护困难 |
| M4 | `routes/user.js` 124-129 | 死路由 PATCH /notifications 重复定义 | 第二个定义永远不会被调用 |
| M5 | `routes/payment.js` 30,77 | 查询遗漏 `referral_credit` 字段 | 推荐人积分抵扣功能永不起作用 |
| M6 | `routes/posts.js` | POST pin/feature/lock 路由在之前清理中已删除 | ✅ 已修复 |

### 🟡 M7-M10: 前端
| ID | 位置 | 问题 | 影响 |
|----|------|------|------|
| M7 | `main.js` ~50 处 | 大量 console.error/warn 残留 | 生产环境暴露 API 错误细节 |
| M8 | `main.js` >8900 行 | 单文件无打包/压缩/摇树 | 初始加载慢 |
| M9 | `ai/styles.css` 12 处 | `!important` 滥用 | CSS 优先级管理混乱 |
| M10 | `ai/index.html:8` | Token 可通过 URL query param 传递 | Token 留在浏览器历史和服务器日志 |

### 🟡 M11-M17: 桥接软件
| ID | 位置 | 问题 | 影响 |
|----|------|------|------|
| M11 | `aurum_bridge_gui.py` 17 处 | bare except 吞噬异常 | 配置文件损坏静默失败 |
| M12 | 第 1183-1191 vs 1211-1221 | QThread 终止行为不一致 | 遗留僵尸线程 |
| M13 | 第 386-397 行 | 平仓 `order_send` 返回值未检查 | 部分订单失败但报告全部成功 |
| M14 | 第 318, 469, 471 行 | 已弃用 `datetime.utcfromtimestamp()` / `utcnow()` | Python 3.12+ 将移除 |
| M15 | 第 818-881 行 | `UpdateDialog` 死代码，引用不存在的方法 | 混淆维护 |
| M16 | `aurum_updater.py` 232-239 | `_self_delete()` 死代码 | 遗留无用函数 |
| M17 | `app.js` ~2980 | 空值防御缺失 — `_applyHistoryData(data)` 未检查 `data` 是否为 null | 潜在 TypeError |

---

## 四、应用稳定性 & 性能相关

### 定时器清理 + WebSocket 重连
| ID | 位置 | 问题 |
|----|------|------|
| P1 | `app.js` 837-858 | 全局 setInterval 永不清理 |
| P2 | `app.js` 1501-1502 | K 线成交量定时器未清理 |
| P3 | `app.js` 688-689 | WebSocket 重连无指数退避（固定 3 秒） |

### 前端代码质量
| ID | 位置 | 问题 |
|----|------|------|
| Q1 | `app.js` 2237-2359 | `renderSignal()` 123 行过长 |
| Q2 | `app.js` 2971-3106 | `_renderHistoryChart()` 136 行过长 |
| Q3 | `app.js` 多处 | 魔法数字（120000, 10000, 3000, 1000）未定义常量 |
| Q4 | `app.js` 1174-1185 | 被注释掉的死代码未删除 |
| Q5 | `app.js` 247 | `$()` 全局函数可能与 jQuery 冲突 |

---

## 五、汇总统计

| 严重程度 | Server | 前端 HTML/CSS/JS | App.js | 桥接 Python | **合计** |
|---------|--------|--------------------|--------|-------------|---------|
| 🔴 致命 | 4 | 5 | 3 | 3 | **15** |
| 🟠 高危 | 6 | 3 | 0 | 4 | **13** |
| 🟡 中危 | 6 | 4 | 5+ | 7 | **22+** |
| 🟢 建议 | 7 | 5 | 5 | 7 | **24** |
| **合计** | **23** | **17** | **13+** | **21** | **74+** |

---

## 六、优先修复建议（按紧急程度）

### 立即修复（安全漏洞，直接可利用）
1. **C1/C4** — 验证码登录/密码重置绕过 → 验证 verifyToken 有效性
2. **C2** — CORS 配置受限 origin 白名单
3. **C3** — JWT Secret 统一管理 + 生产环境强制检查
4. **C4/C5** — XSS 漏洞修复（bvid escapeHtml + 移除 inline onclick）
5. **C9** — 密码改用 DPAPI / Credential Manager 存储
6. **C10** — SSL 验证不可用时报错而非降级
7. **C11** — Token 迁移到 httpOnly Cookie

### 本周修复（影响稳定性和性能）
8. **H4** — 添加 `express-rate-limit`
9. **H5** — 注册 `uncaughtException` / `unhandledRejection` 处理器
10. **H1** — 管理员列表 N+1 查询优化（批量/并发）
11. **H3** — `_bridgeLocks` 使用 `async-mutex` 替代
12. **H10/H11** — 会员过期处理 + MT5 资源清理
13. **H2** — 替换所有同步 I/O 为异步

### 下个迭代（代码质量和长期稳定性）
14. **H9** — 市场数据广播添加节流
15. **M11** — bare except 替换为具体异常类型
16. **P3** — WebSocket 重连添加指数退避
17. **M10** — 移除 URL query param 传 token
18. **Q3/Q4** — 提取魔法数字常量 + 清理死代码
