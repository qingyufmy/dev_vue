# 数据库规范化与全量数据迁移方案

> 2026-09-06 全面规范化接续方案：[数据库结构优化与全面规范化实施方案](database-standardization-execution-plan-20260906.md)。原始观测和历史设计保留；新实施以实际结构复核、全量字段合同及追加迁移为准。

> 状态：阶段 7 历史设计基线；2026-09-05 已完成 M1 双库结构演练，尚未回填旧数据。
>
> 最新执行依据：[M1 源备份、字段映射与回填对账方案](./stage-m1-data-backfill-and-reconciliation-plan.md)。本文的逻辑实体候选不等于当前已建物理表。
>
> 版本：1.1
>
> 日期：2026-09-02
>
> 适用范围：主站、AI 交易实验室、管理后台、统一认证、量见智桥服务端

## 1. 目标与边界

本轮数据库重构的目标不是把现有 165 张表原样搬到新目录，而是在完整保留现有用户和业务数据的前提下，建立一套可长期迭代的 MySQL 8.4 数据结构。

必须达到：

- 一个业务事实只有一个权威存储位置，避免同一状态散落在多张表或 JSON 中。
- 表、字段、主键、外键、索引、时间、金额、状态和迁移文件使用统一规范。
- 主站、AI 交易实验室、管理后台、认证和 Bridge 按业务域访问数据，禁止路由层到处散落 SQL。
- 高频查询有明确索引和执行计划预算；摘要接口不读取大字段，实时通道不重复传输完整快照。
- 事务尽可能短、锁定顺序固定、外部调用不进入事务，并能对可安全重试的死锁做有界恢复。
- 迁移可中断、可继续、可核对、可回滚；没有逐用户和逐业务对账证据时不得删除旧结构。
- 数据库统一存储 UTC；主站和管理后台显示北京时间，AI 交易实验室按对应终端的已校准服务器时区显示。

以下事项不在本方案中直接执行：

- 不修改当前 `dev_vue` 中的任何表、字段、索引或数据。
- 不删除任何旧表或历史数据。
- 不把数据库拆成微服务，也不为了“规范化”引入复杂分布式事务。
- 不承诺数据库永远不会产生死锁。MySQL 官方也将死锁视为并发系统中需要预防、检测和安全恢复的正常情况；本项目的验收目标是消除已知反向锁序、降低发生概率、完整记录并对幂等事务安全重试。

## 2. 当前 `dev_vue` 只读基线

审计时间：2026-09-02。所有检查均为元数据、聚合统计或 `EXPLAIN`，未执行 DDL、DML、`ANALYZE TABLE` 或迁移。

### 2.1 环境与规模

| 项目 | 已验证结果 |
| --- | --- |
| 数据库 | `dev_vue` |
| MySQL | 8.4.8 |
| 存储引擎 | 165 张表全部为 InnoDB |
| 估算行数 | 约 26.6 万行 |
| 估算体积 | 约 682.5 MB |
| 缺少主键的表 | 0 |
| 当前隔离级别 | `REPEATABLE READ` |
| 应用数据库时区 | `mysql2` 与连接初始化均固定为 `+08:00`，不符合新版 UTC 要求 |
| 数据库默认排序规则 | `utf8mb4_general_ci` |
| 实际表排序规则 | 159 张 `utf8mb4_0900_ai_ci`，6 张 `utf8mb4_general_ci` |
| 外键 | 5 个 |
| `_id` 形态字段 | 452 个，其中只有 5 个由外键约束 |
| JSON 形态存储 | 141 个 JSON 命名的文本字段，4 个原生 JSON 字段 |
| 时间字段 | 405 个 `DATETIME`、1 个 `TIMESTAMP`、10 个 `DATE` |

外键数量少不自动等于数据错误；审计、日志、外部协议 ID 和可保留的历史快照可以有意使用软引用。但用户、交易账户、策略、订阅、订单、风控和复盘等强一致关系需要逐项决定是数据库外键、唯一约束还是显式软引用，不能继续默认全部依赖应用代码。

### 2.2 数据完整性抽查

以下已抽查的核心强关系在当前备份中未发现孤儿记录：

- `trading_accounts.user_id -> users.id`
- `mt5_account_bindings.current_user_id -> users.id`
- `mt5_account_bindings.current_trading_account_id -> trading_accounts.id`
- `strategy_subscriptions -> users / auto_prompt_types / trading_accounts`
- `inference_snapshots -> ai_signals / auto_prompt_types`
- `auto_signal_deliveries -> ai_signals / users`
- `order_intents -> users / trading_accounts`
- `risk_decisions -> order_intents`
- `signal_outcomes -> order_intents`
- `trade_review_cases -> signal_outcomes`

另有两类不能用删除处理的数据异常：

- `ai_signals` 有 1,015 条 `user_id=0`，这是旧版平台分析伪用户语义，不是真实用户孤儿。目标结构改为平台 scope + 可空 owner，不创建 ID 0 用户，也不删除信号。
- `notifications` 有 4 条记录引用当前不存在的用户。目标保留消息事实与旧收件人 ID，强关系置空并停止再投递。

