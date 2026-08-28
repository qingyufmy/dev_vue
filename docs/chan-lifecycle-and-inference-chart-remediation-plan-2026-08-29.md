# 缠论当前结构生命周期与推理图层修复方案

> 日期：2026-08-29
> 基线分支：`dev_codex`
> 基线提交：`d05d7d97d945dafa5dda5c9aa829a4ac681cb09c`
> 本文状态：审查与实施方案，不包含算法修改、提交、推送或部署

## 1. 结论

当前问题不是“虚拟机仍在运行旧版缠论算法”，也不是推理详情读取了另一轮行情。信号 `#16401` 的冻结快照与当前提交直接重算结果一致，四个周期均为 `chan_structure_v7 / chan_window_v7`。

已确认的问题共有五类：

1. **P0：未收盘 K 线进入缠论当前方向归约。** 分型和确认笔使用已收盘 K 线，但 `developing_bi` 与 `latest_price / price_vs_center` 仍可能读取最后一根未收盘 K 线，导致 `local_bias`、`reversal_watch` 或中枢相对位置提前变化。
2. **P0：已确认活动分型被后续已收盘 K 线破坏后，候选笔没有失效。** 底分型下破后仍生成向上 `developing_bi`，顶分型上破时存在完全对称的问题。
3. **P1：推理图缺少最新“笔、候选笔、分型、未确认延伸”的几何数据与图层。** 页面只画旧的已确认线段，因此画面看起来停留在过去；当前对象本身也缺少可绘图的时间坐标。
4. **P1：按需读取的周期证据没有把 `timeframe_summary` 合并回图表上下文。** 当轻量快照未内嵌该周期摘要时，接口虽返回完整摘要，前端仍可能只使用 K 线而画不出结构。
5. **P2：通用文本翻译会把未知 `snake_case` 粗暴替换成“相关状态尚未确认”。** 这会掩盖真实字段含义，但不改变模型输入或交易执行。

修复应先保证“已收盘边界”和“活动分型生命周期”正确，再补齐快照坐标与图层。**本批次不调整策略核心逻辑，不让模型重新计算缠论，不增加服务端策略型下单硬限制。**

## 2. 审查范围与证据

### 2.1 已核对链路

- 原始/冻结 K 线 → 包含关系处理 → 分型 → 笔 → 线段/中枢 → `latest_structure`
- `latest_structure` → `trend_state` → `evidence_capabilities.local_structure_usable`
- 多窗口选择 → 模型载荷投影 → 推理冻结快照 → 详情接口 → 前端图表
- 通用输出文本 → 前端字段翻译

### 2.2 冻结样本 `#16401`

M5 冻结行情中：

- 系统保留的底分型为 `4551.53`，约在 18:20，18:25 完成确认；
- 后续已收盘 K 线已出现 `4546.78`、`4534.58`、`4532.12` 的更低低点；
- 当前结果却仍是：
  - `current_bi = down 4582.70 → 4551.53`
  - `developing_bi = up 4551.53 → 4569.19`
  - `latest_structure.local_state = reversal_watch`
  - `latest_structure.local_bias = up`

这说明旧底分型虽然仍可作为“历史已确认分型”保留，但已经不能继续作为有效向上候选笔的起点。当前代码没有表达这一区别。

### 2.3 代码证据

