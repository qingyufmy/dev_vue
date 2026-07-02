# 安全与权限修复结果

## 提交信息

- 分支：`dev_codex`
- Commit: `fix: harden permission checks and AI token handoff`

## 修改文件清单

1. `server/routes/sentiment.js` — 问题 1
2. `server/routes/video.js` — 问题 2
3. `server/routes/trades.js` — 问题 3
4. `public/src/main.js` — 问题 4
5. `public/ai/app.js` — 问题 4

## 问题 1：`/api/sentiment/refresh` 缺少权限控制

### 修改位置

- `server/routes/sentiment.js:1` — 引入 `authMiddleware, adminOnly`
- `server/routes/sentiment.js:24` — 路由加 `authMiddleware, adminOnly`

### 修复说明

`GET /sentiment` 保持公开读取。`POST /sentiment/refresh` 加上 `authMiddleware` + `adminOnly` 中间件，只有管理员可触发外部抓取。

### 手动实测

1. 未登录 `POST /api/sentiment/refresh` → 预期 401 `请先登录`
2. 普通用户 `POST /api/sentiment/refresh` → 预期 403 `需要管理员权限`
3. 管理员 `POST /api/sentiment/refresh` → 预期 200 `{ ok: true, data, updatedAt, source: 'IG' }`
4. 未登录 `GET /api/sentiment` → 预期 200，仍可读取

## 问题 2：`/api/qiniu-callback` 普通用户可写视频流记录

### 修改位置

- `server/routes/video.js:7` — 引入 `adminOnly`
- `server/routes/video.js:307` — 路由加 `adminOnly`
- `server/routes/video.js:309-324` — 增加参数校验

### 修复说明

1. 加 `adminOnly` 中间件，普通用户 403
2. `episodeId` 必须是正整数
3. `key` 必须是非空字符串
4. `size` 如果传入必须是非负数字
5. 非法参数返回明确错误，不写库

### 手动实测

1. 未登录 `POST /api/qiniu-callback` → 预期 401
2. 普通用户 `POST /api/qiniu-callback` → 预期 403
3. 管理员传 `{ episodeId: 1, key: "test.mp4", size: 1024 }` → 预期 `{ ok: true }`
4. 管理员传 `{ episodeId: -1, key: "" }` → 预期错误提示，不写库

## 问题 3：`/api/trades?id=...` 详情接口绕过公开限制

### 修改位置

- `server/routes/trades.js:11-22` — 详情查询加可见性检查 + 显式字段

### 修复说明

1. 不再 `SELECT *`，改为显式选择允许展示的字段
2. 查询时包含 `user_id, is_public` 用于权限判断，返回前剔除
3. 可见性规则：
   - 管理员：看全部
   - 记录所有者（`user_id` 匹配）：看自己的
   - 其他：只看 `is_public = 1`
4. 找不到或无权查看返回 `{ ok: false, error: '无权查看或记录不存在' }`

### 手动实测

1. 准备 `is_public = 1` 的记录 → 未登录可访问
2. 准备 `is_public = 0` 且属于用户 A 的记录：
   - 未登录 → 不可返回
   - 用户 B 登录 → 不可返回
   - 用户 A 登录 → 可返回
   - 管理员登录 → 可返回
3. 返回 JSON 不含 `user_id`、`is_public` 内部字段

## 问题 4：AI 页 token 不应通过 URL 参数传递

### 修改位置

- `public/src/main.js:7843-7849` — `#navAI` 点击不再拼 `?token=`
- `public/ai/app.js:1-10` — token 初始化支持从 cookie 读取

### 修复说明

1. 主站点击 AI 入口：先 `syncAuthCookieFromStorage()` 确保 cookie 同步，再 `window.open('/ai')`
2. AI 页初始化 token 来源优先级：URL 参数（兼容旧链接）→ localStorage → Cookie `ws_token`
3. 旧 `/ai?token=...` 链接仍兼容：读取后立即 `history.replaceState` 清除地址栏

### 手动实测

1. 登录后点击 AI → 新窗口地址栏为 `/ai`，无 `token` 参数，AI 页正常进入
2. AI 页刷新 → 仍登录，不丢状态
3. 直接访问 `/ai?token=<有效token>` → 能进入，地址栏立即清除 token
4. 未登录访问 `/ai` → 跳回首页
5. 浏览器 Network：`/aurum-api/auth/me` 正常返回用户信息

## 验证命令和结果

| 命令 | 结果 |
|------|------|
| `node --check server/routes/sentiment.js` | 通过 |
| `node --check server/routes/video.js` | 通过 |
| `node --check server/routes/trades.js` | 通过 |
| `node --check server/index.js` | 通过 |
| `node --check public/src/main.js` | 通过 |
| `node --check public/ai/app.js` | 通过 |
| `vitest run` | 6 文件 75 测试全部通过 |

## 未解决风险

1. 浏览器 WebSocket 连接仍通过 URL query 传递 token（`/aurum-api/bridge/ws?type=browser&token=...`）。完整修复需要后端 `handleBrowserWs` 支持从 Cookie 读取 token，属于后续优化。
2. 七牛回调签名校验未实现（项目中无现有签名机制），当前仅靠管理员权限收口。建议后续接入七牛回调签名。
