# V4 数据写入所有权核查

日期：2026-09-08。P0 源码清单与首轮语义核查，未完成全表所有权验收。

第十九批更新：认证模块的 Bridge 凭据撤销实现已迁入 bridge，运行入口通过受限 composition 入口创建并注入 auth；auth 不再直接写这两张 Bridge 表。当前 JSON 已刷新为236个源文件、264个候选、92张静态目标表、6张多模块写入表；5处未解析候选和114处间接调用保持。下文首轮统计为改造前证据。

## 证据与复现

运行 `pnpm run inspect:sql-writes`，或者直接运行 `node scripts/inspect-sql-writes.mjs` 取得纯 JSON。本次结果保存于 [SQL 写入清单](sql-write-inventory-20260908.json)。工具只读取 `server/src`，不读取环境配置、连接数据库或执行 SQL。

本次扫描 235 个源文件，得到 264 个 SQL 候选、92 张可静态确定的写入目标表；其中 8 张表存在不同模块目录的写入者。另有 5 个未解析候选、114 处参数非直接 SQL 字面量或以插值开头的 execute/query 调用，保留人工核查，不过滤成“通过”。后者包含同名业务方法及只读 SQL，不能按数量认定为遗漏写入。

清单使用 TypeScript AST 提取字面量，SQL 引号/注释分词后识别单表写入目标；不会把 `ON DUPLICATE KEY UPDATE` 或值内的 SQL 文本算成第二次写入。未知动态表名、多表 UPDATE、CTE、多语句保留未解析。文件中的 SQL 可能未被实际调用，模块目录仅代表当前实现位置，不代表批准的数据所有者。

这不是数据库表目录，也不是所有权门禁。尚未覆盖旧服务、迁移、触发器、存储过程、ORM、跨文件 SQL 数据流及可执行 SQL 注释；无运行写入者的历史表仍须结合数据库表矩阵逐项定责。禁止将 92 张等同于当前数据库全部业务表，或直接把当前唯一写入者登记为正式所有者。

## 已发现的跨域写入与收口方向

以下为后续实现约束，公开端口尚未在本批实现。完整调用位置与行号见 JSON，每条写入保留独立证据。

| 表 | 当前源码写入者 | 目标职责与处理方式 | 阶段 |
| --- | --- | --- | --- |
| `trading_accounts`、`trading_account_ownership_intervals`、`trading_account_ownerships` | bridge | 账户实体与归属属于 trading。Bridge 首次认领通过 trading 的事务内公开能力完成；账户创建、归属、凭据重查、绑定和连接登记保留同一提交边界 | P1 |
| `terminal_profiles`、`terminal_account_bindings`、`bridge_connection_sessions` | bridge | 设备档案、精确绑定和连接生命周期由 bridge 管理；trading 通过声明的查询能力取得账户连接投影 | P1 |
| `bridge_refresh_sessions`、`bridge_v4_pairing_requests` | bridge（第十九批已移除 auth 直接写入） | 凭据与配对撤销实现由 bridge 拥有，运行入口注入 auth 所需的撤销端口。原用户锁、配对/凭据同一事务以及设备撤销完成后再退出网页的顺序保留；失败继续向上传播 | P1/P6，当前端口收口已实现 |
| `subscription_schedules` | strategies、inference | 区分订阅配置变更与调度游标推进，通过所属域的比较并更新能力协作；不得以两个模块分别控制部分字段替代唯一所有者。最终归属结合 P3/P4 用例复审确定 | P3/P4 |
| `trade_decisions` | inference、risk | 推理决策事实由 inference 拥有；risk 保存风险判断后，需在现有事务中调用明确的决策关联/状态迁移能力，不能直接改另一域状态 | P4/P5 |
| `risk_decisions_v4` | risk、execution | 风险决策由 risk 拥有；execution 绑定 operation 时通过带 revision 的事务能力，不直接更新 risk 表 | P5 |
| `risk_reservations_v4`、`risk_reservation_events_v4` | execution、trading | 预留预算规则与生命周期归 risk，执行流程和可信投影通过专用能力预留、提交、过期或吸收；不根据表当前所在文件确定归属 | P5 |
| `outbox_events` | outbox、execution、inference、reviews、risk、trade-history、trading | outbox 提供受限的事务内追加能力和投递状态管理；业务域仍在自己的事务内追加事件。不能改为先提交业务、再独立插入事件，也不把多生产者当成可删除的重复写入 | P0/P1–P6 |

