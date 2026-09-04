# V4 市场行情、宏观研究与经济日历实施方案

> 文档状态：正式重写方案，尚未实施
>
> 当前基线：`dev_vue` / `8823579171549663992e7c1c07dbfd427cc160a6`
>
> 重写日期：2026-09-04
>
> 适用范围：AI 交易实验室 `trade`、V4 服务端、V4 管理后台、数据库迁移与后台任务
>
> 授权边界：本文件只定义方案，不授权安装依赖、购买或抓取数据、执行迁移、启动任务、调用模型、部署、删除历史数据或发送交易指令

## 1. 结论与实施原则

旧版方案的 point-in-time、不可变快照、模型版本、失效保护和只读边界继续保留，但旧静态前端、双 API 路径、Plus/Pro 白名单、独立同义快照表和首版同时引入全部模型的设计全部废止。

V4 采用以下结论：

1. “市场行情”是 AI 交易实验室的独立一级导航，不属于 AI 分析师的子页面。
2. 页面分为专业行情、跨市场宏观环境和经济日历三个相互独立的工作区。
3. `macro_research_snapshots` 是宏观发布结果的唯一权威表，不再新增 `macro_dashboard_snapshots`。
4. 宏观结果是平台级、只读、中期研究背景，不读取用户账户和持仓，不直接产生交易动作。
5. AI 分析师可以读取已发布且有效的宏观快照，但必须冻结快照 ID、版本、截止时间和哈希；缺失宏观快照不得自动放宽策略或风控。
6. 首版先完成可追溯数据、经济日历、透明因子状态和只读界面；XGBoost、概率校准、SHAP、HMM 分阶段研究，不作为首版页面上线的强制条件。
7. 浏览器首次加载和详情读取走 HTTP；只对新快照、高影响事件实际值和风险级别变化推送小型 WebSocket 失效事件。
8. 所有后台任务由独立 PM2 Worker 执行；HTTP API、浏览器实时网关和 Bridge Gateway 不执行宏观采集、训练或定时任务。
9. 所有数据库变更使用追加迁移，保留现有数据和证据；不得修改已经存在的迁移文件。

## 2. 当前 V4 基线

### 2.1 已存在能力

- `frontend/apps/trade` 已有 `/market` 占位路由，正式实现应替换占位页。
- 前端统一使用 Vue 3、Vite、TypeScript、Tailwind CSS 4、shadcn-vue（Reka UI）和 Lucide。
- 所有新浏览器接口统一使用 `/api/v4`；不再新增 `/api` 或 `/aurum-api` 兼容入口。
- V4 服务端按 `domain / application / infrastructure / transport` 分层，并由独立 PM2 角色运行 API、实时网关、调度器和 Worker。
- `macro_research_snapshots` 已由迁移 `20260903_005_analysis_scheduler_and_account_fanout.sql` 创建。
- `MysqlMacroSnapshotReader` 已在 AI 分析输入构建时读取最新有效宏观快照。
- 分析任务已经冻结行情、策略和宏观输入，宏观研究不应进入五分钟分析的同步关键路径。

### 2.2 当前冲突

现有 `macro_research_snapshots` 只具备最小占位结构，同时允许 `platform` 和 `user` 作用域。新宏观看板若再创建另一张发布快照表，将形成两个权威源；如果继续允许用户级宏观快照覆盖平台快照，也会让相同市场事实随用户变化。

因此实施时必须扩展现有表并收敛读取语义：

- 新生成并向用户发布的宏观快照只允许 `owner_scope='platform'`；
- 现有记录原样保留并标记来源和兼容状态，不直接删除；
- 新看板和 AI 分析统一从同一套“已发布、未过期、哈希有效”的平台快照中读取；
- 用户策略只能决定是否把该平台快照作为分析证据，不能生成一份用户专属宏观事实；
- 如果未来确实需要用户研究笔记，必须使用不同领域和表名，不得复用宏观市场事实表。

## 3. 产品边界与术语

### 3.1 页面目标

“市场行情”回答三组问题：

1. 当前黄金价格、K 线、成交量和市场状态是什么；
2. 利率、通胀预期、美元、黄金波动率和地缘风险等跨市场因子处于什么状态；
3. 接下来有哪些重要经济事件，公布值与预期的差异是什么。

### 3.2 明确不做

