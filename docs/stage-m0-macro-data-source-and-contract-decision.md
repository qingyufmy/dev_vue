# Stage M0 宏观研究数据源与合同冻结决策

> 状态：M0 完成，进入 M1 前置决策已冻结  
> 日期：2026-09-05  
> 适用范围：AI 交易实验室“市场行情 / 宏观环境 / 经济日历”与 AI 分析师宏观证据  
> 实施边界：本阶段只读核查数据库、代码和官方资料；未执行迁移、未创建数据库、未接入供应商、未启动 Worker、未触发交易

## 1. 决策摘要

1. V1 先交付可追溯的客观宏观因子、数据健康、经济日历和只读页面，不承诺机器学习综合方向或交易信号。
2. V1 核心因子冻结为 FRED/ALFRED 的 `DFII10`、`T10YIE`、`DTWEXBGS`；GPR 为可选因子，GVZ 在许可明确前保持关闭。
3. 统一黄金历史不是 V1 客观因子页面的上线阻塞项，但在 V2 任何预测、回测或敏感度统计开始前必须选定一个连续、定义明确、可用于建模的权威来源。
4. 统一黄金历史首选试用候选为 Twelve Data 的 XAU/USD Commodity Aggregate；EODHD 和 Trading Economics 作为对照候选。候选不等于批准，必须通过数据质量与书面许可闸门。
5. 经济日历首选试用候选为 Trading Economics，EODHD 为预算或降级候选。前者的稳定事件 ID、修订、重要性、更新时间和翻译能力更符合合同要求。
6. 浏览器完整数据一律通过 `/api/v4` HTTP 获取；WebSocket 只发送 `changed` 小事件，使对应 Vue Query 失效后回读 HTTP。
7. 分析策略未声明 `macro_evidence` 时默认 `off`。首发只接受 `off | context`；`required` 保留为未来模式，在完成独立验证前不得启用。
8. 宏观证据只能作为分析背景，不能单独制造交易机会、改变服务端风控、绕过技术触发或直接产生交易指令。
9. 当前 `dev_vue` 数据库是旧版迁移源，不是 V4 目标库。V4 SQL 明确只允许在空的旁路目标库执行，不得直接运行到 `dev_vue`。
10. M1 必须先解决并演练旧 `inference_snapshots` 与 V4 同名新表的旁路迁移，再实现宏观表与合同；禁止依赖 `CREATE TABLE IF NOT EXISTS` 掩盖结构冲突。

## 2. M0 核查事实

### 2.1 当前数据库

使用 `server/.env` 对 `dev_vue` 做只读查询，未输出凭据，得到：

| 项目 | 只读结果 |
| --- | --- |
| MySQL | 8.4.8 |
| 当前库 | `dev_vue` |
| 会话隔离级别 | `REPEATABLE-READ` |
| 最新旧版迁移 | `201_risk_reset_baseline_and_semantic_version` |
| `macro_research_snapshots` | 不存在 |
| `macro_observations` | 不存在 |
| `economic_calendar_events` | 不存在 |
| `ai_analysis_runs` / `market_analyses` | 不存在 |
| `inference_snapshots` | 存在，但为旧版结构 |

旧 `inference_snapshots` 使用 `BIGINT id`，并直接包含 `signal_id`、`system_prompt`、`user_prompt` 等宽字段；V4 迁移 `20260903_004_ai_strategy_and_inference_core.sql` 计划创建的是 `CHAR(36) id`、`purpose`、`user_id` 和独立 payload 表，两者不是同一结构。

### 2.2 当前源码

- `/market` 仍是前端占位路由，尚无宏观看板实现。
- V4 源码已有 `MysqlMacroSnapshotReader`，会从 `macro_research_snapshots` 读取平台或用户快照，并优先用户快照。
- `AnalysisContextBuilder` 当前无条件读取宏观快照，未受策略版本配置控制。
- 分析策略编译器当前只允许 `timeframes` 和 `candle_limit`，尚不接受 `macro_evidence`。
- 浏览器实时目标当前的 `market` 只支持账户级 quote/candle；平台级 macro/calendar 目标和事件尚未进入共享合同。
- `20260903_005_analysis_scheduler_and_account_fanout.sql` 在源码层定义了最小 `macro_research_snapshots`，但当前 `dev_vue` 实例没有应用该迁移。

