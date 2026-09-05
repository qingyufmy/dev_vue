# M1 / B2 首批目标结构与读写合同设计

> 2026-09-05；基于 `a75efa71`。状态：设计与两轮复审完成，等待分批实施确认。
>
> 原设计轮次只修改方案与路线图，没有新增/执行 SQL 迁移。后续 P1 用户状态及推荐账户的追加 SQL 文件与离线验证见 [P1 记录](./stage-m1-b2-p1-user-state-schema-report.md)；其余仍是待实施合同。没有因 P1 执行数据库/Redis/Bridge 连接、数据回填、服务启动、前端改版或交易测试，文件内容不是运行环境现状。

## 1. 输入与边界

- [首批字段评审](./stage-m1-b2-identity-account-mapping-review.md)：11 表、148 列；[冻结字段清单](./migration/m1-b2-identity-field-manifest-20260905.json) 与 [脱敏观测](./migration/m1-b2-identity-observation-20260905.json) 保持不改。
- 数据基线仍为 B1 的隔离镜像和 snapshot hash；本轮没有重新读取镜像，数据库数量结论引用上轮观测，不声称是新的现场核验。
- 当前结构：`server/db/migrations/bootstrap/v4-foundation-v1.sql`、001、002、003、013 等已执行文件。任何实现只追加新迁移，禁止改写它们。
- 当前生产者/消费者：`server/src/modules/auth`、`trading`、`bridge`、`trade-history`、`reviews`，`contracts/openapi-v4.json`，`frontend/apps/trade`。
- 权威原则：系统用户不等于交易账户；账户实体不等于当前归属；当前归属不等于历史记录的访问权；观摩不等于交易授权。

本次设计覆盖首批的用户字段、会员/推荐事实、账户关系、离线读取、观摩政策和退役状态证据。模型配置、策略/订阅、执行/复盘全字段、商业账本仍在后续 B2；不得以本方案关闭这些领域的阻断。

## 2. 结构选择：沿用主干，只分离独立生命周期

| 对象 | 处理 | 权威职责 |
| --- | --- | --- |
| `users` | 追加标量字段，不另造用户主表 | 登录身份、生命周期、验证状态、当前会员投影和基本偏好 |
| `user_referral_accounts`（新增） | 一用户一行 | 当前推荐码、推荐关系原值、可用推荐余额 |
| `trading_accounts` | 沿用，补已知账户属性/归属版本 | platform + server + login 的实体，不含用户私有别名 |
| `trading_account_ownership_intervals`（新增） | 一次归属一行 | 可追溯归属区间；开始/结束及原因 |
| `trading_account_ownerships` | 沿用当前授权投影，关联区间 | 当前 owner / observer_source 权限的快速读取 |
| `user_trading_account_settings`（新增） | 一用户一账户一行 | 别名、隐藏、账户暂停等用户态 |
| `terminal_profiles/bindings/sessions` | 沿用，禁止由缺失旧字段伪造 | 真实设备和当前路由 |
| `observer_sources`（新增） | 一观摩源一行 | 源操作者、账户、可选分析策略及配置状态 |
| `observer_channels/accesses` | 沿用并追加 | 频道受众/排序及显式授权 |
| `legacy_domain_records`（新增，和 B3 共同实施） | 仅退役事实的可查询索引 | 加密历史载荷定位和授权元数据，不承接活动会员/推荐功能 |

不添加第二套认证服务、万能属性 EAV 表、迁移常驻 Worker 或第二套交易事实库。新增表由对应域 repository 负责；跨域只调用应用端口，不从路由直接写 SQL。

以下字段除明确说明外：FK 指向现有实体；删除使用软删除/撤销；不设 CASCADE 删除用户历史。INT 用户 ID 保持现有合同，账户/区间等 BIGINT/UUID 对外用字符串；金额 DECIMAL，UTC 时间 DATETIME(3)。

## 3. 用户与会员：具体列和写入职责

### 3.1 users 追加字段

“用户补充字段”指补齐旧用户数据的目标存储和必要的并发控制，不是新增一组要求用户填写的资料。验证状态、会员来源由对应服务端用例维护；最近活跃、已读位置和资料版本由系统维护。