- 不读取余额、权益、持仓、挂单、手数或账户风险额度；
- 不创建 `order_intents`、不调用 Bridge、不下单、不平仓；
- 不以宏观偏向替代 AI 分析师的行情判断；
- 不以宏观偏向绕过 AI 交易员或服务端确定性风控；
- 不输出 Kelly 仓位、绝对手数或“立即买入/卖出”；
- 不在页面请求期间抓取外部数据、训练模型或重新生成快照；
- 不把新闻标题或 LLM 摘要当作可验证的宏观数值；
- 不把相关性、SHAP 或事件后价格变化描述为已证明的经济因果。

### 3.3 统一术语

为避免与策略中 H1/H4 的“宏观方向”混淆，V4 使用：

| 名称 | 含义 | 典型周期 |
| --- | --- | --- |
| 跨市场宏观环境 | 利率、通胀预期、美元、波动率、地缘风险等平台研究 | 约 2 至 4 周 |
| 高周期技术背景 | H1/H4 的趋势和结构状态 | 小时至数日 |
| 当前交易机会 | M15/M5/M1 的当前结构与触发 | 分钟至小时 |

页面、API、提示词和审计记录不得再用一个无时间范围的 `macro_direction` 同时表示以上三种概念。

### 3.4 结果状态

跨市场宏观结论只允许：`bullish_strong`、`bullish`、`neutral`、`bearish`、`bearish_strong`、`uncertain`、`unavailable`。

V1 客观因子快照没有经过验证的预测模型时，horizon 必须使用描述型口径，不能伪装成 20 日预测：

```json
{
  "actionable": false,
  "horizon": { "kind": "descriptive", "value": null, "label": "当前跨市场宏观环境" },
  "disclaimer": "客观因子状态，不代表当前入场信号"
}
```

只有经过验证并激活的 20 日模型结果才使用预测型口径：

所有用户可见结果固定包含：

```json
{
  "actionable": false,
  "horizon": { "kind": "trading_days", "value": 20, "label": "未来 20 个交易日" },
  "disclaimer": "跨市场中期研究背景，不代表当前入场信号"
}
```

## 4. 信息架构与页面范围

### 4.1 路由

```text
/market                 专业行情
/market/macro           跨市场宏观环境
/market/calendar        经济日历
```

路由切换保留可分享 URL；筛选条件使用明确查询参数，禁止把大状态放入 URL。

### 4.2 专业行情

专业行情复用首页的市场合同和实时客户端，不复制第二份行情状态。主要模块：

- 交易账户/行情来源选择，仅决定实时经纪商报价来源；
- 标准品种与经纪商品种映射；
- Bid、Ask、点差、市场开闭状态；
- 完整交互 K 线、成交量、周期切换；
- 24 小时高低、日内变化等可由权威行情推导的指标；
- 数据时间、终端时间偏移、最后同步时间和陈旧状态。

专业行情是账户行情投影；跨市场宏观快照仍然是平台级，不随账户切换。

### 4.3 跨市场宏观环境

默认页面只突出：

- 中期宏观偏向和时间范围；
- 数据截止时间、新鲜度和研究状态；
- 贡献最大的 3 个支持因子和 3 个反对因子；
- 因子状态总览；
- 重要变化时间线；
- “查看方法与来源”的渐进披露入口。

只有模型达到发布门槛后，才显示预测区间、校准概率或 SHAP。没有 active 模型时仍可展示客观因子，不以占位概率伪造结论。

### 4.4 经济日历

经济日历至少显示：

- 事件名称、国家/地区、事件分类和重要程度；
- 计划公布时间、原始时区和 UTC 时间；
- 前值、预期值、实际值及其单位；
- 是否修订、修订前值和修订时间；
- `actual - consensus` 或适合该指标的标准化 surprise；
- 历史上对黄金的统计敏感度，明确标记为相关性而非因果；
- 数据来源、抓取时间和证据版本。

事件公布前不预测“确定影响方向”。公布后分别展示“数据意外方向”和“黄金历史敏感度”，不能把两者压缩成必然涨跌结论。

## 5. 数据源与许可闸门

### 5.1 首选因子