交易账户身份抽查发现一个“同一经纪商服务器 + 登录账号”对应两条未物理删除记录的分组，`observe_status` 分别为 `transferred` 和 `active`，涉及两个系统用户。旧归属行仍被 2 条订阅和 216 条订单意图引用，当前归属行被 1 条订阅和 11 条订单意图引用，因此既不能当作普通重复行删除，也不能继续保留两个账户实体。新版将两行映射为一个权威交易账户，通过归属历史和 legacy ID map 保留全部引用，旧用户订阅转为所有权已转移的非活动历史。

### 2.3 大字段和带宽风险

当前数据库体积主要由少量宽表的大型文本快照构成：

| 表.字段 | 行数 | 平均字节 | 最大字节 | 聚合体积 |
| --- | ---: | ---: | ---: | ---: |
| `ai_signals.market_data_json` | 1,764 | 76,036 | 206,148 | 127.91 MB |
| `inference_snapshots.klines_json` | 789 | 146,698 | 258,840 | 110.38 MB |
| `trade_review_cases.evidence_json` | 155 | 511,925 | 1,365,440 | 75.67 MB |
| `inference_snapshots.user_prompt` | 789 | 72,214 | 97,732 | 54.34 MB |
| `inference_snapshots.market_snapshot_json` | 789 | 54,958 | 98,991 | 41.35 MB |
| `inference_snapshots.system_prompt` | 789 | 32,266 | 60,788 | 24.28 MB |
| `period_review_cases.evidence_json` | 25 | 822,071 | 9,668,320 | 19.60 MB |

源码静态扫描发现约 381 处 `SELECT *` 和 24 处 OFFSET 分页。并非每一处都有性能问题，但在 `ai_signals`、`trade_review_cases` 等宽表上直接 `SELECT *` 会把列表、状态读取和 WebSocket 响应不需要的大字段一起加载，违背前端低带宽要求。

新版将摘要、状态、详情和证据载荷分层：

- 列表与实时事件只读取稳定摘要列。
- 详情按 ID 精确获取。
- K 线、提示词、市场快照和复盘证据进入独立的一对一载荷表，记录编码、压缩方式、字节数和 SHA-256。
- 载荷表不能被通用列表仓储或实时广播默认连接。
- 历史大载荷先保留原值迁移，压缩与归档另设可回滚的数据迁移，不在结构切换时同时改变语义。

### 2.4 查询计划抽查

当前只读 `EXPLAIN` 得到：

- 用户最近 AI 信号使用 `idx_ai_signals_user_created`，可反向索引扫描，方向正确。
- 模型任务事件按 `task_id + id` 查询使用 `idx_model_event_task`，方向正确。
- 用户交易审计按 `user_id`、`created_at_utc_msc DESC`、`id DESC` 查询时，虽然使用现有索引，但估算扫描约 3,809 行且出现 `Using filesort`。现有索引把可空的 `trading_account_id` 放在时间前，不适合“不指定交易账户”的用户查询。
- K 线按 `source_id + standard_symbol + timeframe + open_time_utc_msc` 查询时，优化器选择了另一条以 `broker_symbol` 为第二列的唯一索引，估算扫描约 17,748 行并出现 `Using filesort`；强制正确查找索引后为 range scan 且无需 filesort。实施前需在副本上刷新统计并复核真实参数，不能直接靠 `FORCE INDEX` 掩盖索引或统计问题。

索引调整必须由真实接口查询和 `EXPLAIN FORMAT=JSON` 驱动，不按字段名批量加索引。MySQL 官方也明确指出多余索引会增加写入和优化器成本。

### 2.5 迁移体系现状

- 当前源码 `server/migrations.js` 约 7,148 行，包含 198 个当前迁移定义。
- `dev_vue.schema_migrations` 有 214 条记录；当前源码中的 198 个迁移都已记录为执行，另有 16 个早期历史迁移 ID 已不在源码中。
- 迁移表只有 `id` 和 `applied_at`，没有名称、校验和、执行耗时、应用版本和状态。
- 迁移按 ID 跳过，但无法检测“同一个 ID 的内容被修改”或“数据库执行过仓库已经丢失的迁移正文”。
- MySQL 8.4 支持单条原子 DDL，但 DDL 仍会隐式提交，不是可与多条数据变更一起回滚的事务。现有“执行多条语句后再记录 ID”的迁移可能处于部分完成状态，只能依赖每条迁移自行幂等恢复。
- 现有 GET_LOCK 能避免多个实例同时跑迁移，应保留其单实例保护语义。

### 2.6 并发和死锁基线