| 字段 | 候选类型/空值 | 写入和迁移规则 |
| --- | --- | --- |
| `email_verified`、`phone_verified` | TINYINT NULL | 保留旧 0/1/NULL；新注册显式写 0，只有验证用例置 1；NULL 视为未证明，不能当作已验证 |
| `auth_method` | VARCHAR(20) NULL | 保留来源值；表示原注册/登录方式提示，不绕过实际认证 |
| `plan_period`、`plan_source` | VARCHAR(20) NULL | 分别保留月/年/空串、paid/gift/observer_source/NULL；不推测购买事实 |
| `last_seen_at_utc` | DATETIME(3) NULL | 老 last_seen_at 经时间证据门转换；新请求通过有界异步更新，不每个 WS tick 写 users |
| `changelog_seen_version` | INT NULL | 保留原值；只由本人已读操作更新，不作为权限 |
| `profile_revision` | BIGINT UNSIGNED NOT NULL DEFAULT 1 | 新增并发控制版本，与 token_version 分开；不是伪造旧版本 |

现有 `id/uid/password/nickname/avatar/email/phone/role/token_version/deletion_status/deleted_at/plan/plan_expires_at/created_at/updated_at` 保持，不因字段缺口重命名全部调用链。`plan*` 在商业账本完成前仍由单一会员用例统一写入；禁止同时新增另一个“会员权威表”独立计算后覆盖 users。

认证流程要求：

1. 注册/改绑/找回密码的 challenge 必须新产生、单次消费、有速率/过期控制；旧 17 条 verification_codes 不复活。新增验证字段本身不代表这些接口已经完成。
2. 密码哈希逐字保留，token_version 不归零；19 个 anonymized 身份仍禁用。个人资料不能 PATCH role、会员到期、验证标记或安全版本。
3. 修改联系方式必须同事务消费 challenge、更新联系方式与验证状态、增加安全版本、登记会话撤销/审计；通知 I/O 在事务外。实际跨域锁序须在实现中统一。
4. 登录区分邮箱/手机号类型后查询，不继续用可能多行命中的 OR + LIMIT 1。归一化只用于查找键，原字符串保留；手机号不猜国家码，邮箱不擅自改写 local part。
5. 本批不贸然加邮箱/手机号唯一索引。先冻结归一化算法和已注销身份占用规则，再用最终快照做冲突门，追加对应类型的唯一查找键/索引。注册/改绑切流必须以该门和并发冲突测试为前置，不能只靠“先查不存在再 INSERT”。

本人 HTTP 资料响应为允许列表：展示名、头像、脱敏联系方式、验证状态、有效会员展示、版本。密码/hash/token、Telegram chat_id、推荐内部凭据不进入通用 Profile DTO。www/trade 各自实现设置页面，auth 只负责认证；不恢复嵌入通用用户中心。

### 3.2 Telegram 绑定不纳入新版

2026-09-05 用户明确不需要 Telegram 绑定：取消 `user_telegram_bindings` 新表设计，不实现绑定/解绑入口、绑定回调或依赖旧绑定的自动入群、邀请和通知恢复。P1 不包含 Telegram 活动结构。

旧 `users.telegram_*` 字段不因此直接删除或清空：冻结清单、备份和来源证据继续保留，后续按第 7 节退役历史证据方案逐字段承接，保留原类型、NULL、时间词法和来源，不转换为有效绑定、不重发通知。该决定不代表取消所有通知渠道；其它通知能力仍按各自需求评审。

先前字段评审与冻结清单记录的是当时的候选活动映射，保持原文件可追溯；下一版清单应据本次决定改为退役历史处置，并提供逐字段证据，不能直接解除数据保留阻断。

### 3.3 推荐与会员来源

`user_referral_accounts`：`user_id INT PK/FK`、`referral_code VARCHAR(50) NULL`、`referred_by_code VARCHAR(50) NULL`、`referral_credit DECIMAL(20,8) NOT NULL`、`revision BIGINT UNSIGNED DEFAULT 1`、`updated_at_utc DATETIME(3)`。