| 因子 | 候选来源 | 首版级别 | 备注 |
| --- | --- | --- | --- |
| 统一黄金日线 | 待批准的连续、可商用来源 | 必需 | 不得拼接不同经纪商历史作为训练真相 |
| 美国 10 年实际利率 | FRED/ALFRED `DFII10` | 必需 | 使用可证明的 vintage |
| 美国 10 年盈亏平衡通胀 | FRED/ALFRED `T10YIE` | 必需 | 使用可证明的 vintage |
| 广义美元指数 | FRED/ALFRED `DTWEXBGS` | 必需 | 周末/节假日按来源日历处理 |
| 黄金隐含波动率 | Cboe `GVZ` | 条件必需 | 商业展示与再分发许可需书面确认 |
| 地缘政治风险 | Caldara-Iacoviello GPR | 可选 | CC BY；保留作者、来源与下载日期 |
| 黄金矿业股 | 待批准的 GDX 来源 | 可选 | 无稳定许可时不进入首版 |

### 5.2 经济日历来源

实施前必须选择能够提供稳定事件 ID、计划时间和时区、前值/预期/实际/修订、历史事件、商业展示权和明确缓存条款的合法来源。

没有批准来源时，只允许隐藏入口或明确“尚未接入”；禁止抓取不稳定网页或伪造事件数据。

### 5.3 许可记录

每个来源必须记录 provider、series key、用途、许可状态和版本、归属文案、缓存/留存/建模/展示权限、速率限制、数据延迟、禁止用途和停用日期。

当前官方资料核对基线：

- FRED/ALFRED 支持 real-time period 和 vintage 查询，但使用 API 必须遵守 FRED 及第三方序列条款，并展示要求的声明：<https://fred.stlouisfed.org/docs/api/terms_of_use.html>
- FRED observation/vintage 参数说明：<https://fred.stlouisfed.org/docs/api/fred/series_observations.html>
- GPR 页面提供历史 vintages，采用 CC BY 并要求注明来源和作者：<https://www.matteoiacoviello.com/gpr.htm>
- Cboe 提供 GVZ 历史数据，但指数数据的展示和分发许可必须按实际用途确认：<https://www.cboe.com/tradable_products/vix/vix_historical_data>

许可未确认、许可过期或使用范围不匹配时，对应来源不得进入生产快照。

## 6. Point-in-time 与可复现数据合同

### 6.1 三个时间

每条观测必须区分：

- `observation_at_utc`：经济或市场事实对应的观察时间；
- `available_at_utc`：该值最早可被系统合法使用的时间；
- `ingested_at_utc`：本系统实际取得并持久化的时间。

训练和历史回放只允许读取 `available_at_utc <= feature_cutoff_at_utc` 的最后可用 vintage。禁止用今天修订后的完整历史覆盖过去。

### 6.2 可得性证据

提供方没有给出精确发布时间时，不得事后猜测。接入记录还要保存请求开始/完成时间、响应哈希、证据引用、vintage 参数、provider 更新时间、解析器版本和 `availability_confidence = exact | provider_date | retrieval_only | unknown`。

`retrieval_only` 和 `unknown` 数据可以展示为当前事实，但不得伪装成历史时点已知数据参与严格回测。

### 6.3 日历与缺失值

- 存储统一使用 UTC `DATETIME(3)`；
- 展示层可转换用户时区，但不改变业务事实；
- 交易日采用被冻结的市场日历版本；
- 不以简单前向填充掩盖来源中断；
- 每个特征明确最大容忍陈旧时间；
- 周末、节假日、延迟发布和修订分别建模；
- 缺失关键因子时降级为 `uncertain` 或 `unavailable`。

## 7. 唯一权威数据模型

### 7.1 表职责

| 表 | 职责 |
| --- | --- |
| `macro_data_sources` | 来源、许可、更新频率和启停状态 |
| `macro_series` | 序列定义、单位、方向语义和新鲜度阈值 |
| `macro_ingestion_runs` | 一次采集的租约、状态、证据和错误 |
| `macro_observations` | 不可覆盖的 observation/vintage 数据 |
| `macro_feature_sets` | 冻结特征 schema 和计算版本 |
| `macro_model_versions` | 模型 artifact、配置、训练报告和状态 |
| `macro_research_snapshots` | 唯一的已发布宏观快照 |
| `macro_snapshot_observations` | 快照到输入观测的可追溯关系 |
| `macro_pipeline_jobs` | 特征、训练、评估、快照和健康刷新任务 |
| `economic_calendar_events` | 稳定事件身份和计划属性 |
| `economic_calendar_event_revisions` | 预期、实际、修订和来源证据的追加版本 |

