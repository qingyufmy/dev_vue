# 单点登录与统一认证架构方案

> 状态：可实施基线
>
> 版本：1.0
>
> 建立日期：2026-09-02
>
> 适用范围：`auth`、`www`、`trade`、`admin`、WebSocket、Bridge 授权边界

## 1. 目标

本方案为三个独立前端提供一个账号体系和真正的单点登录，同时保持各应用的会话、权限、故障和安全边界独立。

目标：

- 用户在一个应用完成登录后，进入其它应用时无需再次输入账号和密码。
- `www`、`trade`、`admin` 各自持有独立、不可被 JavaScript 读取的服务端会话。
- 任一业务子域出现前端漏洞时，不得直接读取或复用其它子域的会话凭据。
- 登录、注册、验证码、找回密码、二次验证和账号恢复只保留一套权威实现。
- 登录协议遵循 OpenID Connect Authorization Code Flow 与 OAuth 2.0 PKCE，不自行设计可复制的跳转令牌。
- 保留现有系统用户、角色、会员、联系方式和密码数据；迁移不丢用户数据。
- 实现保持在现有后端内，不为了单点登录强制拆分认证微服务。

非目标：

- MT4/MT5 交易账号不是网站登录身份，不进入统一身份认证。
- Bridge 不使用浏览器 Cookie，也不通过网页单点登录会话维持后台连接。
- 单点登录不代表单点授权；各应用仍独立校验角色、会员和资源权限。

## 2. 当前实现结论

当前登录成功后由后端签发默认有效期 7 天的 JWT，前端把令牌同时写入 `localStorage` 和 JavaScript 可读 Cookie，再通过 `Authorization: Bearer` 调用接口。

主要问题：

- 浏览器脚本可以读取长期凭据，发生 XSS 时令牌可能被直接导出。
- 当前方式只是在同一个前端环境中同步令牌，不是 `www`、`trade`、`admin` 三个独立子域的标准单点登录。
- 如果改成父域共享 Cookie，任一子域被接管时会扩大到其它应用，尤其会放大管理后台风险。
- JWT 注销主要依赖用户级 `token_version`，不能自然表达“退出当前应用、退出全部网站、撤销全部设备”三种不同范围。
- 登录响应、业务 API 和 WebSocket 都直接依赖浏览器持有 Bearer Token，不符合新版独立会话边界。

新版不得复用 `public/shared/session.js` 的客户端持久化方式，也不得在登录响应中向浏览器返回长期访问令牌或刷新令牌。

## 3. 总体架构

```text
                         auth.<domain>
                    统一身份认证与主登录会话
                登录 / 注册 / 找回 / MFA / 账号恢复
                                │
                    Authorization Code + PKCE
                 ┌──────────────┼──────────────┐
                 ▼              ▼              ▼
          www.<domain>    trade.<domain>   admin.<domain>
          www host session trade host session admin host session
                 │              │              │
                 └──── 同源 BFF/API 入口，服务端持有身份 ────┘
```

### 3.1 应用角色

| 客户端 | 登录入口 | 回调地址 | 会话用途 |
| --- | --- | --- | --- |
| `www-web` | `https://www.<domain>/login` | `https://www.<domain>/auth/callback` | 主站、课程、会员与账户功能 |
| `trade-web` | `https://trade.<domain>/login` | `https://trade.<domain>/auth/callback` | AI 交易实验室、HTTP 与实时连接 |
| `admin-web` | `https://admin.<domain>/login` | `https://admin.<domain>/auth/callback` | 管理后台，强制管理员权限和更高认证等级 |

每个应用保留自己的登录页面、品牌说明、帮助入口和错误状态；实际账号凭据只提交给 `auth.<domain>`。应用登录页发起顶层页面跳转，不通过 iframe 静默复制会话，也不在应用之间传递 Token。

### 3.2 BFF 边界

