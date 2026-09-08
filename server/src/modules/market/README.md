# Market

当前实现经济日历、宏观序列、快照列表/详情/latest及概览的公开读取。路由完整不等于来源发布链路、实际日历或规模性能已验收。

宏观序列 GET /api/v4/market/macro-series 通过 MacroSeriesService/MysqlMacroSeriesReader 读取。序列按 observation_at 选择截至 asOf 已 available 且已 ingested 的最新版本，按 available/ingested/id 决定并列版本；分页固定 asOf 与查询条件，来源许可每次按 accessAt 重新检查。scripts/verify-macro-series-reader-mysql.mjs 已验证正式 schema 和会话临时夹具，同一编译 SQL 不改写标识符；九项结果见 docs/architecture/macro-series-reader-mysql-passed-20260909.json。

MacroFreshnessPolicy 支持 utc_elapsed_v1 自然时间，及受限覆盖区间的来源日历。阈值比较 observationAt 到 asOf 的经过时间，不能用最近下载/available 时间刷新旧观测。来源日历提供版本 ID、UTC 半开计时区间、覆盖起止、最长自然时间陈旧上限；区间由来源规则明确节假日与夏令时，模块不推测周末。端点 age 等于阈值仍 fresh，超过为 stale；未知日历或覆盖外为 invalid，非数值序列 invalid，禁用序列 disabled。配置区间会复制并校验排序、不重叠，长期中断受自然时间上限约束。

目前组装仅启用 utc_elapsed_v1；没有已验证的美国/Cboe 日历定义，不能据此把核心来源新鲜度验收标为完成，也不可将其改成自然时间绕过规则。下一步需取得来源明确日历、冻结证据及覆盖窗口并经 composition 注入。测试 macro-freshness.test.ts 中区间明确为合成日历。HTTP 运行校验、认证优先、no-store、错误脱敏与空数据分别由 macro-series-http.test.ts 验证；生产进程尚未重启。

职责：平台市场数据的公开投影与读取规则。domain定义事件与稳定错误，application负责查询校验和键游标，infrastructure拥有MySQL读取，transport负责认证及运行合同校验。index只导出业务能力/类型；composition是API和测试的受限组装入口。

数据：读取economic_calendar_events、economic_calendar_event_revisions及macro_data_sources，无写入。事件数值选择available_at与ingested_at均已到达的最高修订号；来源必须获准展示、未退休、许可未过期。不返回凭据、来源内部详情或采集证据。缓存和失效事件不替代授权。

HTTP：GET /api/v4/market/calendar-events 与 /api/v4/market/calendar-events/:event_id，由marketHttp挂载于trade主机范围。复用注入的会话认证能力，所有响应no-store。分页绑定from/to/importance，按scheduled_at与id排序；修订引起列表变化时客户端应重读，不声称跨页数据库快照一致。

测试入口：server/tests/calendar-http.test.ts；实际SQL探针scripts/verify-calendar-reader-mysql.mjs。探针报告明确区分正式空表查询和会话临时夹具，不能替代真实来源发布验收。

快照由 MacroSnapshotService 和 MysqlPublicMacroSnapshotReader 提供，单条 SQL 核对平台发布及全部关联来源的 display/derived 权利，应用核对 display 哈希与精确因子映射。列表游标固定 asOf，许可和过期投影按当前 accessAt；latest 缺失404，overview允许空快照并聚合未来七天最多20条高影响事件。两次查询不宣称跨资源一致快照。详情/latest的ETag按最终DTO计算，过期状态改变会更新。测试入口 macro-snapshot-http/service/projection/lineage.test.ts；实际MySQL回执 macro-snapshot-reader-mysql-20260909.json。历史payload的display约定见docs/architecture/macro-snapshot-display-v1.md。