- InnoDB 死锁检测已开启，锁等待超时为 50 秒。
- 当前通用 `withTransaction()` 只负责 begin/commit/rollback，没有统一事务名称、隔离级别、耗时、锁等待或安全重试策略。
- 账户身份同步已经针对幂等事务实现了有限死锁重试，这是应保留的正确边界；不能把它扩展成“所有错误自动重试”。
- 关键交易代码已把 Bridge/终端网络调用放在数据库事务之外，应继续作为硬规则。
- 仍存在一次锁住某用户全部 `trading_accounts`、跨多表更新归属的长事务；它需要固定排序、唯一身份行先行锁定和并发测试，不能只依赖重试。
- 当前应用账号无权读取 `INNODB_TRX`、`data_lock_waits`、语句摘要或 `INNODB_METRICS`，因此本次无法验证历史死锁次数、实际锁等待和慢 SQL 排名。应用账号不应获得 PROCESS 权限；需要单独的只读运维监控账号或由数据库平台导出聚合指标。

## 3. 目标数据架构

### 3.1 总体原则

采用单个 MySQL 集群、按业务域组织表和仓储模块，不拆微服务。核心事务事实规范化，读多写少且明确可重建的摘要允许使用投影表。

```text
HTTP / WebSocket / Jobs
          |
       Service
          |
 Domain Repository + named query
          |
  mysql2 pool / transaction / migration
          |
       MySQL 8.4
```

- 路由、WebSocket 消息处理器和 Vue BFF 不直接写 SQL。
- Service 决定业务事务边界，Repository 只负责本业务域查询。
- 跨域读取通过明确的 Service 或只读查询模块，不通过深层导入另一个模块的表实现。
- 不引入第二套数据库或分布式事务；Redis 只做可丢失的缓存、锁和实时协调，MySQL 仍是业务事实来源。

### 3.2 业务域与权威实体

| 业务域 | 权威实体 | 设计重点 |
| --- | --- | --- |
| 身份与认证 | users、auth_sessions、auth_authorization_codes | 与 SSO 方案一致；首版不为单一密码体系额外拆 credentials 表，应用会话不混入用户表 |
| 用户资料与会员 | user_profiles、memberships、membership_events | 当前套餐与到期时间可快速读取，变更历史独立保留 |
| 内容与社区 | courses、course_resources、enrollments、progress、posts、comments、assets | 保留现有课程和社区数据，关系字段规范化 |
| 商业与支付 | products/plans、payment_orders、payment_transactions、payment_matches、membership_activations、entitlement_grants、referrals | USDT TRC20 共享收款地址、金额差和时间窗匹配语义保持不变；会员和 Bridge 并发连接额度均由幂等权益事件生效 |
| 终端与交易账户 | terminal_instances、terminal_profiles、trading_accounts、trading_account_ownerships、terminal_bindings、bridge_connection_sessions、terminal_clock_calibrations | 交易账户以平台 + 标准化经纪商服务器 + 登录账号唯一；档案可新增/删除/更换；当前账户 WebSocket 用带 TTL 的实时 lease 计数 |
| 策略与订阅 | strategies、strategy_versions、strategy_subscriptions、subscription_schedules | 策略正文版本化；用户接收信号时间与策略实际运行时间分离 |
| 分析与模型 | model_profiles、analysis_tasks、analysis_attempts、analysis_events、signals、signal_payloads、inference_snapshots、snapshot_payloads | 系统用户是分析记录归属；MT 账号只作为交易上下文；摘要与大载荷分离 |
| 交易执行 | signal_deliveries、order_intents、risk_decisions、risk_reservations、bridge_commands、trade_outcomes | durable ID 全链路关联；唯一幂等键；不确定结果禁止自动重发 |
| 风控 | risk_policies、risk_policy_versions、account_risk_states、risk_state_events | 当前状态与不可变事件分开；每次修改带 revision |
| 复盘与记忆 | trade_review_cases、period_review_cases、review_versions、review_evidence、strategy_memory_libraries、memory_revisions | 每策略一个权威记忆库；人工确认后才能沉淀 |
| 审计与通知 | audit_events、trade_audit_events、notification_events | 追加写、明确保留周期；删除用户后仍保留必要的非敏感审计快照 |

这张表是逻辑边界，不代表立即新建每个名称。正式 DDL 前必须完成“现表 -> 目标表/字段 -> 转换规则 -> 对账规则 -> 删除条件”的逐表矩阵；能保持干净且语义一致的现表直接保留，不为改名而迁移。

### 3.3 交易账户身份模型

新版不再把 `user_id` 作为交易账户实体的一部分：

```text
trading_accounts
  id
  platform                 # mt4 | mt5
  broker_server_key
  login_account
  ...
  UNIQUE(platform, broker_server_key, login_account)

trading_account_ownerships
  trading_account_id
  user_id
  terminal_instance_id
  authority                # trade | readonly
  started_at
  ended_at
  end_reason
  current_owner_key        # 仅当前有效归属生成值唯一
```