- 浏览器只访问当前应用的同源 `/api/v4/**` 与实时入口。
- BFF 是现有后端中的逻辑边界，不要求拆成三个独立服务。
- 反向代理根据 `www`、`trade`、`admin` 主机名把请求送入对应应用入口和后端会话中间件。
- 浏览器只持有随机会话标识；授权码、访问令牌和身份声明只在服务端处理。
- `packages/api-client` 不读取 Cookie、不拼接 Bearer Token，只使用 `credentials: 'same-origin'` 调用当前应用同源接口。

## 4. 标准登录流程

1. 用户访问某应用受保护路由或登录页。
2. 应用生成一次性 `state`、`nonce` 和 PKCE `code_verifier`，服务端保存与当前登录事务的绑定。
3. 浏览器跳转至 `https://auth.<domain>/oauth/authorize`，携带固定 `client_id`、精确 `redirect_uri`、`response_type=code`、`scope=openid profile`、`state`、`nonce` 和 `code_challenge`。
4. 身份中心检查主登录会话；没有会话时展示统一登录、注册或恢复流程，已有会话时直接继续。
5. 身份中心返回有效期不超过 60 秒、只能消费一次且只绑定当前客户端和回调地址的授权码。
6. 浏览器回到应用 `/auth/callback`；应用服务端校验 `state`，使用 `code_verifier` 兑换并消费授权码。
7. 应用服务端创建该子域自己的会话 Cookie，然后只重定向到登录前经过白名单校验的内部路径。
8. 浏览器地址栏和前端状态中不得保留授权码、ID Token、访问令牌或刷新令牌。

强制规则：

- 回调地址采用完整字符串精确匹配，不接受通配路径和用户传入域名。
- 只允许 Authorization Code Flow；禁止 Implicit Flow 和在 URL 中返回访问令牌。
- PKCE 只允许 `S256`。
- `state`、`nonce`、授权码和 PKCE 参数必须每次随机生成、单次使用并有短有效期。
- `next` 只能是当前应用允许的站内相对路径，禁止开放重定向。
- 认证端点和回调页不得加载不必要的第三方脚本。

## 5. 会话与 Cookie

### 5.1 Cookie

建议名称：

```text
__Host-Http-auth_session
__Host-Http-www_session
__Host-Http-trade_session
__Host-Http-admin_session
```

统一属性：

```text
Secure
HttpOnly
SameSite=Strict
Path=/
不设置 Domain
```

- Cookie 只包含高熵随机会话标识，不包含用户资料、权限、访问令牌或刷新令牌。
- 数据库存储会话标识的哈希，不保存可直接作为 Cookie 使用的明文值。
- 登录成功、权限提升、密码变更和敏感资料变更后轮换会话标识，防止会话固定。
- 本地开发使用独立的安全开发配置；生产属性不得因本地 HTTP 兼容而降级。

### 5.2 有效期建议

| 会话 | 默认策略 | 说明 |
| --- | --- | --- |
| 身份中心 | 会话级；用户明确选择保持登录时绝对有效期最多 30 天 | 只用于后续 SSO，不直接访问业务资源 |
| 主站 | 绝对有效期 7 天，可滚动刷新但不超过上限 | 课程和会员使用 |
| 交易实验室 | 绝对有效期 7 天；敏感交易操作可要求近期认证 | 断线不等于注销，写操作仍受实时权限和风控约束 |
| 管理后台 | 空闲 30 分钟、绝对有效期 8 小时 | 必须满足管理员角色和规定的 MFA 等级 |

具体时长由配置项管理并在上线前冻结；不得散落在前端常量中。

### 5.3 CSRF 与跨子域隔离

`SameSite` 不能单独防御同一父域下被接管子域发起的请求，因此所有写操作还必须：

- 校验精确 `Origin`，只允许当前应用自身来源。
- 要求每个会话派生的 CSRF Token，并由前端放入 `X-CSRF-Token` 请求头。
- 仅对明确允许的方法和请求头响应 CORS 预检，生产环境禁止 `*` 来源。
- 对登录、授权、回调、修改凭据和危险交易操作使用独立速率限制和审计。