### 2.3 迁移边界

`20260903_004_ai_strategy_and_inference_core.sql` 文件头已经明确：只可用于空的 V4 旁路数据库，绝不能直接运行到旧库。M0 冻结这一边界：

```text
dev_vue       = 旧版数据迁移源，只读保留
dev_vue_next  = V4 旁路演练目标，需另行授权后创建
```

当前并未创建或写入 `dev_vue_next`。M1 的 DDL、回填和校验必须在旁路目标完成；正式切换前仍需新备份、两次可重复迁移、逐用户对账和回滚演练。

## 3. 数据源决策

### 3.1 核心宏观因子

| 数据 | 冻结候选 | M0 决策 | 使用限制 |
| --- | --- | --- | --- |
| 美国 10 年实际利率 | FRED/ALFRED `DFII10` | V1 核心 | 保存 realtime/vintage 参数与来源权利信息 |
| 美国 10 年盈亏平衡通胀 | FRED/ALFRED `T10YIE` | V1 核心 | 同上 |
| 广义美元指数 | FRED/ALFRED `DTWEXBGS` | V1 核心 | 按来源日历判定陈旧，不按自然小时硬算 |
| 地缘政治风险 | Caldara-Iacoviello GPR | V1 可选 | CC BY；保存作者、来源和下载日期；周频更新不能伪装成日内数据 |
| 黄金隐含波动率 | Cboe GVZ | 条件关闭 | 只有商业展示、缓存和建模权利得到书面确认后才可启用 |
| 黄金矿业股 | GDX 来源待选 | V1 不纳入 | 避免为凑因子引入另一份未批准行情源 |

FRED/ALFRED API 能表达 real-time period 和 vintage dates，适合 point-in-time 读取，但每条序列仍可能包含第三方权利要求，不能把“API 可访问”当成“可公开再分发”。

### 3.2 统一黄金历史

统一黄金历史只服务于 V2 以后模型目标、敏感度与离线验证；专业行情实时图继续使用用户 Bridge 对应经纪商数据，两者不能混为同一价格真相。

| 候选 | 优点 | 主要缺口 | M0 排位 |
| --- | --- | --- | --- |
| Twelve Data XAU/USD Commodity Aggregate | 有明确的聚合商品口径和较长日线历史，接口适合统一序列 | 商业展示、缓存、衍生数据和模型使用权必须按实际产品书面确认；需验证时区、缺口、修订和 OHLC 定义 | 首选试用 |
| EODHD `XAUUSD.FOREX` | 接口简单，可与日历候选形成低成本组合 | 需要验证长期连续性、报价定义、外部展示和商用条款 | 对照候选 |
| Trading Economics Gold | 可与经济日历同供应商，降低集成数量 | 套餐历史深度、基准定义、缓存与外部展示权仍需销售确认 | 对照候选 |

试用验收必须比较同一冻结区间的：最早日期、交易日覆盖、重复/缺失、时区、OHLC 定义、异常跳点、修订行为、下载上限、原始响应哈希及许可证。未通过前不得选定训练真相。

### 3.3 经济日历

| 候选 | 合同能力 | 缺口 | M0 排位 |
| --- | --- | --- | --- |
| Trading Economics | `CalendarId`、计划时间精度、重要性、actual/previous/forecast、revised、`LastUpdate`、流式更新和中文翻译 | 套餐请求量与公开展示、缓存、历史保存权需书面确认 | 首选试用 |
| EODHD | 2020 年起历史与未来事件，具备国家、时间、actual/previous/estimate | 官方响应示例缺少稳定事件 ID、重要性和明确修订身份；需自行验证是否存在未文档字段且不可依赖推断 ID | 降级候选 |

日历首选的理由不是“功能多”，而是事件修订可追溯性更符合本项目的不可变证据要求。若商业许可不通过，则回到候选评审，不以抓网页替代。