不得另建 `macro_dashboard_snapshots`、`ai_macro_snapshots` 或前端专用持久化副本。

### 7.2 `macro_research_snapshots` 扩展

保留现有字段，通过新迁移增加 `schema_version`、`business_date`、`data_cutoff_at_utc`、`feature_set_id`、可空 `model_version_id`、发布/新鲜度/健康状态、horizon、发布时间和 supersede 时间，以及唯一发布键和最新读取索引。

完整 DTO 可以保留在有 schema 上限的 `payload_json` 中，但可筛选、排序、关联和并发控制字段必须正规化，不能藏在 JSON 内。

### 7.3 快照不变性

- 已发布快照不得原地修改 payload；
- 数据、解析器、模型或解释变化都生成新快照；
- `content_sha256` 对规范化 payload 计算；
- 读取时验证 schema 版本和哈希；
- 新快照发布和旧快照 supersede 在同一短事务完成；
- AI 输入保存快照 ID、revision、哈希和截止时间；
- 已被展示、AI 使用或审计引用的快照永久保留。

## 8. 数据库迁移与现有数据保护

### 8.1 迁移原则

- 迁移只追加到 `server/db/migrations/`；
- 实施时使用 `20260904_015_*` 之后的下一个空闲编号；
- 不修改现有迁移；不在服务启动时自动迁移；
- DDL、回填、校验和 reader 切换分开；
- 大回填使用稳定主键游标和有限批次；
- 不在长事务内调用外部服务、Python 或对象存储。

### 8.2 现有快照迁移

1. 只读盘点现有记录数量、作用域、时间、哈希和 payload schema。
2. 追加新表和可空扩展列，不改变旧读取行为。
3. 将旧记录标记为 `schema_version=0`、`publication_status='legacy'`，原 payload 和哈希不变。
4. 生成首个 V4 平台快照前完成来源、截止时间、许可和哈希校验。
5. 同一发布批次部署新 reader，使看板和 AI 只读符合 V4 合同的平台快照。
6. 旧用户级记录保留为只读证据，不再覆盖平台事实。
7. 对账记录数、ID、哈希、最早/最晚时间和引用关系。
8. 经过回滚窗口和正式审计后，才能另写清理迁移删除无引用的旧索引或冗余结构；不得删除历史证据。

### 8.3 防死锁和查询

- 统一按主键顺序锁定；
- claim 使用短事务和 `FOR UPDATE SKIP LOCKED`；
- 外部 I/O 全部在事务外；
- 发布事务只操作必要快照和 active 指针；
- 禁止 `SELECT *`；
- 历史使用 `(published_at_utc, id)` 稳定游标；
- 观测使用 `(series_id, available_at_utc, observation_at_utc, id)` 索引；
- 事件使用 `(scheduled_at_utc, id)` 游标；
- JSON 大字段不进入列表查询。

## 9. 后台任务与运行架构

### 9.1 PM2 角色

在现有 PM2 项目中增加或扩展：`macro-scheduler`、`macro-ingest-worker`、`macro-research-worker`、`calendar-ingest-worker` 和 outbox dispatcher。可以由通用 Worker 承载低频队列，但用例、队列、并发、超时和指标必须独立。宝塔仍只管理一个 Node/PM2 项目。

### 9.2 队列合同

BullMQ 只携带 `v`、`job_id`、`job_kind`。Worker 从 MySQL 读取权威任务和输入；消息不得携带完整观测、模型正文、密钥或大 JSON。

### 9.3 幂等、租约和未知状态

建议幂等键：

- 采集：`provider:series:vintage_or_window`；
- 特征：`feature_set:data_cutoff:input_hash`；
- 训练：`model_key:training_cutoff:config_hash:input_hash`；
- 快照：`business_date:feature_set:model_version:input_hash`；
- 日历：`provider:event_id:provider_revision`。

每次 claim 增加 fencing token。超时后先进入 `status_unknown`；只有能证明外部进程已终止且没有结果，才允许重试。迟到结果不得覆盖新 generation。

### 9.4 Python 边界

模型研究允许固定 Python CLI，但只能由研究 Worker 有界启动。必须锁定依赖和路径、限制时间/内存/线程/输出、终止完整进程树、校验版本化 JSON Schema 和哈希、脱敏并限长日志，且 Python 不持有生产数据库写权限。