CSRF Token 不是身份凭据，可以由 `/api/v4/session` 随会话摘要返回；它不得跨应用复用。

## 6. 认证与会话接口

### 6.1 身份中心标准端点

| 方法 | 路径 | 调用方 | 用途 |
| --- | --- | --- | --- |
| `GET` | `/.well-known/openid-configuration` | 服务端客户端 | 发布认证元数据 |
| `GET` | `/oauth/authorize` | 浏览器顶层跳转 | 发起授权码流程 |
| `POST` | `/oauth/token` | 应用服务端 | 兑换单次授权码；浏览器不得直接调用 |
| `GET` | `/oauth/jwks` | 应用服务端 | 验证身份中心签名和支持密钥轮换 |
| `POST` | `/api/v4/auth/login` | 身份中心页面 | 密码或验证码登录 |
| `POST` | `/api/v4/auth/logout` | 身份中心页面/应用服务端 | 撤销身份中心主会话 |

客户端注册表初期固定在后端配置中，只登记三个客户端及精确回调地址，不为尚不存在的第三方客户端提前建设动态注册后台。

### 6.2 应用同源接口

| 方法 | 路径 | 用途 |
| --- | --- | --- |
| `GET` | `/api/v4/session` | 返回当前用户、应用权限、认证时间、MFA 等级和 CSRF Token |
| `POST` | `/api/v4/session/logout` | 只退出当前应用 |
| `POST` | `/api/v4/session/logout-web` | 撤销当前用户的身份中心及全部网站应用会话 |
| `POST` | `/api/v4/session/revoke-all` | 二次验证后撤销全部网站会话和 Bridge 设备授权 |
| `GET` | `/auth/callback` | 应用服务端处理授权码并建立 Host-only 会话 |
| `POST` | `/api/v4/realtime/tickets` | 为当前 `trade` 会话签发短时、单次 WebSocket 连接票据 |

成功登录和会话接口不得返回浏览器可持久化的 JWT。错误响应遵循统一 API 错误合同，不返回认证实现细节。

### 6.3 权限

- 会话只证明用户身份和认证强度，不缓存永久授权结论。
- 每个业务接口继续校验用户状态、角色、会员、账户归属和资源权限。
- `admin` 建立会话时和每次管理请求时均校验管理员角色；普通用户已有 SSO 会话也不能建立有效后台会话。
- 删除用户、修改密码、变更角色和执行“撤销全部设备”后必须立即撤销相关会话与实时连接。
- `users.token_version` 在迁移期保留作为全局失效兼容字段；新会话体系稳定后再评估是否合并为统一安全版本字段。

## 7. 数据结构与迁移文件

为避免过度设计，第一版只新增两个权威表，登录审计继续复用现有审计体系。

### 7.1 `auth_sessions`

用途：统一保存身份中心和三个应用的服务端会话。

主要字段：

```text
id                       内部主键
session_hash             唯一，会话 Cookie 随机值的 SHA-256
user_id                  系统用户
client_id                auth / www-web / trade-web / admin-web
parent_session_id        应用会话关联的身份中心主会话，可空
auth_time_utc             最近一次实际完成身份验证的 UTC 时间
mfa_level                none / otp / strong
session_version          建立时的用户安全版本
created_at_utc
last_seen_at_utc
idle_expires_at_utc      可空
absolute_expires_at_utc
revoked_at_utc           可空
revocation_reason        可空
```

索引至少覆盖：`session_hash` 唯一索引、`user_id + revoked_at_utc`、`parent_session_id`、`absolute_expires_at_utc`。

### 7.2 `auth_authorization_codes`

用途：保存短时、一次性授权码及其绑定条件。

主要字段：

```text
id
code_hash                 唯一，不保存明文授权码
user_id
auth_session_id
client_id
redirect_uri
scope
nonce
code_challenge
code_challenge_method     固定 S256
created_at_utc
expires_at_utc
consumed_at_utc           可空
```

