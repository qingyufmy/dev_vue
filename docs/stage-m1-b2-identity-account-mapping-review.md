# M1 / B2 首批字段映射与结构缺口评审

> 2026-09-05；身份、账户、Bridge、会员与连接额度。**首批评审完成，不代表 B2 全域完成，更不是回填就绪。**
>
> 本次只读隔离镜像和目标 A 元数据；没有 DDL/DML、A/B 回填、服务启动、认证切换、终端访问或交易测试。

## 1. 输入和可复核产物

- 冻结输入：`dev_vue_m1_source_20260905_01`；实例 UUID `ac423207-6ef3-11f1-b302-000c29fda104`；MySQL 8.4.8。
- source snapshot：`sha256:af5ed95821a392b62acc24779a3c802dba8d60fb32e713fead5ed25c7817e08c`；恢复证明见 [B1 验收](./stage-m1-b1-retained-backup-continuation.md)。
- 本次元数据/聚合观测开始于 `2026-09-05T09:52:39.747943Z`。通过独立 READ ONLY 事务执行 SELECT 后 ROLLBACK；未重新导出源库。
- 参考源码基线：`75b8e944aafc759248e72800ca0ec36d00abd9b7`。这是本地参考代码版本，**不是所有历史写入版本已经证明一致**。
- [脱敏元数据与聚合计数](./migration/m1-b2-identity-observation-20260905.json)：源列类型、NULL、默认值、排序规则、索引；目标 A 对应结构；无用户行值、密码哈希、验证码、token、IP 或账户号码清单。
- [逐字段清单](./migration/m1-b2-identity-field-manifest-20260905.json)：11 表、148 列，每列一个主处置；固定转换规则 ID/version/规格 SHA-256、候选目标、关系、空值、证据和阻断项。
- 校验工具只验证清单完整性和结构，不读取数据库、不执行转换、不证明权限语义已经通过。行级原值/转换 hash 与 receipt 留在 B3/B4 的受控产物，不公开到 Git。
- `proposal:` / `history-proposal:` 是待评审的业务承接位置，不是已经存在的数据库表；`encrypted-snapshot:` 是原备份定位要求，不表示索引/读取适配已完成。

## 2. 结论与优先级

**当前不应开始 B3 回填。** 主要缺口不是“缺几个字段”，而是归属历史、离线账户可见性、观摩受众和认证/会员事实不能被现有目标无损表达。不能靠填默认值、伪造设备或只保留一个 dump 绕过。

| 范围 | 源行数 | 源列数 | 核实结论 |
| --- | ---: | ---: | --- |
| `users` | 25 | 34 | 25 个身份全部保留，含 19 个 anonymized；活动设置仍有缺口 |
| `verification_codes` | 17 | 10 | 不转成可用 SSO/验证码；加密历史留痕 |
| `bridge_device_pairings` | 1 | 14 | 1 条 consumed，仅历史，不重新授权 |
| `bridge_refresh_sessions` | 17 | 10 | 17 条 V3 凭据保留兼容，不预造 V4 |
| `trading_accounts` | 4 | 15 | 4 个旧 ID、3 组候选实体，尚未批准合并 |
| `mt5_account_bindings` | 3 | 10 | 3 条当前归属，不能当作终端档案绑定 |
| `mt5_account_ownership_history` | 274 | 10 | 274 段历史；现目标 PK 无法完整承接 |
| `bridge_v3_terminal_sessions` | 7 | 20 | 7 条均无 installation_id；备份在线不是真在线 |
| `ai_observer_sources` | 2 | 10 | 2 个源；操作用户不等于管理员/账户所有者 |
| `ai_observer_channels` | 2 | 11 | 2 个 all 频道；新读模型缺动态 audience |
| `ai_observer_channel_assignments` | 0 | 4 | 空表仍有功能；不能解释成无人可观摩 |

## 3. 用户、认证、会员和推荐

### 3.1 身份不能按当前活跃用户筛掉

- 源含 1 admin、24 user；生命周期为 6 active、19 anonymized。19 个匿名化身份保留原 ID、匿名化后的原字段和删除事实，不能恢复曾经的个人信息，不能设回 active；历史外键仍引用它们。
- `users.id/uid/password/token_version/role` 保持原义。密码仅做哈希前缀格式聚合，25 条无空值/未识别 bcrypt 前缀；**这不是实际密码登录验证**，后续用合成密码样例验证 bcrypt 兼容，不导出实际哈希。
- 本次邮箱、手机号、UID 目标排序规则候选冲突为 0；邮箱/手机号跨字段登录碰撞为 0。V4 `findUserByLogin` 仍是 OR + LIMIT 1，email/phone 仅普通索引，所以这些门必须在最终停写快照和新用户写入规则中再次成立，不能把本次零冲突当作永久唯一保证。
- 目标 NOT NULL 而源可 NULL 的 nickname/avatar/role/plan/created_at/updated_at，本快照均无 NULL；仍逐列“遇 NULL 阻断”，不使用目标默认值掩盖原缺失。
- `email_verified/phone_verified/auth_method` 必须有活动承接。不能因当前非空联系方式都已验证，就给未来或另一份快照全部默认 verified；注册、改绑、重置密码、注销需覆盖。

### 3.2 会员和推荐不是归档功能