特别注意：账户三张根表目前扫描为单一写入者 bridge，仍存在业务归属问题；“多写入者数量为零”不能作为所有权完成判据。

## 五处未解析 SQL 的人工核查

| 位置 | 核查结果 | 后续要求 |
| --- | --- | --- |
| execution `mysql-execution-repository.ts:140` | UPDATE 使用 JOIN；实际 SET 的目标为 `risk_reservations_v4`，关联 `execution_intents` 筛选过期操作 | 归入预留过期事务，保留与 intent/operation/预留事件的原子性 |
| inference `mysql-model-task-recovery-repository.ts:50` | 局部 table 仅由 purpose 选择 `ai_analysis_runs` 或 `ai_trader_runs` | 任务过期与对应 run 失败、outbox 保持同一事务；后续全表清单显式展开两表 |
| trade-history `mysql-trade-history-repository.ts:48` | WITH 后为 SELECT 日汇总，非写入 | 保留原候选证据；只读投影另核查授权、金额可比性及查询范围 |
| trading `mysql-trading-repository.ts:549` | DELETE 动态表名；函数类型和两处调用限定 `open_position_snapshots` / `pending_order_snapshots` | 两表属于 trading 运行投影；删除及重插保持同一可信投影事务 |
| trading `mysql-trading-repository.ts:550` | 同一函数 INSERT，目标同上 | 不把完整快照替换拆成可单独提交的 repository 调用 |

人工结论没有覆盖或修改扫描原始结果。114 处间接调用尚未逐一完成数据流核查，不能声称已排除所有其它写入。

## P1 账户样板必须保留的事务与身份条件

`MysqlBridgeGatewayRouteRepository.authorizeAndOpen` 目前在一个事务中取得账户、核查归属与设备凭据、登记档案、创建首次归属、校验 epoch、替换精确绑定并插入连接会话。迁移时先定义交易账户端口与组装层工作单元，禁止向 domain/application 暴露 `PoolConnection`，也禁止内部方法自己提交。

必须保留账户 → 所有者 → 凭据 → 档案 → 绑定/会话的锁序；重复或已删除账户身份不自动复活，货币不匹配仍拒绝；BIGINT ID 保持字符串，账户实体不以 user_id 作为经纪商账户身份。新的写入所有权设计需要同时测试首认领失败整体回滚、并发首认领、旧凭据、旧 epoch 及跨用户账户拒绝。

交易投影对预留的吸收当前依赖成功 intent、精确 Bridge command/result、投影 revision 和发生时间，并写入预留事件。后续抽出能力必须保持这些证据及事务边界，不能用普通异步通知直接释放预算。

## 下一步与本批验证

1. 完成间接 SQL 调用的数据流核查，并与现有数据库表矩阵对齐：正式表、历史兼容表、只读投影、基础设施表分别记录唯一所有者与实际入口。
2. 以账户样板定义事务内公开端口及组合根，先保留现有原子性，再迁移 Bridge 对账户根的直接 SQL。
3. 在明确所有权后实现增量检查；动态目标和无法分析的写入不能被宽泛例外自动批准。

检测器 6 项定向测试通过，涵盖引号/注释、upsert、多表与多语句拒绝、动态目标、间接调用、分组和 TypeScript 解析失败。此次只新增离线工具与证据，没有修改服务端业务实现、迁移或运行配置，未连接 MySQL/Redis/终端。

第十九批实现验证：Bridge 配对/撤销20项、认证SSO13项通过；新增存储失败回滚/释放连接以及注入撤销失败不提前退出网页的回归。完整服务端类型检查、构建及边界增量门通过。SQL double只证明调用与事务控制流程，未连接真实数据库验证回滚或运行撤销。其余多域事务与间接 SQL 尚未收口。
