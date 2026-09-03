# 阶段 10：SSO 端到端竖切验收记录

> 状态：实现与离线验证已完成
>
> 日期：2026-09-03
>
> 范围：统一身份中心、www/trade/admin 独立应用会话、PKCE、CSRF、实时通道单次票据与退出范围

## 1. 本阶段结果

- 新增独立 `auth` 身份中心前端。它只承载认证，不成为第四个业务前端，也不承载通用用户中心。
- `www`、`trade`、`admin` 使用固定 OIDC 客户端和精确回调地址，通过 Authorization Code + PKCE S256 建立各自独立的 Host-only 应用会话。
- 浏览器只持有 HttpOnly Cookie；数据库只保存随机会话与授权码的 SHA-256 哈希，不向 `localStorage`、查询参数或前端状态暴露长期令牌。
- `trade` 和 `admin` 在进入受保护壳层前先读取 `/api/v4/session`，避免未登录用户短暂看到业务页面；主站登录入口统一进入 `/auth/start`。
- 非安全 HTTP 写请求要求当前应用会话、精确 Origin 和会话绑定 CSRF；实时连接先通过 `/api/v4/realtime/tickets` 取得最长 30 秒、仅可消费一次的票据。
- 实现当前应用退出、全部 Web 应用退出和撤销所有设备三种范围；只有“撤销所有设备”会同时撤销 Bridge 设备凭据。
- 授权码、实时票据均为单次消费；应用会话版本与现有用户 `token_version` 绑定，用户被删除、停用或版本提升后旧会话立即失效。
- 生产继续使用 `__Host-Http-*` 安全 Cookie；普通 HTTP 本地开发使用明确隔离的 `aurum_dev_*` Cookie，避免浏览器拒收缺少 `Secure` 的前缀 Cookie，同时不降低生产配置。

## 2. 实现边界

服务端按 domain/application/infrastructure/transport 分层，认证服务不依赖 Fastify 请求对象，MySQL、Redis、密码校验、Bridge 撤销和签名均通过窄端口接入。核心文件位于：

- `server/src/modules/auth/`
- `server/db/migrations/20260903_002_auth_sso_sessions.sql`
- `server/tests/auth-sso-service.test.ts`

前端使用阶段 9 的唯一 shadcn-vue 组件源，新增认证需要的 `field`、`checkbox`、`label` 和 `input-otp` 组件；当前登录表单使用真实组件与 V4 API 客户端，不散落原生 `fetch`。核心文件位于：

- `frontend/apps/auth/`
- `frontend/apps/www/app/pages/login.vue`
- `frontend/apps/trade/src/features/auth/`
- `frontend/apps/admin/src/features/auth/`
- `frontend/packages/contracts/src/index.ts`
- `frontend/packages/api-client/src/index.ts`

V4 OpenAPI 已补充登录、会话读取、三种退出范围和实时票据路径。数据库迁移只新增 `auth_sessions`、`auth_authorization_codes` 两张表，继续复用现有用户、密码哈希、角色和会话版本事实。

## 3. 第一轮实施复审

复审维度：需求覆盖、模块边界、最少代码、现有数据复用和是否设计过度。

发现与调整：

- 没有建立新的用户副本、权限系统或通用账户前端；认证中心只读取现有用户事实，三个业务应用继续拥有各自账户页面。
- 没有引入第三方身份平台或额外微服务；目标 Fastify 模块可在同一部署单元按 Host 注册，保持宝塔/PM2 统一管理方式。
- OIDC 客户端、回调和允许 Origin 使用固定注册表，不提供用户可控的动态回调。
- 没有提前实现与本阶段验收无关的完整注册、找回密码和 MFA 产品流程；相关能力仍属于身份中心后续扩展，不以占位逻辑冒充完成。
- 没有修改旧用户数据，也没有执行迁移；公网旧库到目标结构仍通过保留的版本化迁移链处理。

第一轮结论：核心 SSO 竖切覆盖阶段目标，身份边界清晰，没有制造新的业务前端或重复用户体系。

## 4. 第二轮实施复审

复审维度：安全、并发、重放、退出一致性、本地开发、迁移和连带 Bug。

发现与调整：

- 授权码消费使用数据库事务、`FOR UPDATE` 和条件更新；Redis 实时票据使用原子消费脚本，重复消费均失败关闭。票据消费后还会复核 MySQL 应用会话和用户版本，进程在“会话撤销、Redis 索引删除”之间中断时也不能凭旧票据建连。
- CSRF 同时校验会话派生令牌和精确 Origin；WebSocket 票据放在限定 `/realtime/v4` 路径的 HttpOnly Cookie 中，响应正文不返回票据明文。
- “撤销所有设备”先撤销 Bridge，再撤销 Web 会话；Bridge 撤销失败时保留 Web 会话，避免前端误报已经完成全部撤销并允许用户重试。
- 生产 Cookie 前缀规则与本地 HTTP 冲突已修正为环境隔离 Cookie 名，并加入动态 Host 的完整登录/回调回归测试。
- 过期授权码和会话清理为有界批处理函数，不在 HTTP 请求或网关启动路径执行，避免清理影响主请求进程。
- 管理端 MFA 强制方式仍未冻结，因此本轮只保留可扩展的 `mfa_level` 和客户端最小等级校验机制，未虚构短信或 TOTP 流程。

第二轮结论：代码级会话隔离、单次消费、CSRF、撤销范围和本地/生产 Cookie 边界通过复核；真实基础设施与浏览器证据仍需在后续联调阶段补齐。

## 5. 验收证据

- 根测试：215 个测试文件、3397 项测试全部通过。
- SSO 定向测试：1 个测试文件、8 项测试通过，覆盖 PKCE、精确回调、独立应用会话、一次性授权码、一次性实时票据、管理员边界、退出范围、Host-only Cookie、动态 Host 和 ES256/JWKS。
- 服务端 TypeScript 类型检查通过。
- 前端边界检查通过：`www`、`trade`、`admin` 独立，`auth` 只承担身份中心，shadcn-vue 是唯一通用组件源。
- 前端测试共 12 项通过；7 个前端工作区类型检查通过。
- Nuxt `www` 与 Vite `auth`、`trade`、`admin` 生产构建全部通过。
- OpenAPI JSON 解析及阶段 10 路径检查通过；`git diff --check` 通过。

```powershell
pnpm exec vitest run server/tests/auth-sso-service.test.ts
pnpm typecheck:server
pnpm run verify:frontend-boundaries
pnpm run test:frontend
pnpm run typecheck:frontend
pnpm run build:frontend
pnpm test -- --reporter=dot
git diff --check
```

## 6. 未执行与剩余风险

- 未执行数据库迁移、回填或任何数据修改；迁移文件已生成并保留，需在阶段 15 的旁路库演练中单独授权执行。
- 未连接真实 MySQL、Redis、生产子域、浏览器 HTTPS 或真实 WebSocket 网关；当前证据是服务端真实路由的进程内 HTTP 链路、内存端口和构建测试。
- 未实现注册、找回密码、修改密码、MFA 绑定/挑战和第三方登录产品流程；管理端最终采用 TOTP、Passkey 或其它方式仍需单独冻结。
- 未启动、部署、重启、提交或推送，也未撤销任何真实 Bridge 设备凭据。
- 工作区同时包含阶段 1–9 与 Bridge 的共享未提交改动，本阶段没有强行拆分提交，避免覆盖或误提交其它范围。
