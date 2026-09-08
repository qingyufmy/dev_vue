# 账户数据所有权与锁序清单

基线：b7960bb6，源码只读核查。配套 `account-source-dependency-candidates-20260909.json` 由 `scripts/inspect-account-source-dependencies.mjs` 生成。扫描 280 个 server/src TypeScript 文件，在 58 个文件中记录 323 个字符串/模板候选；候选不是违规数量，也不是完整依赖图。本批未查询数据库或 Redis，不更新上次实际夹具状态。

## 数据职责与退役处理

下表是依照当前调用点整理的责任清单；“应提供能力”表示目标边界，不表示端口已实现。所有路径相对仓库根目录。

| 数据/引用 | 当前源码入口 | 所有者及所需处理 |
| --- | --- | --- |
| users 活动身份、权益 | auth 的 principal adapters；bridge 的 gateway credential、pairing、device revoker 仍有直接 SQL | auth 拥有身份；Bridge 权益/凭据复核不能因已替换注册身份读取而遗漏。退役保留用户，不改身份版本 |
| trading_accounts、ownerships、ownership_intervals | trading/mysql-account-registration、mysql-context-target；execution、inference、reviews、risk、strategies、trade-history 仍直接查询 | trading 拥有归属与区间；历史消费者应按区间授权，不能将结束当前归属等同删除历史访问依据 |
| trading_contexts、trading_context_changes_v4 | trading/mysql-context-commands、mysql-context-receipts | trading 拥有当前上下文及用户命令回执。退役需专用回执，不能改写既有三动作历史合同 |
| observer_sources/channels/access、management_operations/registry | trading/mysql-observer-management-repository、mysql-observer-access-reader | trading 拥有观摩发布/授权；保留已关闭源、频道及回执，活跃入口是退役阻断事实 |
| terminal_profiles、bindings、bridge_connection_sessions、refresh sessions | bridge/mysql-bridge-gateway-route-repository、credential/pairing/device-revoker | Bridge 应提供同事务阻断检查；不能只看账户外键，也不能凭 Redis 离线认定没有可恢复路由 |
| strategy_subscriptions 及策略版本 | strategies/mysql-strategy-catalog；inference、execution 也消费 | strategies 应提供活动订阅事实；保留不可变版本与历史映射，不能由 trading 直接停订阅 |
| operations、execution_intents、bridge commands、risk reservations | execution/mysql-execution-repository、mysql-bridge-command-repository、mysql-user-execution-command-repository、distribution repository | execution 拥有执行生命周期；待决/uncertain 命令和保留占用需按状态机判断，不能只计算行数 |
| 持仓、挂单、runtime/projection revision | execution/mysql-user-execution-command-repository 读取 payload_json 及 revision | 须进一步核对实际投影写入者和新鲜度；空/缺表/过期快照均不能证明终端没有仓位 |
| ai_trader_runs、trade_decisions、market_analyses、模型任务恢复 | inference/mysql-inference-repository、mysql-model-task-recovery-repository | inference 拥有任务事实；P4 缺表仍是未就绪，不能在退役工具中临时创建空表 |
| 风险状态/决策、历史与复盘 | risk/mysql-risk-repository、trade-history collector/schedule、reviews/mysql-review-repository | 各域保留历史证据；账户当前失效与历史查询权限分开设计。跨域直读依旧需逐条收口 |
| outbox payload 与事件二次查询 | outbox/infrastructure/redis-outbox-realtime-publisher.ts | outbox 负责投递，业务状态仍由域拥有；关闭账户不删除已确认事件或伪造消费者已处理 |

表中 mysql 文件均位于对应 `server/src/modules/<domain>/infrastructure/`。候选报告提供完整文件名、行号、源文件摘要、SQL 表名候选和锁子句，便于定位；不根据正则表名候选自动决定所有权。

## 已核实的事务顺序

这里记录源码语句/能力的调用先后。JOIN 中表的书写顺序不等于 MySQL 实际锁获取顺序，必须另用执行计划与双连接验证。