### 3.4 许可状态机

数据源必须使用以下状态，只有 `approved` 能进入生产发布：

```text
candidate -> trial -> legal_review -> approved -> suspended -> retired
```

每个来源保存：用途、套餐/合同版本、展示权、缓存权、留存权、建模权、衍生数据权、署名文本、地域限制、速率限制、延迟、停用日期和复核人。密钥只保存于服务端秘密配置，不进入数据库明文、日志、前端或队列。

## 4. V1 产品与因子合同

### 4.1 V1 只回答什么

V1 允许回答：

- 因子当前值、变化、历史分位和更新时间；
- 按冻结且可解释规则，该因子通常对黄金构成 `supportive | adverse | neutral | uncertain` 哪种背景；
- 数据是否新鲜、缺失、冲突或来源异常；
- 近期高影响经济事件、实际值与预期差异；
- 本次宏观快照使用了哪些 observation/vintage。

V1 不回答：

- “黄金必涨/必跌”；
- 未校准的上涨概率；
- 当前精确入场、止盈、止损或仓位；
- 因子与黄金之间未经验证的因果结论；
- 以宏观背景替代 AI 分析师的技术行情判断。

### 4.2 V1 新鲜度建议值

这些是进入试用时的初始建议，不是未经数据验证的永久常量。最终值必须由来源日历测试冻结：

| 序列 | 建议最大陈旧 | 规则 |
| --- | --- | --- |
| FRED 日频核心因子 | 3 个美国工作日 | 节假日按来源日历延展；来源中断不可被周末规则掩盖 |
| GVZ | 2 个 Cboe 工作日 | 未获许可时状态恒为 disabled，不参与完整性 |
| GPR Daily | 10 个自然日 | 因官方按周更新，页面同时展示原 observation date 与最近下载时间 |
| 经济日历实际值 | 按事件计划时间和供应商更新时间 | 到时未发布显示 pending/delayed，禁止填 0 或猜测 |

### 4.3 时间与可得性

所有观测至少包含：

```text
observation_at_utc
available_at_utc
ingested_at_utc
provider_updated_at_utc?
availability_confidence = exact | provider_date | retrieval_only | unknown
```

历史回放只可读取 `available_at_utc <= feature_cutoff_at_utc` 的最后可用版本。`retrieval_only` 和 `unknown` 可以展示为当前事实，但不能进入严格 point-in-time 回测。

## 5. HTTP API 合同冻结

### 5.1 路径与通用规则

用户接口冻结为：

```text
GET /api/v4/market/overview
GET /api/v4/market/macro-snapshots/latest
GET /api/v4/market/macro-snapshots
GET /api/v4/market/macro-snapshots/{snapshot_id}
GET /api/v4/market/macro-series
GET /api/v4/market/calendar-events
GET /api/v4/market/calendar-events/{event_id}
```

管理接口冻结为：

```text
GET   /api/v4/admin/macro/sources
PATCH /api/v4/admin/macro/sources/{source_id}
GET   /api/v4/admin/macro/jobs
POST  /api/v4/admin/macro/jobs
GET   /api/v4/admin/macro/models
POST  /api/v4/admin/macro/models/{model_id}/activate
POST  /api/v4/admin/macro/models/{model_id}/retire
GET   /api/v4/admin/macro/health
```

通用规则：

- 响应使用 `{ data, meta }`；错误使用 RFC 9457；Zod 为前端运行时合同。
- ID 为字符串；UTC 为带 `Z` 的 ISO 8601；精确数值以十进制字符串传输，避免 JS 浮点改变事实。
- 列表使用不透明稳定游标，不接受页码；默认 `limit=20`，上限 100。
- 私有响应默认 `Cache-Control: no-store`；平台只读宏观响应可使用 ETag 和短时 private cache。
- `overview` 只聚合最新宏观摘要和近期高影响日历摘要，不复制专业行情、完整快照或历史数组。
- 列表不返回大 payload、来源原始响应、模型 artifact 或完整 lineage。