索引至少覆盖：`code_hash` 唯一索引、`expires_at_utc`、`auth_session_id`。

授权码消费使用单条条件更新或事务锁，只有 `consumed_at_utc IS NULL` 且未过期时才能成功一次。过期授权码和已撤销会话按有界批次定期清理。

### 7.3 时间与数据规则

- 所有认证时间统一存储为 UTC，不使用终端时间和北京时间参与有效期计算。
- 会话 Cookie 明文、授权码明文、密码、验证码和 PKCE `code_verifier` 不写日志。
- IP 和 User-Agent 只作为审计和异常提示，不做容易误伤移动网络用户的强绑定。
- 数据库迁移必须可重复检测、可在现有用户数据上执行，并为新增索引评估锁表时间。

## 8. WebSocket 与 Bridge

### 8.1 WebSocket

- `trade` 先通过同源 HTTP 会话申请有效期不超过 30 秒、只能使用一次的实时连接票据。
- WebSocket 服务校验票据、精确 `Origin`、用户、应用、账户作用域和票据是否消费。
- 建连后服务端仍对每个订阅频道校验资源权限，不相信前端传入的用户或账户 ID。
- 会话撤销、角色变化、用户删除、退出全部网站或退出全部设备时主动断开相应连接。
- WebSocket 票据只用于握手，不能作为 HTTP API 凭据或 Bridge 凭据。

### 8.2 Bridge

- Bridge 保留独立的设备配对、短时连接票据和可轮换刷新会话。
- 网站 SSO 不向 Bridge 下发浏览器 Cookie、OIDC Refresh Token 或应用会话。
- “退出全部网站”默认不影响正在运行的 Bridge；“撤销全部设备”才撤销 Bridge 刷新会话并断开连接。
- Bridge 配对审批要求用户当前拥有有效 `trade` 会话，并继续执行会员、账户归属和管理员观摩源规则。

## 9. 迁移步骤

### 阶段 1：后端基础

1. 增加两个数据表的正式迁移和清理任务。
2. 在现有后端中建立认证模块、客户端固定注册表、授权码和服务端会话服务。
3. 新增 v4 会话中间件，不修改旧接口的行为。
4. 建立密钥轮换、CSRF、精确 Origin、速率限制和审计测试。

### 阶段 2：端到端竖切

1. 先完成 `trade` 登录、回调、会话摘要、HTTP 请求和 WebSocket 票据链路。
2. 验证登录、刷新、账户切换、断线重连、当前应用退出、全部网站退出和全部设备撤销。
3. 浏览器存储中不得出现访问令牌或刷新令牌。

### 阶段 3：接入主站和后台

1. Nuxt 主站接入同一身份中心和自己的 Host-only 会话。
2. 管理后台接入管理员角色、MFA 和短会话策略。
3. 验证三个应用登录入口独立，但已经登录的用户跨应用不再输入密码。

### 阶段 4：切换与清理

1. 上线切换时允许现有用户重新登录一次，不把旧 JWT 自动转换成新会话。
2. 新应用和 v4 API 不再接受浏览器 Bearer JWT。
3. 确认三个应用、WebSocket、Bridge 配对和退出流程稳定后，删除旧登录响应中的 Token、`public/shared/session.js` 及旧 Bearer 认证路径。
4. 删除前先确认旧前端和旧接口已无流量；保留现有用户、密码哈希、角色、会员和绑定数据。

迁移回滚只回滚新应用入口和新会话中间件，不删除新表中的证据数据，也不恢复前端长期令牌作为最终方案。

## 10. 验收条件