- 原会员：pro 4、free 20、plus 1；来源有 paid/gift/observer_source/NULL；周期有 month/空串。保留原 plan、原到期值、来源和周期，未证实到期时间语义前不计算新的有效期。
- `plan_source=observer_source` 不等于购买额度，也不能直接给管理员权限。`NULL` 来源不自动猜成付费，永久期与无效日期需分别处理。
- 1 个用户有非零 `referral_credit DECIMAL(20,8)`，必须精确保留并对账，不能降为 DOUBLE、置零或只放历史不可用。
- **`referred_by` 存的是推荐码字符串，不是 user ID。** 写入/解析依据 `server/routes/auth.js` 按 `users.referral_code` 查询。本快照非空 referred_by 为 0，但结构与后续快照必须按推荐码关系实现，不能靠 MySQL 隐式转数字联表。
- changelog 已读、last_seen 等按活动需求补承接；旧 `bridge_heartbeat` 仅历史，不作为新在线状态。2026-09-05 用户后续明确不需要 Telegram 绑定，因此取消其活动承接，转为待逐字段验证的退役历史处置，详见目标方案 §3.2。下方冻结映射表保留原评审记录，不代表当前仍要实现绑定。
- 推荐：保留现有 users 身份/快速会员读合同；简单验证/会员来源字段可追加 users；外部联系、推荐权益等有独立生命周期的内容由所属域承接。此轮不强制为每个旧字段拆一张新表。

证据：`server/routes/auth.js`、`server/routes/user.js`、`server/membership.js`、V4 `mysql-auth-repository.ts`、bootstrap `v4-foundation-v1.sql`。

## 4. 账户实体与归属历史

### 4.1 实体合并不能合并历史权限

- 4 条旧账户按规范化 server + 原 login 得到 3 组候选身份，1 组重复；均能匹配终端 session，未发现同一候选身份匹配多个 platform。
- 源 session 枚举含 MT4 1、MT5 6，**不能根据 mt5_* 表名前缀给所有账户填 mt5**。session 只是当前保存的证据，历史身份仍需结合绑定/归属行冻结映射。
- 币种候选来自 `mt5_account_bindings.account_currency`，不是根据品种猜 USD。本次无缺失候选、无超过目标 12 字符情况；保留原值且检查冲突。
- 所有 4 个旧账户 ID 必须都有 legacy map；如果确认投影成 3 个新实体，多对一映射仍保留每个旧 ID 的用户语境、状态和完整历史引用。
- `nickname/review_status/observe_status/is_deleted/anomaly_code` 含用户关系语义，不能全塞到账户实体。旧 transferred/switched 与实体删除不同；`is_deleted` 是布尔而目标是删除时间，不能伪造删除时刻。
- 本次 margin_mode 都是 hedging；这仍是账户属性事实，不能丢弃或用目标默认 netting 推算。

### 4.2 274 个区间需要独立承接

- 274 行历史；3 个未结束区间；同一 user + 旧 account 的重复组 2 个。
- 按同身份半开区间 `[started_at, ended_at)` 比较，反向区间/重叠对为 0；缺 user/account、binding 当前 owner 与账户 user 不一致、binding 无匹配开放区间、历史 server/login 与原账户不一致，均为 0。
- 现 `trading_account_ownerships` PK 为 `(user_id,trading_account_id,role)`，只能做当前/最近授权投影。把 274 行 UPSERT 到这里会覆盖已结束区间。
- 推荐追加“归属区间历史”承接，每段有稳定 ID、旧 interval ID、用户、账户、开始/结束、原因和来源证据；现授权表可继续用作当前授权投影，不为迁移重写所有业务。
- 历史交易/复盘/私有分析必须按原用户及区间/来源引用授权。当前 owner 不能因此看到上一个 owner 的私有记录；旧 owner 的合法历史也不能因当前授权撤销就消失。
- 当前开放段来源于绑定+历史一致性，不单凭 `trading_accounts.user_id` 或最近 session.user_id 生成 owner。
- 唯一当前归属与区间冲突的 DDL/短事务锁序及历史查询索引，在下一轮结构设计中明确；不承诺“数据库绝不死锁”，而是固定锁序、短事务及完整幂等重试。

### 4.3 不伪造终端以让账户列表有数据

V4 `accountSelect()/accountByIdSelect()` 对真实 terminal binding/profile 使用 INNER JOIN。7 个旧 session 的 installation_id 全为空，因此即使导入实体和 owner，新账户页也可能全空。

应把“已有权查看的账户”和“当前可路由终端”分开读取：离线账户可见，路由/交易权限为空或关闭；新设备经过正常认证握手再注册真实 profile/binding/session。**不能填随机安装 ID、复制 terminal_instance_id 当安装 ID、借用管理员档案来凑界面。**

## 5. Bridge 凭据、连接额度、观摩

### 5.1 V3 更新/refresh 兼容保留