| 位置 | 当前行为 | 问题 |
|---|---|---|
| `server/routes/ai/market-data.js:2055-2057` | 构造了 `closedRates`，但 `latest` 读取 `rates` 最后一根 | 未收盘收盘价可进入缠论趋势/中枢归约 |
| `server/routes/ai/market-data.js:2152-2160` | 分型使用 `closedRates`，`buildDevelopingBi(activePivot, rates)` 使用全量 `rates` | 同一份缠论结果混用已收盘与未收盘边界 |
| `server/routes/ai/market-data.js:445-464` | 底分型只寻找后续最高点；顶分型只寻找后续最低点 | 不检查候选笔起点是否已被反向新低/新高破坏 |
| `server/routes/ai/market-data.js:1441-1495` | 只要确认笔与候选笔方向相反就进入 `reversal_watch` | 无活动分型有效性条件，错误候选方向被提升为当前方向 |
| `server/routes/ai/market-data.js:1631-1669` | `developing_direction` 可直接成为 `trend_state.local_bias` | 上游错误被放大并送入策略路径 |
| `server/routes/ai/market-data.js:1840-1870` | 有方向且有分型/笔即可令 `local_structure_usable=true` | 无法区分“有效候选反转”和“起点已破坏” |
| `server/routes/ai/market-data.js:2475-2477` | 当前笔、候选笔、最近笔只有方向与价格 | 冻结快照缺少前端绘制所需的时间坐标 |
| `public/ai/app.js:14204-14216` | 只画 `prev_segment/current_segment/candidate_segment` | 最新笔、候选笔和分型全部缺席 |
| `public/ai/app.js:13987-14001` | 按需证据只回填 K 线，结构仍只从内嵌 frame 读取 | `timeframe_summary` 已返回但未被图表使用 |
| `public/ai/app.js:14039-14055` | 固定写“最后一根为未收盘 K 线”，平台标签取当前桥接状态 | 历史快照说明可能与当时数据状态不一致 |
| `public/ai/app.js:1874-1877` | 所有未知下划线字段统一降级成同一句话 | 字段解释丢失，多个状态被显示成同一含义 |

### 2.4 已排除项

- 不是部署版本落后：本地、虚拟机与 `origin/dev_codex` 提交一致。
- 不是冻结快照串号：页面读取的就是 `#16401` 对应快照。
- 不是重算漂移：使用冻结行和保存的结构锚点，以当前代码直接重算，M5/M15/H1/H4 的主要结构字段与保存结果一致。
- 不是旧的候选线段退役修复被回滚：之前修复的是线段候选确认、失效和历史退役；本次缺口位于更低一层的“活动分型 → 候选笔”。
- 详情接口不是完全缺数据：周期摘要会由服务端返回，主要缺陷是笔对象没有坐标，以及前端按需证据未接入摘要。

## 3. 正确的生命周期语义

### 3.1 不重写历史确认结果

已确认分型和已确认笔是历史事实，不因后续价格变化被删除或改成未确认。修复不能重绘历史确认链，也不能直接把 `current_bi.end_price` 改成尚未形成分型的新极值。

### 3.2 区分“历史已确认”与“当前仍可作为候选起点”

为活动分型增加独立生命周期，而不是复用 `confirmed=true/false`：

- `active`：已确认，且后续已收盘 K 线尚未越过该分型极值；可作为反向候选笔起点。
- `origin_breached`：底分型之后出现更低低点，或顶分型之后出现更高高点；历史确认仍保留，但不可再生成相反方向候选笔。
- `replaced`：出现并被笔规则接受的同类型更极端新分型，活动起点迁移到新分型。
- `unavailable`：没有足够结构确定活动起点。

破坏条件仅使用**已收盘 K 线的高低点**：

- 底分型：后续已收盘 K 线 `low < pivot.price` 才算破坏；相等不扩大现行严格比较规则。
- 顶分型：后续已收盘 K 线 `high > pivot.price` 才算破坏。
- 未收盘 K 线只可用于独立的实时价格展示，不参与上述状态。

### 3.3 当前方向归约

| 条件 | `developing_bi` | `local_state` | `local_bias` |
|---|---|---|---|
| 活动分型有效，已出现反向运动，且与最后确认笔反向 | 有效候选笔 | `reversal_watch` | 候选笔方向 |
| 活动分型有效，但尚无有效反向运动 | `null` | `continuation` | 最后确认笔方向 |
| 活动分型起点已被破坏 | `null` | `continuation` | 最后确认笔方向 |
| 没有最后确认笔且无法形成可靠候选 | `null` | `unavailable` | `neutral` |

同时增加只读诊断字段：