- referred_by_code 按旧推荐码关系保存，**不是 user ID**；推荐码唯一性、大小写等值规则未专项对账前，不靠 `CAST(... AS INT)` 或默认用户建立关系。
- 首次回填 credit 为原值，包括唯一非零用户；0 是真实 0，不能用 DEFAULT 0 遮盖漏迁。金额 API 用十进制字符串。
- 不根据当前余额制造历史佣金/支付记录。商业波次补 ledger 后，以明确的迁移期初记录和冻结来源对账，不冒称真实收入事件。
- 所有新余额变动在商业域同一短事务完成 ledger + balance + revision + outbox；禁止个人 Profile PATCH 余额。账本与余额写协议未完成前不启用推荐兑换/结算切流，仍保留旧服务能力与数据。
- 会员来源/周期保留在 users；充值/赠送/到期等副作用只在正式业务触发，不在回填时重播。连接默认额度 1 仍由既有服务计算，不再插入一份赠送额度。

## 4. 账户实体、用户态和历史区间

### 4.1 账户实体

`trading_accounts` 增加 `margin_mode VARCHAR(20) NULL` 与 `ownership_revision BIGINT UNSIGNED DEFAULT 1`；NULL margin_mode 表示未知，不能默认 netting。当前唯一身份 `(platform, broker_server, account_login)` 暂不改写。

合并前检查须使用**目标实际排序规则**和 platform，不只使用上轮 LOWER/TRIM 的候选分组。4 旧 ID → 3 候选实体尚非批准映射；多个旧 ID 映到一实体时，所有私有字段和历史引用继续保留各自来源。gateway 当前按 server/login 查 LIMIT 1 后才比 platform，实施时应把 platform 放进同一身份谓词，避免 MT4/MT5 同名路由选错；严格路由校验不因此放松。

币种保留 binding 的可信原值；多个来源冲突、未知 platform、无法证明 broker 别名时阻断，不自动设 USD、mt5 或去掉服务器后缀。server 的规范化/别名注册不在本批扩展。

### 4.2 用户账户设置

`user_trading_account_settings` 候选列：

| 字段 | 类型 | 规则 |
| --- | --- | --- |
| `user_id`、`trading_account_id` | INT、BIGINT UNSIGNED；联合 PK/FK | 一用户一实体，不共享别名 |
| `nickname` | VARCHAR(100) NULL | 原空串/NULL 保留 |
| `hidden` | TINYINT NOT NULL DEFAULT 0 | 本人列表隐藏；不删除实体、不撤销历史 |
| `connection_paused` | TINYINT NOT NULL DEFAULT 0 | 经明确的旧状态映射产生；不能从 transferred 推出永久禁止 |
| `review_status`、`observe_status` | VARCHAR(20) NULL | 保留旧状态事实，不直接等同 V4 风控审批通过 |
| `legacy_is_deleted` | TINYINT NULL | 原布尔删除标记；不伪造删除时间 |
| `observed_until_utc/identity_verified_at_utc/first_verified_at_utc` | DATETIME(3) NULL | 时间证明后派生，原值仍有 receipt |
| `anomaly_code` | VARCHAR(64) NULL | 展示/历史诊断；非自动提权依据 |
| `revision`、`updated_at_utc` | BIGINT UNSIGNED、DATETIME(3) | 用户操作并发版本及新写入审计时间 |

同一用户的多个旧 ID 合并到同一设置键且内容冲突时，生成 issue 和逐源 row receipt；先保留所有原字段，不自动“最近一条覆盖”。`hidden/connection_paused` 是新功能状态，旧→新映射必须列出状态真值表；本批原关闭状态尚未完整盘点时，不默认启用连接/自动分析/交易发送。旧 `user_bridge_settings` 的用户级开关向多账户扩展另做明确的分发规则，不在这里暗自复制成全部开启。

### 4.3 归属区间表

`trading_account_ownership_intervals`：