### 5.2 最新快照 DTO

```json
{
  "data": {
    "id": "mac_...",
    "schema_version": 1,
    "revision": "1",
    "business_date": "2026-09-05",
    "horizon": "medium_term",
    "data_cutoff_at": "2026-09-05T08:00:00.000Z",
    "published_at": "2026-09-05T08:01:00.000Z",
    "valid_until": "2026-09-06T08:01:00.000Z",
    "status": "fresh",
    "direction": "uncertain",
    "summary": "核心因子存在分歧，暂不形成综合方向。",
    "factors": [
      {
        "code": "DFII10",
        "label": "美国10年实际利率",
        "value": "1.82",
        "unit": "percent",
        "observation_at": "2026-09-04T00:00:00.000Z",
        "available_at": "2026-09-05T00:00:00.000Z",
        "freshness": "fresh",
        "gold_relation": "adverse"
      }
    ],
    "content_sha256": "..."
  },
  "meta": {
    "request_id": "req_..."
  }
}
```

冻结枚举：

- `status = fresh | stale | partial | unavailable`
- `direction = supportive | adverse | neutral | uncertain`
- `freshness = fresh | stale | missing | disabled | invalid`
- `gold_relation = supportive | adverse | neutral | uncertain`

V1 的 `direction` 只有在透明合成规则经过离线冻结测试后才可为前三种；否则必须为 `uncertain`。该方向是中期研究背景，不是买卖信号。

### 5.3 经济日历 DTO 核心字段

列表项至少包含：`id`、`provider_event_id`、`country`、`currency`、`title`、`scheduled_at`、`time_precision`、`importance`、`period`、`unit`、`previous`、`consensus`、`actual`、`revised_previous`、`status`、`provider_updated_at`、`revision`。

冻结枚举：

- `time_precision = exact | date_only | tentative`
- `importance = low | medium | high | unknown`
- `status = scheduled | released | revised | delayed | cancelled`

供应商没有字段时必须明确返回 `null` 或 `unknown`，禁止由标题拼出稳定 ID，也禁止把空值变成 0。

## 6. WebSocket 合同冻结

### 6.1 订阅目标

在现有单一浏览器 WebSocket 上扩展平台级 market target：

```json
{
  "kind": "market",
  "trading_account_id": null,
  "observer_channel_id": null,
  "symbol": null,
  "timeframe": null,
  "resource_id": "macro",
  "after_revision": null
}
```

`resource_id` 只允许 `macro | calendar`。它与账户级 `market quote/candle` 共用 `kind=market`，但平台目标必须没有交易账户和观摩频道。平台列表/最新指针没有可安全重放的连续 revision，因此 `after_revision` 固定为 `null`。

管理后台另增加受 RBAC 限制的 `kind=admin, resource_id=macro_source_health`，不得让普通交易用户订阅来源错误明细。

### 6.2 事件

| 事件 | resource.kind | 最小 data | HTTP 恢复源 |
| --- | --- | --- | --- |
| `market.macro.changed` | `macro_snapshot` | `change`, `published_at`, `status` | latest/detail snapshot |
| `market.calendar.changed` | `calendar_event` | `change`, `scheduled_at`, `importance`, `status` | event list/detail |
| `market.source_health.changed` | `macro_source_health` | `source_id`, `health`, `observed_at` | admin macro health |

`change` 只允许 `created | updated | superseded | invalidated`。事件包络沿用 `aurum.realtime.v4`：平台事件仍由服务端填充已认证用户的 `scope.user_id`，其余 scope ID 为 `null`。事件不携完整快照、全部因子、原始供应商响应、日历正文或错误堆栈。

客户端收到事件只做：校验合同与 scope -> 丢弃旧事件 -> 使精确 query key 失效 -> HTTP 回读。不得增加第二条 WebSocket、WebSocket RPC 或日频数据秒级轮询。

## 7. AI 分析师宏观证据合同

### 7.1 策略配置

分析策略配置扩展为：