- 当前账户接管、只读登录不得接管、管理员观摩源例外等规则继续由服务层执行。
- 数据库唯一约束保证同一交易账户最多一个当前可交易归属。
- 历史信号、订单、成交、复盘始终引用稳定 `trading_account_id`，用户切换不会截断交易账户自身历史。
- 系统用户是分析记录和订阅的归属；不得按 MT 登录账号重新分类分析记录。
- Bridge 并发连接额度按系统用户跨安装实例计算，MT4/MT5 共用；只统计当前有效账户 WebSocket lease。离线档案和历史账户不占额度，同一逻辑连接或稳定账户重连接管不重复计数。
- 策略订阅必须显式引用 `trading_account_id`，不同账户可以使用不同策略、运行时段和风险配置，不建立用户级唯一活动订阅约束。
- Bridge 本地删除或更换档案只结束当前 WebSocket/route 并清理可重建本地缓存，不物理删除服务器交易账户、归属历史、订阅历史或交易证据。详细语义见 [Bridge 并发连接额度与账户级策略订阅模型](./bridge-connection-quota-and-account-subscription-model.md)。

### 3.4 字段与类型规范

- 表名、字段名使用 `snake_case`，表名统一复数。
- 关系键统一 `<entity>_id`；外部协议标识使用清楚名称，如 `command_id`、`ticket`、`provider_request_id`。
- 现有用户 ID 和核心业务 ID 迁移时原值保留；新建高频事件表默认使用 `BIGINT UNSIGNED` 自增主键。
- 金额、价格、手数和风险金额使用明确精度的 `DECIMAL`，禁止新增 `DOUBLE` 保存需要精确比较的交易数值。由 MT 原始浮点转换时按品种 digits、volume step 和原始字符串核对。
- 布尔值使用 `TINYINT(1) NOT NULL`；状态由数据库约束与应用合同共同校验。当前已执行 SQL 的稳定 ENUM 保留，新增状态须追加迁移并同步合同，不为符合早期类型偏好重写历史 SQL。
- 新时间列使用 `DATETIME(3)` 并按 UTC 写入；会话统一 `time_zone = '+00:00'`。终端业务时间不直接替代 UTC，只保存 `observed_at_utc`、`timezone_offset_minutes`、校准状态和来源。
- 原生结构化数据优先使用 MySQL JSON；需要 `gzip-base64` 或其它编码的大载荷使用 `LONGTEXT/LONGBLOB + encoding + sha256 + byte_size`，不能伪装成原生 JSON。
- 可搜索、可关联、可排序的业务字段不得只存在 JSON 中。
- 所有可并发编辑的配置表增加 `revision BIGINT NOT NULL`，更新使用 compare-and-swap。
- 所有表明确 `created_at`、`updated_at` 是否需要；不可变事件只需要发生时间，不机械增加无用字段。

### 3.5 外键与删除策略

- 用户、交易账户、策略、订阅、订单、风险决策、复盘等同库强关系优先使用外键。
- 财务、交易、审计和模型证据禁止级联物理删除；使用 `RESTRICT`、`SET NULL` 或身份墓碑。
- 只对纯从属且可随父记录删除的数据使用 `ON DELETE CASCADE`。
- Bridge 外部票号、供应商请求 ID、幂等键和历史审计引用使用软引用，并写明原因。
- 用户删除继续采用状态和墓碑流程；不得为了通过外键而抹掉交易、支付或审计证据。

## 4. 查询与带宽规范

### 4.1 查询规则

- 新代码禁止 `SELECT *`；Repository 为每个用途声明字段投影。
- 列表、摘要、实时事件、导出和详情使用不同查询，不复用“万能详情 SQL”。
- 大列表使用基于稳定唯一排序键的 keyset/cursor 分页；后台小型固定集合才允许 OFFSET。
- 复合索引按实际 `WHERE` 等值条件、范围条件和排序顺序设计；不为每个字段单独加索引。
- 所有上线查询都要保存 query name、执行时间、返回行数和错误码；慢查询日志只记录归一化摘要，禁止记录密码、Token、模型密钥和完整提示词。
- 删除索引先在测试环境设为 INVISIBLE，观察执行计划和慢查询，再决定物理删除。
- 禁止前端为了本地筛选拉取完整历史；服务端提供精确字段、筛选、排序、游标和聚合。

### 4.2 首批必须复核的索引

以下是审计候选，不是本轮直接执行的 DDL：

1. `trade_audit_logs(user_id, created_at_utc_msc DESC, id DESC)`：覆盖不指定账户的用户最近审计查询。
2. `trade_audit_logs(user_id, trading_account_id, created_at_utc_msc DESC, id DESC)`：保留账户级查询时复核是否需要与第一条并存。
3. `market_candles(source_id, standard_symbol, timeframe, open_time_utc_msc)`：检查统计信息、列定义和真实生产参数为何未被优化器选择；仅在解释清楚后调整。
4. 高频任务/事件、Bridge ledger 和模型容量队列：按 worker claim 查询确认 `status + scheduled/deadline + id` 的索引和锁读取完全一致。
5. 所有新增外键列必须有匹配索引；所有唯一幂等键必须由数据库唯一约束保证。

### 4.3 执行计划质量门

每个核心接口建立固定的 `EXPLAIN FORMAT=JSON` 快照和数据量级：