- `id CHAR(36) ascii_bin PK`：B3 稳定 legacy map；新业务 UUID。不得以 snapshot/当前时间作为迁移 ID 的唯一来源。
- `trading_account_id BIGINT UNSIGNED`、`user_id INT`、`role ENUM('owner','observer_source')`：均明确关系。
- `started_at_utc DATETIME(3) NOT NULL`、`ended_at_utc DATETIME(3) NULL`、`end_reason VARCHAR(64) NULL`；校验 ended >= started；区间 `[start,end)`，零长区间保留历史但不授予时间范围。
- `origin_kind ENUM('legacy','runtime')`、`origin_ref VARCHAR(191) ascii_bin`；联合唯一，定位迁移原区间或幂等业务操作；旧 274 行不能压缩覆盖。
- `created_at_utc/updated_at_utc DATETIME(3)`：区分系统登记时间与 started/ended 的业务时间，不能混称原写入时间。
- `open_owner_account_id` 可空生成列：仅 role=owner 且 ended=NULL 时取 trading_account_id，否则 NULL；UNIQUE，限制一个实体同一时刻只有一个开放 owner。observer_source 授权不冒充 owner。
- 索引：`(user_id,trading_account_id,started_at_utc,id)`、`(trading_account_id,started_at_utc,id)`；按授权范围和时间稳定游标读取，不用全表 OFFSET。