- `latest_structure.active_pivot_state`
- `latest_structure.direction_basis`
- `latest_structure.pivot_breach_price`
- `latest_structure.pivot_breach_time_utc_msc`
- `latest_structure.continuation_extreme_price`
- `latest_structure.continuation_extreme_time_utc_msc`

这些字段由系统计算，只解释既有结论，不要求模型根据 K 线重新推导。

## 4. 分阶段实施方案

### 阶段 A：统一已收盘边界（P0）

涉及：`server/routes/ai/market-data.js`

1. 在 `computeChanWindow` 入口只生成一次 `closedRates` 与 `closedLatest`。
2. `buildDevelopingBi` 改为只接收 `closedRates`。
3. 缠论结果内的 `latest_price`、`price_vs_center`、背景趋势中枢比较统一使用 `closedLatest`。
4. 实时价格继续保留在通用行情对象的 `latest_price`，不得混入 `summary.chan` 的已收盘结构口径。
5. 给缠论结果增加 `as_of_closed_bar_time_utc_msc`，明确当前结构截止时间。

验收：只改变最后一根未收盘 K 线的高低收，完整 `summary.chan` 必须逐字段不变；把该 K 线标记为已收盘后，才允许结构发生变化。

### 阶段 B：修复活动分型与候选笔生命周期（P0）

涉及：`server/routes/ai/market-data.js`

1. 新建纯函数 `inspectActivePivotLifecycle(activePivot, closedRates)`，返回活动状态、破坏极值及时间位置。
2. `buildDevelopingBi` 只有在 `active_pivot_state=active` 时才能生成候选笔。
3. 候选笔同时检查两个方向：寻找目标方向极值之前，先确认起点未被后续已收盘 K 线反向越过。
4. `buildLatestChanStructure` 根据活动分型状态归约，不再仅以“确认笔方向与候选方向相反”判定 `reversal_watch`。
5. `prioritizeLatestChanStructure` 只接受生命周期有效的 `developing_direction`；非法或未知状态不得成为 `local_bias`。
6. `buildChanEvidenceCapabilities` 保持策略通用：不新增下单硬门槛，只保证 `local_structure_usable` 对应的方向来源有效且可解释。
7. 多窗口选择继续以完整窗口为权威，但加入不改变执行结果的尾部生命周期一致性诊断；若窗口间不一致，记录 warning，不用较短窗口覆盖完整窗口。
8. 生命周期语义发生变化后将算法标识升级为 `chan_structure_v8`，模型载荷审计标识升级为 `chan_model_payload_v2`；旧 v7 锚点不冒充新算法锚点。

对 `#16401` 的预期结果：

- `latest_confirmed_fractal` 仍可保留底分型 `4551.53`，但标记 `active_pivot_state=origin_breached`；
- `developing_bi=null`；
- `local_state=continuation`；
- `local_bias=down`；
- 不再把该旧底分型解释成有效的 M5 向上反转观察。

### 阶段 C：补齐结构坐标，但不扩大模型请求（P1）

涉及：

- `server/routes/ai/market-data.js`
- `server/routes/ai/chan-model-payload.js`
- `server/routes/ai/inference-snapshots.js`

1. 为 `current_bi`、`recent_bis`、`developing_bi` 和活动分型摘要补齐：
   - `start/end_time_utc_msc`
   - `start/end_broker_time`
   - 必要的原始索引，仅用于审计回放
2. 对 `origin_breached` 提供独立的“未确认同向延伸”坐标；明确它不是已确认笔，不得放进 `recent_bis`。
3. 内部冻结快照保留这些坐标，以便精确绘图和复现。
4. 模型载荷投影对笔对象采用显式字段白名单，剔除纯绘图坐标，避免增加正常推理请求大小。
5. 不把 `historical_candidate_segment` 重新送给模型；退役历史只能用于审计显示。

### 阶段 D：重构推理详情图层（P1）

涉及：`public/ai/app.js` 及相关样式文件

建议图层表达：

