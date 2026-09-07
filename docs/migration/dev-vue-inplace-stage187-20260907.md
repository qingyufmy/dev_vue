# 阶段 187：主站课程登录代理闭环

## 修复结果

阶段 186 的主站学习代理只覆盖课程 GET。此前报告中的“现有主站 SSO 继续由原有路由/代理承担”经源码核实不成立：Nuxt 没有登录开始、回调和会话代理，身份中心 Vite 也没有认证开发代理。本次补齐这些缺口。

- WWW 增加 `/auth/start`、`/auth/callback`、`/api/v4/session` 和 `/api/v4/session/logout`，与课程读取共用固定上游代理。认证动作、学习路径和查询参数均限定范围。
- Nuxt 代理显式使用 `redirect: manual`，保留浏览器应接收的 Location 和 Set-Cookie，避免服务端提前跟随并消费 OAuth 回调。响应 private/no-store，转发原始 Origin、CSRF 与 Cookie。
- auth Vite 仅代理认证的精确路由，保留浏览器 Host 与 Origin，不改变服务端的身份域及 CSRF 校验。
- auth 与 learning 共用 Cookie 命名函数。HTTPS 识别安全 Cookie，本地 HTTP 使用开发 Cookie；两种模式不交叉接受，trade Cookie 不构成 WWW 身份。

## 定向复核和验证

本次属于已授权课程访问流程中的身份接入修复，未改变 OAuth、权限或令牌协议。复核重点为固定代理目标、单次授权码、Host-only Cookie、原始 Origin 和退出后的会话失效。

- SSO 与 learning：19 项测试通过，包括安全/开发两种 Cookie 的登录、返回课程、个人记录读取、错误 Cookie 模式拒绝、跨站退出拒绝和退出失效。
- WWW：2 项测试通过，含代理目标、查询、no-store 与手动重定向验证；类型检查与生产构建通过。
- auth：3 项测试通过，含实际 Vite 代理与临时本地 HTTP 上游之间的 Location、Set-Cookie、Host、Origin、Cookie 传输及相似路径不转发验证；类型检查与构建通过。
- 服务端类型检查、前端应用隔离检查通过。

SSO 行为测试使用真实 AuthService 和 Fastify 注入，身份持久层、密码校验与短期状态使用测试实现。代理网络测试只监听临时本地回环端口，并在结束后关闭。没有使用真实账号登录、真实 Redis、浏览器 Cookie jar，也未启用完整运行进程、修改数据库或部署。因此不能表述为完整真实 SSO 验收完成。

## 本地配置与接续

API 的 `WWW_ORIGIN` 应与 Nuxt `NUXT_LEARNING_WWW_ORIGIN` 一致，例如 `http://localhost:3100`；API 的 `AUTH_ORIGIN` 应与身份中心开发地址一致，例如 `http://localhost:4176`。本地 HTTP 配置 `V4_SECURE_COOKIES=false`；正式 HTTPS 保持安全 Cookie。

Nuxt `NUXT_LEARNING_API_BASE` 和身份中心私有开发变量 `AURUM_AUTH_API_BASE` 指向 V4 API（默认 `http://127.0.0.1:3010`）。后者只用于 Vite 开发代理，生产身份域仍需部署层转发。未修改当前 env 或启动服务。

后续按 [学习进度写入方案](../learning-progress-write-plan.md) 接入手动完成标记、幂等记录与并发保护。播放器尚未接入，不能把打开外部视频链接当作已观看时长。