这是生成列 + 唯一索引方案，不是 MySQL 部分索引语法。MySQL 唯一索引允许多个 NULL；索引仅解决开放 owner 唯一，**不解决所有历史区间重叠**，后者仍由按账户串行事务和回填预检保障。[MySQL 8.4 索引说明](https://dev.mysql.com/doc/refman/8.4/en/create-index.html)

现 `trading_account_ownerships` 保持联合 PK，但追加 `interval_id CHAR(36) NULL`、`revision BIGINT UNSIGNED DEFAULT 1`，作为当前/最近授权投影：

- 成功回填/新写入后的活动 grant 必须引用同 user/account/role 的开放区间。追加组合唯一引用键/FK 或等效严格写入不变量时需做真实 MySQL 演练，不能只校验 id 存在。
- 新增开放 owner 唯一保护与区间表一致；撤销时关闭原 interval，更新 grant revoked；再次获得则新 interval，不重开旧 interval。
- 初期 interval_id NULL 只用于扩展阶段未转换的行；运行切换质量门要求活动行为 0 个 NULL。不能在不完整迁移状态下授权。
- 不存在账户上的“每用户只有一个 owner”唯一约束；用户可按额度同时连接多个账户，也可频繁切换。

### 4.4 三类权限的正式界限

| 使用场景 | 授权依据 | 明确禁止 |
| --- | --- | --- |
| 当前账户指标、持仓、改单/下单 | 活动 owner + 用户安全/会员状态 + 当前路由，写操作再经统一 execution/risk | 历史 owner 获得当前交易能力 |
| 本人的已发生交易/推理/复盘 | 记录自身 user_id + 原区间/来源关系；查询限制到授权记录 | 只靠“现在拥有实体”读取所有旧用户私有数据 |
| 观摩已发布实时内容 | active source/channel + 动态 audience 或显式 grant | 原始设备凭据、源操作者个人信息、私有历史、任何交易写入口 |

历史账户列表是独立 read-only 入口（候选 `GET /api/v4/trading-accounts?access=history`），可以展示本人曾经拥有/具有本人记录的账户；不能复用它作为 execution 的 ownsAccount。

新增内部端口 `AccountAccessPolicy`，明确 `canReadCurrentAccount / canReadOwnHistory / canExecute / canObservePublished`，由 trading 域实现，history/reviews/execution 调用端口。不得写一个含混的 `canAccessAccount=true` 横跨全部用途。当前 `TradeHistoryService.records → ownsAccount` 必须在该批改为历史读取授权，详情、列表、统计、下载采用同一记录范围。

还需修正历史采集归因：当前 collector 新建记录使用 route.userId，而终端可能返回前一 owner 时期的数据。必须按不可变系统来源或发生时间对应的可靠区间解析；不按采集时的连接用户给历史数据改 owner。跨归属区间的持仓、分批成交不能仅按开/平某一时间给整单授权；无法明确时保留 terminal facts 并标 unresolved，等待精确拆分/对账，不暴露给新 owner。现唯一 `(account, stable_trade_key)` 继续防止同笔交易重复计数；本批不为新旧用户各复制一份完整成交。

## 5. 离线账户合同：账户存在不依赖设备在线

### 5.1 读取顺序

1. 先按系统用户和活动 owner 读取实体/设置；账户权限记录是主体。
2. 真实绑定、档案、路由按账户选取至多一个**匹配同 user/profile/instance/epoch 的有效当前项**再 LEFT JOIN；不能多行 JOIN 导致列表重复，也不能任取 LIMIT 1。
3. 在线判定同时需要有效 lease/当前 route 及新鲜心跳。仅 disconnected_at=NULL 或旧快照存在不等于在线。无法获得可靠在线依据时返回 offline/不可交易，不展示伪“正常”。
4. 无 profile：`terminal_profile_id=null`、`terminal_instance_id=null`、`bridge_state=offline`、`trade_permission=false`，账户行照常返回。
5. 已缓存指标可展示为有 observed_at 的历史快照；从旧 owner/epoch 遗留的持仓/账户投影不可直接展示给新 owner，需 provenance 校验或隔离等待新快照。

### 5.2 必须同步的合同改动

- `contracts/openapi-v4.json`：TradingAccountSummary 和 AccountSnapshot 中 required 字段保留，但 terminal_profile_id 允许 null。Domain TypeScript、route DTO、客户端 schema 和 fixtures 同批修改，不能只在 Vue 写兜底字符串。
- 不给离线账户填空账户数据：首次无快照则 snapshot=null，报价缺失为 null；余额不填 0。列表有实体不等于实时数据已就绪。
- 当前模式可选择本人离线账户，read_only=true；不会自动进入观摩模式。用户明确进入/退出观摩；连接就绪和账户切换推送失效事件，客户端重拉 HTTP 权威快照。
- `trade_permission` 只是当前能力摘要，交易提交仍执行服务端账户/epoch/风控检查，不能信任浏览器缓存或 trading_contexts.read_only。
- 前端只改数据消费者空态/禁用态，不在本阶段重新设计页面；后续 UI 仍遵守 shadcn-vue、各应用业务隔离。

### 5.3 真实设备登记不能遗漏

当前 gateway `authorizeAndOpen` 要求 profile + binding 预先存在，所以“等待设备重新连接”本身不足以修好迁移用户的连接。

在 Bridge/auth 后续实现批中补明确的服务端 `RegisterTerminalProfileAndBinding` 用例：已验证设备凭据 + 真实安装/profile 标识 + 终端报告 + 用户/账户占用检查，登记后才允许 gateway 打开路由。开户/转移证据不足则返回需授权/冲突，不能仅凭报出 server/login 抢占其他用户账户；精确的首次认领流程沿用 Bridge 认证专项确认，不在回填里执行。

设备目录身份不等于终端数据本身的可信证明。不得伪造安装 ID、自动登录 MT、启动终端、猜当前 owner；V3 refresh 只在原用户认证链内迁移成真实 V4 档案凭据，不批量预造 V4 session。

## 6. 观摩 source、频道与动态受众

### 6.1 observer_sources 新表

| 字段 | 候选类型/规则 |
| --- | --- |
| `id` | BIGINT UNSIGNED PK；旧 source ID 经映射保留 |
| `display_name`、`notes` | VARCHAR(80)、VARCHAR(255) NULL；notes 仅管理读取 |
| `operator_user_id` | INT FK users；对应旧 bridge_user_id，不等于管理员或观众 |
| `trading_account_id` | BIGINT UNSIGNED NULL FK；未配置源保留而不可发布 |
| `analysis_strategy_id` | BIGINT UNSIGNED NULL；旧 mixed strategy 在后续策略映射确认前不直接填 |
| `status` | active/disabled 原业务状态 |
| `configuration_status` | pending/ready；新增迁移可用性状态，与原 status 分开 |
| `created_by_user_id` | INT FK users；只保存实际创建者，不用默认 admin |
| `created_at_utc`、`updated_at_utc`、`revision` | UTC 时间及并发版本 |

同源可以被多个频道引用，账户切换只修改 source。operator 可以是已有合法 pro 用户，不把历史非 admin 操作者升级为 admin；管理员权限只决定谁能管理配置。operator 的源发布能力通过受控 observer_source 授权，不自动获得 owner 交易能力。现 gateway 仅 owner 路径，若需非 owner 发布，必须单独的只读源能力路径和负向测试后开放，不能用 OR role=observer_source 放行所有交易命令。

### 6.2 observer_channels/accesses 追加

- channels 增加 `source_id BIGINT UNSIGNED NULL FK`、`slug VARCHAR(64)`、`description VARCHAR(255) NULL`、`audience ENUM('all','plus','pro','assigned')`、`is_default TINYINT`、`sort_order INT`、`updated_at_utc DATETIME(3)`、`revision BIGINT UNSIGNED DEFAULT 1`。
- slug/default 冲突必须在迁移预检列出；单一默认频道约束在同域事务中维护并测试并发设默认。新建未配置频道不能默认 active+all。
- 现 `source_trading_account_id` 暂留兼容投影，后续只由 source 配置用例同事务维护；不能让两个可独立编辑的源账户字段并存。切换到 source_id 读取前要求活动频道关联完整、投影一致；删除旧列属于另一个追加清理门。
- accesses 追加 `granted_by_user_id INT NULL`、`revision BIGINT UNSIGNED DEFAULT 1`；旧 created_by 明确保存。撤销的 grant 不参与授权。
- 受众语义保持旧规则：source/channel 可用 AND（audience=all OR audience=当前 effective plan OR 有未撤销的显式 grant）。assigned 不意味着必须匹配同名会员；pro 不自动继承 plus 频道。改变等级包含关系属于另一次产品规则变更。
- all 仍要求已认证且账户生命周期有效，不是匿名公共 API。只向授权观察者发发布内容，不向其发送源操作者私有账户/设备元数据。

### 6.3 不能只改下拉列表

复用同一个观摩政策查询于 `listObserverChannels`、`saveContext`、`readableAccount`、浏览器 realtime 订阅鉴权/重鉴权。当前 saveContext 也直接检查 accesses，只改 list 会出现“能看到但进不去”。

会员到期、grant 撤销、频道禁用、source 切换：事务增加 revision 并写 outbox；WS 撤除旧订阅/发失效，HTTP 每次重验。源用户私有数据从不进入观摩流；已发布数据也不能无限沿用旧授权。网关必须在权限版本变化或短期授权到期后拒绝旧订阅并重鉴权；source/账户/epoch 变化前后的缓冲消息不能混发。P4 实现前明确撤权传播的最长时间和故障时拒绝策略，并验证事件丢失、网关失联场景；当前不承诺分布式零延迟撤权。不得把“刷新页面后才撤权”作为安全机制。

管理 HTTP 为受限 source/channel 配置接口（不提供任意账户操作者代填）；普通用户只获得已发布频道摘要。观摩当前可看行情/发布的持仓快照，不因此读取 operator 的交易历史、推理原文、联系方式、模型配置或执行指令。

## 7. 受控历史证据与迁移清单衔接

为退役 verification、consumed pairing、旧 terminal session、旧在线心跳提供 `legacy_domain_records`，与 B3 row receipt 分工：receipt 证明每源行处置；domain record 提供受控查询入口，不能代替 receipt。

最小列：id CHAR(36)、logical_source_id、source_table（代码白名单）、source_pk_canonical/hash、record_kind（有限领域类型）、subject_user_id NULL、trading_account_id NULL、ownership_interval_id NULL、occurred_at_utc NULL、time_kind、payload_ref、payload_sha256、snapshot_id、created_at_utc；唯一 `(logical_source_id,source_table,source_pk_hash)`，hash 命中还必须比较完整规范化 PK，避免悄悄合并冲突。

- payload_ref 指向受限加密逐行载荷/包，类型、NULL、原时间词法和原字段字节保留；不是公开磁盘路径或任意 SQL 查询入口。原 encrypted dump 继续保留为恢复证据。
- 索引按 subject_user/record_kind/id 及 account/interval/id；列表不读取 payload，详情先鉴权再解密。用户/管理员两套明确读取权限；管理员访问敏感历史须有专门能力和审计，不等于所有管理员常规列表可导出验证码。
- 不提供重新消费验证码/配对、恢复 session、重发通知或执行历史命令的按钮/API。退出活动流程不等于删除原事实。
- 用户/member/推荐/观摩等仍需使用的功能不能只存此表。所有未知时间字段仍 blocked，不能用保存进历史的成功替代活动 UTC 转换成功。
- B3 真正执行前还需配置加密服务/key reference、载荷格式版本、保留/删除策略和恢复演练。没有这些就保持 G-EVIDENCE，不临时自创加密算法或明文落盘。

本设计不修改 `m1-b2-identity-field-manifest-20260905.json` 的 reviewed/blocked 结果。后续实现提供新的 manifest 版本和每个 gap 的证据，再逐项关闭；规格文字完成不等于 138 个阻断字段已可迁移。

## 8. 并发、失效和查询质量

账户认领/转移的候选短事务顺序：相关 users（ID 升序）→ trading_accounts（ID 升序）→ ownership intervals / current grants → 相关 profiles/bindings → contexts/revisions → outbox。首次实体并发创建依赖明确身份唯一键捕获冲突后重新定位，不使用 INSERT IGNORE。

- 锁住 account 主行后检查区间重叠与开放 owner；关闭旧区间、创建新区间、撤销旧当前 grant、更新 ownership_revision 同事务提交。停止旧路由/通知在提交后的 outbox 消费者执行，旧 epoch 即时在服务端授权检查中失效，不能依赖消息及时到达。
- 迁移批次与正常业务写入分离；迁移只向隔离目标、来源固定、每批 business + ID map + receipt + checkpoint 原子提交。DDL 仍单独运行，不放业务事务。
- 修改系统用户/安全版本、设备解绑、账户转移、执行 preflight、历史采集的既有锁序必须共同审查。上述顺序是待统一约定，不声称现在所有 repository 已遵守。
- 禁止事务内等模型、网络、Redis 或 Bridge 回复。死锁只对完整幂等事务有界重试；提交结果未知先查 operation/receipt，不当成失败重做。
- 查询使用用户/账户/区间范围和覆盖索引；真实依赖阶段对空/常规/多归属大样本执行 EXPLAIN 与受控耗时测试。不能只根据有索引就宣称查询已经优化。

不承诺“永无死锁”。短事务、一致锁序、合适索引及可恢复的重试能降低风险；这也与 MySQL 官方建议一致。[MySQL 死锁处理](https://dev.mysql.com/doc/refman/8.4/en/innodb-deadlocks-handling.html)

## 9. 分批实施顺序与验收

每批开始前说明范围并确认。编号为工作包，不预占迁移文件序号；实施时使用 017 之后实际最新可用序号。

| 批次 | 实施范围 | 完成门 | 不包含 |
| --- | --- | --- | --- |
| P1 | users 标量追加、推荐账户结构、离线 schema 测试、来源映射补充 | 原字段类型/精度/NULL 逐项承接；无伪造会员/余额；migration checksum/干净安装检查 | Telegram 绑定、真实 DDL、支付/通知、认证切换、完整商业 ledger |
| P2 | 归属区间/用户账户设置/授权投影及 AccountAccessPolicy 合同与测试 | 重复转入转出不覆盖；本人历史可读；他人私有历史/当前交易不可读 | 原库数据合并、终端操作 |
| P3 | 离线账户查询、nullable DTO/客户端；历史入口和采集归属 guard | 无 profile 仍可见；不靠最新连接用户重分历史；列表无重复、无假在线 | 新 UI 设计、真实执行测试 |
| P4 | source/channel/accesses 结构、统一观摩鉴权、失效合同 | all/等级/显式授权四类真值表；列表/进入/HTTP/WS 一致；禁用传播有界且失败关闭 | 任意授予操作者交易权 |
| P5 | 与 Bridge 专项合并完成真实设备登记和只读发布能力；B3 历史证据适配 | 不伪造 profile；刷新兼容/撤销保留；模拟跨账户攻击失败 | 未获许可的实机连接/交易、安装器发布 |
| 后续 B2 | 模型/策略/执行/复盘/商业等剩余字段与时间证明 | 完整领域映射与全部活动功能承接 | 未确认的 B3 回填、切流、删表 |

最低负向/并发样例：

1. NULL verified 不提升；anonymized 禁登录；原密码和安全版本不重置。
2. 两请求并发绑定同联系方式只允许一方成功，失败不消费另一请求的 challenge；非法会员修改拒绝。
3. 推荐小数精度/大额/零和 NULL 区分；重复迁移/重复财务事件不重复加余额。
4. owner A→B→A 三个区间全部存在；关闭边界、同一时间交接、重复幂等、并发抢占、重叠区间被阻断。
5. owner A 可查本人的旧交易但不能查 B 的；B 新采集 A 的历史不改成 B；跨区间整单不泄漏或重复统计。
6. 离线无 profile、有多个历史 binding、过期心跳、旧 epoch 快照四类不丢账户、不重复、不授权交易。
7. MT4/MT5 同 server/login 精确分流；不匹配 platform/instance/epoch 拒绝。
8. all/plus/pro/assigned、显式 grant、会员到期、source disabled/pending、频道撤销，HTTP 与 WS 同一结论。
9. 旧 refresh 不按兼容 expires_at 自行失效，但撤销/用户失效不能绕过；新设备不靠伪造安装标识通过。
10. scope/字段遗漏、unknown 时间、hash/来源漂移、DDL 中断、事务提交未知均停止或走专门恢复，不清空 A/B。

每批报告必须分开：本地测试、真实 MySQL schema 演练、业务回填对账、应用/WS 验收、终端只读、模拟账户交易。当前 MT5 为真实使用账户，交易指令实测仍禁止，不能把用户以前模拟账户许可挪用到当前。

## 10. 两轮复审记录

### 第一轮：需求覆盖、职责和复杂度

- 去掉“重建用户中心/新会员主表”的冲动，保留现有身份和会员读取合同，仅分离独立生命周期的推荐和账户设置。根据用户补充决定移除 Telegram 绑定，不为已取消功能建设活动结构。
- 归属区间不是另一份交易记录；区间负责授权和来源，交易事实仍由现有 history/execution 域管理。
- 发现 source/channel 默认值和 audience 缺口，使用动态受众，不给全部现有用户批量制造 grant。
- 离线显示不需要改 Bridge 传输协议，但真实 profile 首次登记确实缺流程，单独列入 P5，避免误以为重连自然解决。
- 设计阶段不生成几百行未经演练的 SQL，也不把 11 表首波扩大成 165 表全量实施。

### 第二轮：安全、数据、并发、兼容与回滚

- 补发现历史列表仍要求当前 owner、collector 使用采集者归属：P2/P3 必须同时处理，不能只允许旧 owner 进列表而新采集仍串号。
- 观摩政策不只在列表使用，必须同步 context 写入、HTTP 数据读取和 WS 鉴权；明示只读 source 不能从 owner gateway 漏到写命令。
- 将个人设置 hidden、旧账户 is_deleted、归属撤销、终端离线分开；任何一种都不能抹掉旧历史或伪造删除时刻。
- 开放 owner 唯一和任意历史区间不重叠分开保证；不把 generated UNIQUE 当完整时间区间约束。
- 时间、联系方式唯一规则、稳定身份合并、余额期初和加密证据仍有独立质量门；不把候选 target 写入存在性当成功。
- 追加列扩展阶段旧读取可继续；新读写启用前全量验收。新数据写入后不允许简单切旧库回滚；需冻结新增事实并对账。schema 回退不 DROP 新表或清空数据，保留现场。

## 11. 当前交付与下一确认门

原设计轮次交付是该方案及路线图更新。该轮清单校验 `tests/v4-field-manifest.test.js` 与 `tests/v4-field-manifest-artifact.test.js` 共 2 files / 13 tests 通过；4 份相关文档的 65 处本地链接存在性检查通过，`git diff --check` 通过。没有业务代码改动，不运行应用构建；没有连接服务器或执行任何迁移。离线清单测试不验证本方案尚未实现的 SQL、API 或权限行为。

补充需求复审：第一轮确认 Telegram 绑定不再属于活动功能，避免为已取消需求建表；第二轮确认取消功能不等于删除旧数据，保留冻结证据及后续逐字段历史处置门，不复活旧绑定或通知。本次修订仅改文档。

用户随后已确认 P1（不含 Telegram 绑定），本批交付范围为追加 018 文件和离线测试；最终验证及下一确认门以 [P1 记录](./stage-m1-b2-p1-user-state-schema-report.md) 为准。不改运行库，不启用认证、财务或通知写入；后续 P2 仍需另行确认。