```json
{
  "timeframes": ["M5", "M15", "H1", "H4"],
  "candle_limit": 300,
  "macro_evidence": {
    "mode": "off",
    "accepted_schema_versions": [1],
    "max_age_seconds": 172800
  }
}
```

冻结规则：

- 缺少 `macro_evidence` 等同 `mode=off`，保证现有策略不发生隐式行为变化。
- M6 首发编译器只接受 `off | context`；`required` 作为保留枚举写入设计，但不得在首发合同接受。
- `accepted_schema_versions` 为 1 至 8 个不重复正整数；`context` 时必填。
- `max_age_seconds` 为 3600 至 604800 的整数；`context` 时必填。
- `off` 时不读取宏观表，输入快照明确保存 `{ "status": "disabled" }`。
- `context` 时只读取已发布、平台级、schema 被接受、哈希正确且未超过策略 age 上限的快照。
- 缺失、陈旧、schema 不兼容或哈希错误时保存明确状态与原因；除系统完整性错误外，不能自动切换成更宽松策略。

### 7.2 受限 evidence projection

模型输入只包含：快照 ID、revision、schema、cutoff、published/valid time、status、中期 horizon、因子方向/值/单位/时间/新鲜度、简短可审计摘要和 content hash。不得包含供应商密钥、内部许可文本、原始响应、训练集、模型 artifact 或管理告警。

提示词与输出合同必须明确：

- 宏观证据是中期背景，不是当前入场点；
- 宏观证据不能单独把 `opportunity=none` 改成交易机会；
- 宏观证据不能生成服务端交易命令、仓位或风控例外；
- 技术行情与宏观背景冲突时应陈述冲突，不能伪造确定性；
- AI 交易员和服务端硬风控仍使用各自冻结输入与确定性规则。

## 8. M1 数据库与迁移闸门

M1 不直接在 `dev_vue` 增加宏观表。正确顺序：

1. 用户另行授权后，对 `dev_vue` 生成可恢复备份并记录哈希、版本和冻结时间。
2. 创建空的旁路目标库，验证其不是旧库、没有业务表且连接配置独立。
3. 从 `20260903_001` 开始在目标库执行 V4 结构迁移，并对每个迁移记录文件哈希。
4. 使用专用回填程序把旧 `inference_snapshots` 转换到 V4 `inference_snapshots + inference_snapshot_payloads`，绝不在源表原地 ALTER。
5. 在 V4 目标中扩展 `macro_research_snapshots`，新增观测、lineage、任务和日历表；迁移编号使用 `20260905_015_*` 起的下一个实际空闲编号。
6. 当前源库没有宏观快照，因此不存在需要伪造的旧宏观记录；若正式公网快照后来出现同名数据，必须重新只读盘点并增加显式转换分支。
7. 同一源快照至少完整迁移两次，逐用户数量、稳定主键、关键字段和大载荷 SHA-256 一致。
8. 只有 API、Worker、WebSocket、AI 输入、前端和回滚演练都通过后才允许切换配置。

必须加入预检：目标库一旦发现 `inference_snapshots` 存在但结构指纹不等于 V4，迁移立即失败关闭；不得因 `IF NOT EXISTS` 继续。

## 9. M1 验收门

- contracts 先于路由实现，前后端共用同一 Zod 字段与枚举。
- 分析策略编译器支持冻结的 `macro_evidence` 且默认 `off`。
- `off` 路径证明不会查询宏观表；`context` 的缺失、陈旧、schema、hash 分支都有测试。
- 平台 macro/calendar realtime target 有鉴权、非法账户 scope 拒绝、事件限载、断线回读测试。
- 迁移预检能识别旧/V4 `inference_snapshots` 同名异构并失败关闭。
- 所有 DDL 仅在旁路目标演练；源 `dev_vue` 零写入。
- 任何数据源仍处于 candidate/trial 时，生产采集与用户展示开关保持关闭。

## 10. 第一轮复审：产品、数据与 AI 边界

### 10.1 发现