生产服务器不能稳定提供 Python 时，模型阶段保持关闭；V1 客观因子和经济日历不应因此不可用。

## 10. 分阶段研究与模型门槛

### 10.1 V1：客观数据与透明状态

先交付 point-in-time 数据链路、来源与新鲜度、因子水平/变化/历史分位/方向语义、冲突与缺失状态、经济日历、不可变快照、API、页面和运维。综合偏向只有在冻结规则经离线验证后显示，否则只展示因子。

### 10.2 V2：离线 champion/challenger

候选至少包括零收益、历史均值、黄金动量、线性/Elastic Net 和浅层 XGBoost。研究 20 日目标前必须预注册因子、窗口、截止规则、训练/校准/最终测试区间、主要指标、试验次数和淘汰标准，并保留不可触碰最终测试集。

### 10.3 统计验证

必须包含时间顺序 walk-forward、purge/必要 embargo、block bootstrap、HAC/Newey-West、样本外 IC/方向准确率及区间、Brier/校准误差、因子消融、阶段稳定性、简单基线、多重试验修正和 CPCV 路径依赖说明。

20 个交易日影子运行只叫“运营稳定性观察”，不得作为 alpha 有效性证据。

### 10.4 V3：概率、SHAP 与体制模型

- 概率只能来自独立样本外校准，不能把回归分数当概率；
- 回归方向和分类概率冲突时输出 `uncertain`；
- SHAP 只解释已激活模型并通过 additivity；
- HMM/Markov switching 必须优于持久性基线；
- 不达标时不显示概率或体制切换，不能为完成 UI 降低门槛。

### 10.5 生命周期

`draft -> evaluating -> shadow -> active -> retired`，评估失败进入 `rejected`。自动训练不得自动激活；激活需要管理员二次确认、expected revision、审计和回滚版本。

## 11. 与 AI 分析师的关系

### 11.1 同源不同投影

看板和分析师读取同一个权威快照：看板使用完整展示投影，分析师只使用受限 `analysis_evidence` 投影。分析任务冻结快照 ID、revision、schema、hash、cutoff 和 horizon。

### 11.2 策略显式开关

分析策略版本增加：

```json
{
  "macro_evidence": {
    "mode": "off | context | required",
    "accepted_schema_versions": [1],
    "max_age_seconds": 172800
  }
}
```

首发默认 `context`：可用则冻结，不可用则记录原因并继续原策略；它不能单独生成交易机会或替代技术触发。`required` 只允许专门验证的策略使用，缺失时返回不可评估而非放宽条件。当前隐式读取宏观快照的代码必须改为受策略版本控制。

### 11.3 五分钟调度

五分钟分析不访问外部宏观供应商、不运行宏观模型，只读取发布快照。新快照或高影响数据可登记一次分析触发，但仍受订阅、去重、latest-wins 和时效规则约束。

## 12. HTTP API 合同

### 12.1 用户接口

```text
GET /api/v4/market/overview
GET /api/v4/market/macro-snapshots/latest
GET /api/v4/market/macro-snapshots?before=<cursor>&limit=<1..100>
GET /api/v4/market/macro-snapshots/:snapshotId
GET /api/v4/market/macro-series
GET /api/v4/market/calendar-events?from=<iso>&to=<iso>&importance=<...>&cursor=<...>
GET /api/v4/market/calendar-events/:eventId
```

专业行情继续复用已有账户级行情接口。响应统一 `{ data, meta }` 和 RFC 9457 problem；Zod 合同放在 `frontend/packages/contracts`；列表不返回大 payload；历史使用稳定游标；支持 ETag；错误不泄漏密钥、Python 栈或 SQL。

### 12.2 管理接口

```text
GET   /api/v4/admin/macro/sources
PATCH /api/v4/admin/macro/sources/:sourceId
GET   /api/v4/admin/macro/jobs
POST  /api/v4/admin/macro/jobs
GET   /api/v4/admin/macro/models
POST  /api/v4/admin/macro/models/:modelId/activate
POST  /api/v4/admin/macro/models/:modelId/retire
GET   /api/v4/admin/macro/health
```

写操作必须有认证、RBAC、CSRF、幂等键、expected revision、二次确认和审计。API 只登记任务，不同步执行采集、训练或补算。

## 13. 浏览器实时合同

允许事件：`market.macro.changed`、`market.calendar.changed` 和仅管理员接收的 `market.source_health.changed`。事件只携资源 ID、revision、变化种类和必要时间，不携正文、全部因子或历史。