- 关键点查找不得退化为全表扫描。
- 用户、账户和策略列表的估算扫描行数应与返回页大小同量级。
- 排序查询不得无理由出现 `Using filesort`；可接受时必须记录数据上限和基准耗时。
- 不允许 `Using temporary`、不受控笛卡尔积或对大表进行前导 `%keyword%` 搜索。
- 任何索引变更同时验证写入成本、磁盘占用和至少一个真实查询计划。

## 5. 事务与死锁治理

### 5.1 固定锁顺序

全项目统一以下顺序；无需的层级直接跳过，不得反向：

```text
users
  -> terminal_instances / trading_accounts / ownerships
  -> strategies / subscriptions
  -> order_intents
  -> risk_account_states / risk_reservations / risk_decisions
  -> deliveries / outcomes / reviews
  -> append-only audit events
```

- 锁多行前必须按主键升序取得确定集合，再按相同顺序锁定或更新。
- `FOR UPDATE` 必须使用唯一键或有界索引范围；禁止无索引条件锁表扫描。
- 队列 worker 可对已证明可独立处理的任务使用 `FOR UPDATE SKIP LOCKED`；普通业务读取禁止使用它，因为它返回不一致视图。
- 全局风控开关等单例锁需要在账户状态之前统一获取，所有入口保持相同顺序。

### 5.2 事务时长

事务内禁止：

- Bridge、MT4/MT5、模型、邮件、短信、区块链、对象存储和其它网络调用。
- 无界循环、压缩大载荷、生成报告、等待定时器或用户确认。
- 大批量迁移或一次性更新全部用户。

外部调用使用“短事务准备 -> 外部调用 -> 短事务确认”的状态机和幂等键；结果不确定时进入 `uncertain`，不得自动重复下单。

### 5.3 安全重试

- 只有整个事务可证明幂等，或所有副作用均由唯一键保护时，才允许重试 MySQL 1213 / SQLSTATE 40001。
- 重试整个事务，不只重试失败语句；使用 2 至 3 次有界指数退避和抖动。
- 1205 锁等待超时默认不与 1213 等同处理；先确认服务器 `innodb_rollback_on_timeout` 和事务幂等边界。
- 交易命令已经离开数据库并可能到达终端后，数据库错误不得触发再次发送命令。
- 每次重试记录 transaction name、attempt、elapsed、MySQL code 和关联 ID，不记录敏感正文。

### 5.4 隔离级别

当前 `REPEATABLE READ` 不直接全局改为 `READ COMMITTED`。实施时分两类验证：

- 订单、账户接管、风控和支付等显式锁定事务，先证明唯一索引和锁序；必要时按事务设置隔离级别。
- 报表、列表和 worker 队列在副本上比较 `READ COMMITTED` 的锁范围、结果语义和 binlog 配置。

只有并发测试、复制配置和业务一致性全部通过后才调整默认值。`READ COMMITTED` 会减少大多数 gap lock，但不能消灭死锁。

## 6. 新迁移体系

### 6.1 文件结构

停止继续向单个 `server/migrations.js` 追加。当前已落地结构（不再采用早期 JS migration 目录草图）：

```text
server/db/migrations/
  bootstrap/v4-foundation-v1.sql
  20260903_001_bridge_v4_device_sessions.sql
  ...                             # 001～017，已执行文件不可变
  20260905_017_economic_calendar.sql
  corrections/011-execution-intent-foreign-keys.sql
scripts/migrate-v4-schema.mjs      # 显式 CLI，非应用启动钩子
scripts/lib/v4-*.mjs              # 清单、执行、审计与恢复模块
server/src/modules/*/infrastructure/ # 领域 Repository
```

迁移文件一经在任何共享环境执行不得修改，只能新增纠正迁移。

公网目前运行旧版结构，因此迁移目录不是临时开发脚本，而是 V4 发布物的一部分：

- 必须保留已识别的旧 `schema_migrations` 版本到 V4 的连续升级路径，不能把最终结构压成只适用于空库的单一 baseline。
- 旧 `server/migrations.js` 的正文不再继续修改，但其历史 ID、执行事实和必要转换规则必须通过只读归档或版本映射保留；不得因删除旧后端代码而丢失迁移来源。
- legacy ID map、分块回填 checkpoint、失败重试状态和对账结果必须由正式迁移工具持久化，不能依赖开发者本地文件或手工 SQL。
- 已发布迁移禁止删除、重排、改名或修改 checksum。错误只能通过新的前向纠正迁移处理。
- 空库安装可以使用经过校验的 schema snapshot 加速，但仍须记录等价版本并保留完整历史升级链；snapshot 不能替代公网升级测试。

### 6.2 迁移记录

当前新版 `schema_migrations` 记录：

- `id`
- `checksum_sha256`
- `execution_id`
- `status`
- `statement_count` / `completed_statements`
- `started_at_utc` / `completed_at_utc`
- `error_code`

追加 `schema_migration_events` 保存恢复授权、原失败现场与纠正产物 hash。旧库 214 条迁移事实另行完整保留，不作为 V4 SQL 已执行记录，不补造旧正文 checksum。数据回填 run、ID map、receipt 与 checkpoint 尚待独立实现。

显式运行迁移 CLI 时：