- **线段**：已确认线段使用金色实线；有效形成中线段使用灰色虚线。
- **笔/分型**：最近确认笔使用细实线；有效候选笔使用虚线；最新分型使用顶/底标记。
- **未确认延伸**：活动分型被破坏后的同向延伸使用单独的浅色虚线，并明确标注“未确认延伸”，绝不标成已确认笔。
- **历史退役候选**：默认不显示；审计模式可使用灰色点线，图例必须写“已退役候选”。
- **中枢、背驰、买卖点**：保持现有独立开关，但所有对象均按冻结时间坐标定位。

同时修复：

1. `chanSummaryForTimeframe` 优先读取本周期按需证据的 `timeframe_summary.summary.chan`，再回退到内嵌 frame。
2. 图表头部根据冻结 `market_data_quality.last_bar_closed` 动态显示最后一根状态。
3. 平台和时间标签读取冻结快照来源，不读取用户当前连接的桥接平台。
4. 增加“结构覆盖说明”：当已确认线段端点早于当前已收盘行情，但最新笔/分型存在时，提示“线段为历史确认结构，当前变化见笔/分型层”，避免把旧线段误解为算法停算。
5. 缺少坐标时显示具体缺失对象，不再只给笼统的“旧快照不完整”。

### 阶段 E：修复通用字段翻译（P2）

涉及：`public/ai/app.js` 与前端治理测试

1. 保留通用输出字段，不增加策略专属强制格式。
2. 对已知结构字段和值采用显式映射，例如 `local_state`、`local_bias`、`active_pivot_state`、`direction_basis`、`reversal_watch`、`origin_breached`。
3. 仅当整段内容确实是未知内部代码时才使用通用兜底；不得在中英文混合说明中把每个未知 token 分别替换成同一句话。
4. 原始结构化 JSON 键名不改，翻译仅发生在展示层，不影响持久化、模型输出解析和执行合约。

### 阶段 F：策略与提示词边界

本轮算法修复后，策略提示词原则上无需改动：

- 保持“系统提供的缠论数据是唯一权威”；
- 不写分型、笔、线段、中枢或背驰计算公式；
- 不要求模型从原始 K 线补算；
- 不新增服务端策略型硬拦截；
- 不改变 H1 主判、H4 备判和现有 M15/M5 入场结构。

只有在新增诊断字段需要展示说明时，才增加一句通用字段语义，不能修改现有路径门槛或放宽下单条件。

## 5. 回归测试与验收矩阵

### 5.1 算法单元测试

必须新增以下成对用例：

1. 底分型有效 → 形成向上候选笔 → `reversal_watch/up`。
2. 底分型被后续已收盘更低低点破坏 → 候选笔失效 → `continuation/down`。
3. 顶分型有效 → 形成向下候选笔 → `reversal_watch/down`。
4. 顶分型被后续已收盘更高高点破坏 → 候选笔失效 → `continuation/up`。
5. 未收盘 K 线刺破底/顶分型 → 结构完全不变。
6. 同一根 K 线收盘后再刺破 → 生命周期才切换。
7. 后续同类型更极端分型被规则接受 → 活动起点迁移，不重写此前已确认笔。
8. 相等高/低不触发严格破坏，保持现行边界。

### 5.2 冻结行情回归

- 固化 `#16401` M5 冻结样本为脱敏 fixture。
- 增加一份完全对称的顶分型上破 fixture。
- 对 M5/M15/H1/H4 逐周期执行当前代码直接重算。
- 比较算法修复前后的：分型、最近笔、候选笔、活动分型状态、`local_state`、`local_bias`、`trend_state`、能力位。
- 确认线段、中枢、历史背驰等未受本次低层生命周期修复的非预期重绘。

### 5.3 跨窗口与前缀稳定性

- 所有验证窗口最后已收盘时间必须一致。
- 完整权威窗口与较短验证窗口对活动分型状态存在差异时，只记录诊断，不允许较短窗口覆盖完整窗口。
- 给历史前缀增加无关旧 K 线，当前尾部生命周期在窗口收敛后必须一致。
- 去掉或加入最后一根未收盘 K 线，结果必须一致。

### 5.4 模型载荷与策略回放