- 在任一应用登录后，进入另外两个应用不需要重新输入密码。
- 三个应用 Cookie 均为 Host-only、`Secure`、`HttpOnly`，且不能被前端脚本读取。
- 浏览器 Local Storage、Session Storage、IndexedDB、URL 和页面源码中没有访问令牌或刷新令牌。
- `www`、`trade`、`admin` 会话不能互相调用对方的同源接口。
- 普通用户即使完成 SSO，也不能建立管理员会话。
- 回调地址、`state`、`nonce`、PKCE、授权码单次消费和过期行为有自动测试。
- 写操作的 CSRF、精确 Origin、重复提交和会话撤销有自动测试。
- WebSocket 票据只能使用一次；退出或撤销后连接及时断开。
- “退出当前应用”“退出全部网站”“撤销全部设备”三种行为与文案一致。
- 现有用户、会员、角色、密码哈希和 Bridge 绑定无数据丢失。

## 11. 第一轮方案复审

复审范围：需求覆盖、业务边界、现有能力复用、最小实现和是否设计过度。

发现与调整：

- 原设想可能为 `auth`、`www`、`trade`、`admin` 分别拆认证服务，超出当前规模；调整为现有后端中的统一认证模块和三个逻辑 BFF 边界。
- 固定只有三个第一方客户端，没有引入动态客户端注册、授权同意后台或第三方开发者能力。
- 数据结构从独立的主会话表、应用会话表、登录事务表、客户端表和认证事件表收敛为 `auth_sessions`、`auth_authorization_codes` 两张新表；固定客户端使用配置，审计复用现有系统。
- 保留每个应用的独立登录页，同时把账号凭据输入集中到身份中心，满足产品独立性且避免三套登录逻辑。
- Bridge 继续使用现有设备授权边界，没有被错误纳入浏览器 SSO。

第一轮结论：方案覆盖单点登录、三应用隔离、管理员权限、WebSocket 和 Bridge；已去掉无明确收益的服务拆分与数据表。

## 12. 第二轮方案复审

复审范围：兼容性、数据迁移、并发与幂等、异常恢复、时间、安全、测试、回滚和连带 Bug。

发现与调整：

- 父域共享 Cookie 会让子域攻击扩大到管理后台，最终明确禁止 `Domain` 属性并采用每应用 Host-only 会话。
- `SameSite=Strict` 不能单独防止同站不同源攻击，补充精确 Origin、CSRF Token、严格 CORS 和 WebSocket 一次性票据。
- 授权码可能被重复提交，补充哈希存储、60 秒内过期、客户端/回调/PKCE 绑定和事务单次消费。
- 旧 JWT 自动换新会延续令牌盗用风险，调整为切换时允许用户重新登录一次；用户业务数据不受影响。
- “退出全部”语义容易误断 Bridge，拆分为当前应用、全部网站和全部设备三种撤销范围。
- 管理员角色可能在会话期间被撤销，补充每次管理请求重新校验角色和立即断开会话。
- 所有过期和审计时间统一 UTC；终端时间不得进入网站认证有效期判断。
- 回滚不得重新把客户端长期 JWT 作为最终架构，仅允许恢复旧入口以处理上线故障。

第二轮结论：最终方案已覆盖跨子域、会话窃取、CSRF、并发消费、撤销、迁移和回滚风险，可以进入数据迁移与端到端竖切设计。

## 13. 剩余待冻结项

- 正式生产域名和 `auth.<domain>` 的证书、反向代理与 DNS。
- 身份中心签名算法、密钥托管和轮换周期。
- 管理员 MFA 的具体方式；默认要求至少一次性验证码，后续可升级通行密钥。
- 各类会话最终有效期和“保持登录”是否开放给交易实验室。
- v4 API 的最终公开根路径需与后端统一 API 方案一起冻结。

## 14. 标准依据

- [OpenID Connect Core 1.0](https://openid.net/specs/openid-connect-core-1_0-18.html)
- [RFC 9700: Best Current Practice for OAuth 2.0 Security](https://www.rfc-editor.org/rfc/rfc9700.html)
- [RFC 10017: OAuth 2.0 for Browser-Based Applications](https://www.rfc-editor.org/rfc/rfc10017.html)
- [MDN Secure Cookie Configuration](https://developer.mozilla.org/en-US/docs/Web/Security/Practical_implementation_guides/Cookies)