1. 原方案把统一黄金历史列为首版必需，会把 V1 客观数据页面与 V2 模型研究错误绑死。
2. 原方案默认 `macro_evidence=context`，会让所有旧分析策略在无显式发布的情况下改变输入。
3. 供应商“有接口”不代表产品具备公开展示、缓存、长期保留和建模权。
4. 中期宏观背景若直接显示为“偏多/偏空概率”，普通交易者容易误认成入场建议。

### 10.2 调整

- 黄金统一历史改为 V2 前置，不阻塞 V1。
- 策略默认改为 `off`，首发只支持 `off | context`。
- 引入数据源许可状态机与书面权利闸门。
- V1 使用 `supportive/adverse/neutral/uncertain` 的黄金背景语义，不使用买卖动作或未校准概率。

### 10.3 结论

产品边界通过。V1 可在不引入模型风险和隐式策略变化的前提下先提供有价值的宏观事实。

## 11. 第二轮复审：迁移、协议与运行风险

### 11.1 发现

1. 方案文字曾把源码迁移定义的表误写成当前数据库已存在。
2. 当前旧表 `inference_snapshots` 与 V4 新表同名异构，直接运行迁移会被 `IF NOT EXISTS` 掩盖。
3. 当前实时协议不允许无账户的 market target，平台宏观事件尚无授权与合同。
4. 当前 reader 允许用户宏观快照覆盖平台事实，并且无条件进入分析输入。

### 11.2 调整

- 明确 `dev_vue` 是只读迁移源，V4 migration 只跑空旁路库。
- 增加结构指纹预检、专用回填和两次可重复迁移门。
- 冻结平台 `market/macro|calendar` target 和管理员 health target。
- 新发布宏观事实仅允许平台 scope；AI reader 改由策略显式控制。

### 11.3 结论

架构合同可进入 M1 设计与实现，但仍不授权创建目标库、执行迁移或购买供应商。M1 开始前需要用户单独确认数据库旁路演练和试用供应商范围。

## 12. 剩余风险与待用户决策

- Twelve Data、Trading Economics、EODHD、Cboe 的最终商业权利尚未取得书面确认。
- 候选供应商尚未做同区间数据质量对比，不能批准训练真相或事件主键策略。
- FRED 的具体序列权利与产品署名文案仍需逐条登记。
- V4 旁路数据库尚未创建，旧数据回填程序和结构指纹尚未实现。
- 平台级 realtime 合同尚未进入共享 Zod 和服务端授权代码。
- V1 因子合成规则尚未经过冻结区间验证，因此默认综合方向应为 `uncertain`。

## 13. 官方资料基线

- FRED/ALFRED observations 与 vintage 参数：<https://fred.stlouisfed.org/docs/api/fred/series_observations.html>
- FRED API 条款：<https://fred.stlouisfed.org/docs/api/terms_of_use.html>
- Caldara-Iacoviello GPR 数据与许可：<https://www.matteoiacoviello.com/gpr.htm>
- Cboe 历史 GVZ 数据入口：<https://www.cboe.com/tradable_products/vix/vix_historical_data>
- Twelve Data 商品聚合列表：<https://twelvedata.com/exchanges/commodity>
- Twelve Data 商业与个人用途说明：<https://support.twelvedata.com/en/articles/5332349-commercial-and-personal-usage>
- Twelve Data 条款：<https://twelvedata.com/terms>
- Trading Economics 经济日历字段：<https://docs.tradingeconomics.com/economic_calendar/schema/>
- Trading Economics 日历流式更新：<https://docs.tradingeconomics.com/economic_calendar/streaming/>
- Trading Economics 日历翻译：<https://docs.tradingeconomics.com/economic_calendar/translations/>
- Trading Economics API 套餐：<https://tradingeconomics.com/api/pricing.aspx?source=basic-pricing-list>
- EODHD 经济事件字段：<https://eodhd.com/financial-apis/economic-events-data-api>
- EODHD 外汇品种列表：<https://eodhd.com/financial-apis/list-supported-forex-currencies>
- EODHD 条款：<https://eodhd.com/financial-apis/terms-conditions>

价格、配额和许可条款会变化，实施或采购前必须重新核对官方页面并获得与实际用途一致的书面确认。