- 17 条 refresh 均未撤销、用户存在且目前 active、哈希格式检查通过；只说明本快照的关联/格式，不意味着每条都应被赋予交易权限。
- 001 追加迁移已提供 credential_version、installation_id、profile_id、generation、migration_key 等；源行以 **credential_version=3** 原样承接。不要批量填 version=4 或伪造来源 refresh ID。
- 旧 `bridge-auth-session.js` 与 V4 `rotateFromLegacy` 都将设备授权视为显式撤销前持续有效；expires_at 是兼容字段，不按它自行撤销旧授权。该行为有现有回归测试，本轮不另加 TTL 规则。
- 同时严格保留 revoked_at、用户 deleted/anonymized、安全版本与会员门。到期字段转换依然要证明时区，不能变成“永久会员”。
- 旧 1 条 consumed pairing、17 条 verification challenge 不转换成新 SSO/可用配对；原敏感字段只在受控加密证据中保留。重发验证码/重新配对是正常交互，不由回填器发送。
- 浏览器 JWT/内存 ticket 不合成 auth_sessions；仅真实认证建立新 Host-only SSO 会话。

### 5.2 额度按真实连接算，不按历史账户算

- 当前 V4 `ConnectionCapacityService` 已是 **1 个默认额度 + 有效追加 grant**，Redis lease 管当前连接；源码符合“换账户不消耗购买额度”的基本计数设计。
- 旧 4 个账户、7 个 session、17 个 refresh、会员 pro/plus、Bridge 心跳都不是购买数量凭证，禁止导入成额外 grant，也不按其数量预占连接。
- 源 165 表清单没有独立同名连接额度账本，但不能据此宣称“所有用户都没有付费额度”；商业波次必须核对订单/配置/管理员赠送来源，再按真实凭证写 source_type/source_id/quantity/有效期。
- 默认 1 已由代码提供，不能再插入一条 quantity=1 的 migration grant 导致变成 2。
- 旧 connected=1 有 2 条，仅冻结历史；切流后活跃 lease 从真实握手建立，不恢复旧在线状态。
- `user_bridge_settings`（4 行、8 列）仍在后续字段波次：其中 connection_enabled、trade_send_enabled、auto_reasoning_enabled、observation_mode 不能被本轮凭据/额度迁移视为已承接，更不能用默认开启覆盖旧的关闭状态。原始证据仍在冻结镜像中。

### 5.3 观摩不是一张频道表

- 2 个频道 audience=all，显式 assignments 为 0；旧代码为 audience=all / 当前等级 / 显式分配的并集。
- 当前 V4 `listObserverChannels` 只 INNER JOIN `observer_channel_accesses`。直接只复制 assignments 会导致这两个公开频道都不可见。
- 需承接 source 实体及 source→account、可选 strategy 的关系；频道 audience/default/sort/slug/description 及禁用状态；显式授权者也需有审计。
- 推荐动态受众读取，保留显式 grant，而不是迁移时给现有 25 个用户铺授权行（会漏新用户/等级变化，并掩盖来源）。
- 2 个 source 中有 1 个 bridge 操作用户不是 admin；旧 validateBridgeUser 允许符合条件的 pro 用户，不能把它当坏数据，也不能给该用户升为 admin。观摩源操作、创建者、交易 owner、观众各自映射。

## 6. 时间、精度与凭据证据门

| 类型 | 本批处理 |
| --- | --- |
| 旧 DATETIME / DATETIME(3) | 清单均暂标 unknown；保留原 lexical/NULL/精度。当前 db.js 的 +08 和 beijingNow、auth/Bridge NOW 写入是候选证据，不足覆盖全历史 |
| *_utc_msc | 以 unsigned 十进制字符串保留毫秒，不再减时区；映射 DATETIME(3) 前做合法范围校验 |
| int / bigint / ID | 不经过 JS Number 损失精度；ID map 不因 A/B 或 snapshot 改变 |
| DECIMAL(20,8) | 逐用户精确文本保存；原值与转换值对账，不公开金额 |
| token/password/code | 不输出内容、不换加密算法、不重新生成用户密码；验证码不恢复成可用挑战 |
| NULL / 空串 / 0 | 不混同；源默认值只是建表事实，不代替原行值 |

规格 SHA-256 算法：对 UTF-8 `JSON.stringify({id,version,rule})` 求 SHA-256；它锁定本轮**规则文本**，不是尚未实现的迁移转换代码哈希。B3 还必须绑定执行实现及读写 schema 的 hash。

`sourceDefault.kind=null` 表示本次 information_schema 的 COLUMN_DEFAULT 为 SQL NULL，不将其解释成强制填 NULL；对 NOT NULL 列也可能表示没有显式默认。执行时始终显式处理原行值，不借默认值补数据。

## 7. 逐列索引

下表为人工审查入口；类型、NULL/default/collation、校验与完整阻断列表见 JSON。10 列局部规则 reviewed 并不使 users 整行或整批可执行；138 列带阻断，部分多个目标字段依赖同一个结构缺口。