平台事件在服务端授权后按用户扇出；客户端收到事件后使 Vue Query 失效并 HTTP 回读。sequence 缺口、重连和权限变化时重拉快照。页面不得创建第二个 WebSocket，不得用 WebSocket RPC，也不得对日频宏观数据秒级轮询。

## 14. 权限、套餐与隐私

不再硬编码 Plus/Pro 或旧 observer tab，改用能力型 entitlement：`trade.market.read`、`trade.market.macro.read`、`trade.market.calendar.read`、`admin.macro.operate`。套餐映射由管理后台配置，服务端对 API 和 realtime 独立授权。

平台快照不含用户 ID、交易账号、资金、持仓或 Bridge 信息。日志不记录外部 API key。

## 15. 前端模块化与设计要求

建议目录：

```text
frontend/apps/trade/src/features/market/
├─ api/
├─ components/{professional,macro,calendar}/
├─ composables/
├─ model/
├─ realtime/
├─ views/
└─ __tests__/
```

专业行情、宏观和日历分别拥有组件和 composable，不形成超大 `MarketView.vue`。Button、Tabs、Table、Select、Popover、Dialog、Sheet、Tooltip、Skeleton、Alert、Badge、Progress 等优先使用共享 shadcn-vue 组件，不引入第二套 UI 库。

图表通过项目批准的适配层使用；新增可视化依赖要先评估体积、可访问性、生命周期和许可证。页面必须覆盖 loading、empty、partial、stale、no-access、error、realtime disconnected、source unconfigured 和 model unavailable。移动端使用详情 Sheet，避免大表横向拖动；触控目标至少 44px，并支持 reduced motion。

## 16. 管理后台与运营能力

后台提供数据源/许可、序列水位、任务状态、模型版本和报告、平台快照与哈希、陈旧/失败告警、功能开关、entitlement 映射和全部人工操作审计。密钥只能显示配置状态和脱敏指纹，不能读取明文。

## 17. 监控、保留与清理

监控来源成功率/延迟/限流、序列水位、queue lag、任务 unknown、Python 资源、快照发布延迟、API 分位延迟、payload、realtime resync 和 AI 引用快照版本。

已被快照引用的观测、artifact、训练报告和来源证据不得清理；已发布或被 AI 引用的快照长期保留。无引用临时对象按许可和审计策略分批清理，先标记候选、再检查引用、最后限速删除并记录审计。

## 18. 测试与验收

### 18.1 数据与数据库

- vintage 防未来数据、available 证据、修订不覆盖旧值；
- 单位、频率、日历、缺失和事件 revision；
- 许可关闭后不生成生产快照；
- 旧快照 ID/payload/hash 不变；
- user 旧记录不覆盖 V4 平台快照；
- 新库、生产结构和重复迁移；
- 索引、游标、双 Worker claim、迟到结果、fencing 和死锁重试。

### 18.2 模型

- 固定输入可复现；
- purge/embargo 无泄漏；
- block bootstrap/HAC 口径；
- 概率只来自样本外校准；
- 冲突输出 `uncertain`；
- SHAP additivity；
- HMM 与持久性基线；
- 无 active 模型时客观数据仍可用。

### 18.3 API、实时与前端

- 仅 `/api/v4`、strict contract、entitlement、RBAC、CSRF、幂等和 revision；
- ETag、cursor、payload 上限和错误脱敏；
- changed 小事件、授权扇出、重连、sequence gap 和 HTTP 回读；
- 360、390、768、1024、1280、1440、1920 宽度；
- 键盘、焦点、对比度、非颜色状态、长文本和 reduced motion；
- 图表销毁、切路由和后台恢复；
- 不混淆 20 日宏观背景与当前交易机会。

### 18.4 上线闸门

必须完成数据许可、migration rehearsal、旧数据零丢失对账、真实 PM2/MySQL/Redis 环境验证、至少一个可复现平台快照、API/实时/权限/响应式验收，并证明关闭宏观功能不影响行情、AI、交易、Bridge 和后台。全过程不执行真实交易指令。

## 19. 发布与回滚

独立开关：`TRADE_MARKET_WORKSPACE_ENABLED`、`MACRO_DATA_INGEST_ENABLED`、`MACRO_DASHBOARD_ENABLED`、`MACRO_MODEL_RESEARCH_ENABLED`、`MACRO_AI_EVIDENCE_ENABLED`、`ECONOMIC_CALENDAR_ENABLED`。