- 数据库存在仓库未知版本：失败关闭并提示先同步代码。
- 同版本校验和不同：失败关闭，禁止继续。
- 迁移顺序缺口或重复：失败关闭。
- 继续使用数据库级 advisory lock，避免并发迁移。

结构和数据迁移均不能随应用/PM2 启动自动执行。结构由受控 CLI 执行；大数据迁移由另一个显式命令运行并记录 checkpoint。

### 6.3 DDL 安全

- 每个 ALTER 明确预估表大小、算法、锁级别、额外磁盘和回滚方式。
- 能用 `ALGORITHM=INSTANT` 的操作显式要求 INSTANT；否则评估 INPLACE/LOCK=NONE。禁止无评估回退到 COPY。
- DDL 与数据回填分开，因为 MySQL 的原子 DDL 仍会隐式提交。
- 新唯一约束和外键先执行重复/孤儿预检；预检不通过则停止，不以删除数据“修复”。

## 7. 不丢数据的迁移路径

2026-09-06 用户再次明确最终交付：公网结构以 `dev_xin` 为基线，重构完成后必须能在现有公网服务器覆盖升级且既有数据不丢失。空库安装或 Bridge 联调库不能替代旧数据升级。经用户授权 SSH 只读核验，`dev_vue` 与 `dev_xin` 有效结构一致（165 表、2,598 字段、570 索引、214 条旧迁移 ID）；4 表建表 SQL 仅显式字符集声明写法不同，字段元数据无差异。结构一致不代表业务数据一致或迁移已完成。现有安装器与全量升级之间的缺口、验收门及后续步骤见 [公网升级兼容核查](migration/public-upgrade-compatibility-review-20260906.md)。

### 7.1 总策略

当前 `dev_vue` 是从测试虚拟机备份导入的迁移源。当前操作只读，但不能把本轮计数观测等同于持久化冻结；须经新备份和恢复源镜像固定回填输入，不在原表上重写。

开发期采用旁路目标库：

```text
dev_vue                  # 迁移源，只读保留
dev_vue_m1_a             # 已批准并完成结构安装，保留审计
dev_vue_m1_b             # 已批准并完成结构安装，保留审计
dev_vue_m1_source_20260905_01 # 建议的恢复源镜像，尚未批准/创建
```

新恢复源镜像和受限备份路径须单独确认。正式回填前生成可恢复备份，记录 hash、版本和快照来源；A/B 共用同一恢复源。

旁路迁移的收益：

- 任一转换失败不污染源库。
- 可以逐表比较用户、账户、策略、信号、订单、复盘和支付数据。
- 使用同一冻结源在独立 A/B 目标验证确定性与幂等；保留失败现场，不自行清空目标库。
- 前后端可以通过独立配置切换，不需要在旧表和新表之间长期双写。

正式上线时使用维护窗口完成最后增量或重新从停写快照迁移；本项目本地阶段不需要提前实现复杂双写。

切流后若产生新写入，不能仅切回旧连接；必须先冻结新增事实并逆向对账，终端成交也不能通过恢复旧库撤销。具体门禁以最新 M1 方案为准。

### 7.2 阶段

1. **冻结清单**：导出 165 张表的 DDL、行数、主键范围、索引、约束、数据体积和用途。
2. **逐表映射**：执行已冻结的[数据库逐表迁移矩阵](./database-table-migration-matrix.md)，为每张现表落实 `保留`、`重塑`、`合并`、`拆分`、`归档` 或 `候选删除` 以及字段转换。
3. **源库校验**：检查孤儿、重复身份、非法状态、无效 JSON、时间范围、金额精度和空值；只报告，不静默修复。
4. **建立目标结构**：仅在目标库运行带校验和的新迁移。
5. **按主键分块回填**：每批提交并记录 `last_source_pk`、源数量、目标数量、错误数量和哈希。
6. **逐用户对账**：按系统用户核对会员、交易账户归属、策略、订阅、信号、交付、订单、成交、复盘、记忆、支付和通知。
7. **全局对账**：核对总数、唯一键、外键、金额总和、状态分布、最早/最晚时间和大载荷 SHA-256。
8. **应用验收**：新 API、WebSocket、Jobs 和 Bridge 在目标库完成真实功能回归和并发测试。
9. **切换演练**：记录停写、最终增量、配置切换、健康检查和回滚耗时。
10. **正式切换**：只有所有门通过才让应用连接新库；源库保持只读回滚窗口。
11. **清理旧结构**：用户确认稳定、备份可恢复且回滚窗口结束后，另立删除清单和迁移；禁止与首次切换同批执行。

旧前端和旧业务代码可以在 V4 工程开始时从 `dev_vue` 清除，并通过独立参考仓库核对功能；数据库迁移文件、旧版本识别、legacy ID 映射和一次性数据转换代码不属于“旧业务代码”，必须保留到所有受支持公网实例完成升级，并在此后继续作为可审计发布历史保存。

### 7.3 逐用户对账最小集合

每个用户生成不含隐私正文的对账记录：