| 源字段 | 主处置 | 候选承接 | 转换 | 阻断 |
| --- | --- | --- | --- | --- |
| `users.id` | active | `users.id` | `b2.legacy-id` | 局部规则已审；仍受整行门约束 |
| `users.uid` | active | `users.uid` | `b2.exact` | 局部规则已审；仍受整行门约束 |
| `users.email` | active | `users.email` | `b2.exact` | 局部规则已审；仍受整行门约束 |
| `users.email_verified` | blocked | `proposal:user-settings.email_verified` | `b2.exact` | G-USER |
| `users.auth_method` | blocked | `proposal:user-settings.auth_method` | `b2.exact` | G-USER |
| `users.password` | active | `users.password` | `b2.exact` | 局部规则已审；仍受整行门约束 |
| `users.nickname` | active | `users.nickname` | `b2.exact` | 局部规则已审；仍受整行门约束 |
| `users.avatar` | active | `users.avatar` | `b2.exact` | 局部规则已审；仍受整行门约束 |
| `users.role` | active | `users.role` | `b2.state` | 局部规则已审；仍受整行门约束 |
| `users.plan` | active | `users.plan` | `b2.state` | G-MEMBER |
| `users.plan_period` | blocked | `proposal:user-membership-referral.plan_period` | `b2.exact` | G-MEMBER |
| `users.plan_expires_at` | active | `users.plan_expires_at` | `b2.wall-clock` | G-TIME |
| `users.telegram_id` | blocked | `proposal:user-settings.telegram_id` | `b2.exact` | G-USER |
| `users.telegram_username` | blocked | `proposal:user-settings.telegram_username` | `b2.exact` | G-USER |
| `users.telegram_name` | blocked | `proposal:user-settings.telegram_name` | `b2.exact` | G-USER |
| `users.telegram_chat_id` | blocked | `proposal:user-settings.telegram_chat_id` | `b2.exact` | G-USER |
| `users.telegram_group_status` | blocked | `proposal:user-settings.telegram_group_status` | `b2.exact` | G-USER |
| `users.telegram_bot_started_at` | blocked | `proposal:user-settings.telegram_bot_started_at` | `b2.wall-clock` | G-USER, G-TIME |
| `users.telegram_joined_at` | blocked | `proposal:user-settings.telegram_joined_at` | `b2.wall-clock` | G-USER, G-TIME |
| `users.telegram_last_invite_sent_at` | blocked | `proposal:user-settings.telegram_last_invite_sent_at` | `b2.wall-clock` | G-USER, G-TIME |
| `users.referral_code` | blocked | `proposal:user-membership-referral.referral_code` | `b2.exact` | G-MEMBER |
| `users.referral_credit` | blocked | `proposal:user-membership-referral.referral_credit` | `b2.decimal` | G-MEMBER |
| `users.referred_by` | blocked | `proposal:user-membership-referral.referred_by` | `b2.relation` | G-MEMBER |
| `users.last_seen_at` | blocked | `proposal:user-settings.last_seen_at` | `b2.wall-clock` | G-USER, G-TIME |
| `users.bridge_heartbeat` | history | `history-proposal:users.bridge_heartbeat` | `b2.wall-clock` | G-EVIDENCE, G-PROJECTION, G-TIME |
| `users.created_at` | active | `users.created_at` | `b2.wall-clock` | G-TIME |
| `users.updated_at` | active | `users.updated_at` | `b2.wall-clock` | G-TIME |
| `users.phone` | active | `users.phone` | `b2.exact` | 局部规则已审；仍受整行门约束 |
| `users.phone_verified` | blocked | `proposal:user-settings.phone_verified` | `b2.exact` | G-USER |
| `users.changelog_seen_version` | blocked | `proposal:user-settings.changelog_seen_version` | `b2.exact` | G-USER |
| `users.token_version` | active | `users.token_version` | `b2.exact` | 局部规则已审；仍受整行门约束 |
| `users.plan_source` | blocked | `proposal:user-membership-referral.plan_source` | `b2.exact` | G-MEMBER |
| `users.deleted_at` | active | `users.deleted_at` | `b2.wall-clock` | G-TIME |
| `users.deletion_status` | active | `users.deletion_status` | `b2.state` | 局部规则已审；仍受整行门约束 |
| `verification_codes.id` | history | `encrypted-snapshot:verification_codes.id` | `b2.history` | G-EVIDENCE, G-AUTH |
| `verification_codes.email` | history | `encrypted-snapshot:verification_codes.email` | `b2.history` | G-EVIDENCE, G-AUTH |
| `verification_codes.code` | history | `encrypted-snapshot:verification_codes.code` | `b2.history` | G-EVIDENCE, G-AUTH |
| `verification_codes.purpose` | history | `encrypted-snapshot:verification_codes.purpose` | `b2.history` | G-EVIDENCE, G-AUTH |
| `verification_codes.expires_at` | history | `encrypted-snapshot:verification_codes.expires_at` | `b2.wall-clock` | G-EVIDENCE, G-AUTH, G-TIME |
| `verification_codes.used` | history | `encrypted-snapshot:verification_codes.used` | `b2.history` | G-EVIDENCE, G-AUTH |
| `verification_codes.verify_token` | history | `encrypted-snapshot:verification_codes.verify_token` | `b2.history` | G-EVIDENCE, G-AUTH |
| `verification_codes.created_at` | history | `encrypted-snapshot:verification_codes.created_at` | `b2.wall-clock` | G-EVIDENCE, G-AUTH, G-TIME |
| `verification_codes.phone` | history | `encrypted-snapshot:verification_codes.phone` | `b2.history` | G-EVIDENCE, G-AUTH |
| `verification_codes.token_used` | history | `encrypted-snapshot:verification_codes.token_used` | `b2.history` | G-EVIDENCE, G-AUTH |
| `bridge_device_pairings.id` | history | `encrypted-snapshot:bridge_device_pairings.id` | `b2.history` | G-EVIDENCE, G-AUTH |
| `bridge_device_pairings.device_code_hash` | history | `encrypted-snapshot:bridge_device_pairings.device_code_hash` | `b2.history` | G-EVIDENCE, G-AUTH |
| `bridge_device_pairings.user_code_hash` | history | `encrypted-snapshot:bridge_device_pairings.user_code_hash` | `b2.history` | G-EVIDENCE, G-AUTH |
| `bridge_device_pairings.user_id` | history | `encrypted-snapshot:bridge_device_pairings.user_id` | `b2.history` | G-EVIDENCE, G-AUTH |
| `bridge_device_pairings.approved_token_version` | history | `encrypted-snapshot:bridge_device_pairings.approved_token_version` | `b2.history` | G-EVIDENCE, G-AUTH |
| `bridge_device_pairings.status` | history | `encrypted-snapshot:bridge_device_pairings.status` | `b2.history` | G-EVIDENCE, G-AUTH |
| `bridge_device_pairings.device_name` | history | `encrypted-snapshot:bridge_device_pairings.device_name` | `b2.history` | G-EVIDENCE, G-AUTH |
| `bridge_device_pairings.created_ip` | history | `encrypted-snapshot:bridge_device_pairings.created_ip` | `b2.history` | G-EVIDENCE, G-AUTH |
| `bridge_device_pairings.approved_ip` | history | `encrypted-snapshot:bridge_device_pairings.approved_ip` | `b2.history` | G-EVIDENCE, G-AUTH |
| `bridge_device_pairings.expires_at` | history | `encrypted-snapshot:bridge_device_pairings.expires_at` | `b2.wall-clock` | G-EVIDENCE, G-AUTH, G-TIME |
| `bridge_device_pairings.approved_at` | history | `encrypted-snapshot:bridge_device_pairings.approved_at` | `b2.wall-clock` | G-EVIDENCE, G-AUTH, G-TIME |
| `bridge_device_pairings.consumed_at` | history | `encrypted-snapshot:bridge_device_pairings.consumed_at` | `b2.wall-clock` | G-EVIDENCE, G-AUTH, G-TIME |
| `bridge_device_pairings.created_at` | history | `encrypted-snapshot:bridge_device_pairings.created_at` | `b2.wall-clock` | G-EVIDENCE, G-AUTH, G-TIME |
| `bridge_device_pairings.updated_at` | history | `encrypted-snapshot:bridge_device_pairings.updated_at` | `b2.wall-clock` | G-EVIDENCE, G-AUTH, G-TIME |
| `bridge_refresh_sessions.id` | active | `bridge_refresh_sessions.id` | `b2.legacy-id` | G-REFRESH |
| `bridge_refresh_sessions.user_id` | active | `bridge_refresh_sessions.user_id` | `b2.relation` | G-REFRESH |
| `bridge_refresh_sessions.token_hash` | active | `bridge_refresh_sessions.token_hash` | `b2.credential` | G-REFRESH |
| `bridge_refresh_sessions.expires_at` | active | `bridge_refresh_sessions.expires_at` | `b2.wall-clock` | G-REFRESH, G-TIME |
| `bridge_refresh_sessions.revoked_at` | active | `bridge_refresh_sessions.revoked_at` | `b2.wall-clock` | G-REFRESH, G-TIME |
| `bridge_refresh_sessions.last_used_at` | active | `bridge_refresh_sessions.last_used_at` | `b2.wall-clock` | G-REFRESH, G-TIME |
| `bridge_refresh_sessions.user_agent` | active | `bridge_refresh_sessions.user_agent` | `b2.exact` | G-REFRESH |
| `bridge_refresh_sessions.last_ip` | active | `bridge_refresh_sessions.last_ip` | `b2.exact` | G-REFRESH |
| `bridge_refresh_sessions.created_at` | active | `bridge_refresh_sessions.created_at` | `b2.wall-clock` | G-REFRESH, G-TIME |
| `bridge_refresh_sessions.updated_at` | active | `bridge_refresh_sessions.updated_at` | `b2.wall-clock` | G-REFRESH, G-TIME |
| `trading_accounts.id` | active | `trading_accounts.id` | `b2.legacy-id` | G-IDENTITY |
| `trading_accounts.user_id` | blocked | `trading_account_ownerships.user_id` | `b2.relation` | G-IDENTITY, G-OWNERSHIP |
| `trading_accounts.broker_server` | active | `trading_accounts.broker_server` | `b2.exact` | G-IDENTITY |
| `trading_accounts.login_account` | active | `trading_accounts.account_login` | `b2.exact` | G-IDENTITY |
| `trading_accounts.nickname` | blocked | `proposal:user-account-settings.nickname` | `b2.exact` | G-IDENTITY |
| `trading_accounts.margin_mode` | blocked | `proposal:user-account-settings.margin_mode` | `b2.state` | G-IDENTITY |
| `trading_accounts.review_status` | blocked | `proposal:user-account-settings.review_status` | `b2.state` | G-IDENTITY |
| `trading_accounts.observe_status` | blocked | `proposal:user-account-settings.observe_status` | `b2.state` | G-IDENTITY |
| `trading_accounts.is_deleted` | blocked | `proposal:user-account-settings.is_deleted` | `b2.state` | G-IDENTITY |
| `trading_accounts.created_at` | active | `trading_accounts.created_at_utc` | `b2.wall-clock` | G-IDENTITY, G-TIME |
| `trading_accounts.updated_at` | active | `trading_accounts.updated_at_utc` | `b2.wall-clock` | G-IDENTITY, G-TIME |
| `trading_accounts.observed_until` | blocked | `proposal:user-account-settings.observed_until` | `b2.wall-clock` | G-IDENTITY, G-TIME |
| `trading_accounts.identity_verified_at` | blocked | `proposal:user-account-settings.identity_verified_at` | `b2.wall-clock` | G-IDENTITY, G-TIME |
| `trading_accounts.first_verified_at` | blocked | `proposal:user-account-settings.first_verified_at` | `b2.wall-clock` | G-IDENTITY, G-TIME |
| `trading_accounts.anomaly_code` | blocked | `proposal:user-account-settings.anomaly_code` | `b2.state` | G-IDENTITY |
| `mt5_account_bindings.broker_server_key` | blocked | `proposal:current-account-owner.broker_server_key` | `b2.relation` | G-IDENTITY, G-OWNERSHIP |
| `mt5_account_bindings.login_account` | blocked | `proposal:current-account-owner.login_account` | `b2.relation` | G-IDENTITY, G-OWNERSHIP |
| `mt5_account_bindings.current_user_id` | blocked | `proposal:current-account-owner.current_user_id` | `b2.relation` | G-IDENTITY, G-OWNERSHIP |
| `mt5_account_bindings.current_trading_account_id` | blocked | `proposal:current-account-owner.current_trading_account_id` | `b2.relation` | G-IDENTITY, G-OWNERSHIP |
| `mt5_account_bindings.last_verified_at` | blocked | `proposal:current-account-owner.last_verified_at` | `b2.wall-clock` | G-IDENTITY, G-OWNERSHIP, G-TIME |
| `mt5_account_bindings.created_at` | blocked | `proposal:current-account-owner.created_at` | `b2.wall-clock` | G-IDENTITY, G-OWNERSHIP, G-TIME |
| `mt5_account_bindings.updated_at` | blocked | `proposal:current-account-owner.updated_at` | `b2.wall-clock` | G-IDENTITY, G-OWNERSHIP, G-TIME |
| `mt5_account_bindings.first_connected_at` | blocked | `proposal:current-account-owner.first_connected_at` | `b2.wall-clock` | G-IDENTITY, G-OWNERSHIP, G-TIME |
| `mt5_account_bindings.last_connected_at` | blocked | `proposal:current-account-owner.last_connected_at` | `b2.wall-clock` | G-IDENTITY, G-OWNERSHIP, G-TIME |
| `mt5_account_bindings.account_currency` | active | `trading_accounts.currency` | `b2.exact` | G-IDENTITY, G-OWNERSHIP |
| `mt5_account_ownership_history.id` | history | `proposal:account-ownership-intervals.id` | `b2.legacy-id` | G-OWNERSHIP |
| `mt5_account_ownership_history.broker_server_key` | history | `proposal:account-ownership-intervals.broker_server_key` | `b2.relation` | G-OWNERSHIP |
| `mt5_account_ownership_history.login_account` | history | `proposal:account-ownership-intervals.login_account` | `b2.relation` | G-OWNERSHIP |
| `mt5_account_ownership_history.user_id` | history | `proposal:account-ownership-intervals.user_id` | `b2.relation` | G-OWNERSHIP |
| `mt5_account_ownership_history.trading_account_id` | history | `proposal:account-ownership-intervals.trading_account_id` | `b2.relation` | G-OWNERSHIP |
| `mt5_account_ownership_history.started_at` | history | `proposal:account-ownership-intervals.started_at` | `b2.wall-clock` | G-OWNERSHIP, G-TIME |
| `mt5_account_ownership_history.ended_at` | history | `proposal:account-ownership-intervals.ended_at` | `b2.wall-clock` | G-OWNERSHIP, G-TIME |
| `mt5_account_ownership_history.end_reason` | history | `proposal:account-ownership-intervals.end_reason` | `b2.history` | G-OWNERSHIP |
| `mt5_account_ownership_history.created_at` | history | `proposal:account-ownership-intervals.created_at` | `b2.wall-clock` | G-OWNERSHIP, G-TIME |
| `mt5_account_ownership_history.updated_at` | history | `proposal:account-ownership-intervals.updated_at` | `b2.wall-clock` | G-OWNERSHIP, G-TIME |
| `bridge_v3_terminal_sessions.terminal_instance_id` | history | `history-proposal:bridge-terminal.terminal_instance_id` | `b2.fresh-runtime` | G-EVIDENCE, G-PROJECTION |
| `bridge_v3_terminal_sessions.user_id` | history | `history-proposal:bridge-terminal.user_id` | `b2.fresh-runtime` | G-EVIDENCE, G-PROJECTION |
| `bridge_v3_terminal_sessions.platform` | history | `history-proposal:bridge-terminal.platform` | `b2.fresh-runtime` | G-EVIDENCE, G-PROJECTION |
| `bridge_v3_terminal_sessions.broker_server` | history | `history-proposal:bridge-terminal.broker_server` | `b2.fresh-runtime` | G-EVIDENCE, G-PROJECTION |
| `bridge_v3_terminal_sessions.login_account` | history | `history-proposal:bridge-terminal.login_account` | `b2.fresh-runtime` | G-EVIDENCE, G-PROJECTION |
| `bridge_v3_terminal_sessions.connection_epoch` | history | `history-proposal:bridge-terminal.connection_epoch` | `b2.fresh-runtime` | G-EVIDENCE, G-PROJECTION |
| `bridge_v3_terminal_sessions.session_id` | history | `history-proposal:bridge-terminal.session_id` | `b2.fresh-runtime` | G-EVIDENCE, G-PROJECTION |
| `bridge_v3_terminal_sessions.client_version` | history | `history-proposal:bridge-terminal.client_version` | `b2.fresh-runtime` | G-EVIDENCE, G-PROJECTION |
| `bridge_v3_terminal_sessions.connected` | history | `history-proposal:bridge-terminal.connected` | `b2.fresh-runtime` | G-EVIDENCE, G-PROJECTION |
| `bridge_v3_terminal_sessions.last_seen_at_utc_msc` | history | `history-proposal:bridge-terminal.last_seen_at_utc_msc` | `b2.epoch-ms` | G-EVIDENCE, G-PROJECTION |
| `bridge_v3_terminal_sessions.created_at` | history | `history-proposal:bridge-terminal.created_at` | `b2.wall-clock` | G-EVIDENCE, G-PROJECTION, G-TIME |
| `bridge_v3_terminal_sessions.updated_at` | history | `history-proposal:bridge-terminal.updated_at` | `b2.wall-clock` | G-EVIDENCE, G-PROJECTION, G-TIME |
| `bridge_v3_terminal_sessions.installation_id` | history | `history-proposal:bridge-terminal.installation_id` | `b2.fresh-runtime` | G-EVIDENCE, G-PROJECTION |
| `bridge_v3_terminal_sessions.bridge_version` | history | `history-proposal:bridge-terminal.bridge_version` | `b2.fresh-runtime` | G-EVIDENCE, G-PROJECTION |
| `bridge_v3_terminal_sessions.update_release_id` | history | `history-proposal:bridge-terminal.update_release_id` | `b2.fresh-runtime` | G-EVIDENCE, G-PROJECTION |
| `bridge_v3_terminal_sessions.update_target_version` | history | `history-proposal:bridge-terminal.update_target_version` | `b2.fresh-runtime` | G-EVIDENCE, G-PROJECTION |
| `bridge_v3_terminal_sessions.update_state` | history | `history-proposal:bridge-terminal.update_state` | `b2.fresh-runtime` | G-EVIDENCE, G-PROJECTION |
| `bridge_v3_terminal_sessions.update_started_at_utc_msc` | history | `history-proposal:bridge-terminal.update_started_at_utc_msc` | `b2.epoch-ms` | G-EVIDENCE, G-PROJECTION |
| `bridge_v3_terminal_sessions.update_reported_at_utc_msc` | history | `history-proposal:bridge-terminal.update_reported_at_utc_msc` | `b2.epoch-ms` | G-EVIDENCE, G-PROJECTION |
| `bridge_v3_terminal_sessions.update_error_code` | history | `history-proposal:bridge-terminal.update_error_code` | `b2.fresh-runtime` | G-EVIDENCE, G-PROJECTION |
| `ai_observer_sources.id` | blocked | `proposal:observer-sources.id` | `b2.observer` | G-OBSERVER |
| `ai_observer_sources.name` | blocked | `proposal:observer-sources.name` | `b2.observer` | G-OBSERVER |
| `ai_observer_sources.bridge_user_id` | blocked | `proposal:observer-sources.bridge_user_id` | `b2.observer` | G-OBSERVER |
| `ai_observer_sources.trading_account_id` | blocked | `proposal:observer-sources.trading_account_id` | `b2.observer` | G-OBSERVER |
| `ai_observer_sources.strategy_id` | blocked | `proposal:observer-sources.strategy_id` | `b2.observer` | G-OBSERVER |
| `ai_observer_sources.status` | blocked | `proposal:observer-sources.status` | `b2.observer` | G-OBSERVER |
| `ai_observer_sources.notes` | blocked | `proposal:observer-sources.notes` | `b2.observer` | G-OBSERVER |
| `ai_observer_sources.created_by_user_id` | blocked | `proposal:observer-sources.created_by_user_id` | `b2.observer` | G-OBSERVER |
| `ai_observer_sources.created_at` | blocked | `proposal:observer-sources.created_at` | `b2.wall-clock` | G-OBSERVER, G-TIME |
| `ai_observer_sources.updated_at` | blocked | `proposal:observer-sources.updated_at` | `b2.wall-clock` | G-OBSERVER, G-TIME |
| `ai_observer_channels.id` | blocked | `observer_channels.id` | `b2.observer` | G-OBSERVER |
| `ai_observer_channels.name` | blocked | `observer_channels.display_name` | `b2.observer` | G-OBSERVER |
| `ai_observer_channels.slug` | blocked | `proposal:observer-channel-policy.slug` | `b2.observer` | G-OBSERVER |
| `ai_observer_channels.description` | blocked | `proposal:observer-channel-policy.description` | `b2.observer` | G-OBSERVER |
| `ai_observer_channels.source_id` | blocked | `observer_channels.source_trading_account_id` | `b2.observer` | G-OBSERVER |
| `ai_observer_channels.audience` | blocked | `proposal:observer-channel-policy.audience` | `b2.observer` | G-OBSERVER |
| `ai_observer_channels.status` | blocked | `observer_channels.active` | `b2.observer` | G-OBSERVER |
| `ai_observer_channels.is_default` | blocked | `proposal:observer-channel-policy.is_default` | `b2.observer` | G-OBSERVER |
| `ai_observer_channels.sort_order` | blocked | `proposal:observer-channel-policy.sort_order` | `b2.observer` | G-OBSERVER |
| `ai_observer_channels.created_at` | blocked | `proposal:observer-channel-policy.created_at` | `b2.wall-clock` | G-OBSERVER, G-TIME |
| `ai_observer_channels.updated_at` | blocked | `proposal:observer-channel-policy.updated_at` | `b2.wall-clock` | G-OBSERVER, G-TIME |
| `ai_observer_channel_assignments.channel_id` | blocked | `observer_channel_accesses.observer_channel_id` | `b2.relation` | G-OBSERVER |
| `ai_observer_channel_assignments.user_id` | blocked | `observer_channel_accesses.user_id` | `b2.relation` | G-OBSERVER |
| `ai_observer_channel_assignments.created_by_user_id` | blocked | `proposal:observer-access-audit.created_by_user_id` | `b2.relation` | G-OBSERVER |
| `ai_observer_channel_assignments.created_at` | blocked | `observer_channel_accesses.granted_at_utc` | `b2.wall-clock` | G-OBSERVER, G-TIME |