| 路径 | 当前语句顺序 | 影响 |
| --- | --- | --- |
| ContextCommands.execute | begin → auth 用户 UPDATE 锁 → 原回执 → context UPDATE 锁 → ownedTarget 账户/归属/区间 SHARE → 写 context/receipt → commit | 用户→账户；没有自动完整事务重试，提交异常返回 commit_unknown |
| Bridge authorizeAndOpen（已有账户） | begin → lockAccount UPDATE → lockCurrentOwnership JOIN UPDATE → auth 用户 UPDATE → credential JOIN users UPDATE → profile → binding/session → commit | 账户→用户；不仅注册，activate 及其它 assertCurrentRouteBase 调用也沿用此方向 |
| Bridge authorizeAndOpen（新账户） | begin → 身份键查询/插入账户 → credential JOIN users UPDATE → profile → grantFirstOwnership → binding/session | 新账户分支不调用 lockCurrentOwnership；只改已有账户分支不足以建立统一锁协议 |
| Bridge device revocation | begin → users UPDATE → pairing requests UPDATE → refresh sessions UPDATE | 用户→凭据，与 gateway 的 JOIN 锁集合必须共同评估；当前仍直接访问 auth 表 |
| ObserverManagement.execute | begin → registry UPDATE → 管理员 SHARE → 幂等回执 UPDATE → 分支实体锁；assertOwnedAccount JOIN SHARE 后再取运营者 SHARE → receipt/outbox → commit | registry 锁只序列化管理写入，不覆盖上下文和 Bridge，不是全局账户互斥锁 |
| 进入观摩上下文 | 已持 viewer UPDATE/context UPDATE → AUTHORIZE_SQL SHARE → auth.readMany(viewer/operator, SHARE) | 参与者不止一个用户；简单在所有路径“先锁当前用户”不能证明全局无环 |
| execution.accept 与到期处理 | accept 的 lockOwnedAccount JOIN UPDATE 后进入风险/预留；到期处理先收集账户、锁账户，再处理操作 | 未来退役必须与真实命令创建/恢复共用稳定账户约束；不允许预检后无锁写入 |

主要核对点：`mysql-context-commands.ts:22`、`mysql-context-target.ts:13`、`mysql-account-registration.ts:12`、Bridge gateway `:55/:246`、device revoker `:8`、observer management `:156/:512`、observer access `:146`、execution repository `:76/:129/:203`。行号以本报告源摘要为准。

已可从源码构造的冲突：事务 A 持用户 U 的 UPDATE 锁、等待账户 X 的 SHARE 锁；事务 B 持 X 的 UPDATE 锁、等待 U 的 UPDATE 锁。这是锁顺序反转风险的证据，尚未在当前 MySQL 实测死锁，不能报告为已发生的线上故障。Bridge inTransaction 当前只 rollback/translate，没有完整幂等事务的有界死锁重试，不能依赖“已有重试”解决。

## 无外键与缓存引用

- 用户执行命令读取 positions/pending orders 的 `payload_json`；outbox 事件、管理操作 `audit_json/result_json`、命令回执可能保存账户维度。结束归属保留这些事实，不替换 ID、不清空 JSON。动态 JSON 生产者/消费者仍需继续逐链路核对，字符串扫描无法覆盖纯对象属性。
- `RedisBridgeGatewayLeaseStore` 使用 `aurum:v4:bridge:gateway:account:<id>`，另有 user/profile/connection 键并保存 route JSON。route 当前读数不是数据库授权证明；释放必须保持 owner/connection 校验，不直接按模式 DEL。
- `RedisConnectionLeaseStore` 使用 `aurum:v4:bridge:leases:user:<user>:account:<id>` 和用户有序集合，member 为 account|epoch。应先核对实际组装消费者，不假定它与 gateway lease 是同一实现。
- `RedisAccountExecutionLeaseStore` 使用 `aurum:v4:execution:account:<id>`，释放要求 owner 匹配；lease 消失不意味着没有已派发命令。
- 浏览器订阅/缓存与实时票据属于客户端及会话作用域，应通过失效事件、权限复核和权威快照收口，不把后台清 Redis 当成前端已撤权。

## 下一实现决定

本轮不直接新增归属退役写入。先以“已有账户上下文与 Bridge 路由复核”建立可复现的双连接锁交错测试，再根据参与用户、账户和凭据的完整集合确定公开事务协调能力。不得直接把所有事务统一为用户优先：观摩涉及 viewer/operator、多账户分发及账户创建身份键均需涵盖。也不得只移动一个 auth 查询或降低锁强度来让测试通过。

并发方案需覆盖注册、激活、投影、上下文、观摩管理与凭据撤销；尚未查明的投影写入者、动态 JSON/旧代码消费者、实际缺表由对应工作包继续核对。本报告完成了可重复源码候选采集和关键锁反转定位，未完成全依赖清零。确定协议后才追加退役回执迁移与领域阻断能力；期间保留合成账户。

定向复核：扫描器只读取 server/src 和 Git HEAD、独占创建报告，不连接外部依赖；报告包含源码摘要用于防止把过期定位当作现状。两轮设计的约束继续有效，本轮新增证据扩大了锁参与者范围，取消“只调整注册入口即可完成”的实施假设。没有修改运行代码、迁移或冻结输入。