默认关闭，依次开放采集、管理员预览、shadow、用户只读页面和 AI `context`。回滚优先关闭开关并停止新任务，保留数据、快照和审计；数据库降级不删除新表或列。

## 20. 分阶段实施顺序

### M0：前置决策

批准黄金历史源、因子/日历许可、经济日历供应商、Python 环境；盘点现有快照；冻结合同和迁移策略。

### M1：合同与数据库

增加 contracts；追加数据源、观测、任务、模型、lineage 和日历表；扩展唯一快照表；完成旧数据标记、对账和 migration rehearsal。

### M2：采集与管理运维

实现独立 scheduler/worker、V1 来源和后台运维；发布透明因子快照，不启用 ML。

### M3：用户页面与实时失效

实现专业行情、宏观环境和日历；使用 shadcn-vue；接入 HTTP 和小型 changed 事件；完成响应式与可访问性验收。

### M4：离线模型研究

预注册实验，运行基线、线性模型和 XGBoost challenger，生成不可变报告并进入 shadow。未优于基线则停在 V1。

### M5：模型展示

激活达标模型；展示预测区间、校准概率和可验证 SHAP；HMM 仅在达标时启用。

### M6：AI 证据接入

增加策略级 `macro_evidence`，改造隐式 reader，冻结 evidence projection，验证回放、缺失、陈旧、策略关闭和审计。

## 21. 第一轮复审：架构、数据与产品边界

### 21.1 发现

1. 旧静态前端和旧 API 不适配 V4。
2. 新建同义快照表会与现有权威表冲突。
3. 当前分析构建器已隐式读取宏观快照。
4. 20 日方向容易和五分钟机会混淆。
5. 旧方案没有完整经济日历。
6. 首版模型范围过大。

### 21.2 调整

改为 V4 Vue/shadcn-vue、`/api/v4`、独立 Worker；统一唯一快照；AI 接入受策略控制；统一术语；增加经济日历；拆分 V1 数据和 V2/V3 模型。

### 21.3 结论

方案层冲突已消除，但数据许可、生产 Python、现有快照真实内容和经济日历供应商仍是实施前 blocker。

## 22. 第二轮复审：兼容、并发、安全、测试与回滚

### 22.1 发现

1. 事后猜测 `available_at` 会造成未来数据泄漏。
2. DDL、回填和 reader 一次切换会扩大锁和失败面。
3. API 启动 Python 会影响主进程。
4. 大 JSON 进入列表会降低性能。
5. 平台事件需要符合用户授权 scope。
6. 旧用户级快照需保留但不能继续覆盖平台事实。
7. 模型失败不能拖垮客观数据页面。

### 22.2 调整

增加可得性证据；拆分迁移步骤；Python 只由 Worker 启动；列表排除大字段并使用游标；平台事件授权扇出；旧记录保留为 legacy；V1 与模型链路独立开关。

### 22.3 结论

方案满足 V4 模块化、数据保留、异步任务、API/实时边界和可回滚要求。离线测试仍不能替代生产许可、真实运行环境或公网长稳证明。

## 23. 剩余风险与开始条件

### 23.1 剩余风险

- 统一黄金长期历史来源未批准；
- GVZ 商业展示/再分发许可未书面确认；
- 经济日历供应商、额度和许可未选择；
- 当前数据库宏观快照尚未做真实库只读盘点；
- 生产 Python、原生依赖、内存和回滚未验证；
- 20 日重叠目标有效样本有限，复杂模型可能不优于基线；
- GPR 和经济数据修订使可得性证据质量不一；
- 用户仍可能把中期偏向误认为入场建议；
- 平台级 realtime target/schema 需在实现前冻结；
- 可视化依赖可能增加体积和许可证风险。

### 23.2 进入实施前必须确认

1. 数据源和许可清单；
2. 经济日历供应商；
3. 是否接受 V1 不承诺 ML 综合方向，只先展示客观因子；
4. 现有数据库宏观数据只读盘点授权；
5. `/api/v4` 和 realtime 合同；
6. migration rehearsal 与备份恢复方案；
7. 管理员预览和用户开放顺序。

未完成以上确认前，不进入 M1，不创建迁移，不抓取外部数据，不启动宏观 Worker。