## 8. 两轮复审与调整

### 第一轮：需求覆盖与复杂度

- 保留目前 users/auth 的合同，不照旧矩阵拆成多套用户页或新造一套登录模型。
- 将原先“账户归一”拆成实体候选映射、用户账户设置、完整归属区间三个职责；不复制整个旧账户域。
- 纠正 referred_by 是推荐码而非 user ID；补默认额度重复计入风险。
- 扩入观摩三表，是为了检验管理员观摩源/普通观众边界，不提前迁移策略或重做前端。
- 不引入 ETL 服务、泛化数据平台或第二套迁移器；仅纯离线清单校验，DDL 和回填继续单独门控。

### 第二轮：安全、数据、异常和回滚

- 不把当前同身份候选匹配升级为合并许可；历史 ACL、端点档案缺失和账户列表 INNER JOIN 同时标阻断。
- 不把历史 connected、consumed 配对、JWT 变成有效运行状态；V3 refresh 兼容与认证撤销规则同时保留。
- 当前 local writer 不证明全历史时区，未知 DATETIME 全部阻断 UTC 投影；禁止默认时间。
- 观摩 all 不能由空 assignments 推导为空权限，source 操作者不是管理员也不升级角色。
- 清单覆盖失败、未知 transform/gap、PK 漂移、计数漂移、未知时间未阻断时，离线校验失败；通过只证明结构/覆盖。
- 本次没有数据库修改，因此无数据回滚动作；所有 B1 备份/失败现场保留。未来补结构只追加，不修改已执行 bootstrap/001–017。