- 用户 ID、角色、会员状态与到期时间。
- 交易账户实体、当前归属和完整归属历史数量。
- 私有/平台策略访问关系、策略版本和订阅状态。
- AI 信号、推理快照、交付、订单意图、风控决策、成交结果数量。
- 日/月/手动复盘、已确认版本和策略记忆版本数量。
- 支付订单状态与确认金额汇总、会员激活结果、返佣汇总。
- 通知和关键审计事件数量。
- 每类数据按稳定主键和规范化关键字段计算哈希。

不得把密码哈希、会话 Token、API Key、完整提示词或用户正文写入迁移日志。

### 7.4 旧表删除门

只有同时满足以下条件，旧表才能进入删除迁移：

- 逐表映射有明确目标或确认无业务用途。
- 源/目标对账全部通过，没有未解释数量差或哈希差。
- 代码、动态加载、Jobs、Bridge、发布脚本和运维工具均无引用。
- 新库至少完成一次从空库重建和一次从备份恢复。
- 新版三前端、API、WebSocket、Bridge、支付、交易、风控和复盘验收通过。
- 回滚窗口结束且用户明确同意清理。
- 删除前完成最终备份并验证可恢复。

删除操作必须单独提交、单独迁移、单独验收；不得使用一条大范围 DROP 隐藏目标。

## 8. 测试与验收

### 8.1 迁移测试

- 空库从 0 执行到最新版本。
- 从当前 `dev_vue` 快照迁移到目标库。
- 同一快照至少完整重跑两次，目标数量和哈希一致。
- 每个分块点模拟中断后继续，不重复、不遗漏。
- 校验和冲突、未知迁移、重复版本和部分 DDL 均失败关闭。
- 备份恢复后再次执行关键查询和登录。

### 8.2 并发测试

至少覆盖：

- 同一终端账户被两个用户同时连接和接管。
- 同一信号并发生成订单意图。
- 同一幂等键重复下单、挂单、撤单、平仓和分发。
- 订阅修改与自动分析调度同时发生。
- 风控刷新、下单预留、Bridge 回执和复盘创建并发。
- 支付匹配、会员激活和通知副作用并发。
- 多 worker 同时 claim 模型任务、Bridge 命令和迁移任务。

验收不是“没出现一次死锁”，而是：锁序一致、无未捕获 1213、幂等事务可恢复、非幂等外部副作用不重复、监控能关联到事务名称和业务 ID。

### 8.3 查询与容量测试

- 核心查询保存 `EXPLAIN FORMAT=JSON` 基线。
- 用当前数据量、10 倍数据量和最大单用户数据量测 P50/P95/P99。
- 记录数据库返回字节、API 压缩后字节、WebSocket 空闲和峰值带宽。
- 列表查询不得读取载荷表；首页和实时通道不得下载完整历史。
- 验证连接池上限、排队、超时、取消和服务停止时的连接释放。

## 9. 实施顺序

1. 将本方案和数据库规则写入项目基线。
2. 按已完成的[数据库逐表迁移矩阵](./database-table-migration-matrix.md)实现 schema audit、目标 DDL 和可恢复回填命令。
3. 建立新版数据库基础层、文件迁移器和只读 schema audit 命令。
4. 先落地统一认证和系统用户域，验证 SSO 数据迁移。
5. 以“系统用户 -> 终端 -> 交易账户 -> 策略订阅 -> 信号 -> 订单 -> 结果”完成一条端到端竖切。
6. 迁移支付/会员、内容、复盘/记忆、通知/审计等其余业务域。
7. 完成查询计划、并发、恢复、三前端、API、WebSocket 和 Bridge 验收。
8. 演练切换和回滚。
9. 用户确认后正式切换；旧表清理由后续独立任务处理。

## 10. 第一轮方案复审

复审范围：需求覆盖、业务边界、现有能力复用、最小改动、是否设计过度。

发现与调整：

- 原始目标若直接“重画 165 张表”容易遗漏现有功能，已改为先建立逐表迁移矩阵，逻辑域只作为目标边界。
- 为保留所有用户数据，放弃在导入库上直接原位重写，改为旁路目标库反复演练；本地无业务流量，因此不提前引入长期双写。
- 没有引入微服务、分布式数据库或重量 ORM；保留 MySQL 8.4 和 `mysql2`，只增加薄数据库基础层、Repository 与文件迁移器。
- 没有机械要求 452 个 `_id` 全部加外键；审计、协议和历史软引用允许保留，但强一致关系必须逐项说明。
- 把大载荷拆表是为了阻断 `SELECT *` 和带宽浪费，不改变原始证据内容；压缩和归档延后到独立迁移。
- 交易账户实体与用户归属拆分，既满足“一账号一个当前终端/用户”的权威关系，也完整保留已发生的接管历史。

第一轮结论：方案覆盖数据保留、规范化、查询性能、死锁治理和旧表清理，同时避免了不必要的服务拆分和双写系统。

## 11. 第二轮方案复审

复审范围：兼容性、数据与迁移、并发与幂等、异常恢复、时间语义、安全、测试、回滚和连带 Bug。

