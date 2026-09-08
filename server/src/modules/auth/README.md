# Auth 模块边界

负责第一方SSO、应用会话、授权码、CSRF、实时票据和明确范围的注销。网页各应用继续使用独立Host-only会话，不共享父域Cookie或浏览器长期凭据。

## 公开入口与组装

- `index.ts`：应用服务、端口与必要身份类型/错误/协议函数；其它模块只经此入口调用业务能力。
- `composition.ts`：运行入口创建认证服务、实时票据认证器及HTTP插件。`createAuthHttp(service, secureCookies)`封装完整SSO路由；全局路由登记器只接收插件，不导入auth内部路由。
- MySQL、Redis、密码校验、签名器、客户端注册表、清理SQL及HTTP实现保留私有。测试可以直接验证内部适配器，跨域生产代码不得以测试导入为例外。

`BrowserRequestAccess` 是窄的浏览器请求认证合同，只返回 userId/role；`createBrowserRequestAccess` 在 composition 内创建 trade/admin 两种实现，由 API 入口注入消费者。Cookie 解析、会话解析及 CSRF 留在 auth，不向 trading 暴露 AuthService 或持久会话。当前保留既有 Cookie 接受规则，本次结构调整不代表全域 AuthService 导出已收口。

AuthService通过自身所需的BridgeDeviceRevoker端口触发设备撤销；实现由bridge提供并在运行入口注入。设备撤销失败向上传播，随后网页退出不会提前执行。不得把Bridge表SQL重新移回auth。

## 数据与生命周期

当前V4源码直接写入auth_sessions和auth_authorization_codes；其会话撤销、单次授权码消费与到期清理归auth管理。users为身份读取来源，其账户资料、权益及历史写入的完整所有权仍需结合全表矩阵完成，不能以当前未写入认定其无需归属。

登录事务与实时票据使用Redis适配器，持久会话与授权码仍以MySQL为权威。mysql-auth-cleanup保留内部实现；本批没有为它新增定时器、Worker或启动调用。API与实时入口保持各自角色边界。

## 验收入口与未完成项

运行auth-sso-service、browser-realtime-runtime、bridge-pairing及受影响模块HTTP测试；服务端类型检查/构建包含边界和运行合同生成门。实际路由清单使用inspect:api-contracts，已知其它域缺失不能隐去。

当前完成的是公开入口与组装封装，不表示认证全域、用户资料迁移、全部API同源校验、真实MySQL/Redis及浏览器集成均已完成。HTTP合同仍遵循contracts/http/domains/auth.json及总体P0–P7验收。


## 账户身份读取结构合同

受限 composition 导出 assertAccountPrincipalReadSchema，供 API 组装注入账户就绪检查，同一升级锁连接内执行。auth/account-principal-read/v1 所需 users 字段为 id、role、plan、plan_expires_at、deleted_at、deletion_status，验证 MySQL 类型、空值和字符串排序语义及 id 主键；只读取信息架构元数据。

该能力不经业务 index 导出，不向 domain/application 暴露连接；不涵盖完整 auth 写入就绪，不允许将通过结果当作迁移、权限或权益状态证明。字段消费来自 trading 的当前账户归属/观摩查询，后续 SQL 端口化仍需继续。


## 事务内有效用户查询

业务 index 仅导出 ActivePrincipalAccess 类型；createActivePrincipalAccess 仅从 composition 创建绑定调用方连接的实现。isActive(userId, lock) 使用明确 none/update 模式读取删除状态；update 保留 FOR UPDATE 用户行锁，适配器不提交、不回滚、不释放连接。无效 ID 或模式直接拒绝，驱动错误脱敏。该能力不表示交易账户或观摩授权通过。


账户回执授权：ActivePrincipalAccess 支持 none/share/update，share/update 必须绑定调用者事务。独立回执查询先在同连接获取 auth 用户共享锁，读取完后由 trading rollback；写命令保持用户排他锁。auth 不管理交易事务，trading 回执 SQL 不再读取 users。真实双连接锁验证入口 scripts/verify-context-principal-lock-mysql.mjs，使用私有合成用户文件和新建报告绝对路径；只执行并回滚无值变化 UPDATE。其它跨域 SQL 不据此视为完成。


账户身份只读结构能力 V2 由 composition 的 assertAccountPrincipalReadSchemaV2 提供，在 V1 基础上校验观摩授权依赖的 token_version；API 启动与 readiness 使用V2，旧V1保持可复现。验证入口 scripts/verify-account-principal-schema-v2-local.mjs（新报告绝对路径），只读当前开发库元数据与迁移账本；不代表完整auth写入能力或观摩 SQL 已拆分。


主体事实公开能力 AccountPrincipalReader.readMany：最多101个请求ID，返回活动用户的会员原值、UTC到期时间与身份版本；缺失或停用主体不返回。composition 的 createAccountPrincipalReader 绑定调用者连接。none 读取必须与授权其它事实共享一致快照，share 使用外层事务，reader 不负责 begin/commit/release。验证入口 auth-account-principal-reader.test.ts 与 scripts/verify-account-principal-facts-mysql.mjs；观摩消费者尚待注入。


观摩消费者现已通过运行组装注入AccountPrincipalReader：普通快照none、写事务share；auth负责主体字段与停用过滤，trading保留频道策略、会员到期/授权TTL及明确grant规则。消费者组装与真实临时表证据见总体方案第63节。