## 9. 验证与后续确认门

- 主代理复核了校验器与测试；修正 unknown 时间应按 reviewStatus 阻断（不能强制抹掉 history/active 候选处置），以及空字符串是合法 literal 默认值的校验。
- `pnpm exec vitest run` 覆盖 field-manifest 两组新增测试及既有 backup / migration / fingerprint / trade-history rehearsal 回归：**18 files / 142 tests 通过**（2026-09-05 18:06 本机时间）。其中新清单/校验器 13 tests。
- `node --check scripts/lib/v4-field-manifest.mjs` 通过；`git diff --check` 通过。
- 真实依赖证据仅为冻结镜像/目标 A 的 SELECT 元数据和脱敏聚合；测试没有连接数据库、Redis 或终端。
- 未改前后端业务代码，没有运行前端/服务端构建、实际登录、Bridge 握手、公众页面或交易链路测试；本轮不发布运行版本。

测试和静态检查不代表已经登录、连接 Bridge 或验证公众用户可见性。

**建议下一阶段：B2 首批缺口的结构与读写合同设计。** 先冻结用户补充字段、归属区间、离线账户读模型、观摩受众规则和受控历史承接；经确认再实现追加迁移及离线测试。不要直接进入 B3 回填。

2026-09-05 后续更新：[目标结构与读写合同方案](./stage-m1-b2-identity-target-contract-plan.md) 已完成两轮复审，拆为 P1–P5；下一确认门为 P1 用户补充结构和离线验证，不执行真实迁移。本文冻结字段及阻断结论保留，不能因设计完成而标记字段已经可回填。

P1 后续实施位置见 [用户状态与推荐账户结构记录](./stage-m1-b2-p1-user-state-schema-report.md)：提供 018 文件及十个旧状态/推荐字段的明确目标映射，不创建 Telegram 绑定结构。这里仍保留原冻结候选和阻断清单；新增结构文件不代表源字段已转换、安装或对账。

其后继续 B2 的模型配置/用量、策略/订阅、分析/执行/风险/复盘、商业/内容/通知等领域清单。当前 11/165 表字段覆盖只是首波；总清单还剩 154 张源表未完成精确字段审查。会员/推荐本次只覆盖 users 内字段，商业账本仍待后续核对。
