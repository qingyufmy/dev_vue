# 宏观 HTTP 读取实现边界

基线 c809c7f9 加当前未提交的 Bridge HTTP/持仓实现。七个接口仍未注册；本文件作为后续实现依据，不替代接口验收。

## 当前证据

本批实际只读核对 dev_vue，UUID 与既有开发库一致、会话 UTC。`macro-http-readiness-20260909.json` 保存十张宏观/日历相关表的字段、类型及计数：全部存在，全部为零行。不能将空库中的查询成功当成正确处理发布、来源权限、修订和分页的证明；也无需为了 HTTP 读取重新建表。

现有 `MysqlMacroSnapshotReader` 属于 inference，按平台发布、兼容 schema、有效期及健康过滤并校验 payload hash，只返回 analysis_evidence。浏览器合同需要 summary/direction/factors，不能将模型 evidence 原样返回浏览器，也不能取消 AI 原有筛选条件来复用查询。

## 职责与接口

新增 market 业务模块承接平台宏观和经济日历读取，目录仍按 domain/application/infrastructure/transport；仅 composition 组装 MySQL 与 HTTP。七条路由作为同一个 marketHttp 插件注入现有 trade 主机隔离区，统一使用现有登录认证能力。普通用户不获得来源健康管理、凭据或采集证据；不增加会员等级限制。实时仍使用既有失效事件，不新增 WebSocket RPC。

| 接口 | 数据与行为 |
| --- | --- |
| calendar-events 列表 | 从 events 与其当前可用 revision 组装 DTO，四项数值来自 revision 的 DECIMAL；按 scheduled_at/id 有界键游标查询，绑定 from/to/importance；不得用标题生成事件身份 |
| calendar-events/:id | 只返回可展示来源的事件及最新已知修订；缺失或不可展示统一404，数据库/结构异常503；返回修订ETag |
| macro-series | series_code 精确筛选；关联 observations，保留 observation/available/ingested 时间；拒绝尚不可用或尚未入库记录；游标绑定 code/from/to，使用时间加ID处理同时间并列，不把文本观测伪装成数字0 |
| macro-snapshots 列表 | 只读兼容、平台、已发布中期快照；按 published_at/id 键游标，列表只返回summary及factor_count，不读取无关模型正文 |
| macro-snapshots/:id | 校验平台发布与兼容 schema、完整payload哈希及公共DTO结构；按显式白名单投影，不返回analysis_evidence和其它私有字段 |
| macro-snapshots/latest | 使用明确版本集合及 medium_term，发布时间/cutoff不来自未来；无合适快照404，内容损坏503，不能回退schema0旧行冒充已发布 |
| market/overview | 在一次读取的一致时间基准下组合快照摘要和最多20个附近高影响事件；无快照可为null，查询失败必须503，不能catch后返回null或空数组 |

数据来源必须 `approved`、允许展示、未退休且许可未过期；派生快照的浏览器展示还需检查来源映射的相应权利。来源参数与凭据不出现在公开响应。上述要求来自已有 macro_data_sources 和 M0/M1 决定，不在读取接口中启动供应商采集或修改来源许可。

## 数据与分页规则

- 所有数据库日期显式转 UTC 毫秒 ISO，DECIMAL 使用字符串，BIGINT revision/ID 不经过不安全的 number 转换。
- 日历 root 行没有 actual/consensus/previous 数值，必须关联 revision；available_at 和 ingested_at 均不能晚于本次读取时间。修订号和 root revision 各自语义需在 adapter 中明确，禁止选择某事件另一条未来 revision。
- 观测会有多个 vintage；按当前可知时间筛选并确定每个 observation_at 的有效版本，保留并列时的唯一键排序。freshness 依据 series 的 freshness_calendar/limit；没有实现日历规则时不能擅自将周末变陈旧或默认fresh。
- 数据列表是当前读取，不宣称跨 HTTP 页持有数据库事务。游标绑定筛选条件及确定性排序键，拒绝非法/跨筛选游标；需冻结时间窗口时把该窗口写入游标并重新校验。后续修订可导致当前列表变化，客户端依失效事件从首页刷新。
- 快照 canonical payload hash 必须与发布端约定一致；公共摘要字段的具体路径从既有payload合同核对，不凭空猜测。列表避免拉取完整大正文：使用已确认的JSON路径投影公共短字段，详情才读取全文校验；若缺公共字段则失败关闭。
- 七个操作全部登记运行 schema，补齐适用400/404/503问题响应并同步生成；不得为了使路由数量通过而只返回501或空数据。

## 实施顺序与验证

1. 先实现日历 repository/service/HTTP 两条接口，以多revision、未来可用数据、禁用来源、并列时间、跨条件cursor、金额文本和未登录为行为用例。
2. 实现序列读取，先明确 point-in-time 版本选择和 freshness 日历策略；用旧vintage/新vintage及周末输入验证。
3. 核对快照载荷合同，实现列表/详情/latest/overview及哈希、版本、发布、来源权利过滤；不得削弱既有 inference reader。
4. 本地 HTTP/合同/消费者验证之后，在当前空开发库验证真实查询与404/空集合语义；正向数据必须使用隔离夹具或事务回滚演练，空库不算正向证明。
5. 96项实际注册全量对账清零才关闭本轮 API 注册缺口；运行校验及业务/前端验收另记，不从路由齐全推断全功能完成。

## 两轮复审

第一轮（需求/职责）：沿用M0/M1和七项冻结用户合同；把公开读取归market，避免复用AI内部reader泄露analysis_evidence。保留十张既有表，不建立第二套前端宏观库，也不借补接口启动采集或模型任务。

第二轮（兼容/数据/异常）：现库十表全空，因此增加修订与未来时间的正向夹具验证要求；补来源权利过滤、哈希、DECIMAL/BIGINT、游标范围与错误合同。历史设计关于旁路空库迁移已被现有同库升级取代，本批不重跑旧迁移。未确定的payload公共路径、freshness日历和派生来源授权映射必须在相应实现前从项目合同核实，不能用默认值掩盖。

剩余缺口：七接口尚未实现；尚无有效来源/发布快照/观测记录；未验证提供者、真实终端或前端宏观流程。本批只读预检没有增加、修改或删除任何业务数据。