- `chan-model-payload` 快照测试确认模型只收到结构语义，不收到绘图坐标和退役历史。
- 比较修复前后请求体大小；坐标只进入冻结审计数据，正常 AI 请求不得明显增大。
- 使用同一冻结提示词、同一模型参数回放 `#16401`，检查模型是否按修正后的 `local_bias=down` 理解行情。
- 模型是否下单不是算法单元测试的正确性判据；只检查其没有引用已失效候选笔作为入场理由。

### 5.5 前端图表测试

- 使用真实形状的 Chan 摘要，不再把 `chanSummaryForTimeframe` stub 成空对象。
- 验证已确认线段、最近笔、候选笔、分型、未确认延伸分别生成不同 series/marker 与图例。
- 验证退役候选不会被标成当前结构。
- 验证按需 `timeframe_summary` 能绘制结构。
- 验证最后一根收盘状态与冻结快照一致。
- 验证未知字段不会污染整段中文说明。

### 5.6 执行命令与上线验收

实施后至少运行：

```powershell
npm test -- --run tests/ai/chan.test.js tests/ai/chan-model-payload.test.js tests/ai/inference-snapshots.test.js tests/ai/frontend-precise-fixes.test.js tests/ai/frontend-governance.test.js
npm test
```

虚拟机验收只做只读核对：

1. 部署 `dev_codex` 后确认提交、单进程和启动日志一致。
2. 等待至少覆盖 M5、M15、H1 各一次新收盘的自动分析。
3. 对新信号冻结快照做直接重算，确认保存值等于当前代码结果。
4. 浏览器检查各周期图层的最新端点、图例和文字说明。
5. 核对信号到订单链路，但不得因本次验收人工补单、重试或修改数据库。

## 6. 实施顺序、提交边界与回滚

建议拆成三个独立提交：

1. `fix(ai): enforce closed-bar Chan pivot lifecycle`
   - 阶段 A、B 及算法测试。
2. `fix(ai): preserve Chan visualization coordinates`
   - 阶段 C、快照与模型投影测试。
3. `fix(frontend): render current Chan lifecycle evidence`
   - 阶段 D、E 及前端测试。

回滚原则：

- 三个提交可独立回滚；前端问题不得迫使算法回滚。
- 算法提交若造成历史确认线段或中枢大面积重绘，立即停止上线，保留 fixture 和差异报告后回滚。
- 不做数据库迁移；无须数据回填。旧快照缺少笔坐标时继续降级显示，不伪造坐标。
- 先在虚拟机验证，确认后再决定是否同步主分支和公网；本文不授权推送或部署。

## 7. 两轮方案自审

### 第一轮：缠论语义审查

调整结果：

- 没有把“活动分型起点失效”等同于“历史分型从未确认”。
- 没有用尚未成型的新极值重写已确认笔。
- 把“未确认同向延伸”与“反向候选笔”分开，避免继续混画成线段或笔。
- 顶、底两侧采用对称规则，并严格限定为已收盘 K 线。

### 第二轮：系统边界与误伤审查

调整结果：

- 不新增策略专属服务端硬限制，不影响其他策略的通用输出合约。
- 不让 AI 重算缠论，不在提示词写公式。
- 绘图坐标不进入模型请求，避免增加当前约 130 KiB 级别请求的负担。
- 历史退役候选不进入模型方向判断；前端若展示也必须明确为审计历史。
- 修复顺序先算法、后展示，防止用前端画法掩盖错误结构。

## 8. 剩余风险与非本次范围

- 包含关系、等高等低、最小成笔间距属于缠论规则口径问题，本次只保持现行规则，不借机更换流派或混入第二套算法。
- `local_bias` 修正后，部分历史模型结论会改变，这是纠错的预期结果；不能据此直接放宽策略门槛。
- 旧冻结快照没有新增坐标，前端只能明确降级，不能可靠补画。
- 本次不处理模型推理性能、请求整体瘦身、止盈止损策略或下单数量问题。
- 策略实盘效果仍需在算法验收通过后另做冻结回放与前向观察；不能用单一截图或一轮模型输出宣称策略盈利有效。