发现与调整：

- MySQL 8.4 原子 DDL 不等于事务 DDL，已将结构迁移和数据回填拆开，并要求 checkpoint 和部分完成恢复。
- 当前 UTC 要求与 `server/db.js` 的北京时间会话冲突，已明确新连接使用 `+00:00`，展示时区留在应用边界；旧时间值需逐列判定真实语义，禁止统一减 8 小时。
- “确保不会死锁”无法以绝对承诺验收，已转换为固定锁序、唯一索引锁定、短事务、有限幂等重试、死锁观测和并发测试。
- 全局切到 `READ COMMITTED` 可能改变现有风控和订单读语义，已改为先按事务和副本验证，不直接修改默认隔离级别。
- 当前应用数据库账号缺少锁和语句监控权限，已要求独立只读运维观测身份，避免给应用账号扩大权限。
- 支付、Bridge 和模型均含外部副作用，已明确外部调用不进入事务，数据库重试不得导致重复链上处理、重复模型调用或重复交易命令。
- 旧表删除被移动到切换稳定后的独立任务，并增加代码引用、备份恢复、用户确认和逐表删除门。
- 旁路库切换可能遗漏切换窗口的新写入，已要求正式上线采用维护停写快照或有界最终增量；本地阶段无需提前实现复杂 CDC。

第二轮结论：经调整后方案可作为实施基线。165 张表已逐一映射；当前剩余风险是缺少完整慢查询/死锁历史权限、旧 DATETIME 的真实时区语义尚未逐列核定，以及尚未生成可恢复基线备份。这些风险必须在首个 DDL 前关闭。

### 11.1 公网旧结构升级链补充第一轮

- 删除 Vue 旧实现不会减少数据库迁移范围；功能盘点和逐表矩阵用于重建功能，旧迁移版本、legacy ID map、回填 checkpoint 和对账规则用于升级公网数据，两者必须分别保留。
- 只提供最终 schema 或空库 baseline 无法升级当前公网数据库，已要求发布物包含从所有已识别旧 `schema_migrations` 状态进入 V4 的连续路径。
- 旧单文件迁移器不再承载新迁移，但不能直接丢弃其历史事实；采用只读归档/版本映射加新的文件迁移器，避免同时维护两套可写迁移实现。

### 11.2 公网旧结构升级链补充第二轮

- 已发布迁移修改、重排或 squash 会破坏 checksum 和部分升级实例，已明确只能追加前向纠正迁移；schema snapshot 仅加速空库安装，不替代历史链。
- 大表回填继续独立于启动 DDL，使用 checkpoint 可续跑；切换采用维护停写快照或有界最终增量，避免为“无缝”提前引入长期双写和 CDC。
- 无缝迁移的验收含义冻结为：用户和业务数据零丢失、可重复升级、可对账、可回滚、停机窗口可预估；在未完成真实公网快照演练前不承诺绝对零停机。
- 剩余风险仍是旧 DATETIME 真实语义、源库备份、慢查询/锁证据和正式切换窗口；这些阻塞项保持不变，不能因前端从零重写而跳过。

## 12. 当前实施前阻塞项

- 建立只读运维监控方式，取得脱敏的慢查询摘要、`lock_deadlocks` 和锁等待统计。
- 将[数据库逐表迁移矩阵](./database-table-migration-matrix.md)转为机器可校验 manifest，并在每次冻结源库时重新验证 165/165 覆盖率。
- 冻结旧 DATETIME 字段的实际时区语义矩阵。
- 明确本地旁路目标库名称和正式环境切换窗口；不得复用生产库名做未验证实验。
- 为当前 `dev_vue` 生成新的、可恢复且有哈希的基线备份。

## 13. 官方依据

- [MySQL 8.4 Transaction Isolation Levels](https://dev.mysql.com/doc/refman/8.4/en/innodb-transaction-isolation-levels.html)
- [MySQL 8.4 InnoDB Error Handling](https://dev.mysql.com/doc/refman/8.4/en/innodb-error-handling.html)
- [MySQL 8.4 Locking Reads, NOWAIT and SKIP LOCKED](https://dev.mysql.com/doc/refman/8.4/en/select.html)
- [MySQL 8.4 EXPLAIN Output](https://dev.mysql.com/doc/refman/8.4/en/explain-output.html)
- [MySQL 8.4 Atomic DDL](https://dev.mysql.com/doc/refman/8.4/en/atomic-ddl.html)
- [MySQL 8.4 Online DDL](https://dev.mysql.com/doc/refman/8.4/en/innodb-online-ddl.html)
- [MySQL 8.4 Invisible Indexes](https://dev.mysql.com/doc/refman/8.4/en/invisible-indexes.html)
- [MySQL 8.4 Optimization and Indexes](https://dev.mysql.com/doc/refman/8.4/en/optimization-indexes.html)


2026-09-07 时间口径补充：遵循[时间存储与显示规则](time-storage-and-display-policy.md)，时刻存储/传输统一 UTC，实验室显示终端时间，其它应用显示北京时间。
