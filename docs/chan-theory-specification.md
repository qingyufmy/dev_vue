# 缠论结构计算说明文档

## V4 当前口径（2026-09-20）

当前实现位于 `server/src/modules/market/domain/chan-v8/`。窗口版本为 `chan_window_v8`：由策略的数据周期或首页选中周期驱动计算，不再限定为 M5/M15/H1/H4。已有周期调优窗口保留，其他合法周期使用 1800 根目标、1400/1600/1800 根验证窗口；可选周期仍由终端与接口合同决定，历史不足时不伪造完整证据。以下旧版窗口、运行路径及冷启动描述属于历史记录，不覆盖 V4 当前源码。

分型确认使用右侧标准 K 线首次形成时的原始 K 线，后续包含合并不刷新同一分型的确认时间。线段较早的缺口端点仍在等待反向特征确认时，不得提前确认可能被替代的后续端点；明确失效后才继续寻找后续端点。详见 [因果确认修复与复查](chan-causal-confirmation-repair-20260920.md)。

## v6 固定窗口运行口径（2026-08-11）

正式运行的 Chan v6 不再使用统一 2000 根或进程级粘性扩容。每个周期只请求并计算固定目标窗口，验证只使用同一政策中的相邻窗口：M5 为 800（600/700/800），M15 为 1000（800/900/1000），H1 为 1200（1000/1100/1200），H4 为 800（600/700/800）。策略标签中的可见 K 线数量保持不变；其他指标可以要求更多历史，但 `computeChan` 只取最后目标窗口。

达到目标窗口后，没有线段、中枢、进入段或推荐锚点不会再次请求更长历史。`center_count=0` 表示当前固定窗口没有确认中枢，不等于数据缺失；真实缺口仍失败关闭。Chan 结果新增 `evidence_capabilities`，分别声明 `data_complete`、`segment_direction_usable`、`center_structure_usable`、`entry_structure_usable` 和 `divergence_usable`。无可信结构锚点时，进入段、背驰和买卖点能力继续关闭，但已稳定的线段方向可以独立作为方向证据。

连续性检查使用 `market-session-calendar.js` 对当前支持的圣诞节和元旦休市做确定性分类，不补造 K 线；未知工作日长缺口仍标记为可疑。推理快照冻结 Chan 算法版本、目标/验证窗口、能力字段、连续性日历版本和已识别休市细节，并继续兼容旧版 v5 快照。

## 背驰可靠性与时间定位补充（2026-07-17）

- MACD 面积背驰阈值为 `area_cur / area_prev <= 0.85`，峰值背驰阈值为 `peak_cur / peak_prev <= 0.95`；接近相等的峰值不判背驰。
- 输出 `area_ratio`、`peak_ratio`、`area_reduction_pct`、`peak_reduction_pct`，供模型与审计解释力度差异。
- 实时判断仍使用末端稳定线段；`recent_divergences` 从至少两个独立分解结果支持的历史稳定结构链提取，按 UTC 离开段去重后保留最近 6 个。
- 定位同时输出 UTC 毫秒时间、MT5 服务器时间、`stable_id` 与 `divergence_key`。
- 只有行情时钟已校验、闭合 K 线 UTC 时间严格递增且历史完整时，绝对 UTC 定位才可靠。MT4 使用当前服务器偏移换算的时间一律不得标记为精确 UTC；仅当 EA 的偏移样本不超过 5 分钟、偏移合法且数据源已按“平台 + 账户 + 服务器 + 当前偏移”隔离时，才可把严格递增时间用作结构稳定键。休市缓存偏移、陈旧样本、身份缺失或偏移变化均按不可靠处理。
- 多周期上下文输出请求、已用、缺失周期和 `context_status`；缺失任一周期时为 `partial`。
- `forming_divergence` 只是候选线段证据，不能单独触发交易。智能平仓不在本阶段范围内。

## 实用高级结构（第一阶段）

### 走势状态 `trend_state`

- `uptrend` / `downtrend`：最近两个中枢区间明确向上或向下分离。
- `upward_breakout` / `downward_breakout`：已关闭中枢被确认线段突破，且当前价格仍在中枢外侧。
- `consolidation`：中枢仍在延伸，或价格已经回到最近中枢。
- `upward_exhaustion` / `downward_exhaustion`：确认离开段出现顶背驰或底背驰，只表示原方向衰竭和反转风险上升。
- `structural_rise` / `structural_decline`：已有确认线段但没有足够中枢，置信度固定为低。

输出同时包含 `direction`、`phase`、`reversal_bias`、`confidence` 和对应的中枢、线段编号。

### 买卖点候选 `entry_candidates`

- 一类买卖点来自确认底背驰或顶背驰。
- 二类买卖点要求一类点后的回撤不创新低，或反弹不创新高。
- 三类买卖点要求突破中枢后的回踩保持在上沿之上，或反弹保持在下沿之下。

每个候选包含方向、来源、结构参考价、失效价、稳定编号和 `usable_for_entry`。`reference_price` 是结构定位价格，不是可以直接提交的订单价格。系统通过 `bars_since_point` 标记新鲜度，超过 20 根 K 线后为 `stale`；结构可靠性低、时间定位不可靠或候选过期时，候选仍可供观察，但 `usable_for_entry=false`。候选不是订单信号，不能绕过 AI 综合判断和风控。

### 跨周期原始结构合同 `strategy_context.timeframes[].summary.chan`

服务端不再生成通用的跨周期方向汇总或冲突裁决。策略上下文按策略配置的周期逐项传递每个周期的原始 `summary.chan`，模型必须按照当前具体策略正文定义的周期职责、方向关系和入场条件自行解释这些结构；不同周期可以承担不同职责，不假定所有周期必须同向。`evidence_capabilities`、`status`、`reliability`、`warnings` 和 `context_status` 仍是原始证据质量与数据完整性字段，不代表服务端替策略做出的方向结论。

上下文仍输出 `required_timeframes`、`used_timeframes`、`missing_timeframes` 和 `context_status`；缺失周期时为 `partial`，只表示输入数据不完整。新构建的上下文和推理快照不包含 `chan_timeframe_alignment`。读取历史模型对比快照时，可以仅将旧版 `chan_timeframe_alignment` 作为“当时启用过缠论”的兼容标记，不重新生成、解释或驱动当前策略结论。

## 概述

本系统在 `server/routes/ai/market-data.js` 中实现了**保守版缠论结构计算**，用于为 AI 模型提供真实的价格结构数据（分型→笔→线段→中枢→背驰），替代模型自行从 K 线推测结构。

> **重要说明**：本实现是保守结构计算器。已覆盖标准特征序列、线段两种破坏情况和缺口后的第二特征序列；尚未覆盖中枢级别递归和完整走势类型递归。背驰仅比较同一中枢的直接进入段与直接离开段，并要求价格先创新高或新低。

## 代码位置与调用链

| 位置 | 职责 |
|------|------|
| `server/routes/ai/market-data.js` | 指标计算、包含处理、分型、笔、线段、中枢、背驰及统一结果组装 |
| `server/routes/ai/utils.js` | `{{USE_CHAN}}`、周期标签解析、兼容历史常量及 K 线压缩 |
| `server/routes/ai/chan-window-policy.js` | v6 按周期固定目标窗口和验证窗口 |
| `server/routes/ai/market-session-calendar.js` | 确定性休市分类，不补造 K 线 |
| `server/routes/ai/strategy.js` | 根据提示词周期构建策略上下文，按固定政策请求缠论历史 |
| `server/routes/ai/scheduler.js` | 自动推理周期调用策略上下文并把缠论结果交给模型 |
| `server/routes/ai/llm.js` | 仅在提示词包含 `{{USE_CHAN}}` 时保留 payload 中的 `chan` 字段 |
| `tests/ai/chan.test.js` | 缠论结构单元测试和结构不变量测试 |
| `tests/ai/market-data.test.js` | 普通指标窗口与缠论扩展历史隔离测试 |

完整调用链：

```text
提示词周期标签
  -> buildStrategyContextFromTags
  -> 获取可见 K 线与缠论历史 K 线
  -> calculateMarketData
  -> computeChan
  -> strategy_context.timeframes[周期].summary.chan（逐周期原始结构）
  -> maybeAiSignal 按当前策略正文传递给模型
  -> 有 {{USE_CHAN}} 时发送原始 chan，否则剥离 chan
```

提示词包含 `{{USE_CHAN}}` 时，每个相关周期按 v6 政策获取固定目标历史 K 线；没有完整线段或中枢时不再扩展到更长窗口。发送给模型的原始 K 线仍按 `MTF/ATF` 标签数量截取，普通指标也只使用该截取窗口。结构计算排除最后一根尚未收盘的 K 线。

手动推理和自动推理共用 `buildStrategyContextFromTags`，因此历史数量、固定验证窗口、结构计算和降级口径一致。目标窗口只用于缠论结构，不会把模型要求的 80/50/100/60 根可见 K 线扩大。

`window_resynced` 是正常锚点元数据，不作为 warning。若桥接实际返回数量小于请求数量，则输出 `history_bars_below_requested`，并通过 `requested_history_count`、`received_history_count` 和 `history_sufficient` 说明降级原因。

没有处于中枢直接离开段、没有创新高低或力度未缩减都属于正常的“无背驰”状态，不降低结构可靠性；只有 MACD 数据缺失或面积无效才记录背驰计算 warning。

## 算法流程

```
原始 K 线 → 包含处理 → 分型识别 → 笔构造 → 线段构造 → 中枢计算 → 背驰判断
```

## 常量配置

```js
MIN_BARS_PER_BI = 5          // 新笔规则等价参数：极值原始索引差至少为 4
MIN_BIS_PER_SEGMENT = 3      // 有效线段最少笔数
FEED_LAST_N_BIS = 6          // 发送给模型的最近笔数
MIN_KLINES_FOR_CHAN = 30     // K 线不足时返回 insufficient
DIVERGENCE_MIN_AREA_RATIO = 0.85  // 背驰最小面积差异阈值（85%）
MACD_WARMUP_BARS = 40        // 背驰比较不得覆盖 MACD 暖机区
ENABLE_DIVERGENCE = true     // 是否启用背驰判断
```

---

## 1. MACD 序列计算 (`calculateMacdSeries`)

### 作用

计算与原始 K 线一一对应的 MACD histogram 序列，用于背驰判断。

### 算法

```
EMA12[i] = close[i] * k12 + EMA12[i-1] * (1 - k12)   // k12 = 2/13
EMA26[i] = close[i] * k26 + EMA26[i-1] * (1 - k26)   // k26 = 2/27
DIF[i]   = EMA12[i] - EMA26[i]
DEA[i]   = DIF[i] * k9 + DEA[i-1] * (1 - k9)          // k9 = 2/10
HIST[i]  = DIF[i] - DEA[i]
```

### 输出

```js
{ difSeries, deaSeries, histSeries, latestDif, latestDea, latestHist }
```

- `histSeries.length === closes.length`（与原始 K 线等长）
- 前期无法稳定计算的位置填 `0`

---

## 2. K 线包含处理 (`normalizeBarsForChan`)

### 作用

合并包含关系的 K 线，减少虚假分型。

### 规则

1. 过滤无效 K 线（NaN、high < low）
2. 包含判断：`prev ⊇ cur` 或 `cur ⊇ prev`
3. 合并方向：
   - 上升方向：取 `max(high)`、`max(low)`
   - 下降方向：取 `min(high)`、`min(low)`
4. 返回前重新编号 `idx`（连续递增）
5. 保留原始索引区间 `raw_start_idx` / `raw_end_idx`

---

## 3. 分型识别 (`detectFractals`)

### 规则（严格标准）

**顶分型**：`c.high > p.high && c.high > n.high && c.low > p.low && c.low > n.low`

**底分型**：`c.low < p.low && c.low < n.low && c.high < p.high && c.high < n.high`

### 去重

- 连续同类型分型只保留更极端的（顶取更高 high，底取更低 low）
- 最终确保顶底交替

---

## 4. 笔构造 (`buildBis`)

### 规则

1. 顶底交替才可能成笔
2. 默认使用新笔规则：顶底极值原始 K 线索引之差至少为 4（中间至少 3 根原始 K 线）；包含处理后的标准 K 线仅用于分型，不用于缩短笔间距
3. 价格方向校验：
   - 底→顶：`end_price > start_price`
   - 顶→底：`end_price < start_price`
4. 间距不足的候选分型不进入活动端点链；价格方向不满足时计入 `invalidCount`，关闭当前 `bi run` 并从较新的分型建立隔离的新 run。断点前确认笔保留供历史审计，但线段绝不跨 run 连接
5. 由两个已确认分型构成的笔标记为 `confirmed: true`
6. 未收盘 K 线不参与分型和正式笔构造
7. 最后一个被笔构造接受的活动分型到其后全部 K 线（包括当前未收盘 K 线）的实时极值变化，单独输出为 `developing_bi`，不进入线段、中枢或背驰
8. 即使已确认笔不足 3 笔、暂时不能构造线段，只要存在有效活动分型，仍计算 `developing_bi`

### 输出

```js
{
  id, dir: 'up'|'down',
  start_idx, end_idx,
  raw_start_idx, raw_end_idx,  // 原始 K 线区间
  start_price, end_price,
  high, low,
  confirmed: boolean,
  run_id
}
```

组装结果另输出 `bi_run_count`、`active_bi_count`、`active_bi_run_id`、`bi_discontinuity_count` 和 `last_bi_discontinuity`。`recent_bis` 只包含当前活动 run，避免模型把跳空前后的笔拼成一条结构链；旧 run 的价格方向断裂仅作为审计诊断，不会降低当前活动 run 的可靠度。

---

## 5. 线段构造 (`buildSegments`)

### 规则

1. 有效线段至少 3 笔（`MIN_BIS_PER_SEGMENT`）
2. 上涨线段使用向下笔构造标准特征序列，只识别顶分型；下跌线段对称处理，只识别底分型
3. 特征序列先按方向处理包含关系，并按可确认前缀逐步寻找端点，确认后不允许后续元素跨端点重新合并
4. 第一、第二特征元素无缺口时，特征序列分型直接确认线段端点
5. 存在缺口时，从候选端点开始建立第二特征序列；只有出现相反分型才确认，原趋势先创新极值则候选失效
6. 滚动窗口前两个可检测端点只用于重同步，不输出可能受截断前缀影响的线段
7. 在同一历史窗口内从多个笔起点独立分段，末端连续两段必须获得严格多数且至少两个分解支持；更早的每一对相邻线段，也必须在所有能够覆盖该段对的分解器中取得严格多数且至少两票，才可并入确认前缀
8. 无持久锚点时，只在当前周期政策列出的相邻固定窗口中对结构再次确认。窗口只有在其起始时间不晚于待验证结构起点时才具备投票资格。线段必须由同一批窗口对完整连续后缀及其中每一对相邻线段同时给出至少两票且严格多数，禁止把不同窗口的局部多数拼成一条结构链。中枢另以最初三条线段的稳定标识作为形成核心独立投票：支持票必须同时属于线段共识 cohort，分母则包含所有能够观察该核心的窗口；只有联合支持仍为至少两票且严格多数，且目标完整窗口也识别同一中枢相位，才从该核心沿共识链重建延伸或离开状态。短截断窗口只能确认，不能创建或覆盖目标窗口的中枢相位。不得仅凭公共线段后缀重新扫描并生成本地窗口从未共同确认的中枢。背驰把“明确无背驰”计为反对票，把 MACD 暖机区、引用缺失等不可判状态计为弃权；历史背驰和买卖点按可观察窗口的严格多数交集保留。持久锚点命中后可直接增量复用
9. 首尾边界未收敛时返回 `segment_history_unresolved`，保留确认笔与只读笔级中枢，但清空线段级中枢、背驰、趋势和可执行买卖点，不再笼统归因于“市场没有结构”
10. 每个线段记录完整 `high`/`low`、组成笔 ID、`segment_support_count / segment_validator_count`、相邻线段对支持数与跨窗口支持数
11. 无可信锚点时使用当前周期的目标完整窗口，并固定左边界分别回算最后第 3、第 2 和最新一根已收盘 K 线。只有三次回算均为完整、非低可靠、非过期结构，且 `中枢 core + 相邻进入段` 身份完全一致、目标窗口与具备至少 150 根进入段前置上下文的跨窗口联合投票均支持该身份、结构时间键可靠且缓存无缺口时，才把进入段起点保存为结构锚点。目标完整窗口决定并输出结构链，固定验证窗口只提供确认票。冷启动采用两阶段提交：首次确认原子保存“进入段起点 + 进入段稳定 ID + 初始三段核心稳定 ID + 最后确认线段时间 + 观察时间”，并保持 `current_result_usable=false`；下一次必须完整匹配这些身份且最后确认线段不得回退，才允许公开依赖进入段的中枢、背驰和买卖点。锚定重建时，首条线段被明确保留为中枢进入段，初始三段核心从下一条线段开始，避免窗口滚动后相位前移。旧观察时间不得覆盖较新的完整锚点。重复请求不能增加票数，未收盘 K 线不参与时间稳定性验证。`center_entry_unconfirmed` 不否定中枢本身；`structure_anchor_bootstrap_pending` 会清空所有依赖进入段的确认背驰、形成中背驰、历史背驰及买卖点候选

### 输出

```js
{ segments: [...], candidate: { dir, bi_ids, start_price, end_price } | null, resynced: boolean, stable: boolean, supportCount, validatorCount, pairSupport }
```

---

## 6. 中枢计算 (`buildCenters`)

### 规则

1. 连续三条已确认线段的完整区间重叠形成当前实现中的线段级中枢：
   - `ZL = max(lo1, lo2, lo3)`
   - `ZH = min(hi1, hi2, hi3)`
   - 若 `ZL < ZH` 则成立
2. 延伸：后续线段区间与中枢存在正宽度重叠时，保持初始核心区间不变，并更新波动区间 `GG/DD`
3. 关闭：重叠区间为空或仅单点接触时标记 `closed`，并记录 `closed_by_segment_id`
4. `current_center` 始终指向最后一个中枢，包括已关闭中枢；`active_center` 仅指向尚未关闭的中枢
5. `price_vs_center` 始终相对最后一个中枢的固定 `[ZL,ZH]` 判断，只有完全没有中枢时才为 `none`
6. `center_count/current_center/latest_center` 始终表示线段级中枢。`bi_center_count/latest_bi_center` 是只读的低层笔级结构证据，禁止替代线段级中枢进入自动执行

### 中枢状态

| 状态 | 含义 |
|------|------|
| `confirmed` | 刚形成 |
| `extended` | 后续确认线段仍与固定核心区间重叠，波动区间继续更新 |
| `closed` | 已关闭（不再重叠） |

---

## 7. 背驰判断 (`detectDivergence`)

### 前置条件（必须全部满足）

1. 有效线段 ≥ 2
2. 有效中枢 ≥ 1
3. 最新有效线段必须是中枢的直接离开段
4. 必须存在与离开段同方向的中枢直接进入段

### 判断流程

1. 取最新有效线段方向 `current.dir`
2. 找同一中枢的同方向直接进入段 `prev`
3. 任一比较线段起始位置落在前 40 根 MACD 暖机区时停止判定
4. 按方向过滤 MACD histogram，同时计算面积与同色柱峰值：
   - 上行段：只统计正 histogram（红柱）
   - 下行段：只统计负 histogram（绿柱）
5. 创新高/新低检查：
   - 上行：`cur.high > prev.high`
   - 下行：`cur.low < prev.low`
5. 面积缩小检查：`areaCur <= areaPrev × 0.85`

### 返回字段

```js
{
  type: 'top' | 'bottom' | 'none',
  category: 'center_departure',
  trend_confirmed: false,
  strength: 'strong' | 'weak' | 'none',
  reason: string,
  area_cur, area_prev,
  peak_cur, peak_prev,
  price_extreme_cur, price_extreme_prev
}
```

### 可能的 reason

| reason | 含义 |
|--------|------|
| `no_macd_data` | 无 MACD 数据 |
| `insufficient_valid_segments` | 有效线段不足 2 |
| `no_valid_center` | 无有效中枢 |
| `not_after_center` | 不在中枢后 |
| `no_entry_segment` | 找不到该中枢的直接进入段，或方向不一致 |
| `no_price_extreme_break` | 未创新高/新低 |
| `macd_warmup_overlap` | 比较线段覆盖前 40 根 MACD 暖机区 |
| `invalid_macd_area` | MACD 面积为 0 |
| `macd_area_and_height_divergence` | 面积与柱峰同时缩小，强背驰 |
| `macd_area_divergence_only` | 仅面积缩小，弱背驰 |
| `macd_height_divergence_only` | 仅柱峰缩小，弱背驰 |
| `macd_no_divergence` | 面积与柱峰均未满足 |

---

## 8. 组装 (`computeChan`)

### 输入

- `rates`: 原始 K 线数组
- `timeframe`: 时间周期（如 'H1'）
- `macdHist`: histogram 序列（与 rates 等长）

### 输出结构

```js
{
  algorithm_version: 'chan_structure_v4',
  rule_profile: 'new_bi_feature_sequence_quorum',
  status: 'ok' | 'partial' | 'insufficient_klines' | 'insufficient_bis' | 'unreliable_segments' | 'segment_history_unresolved',
  reliability: 'high' | 'medium' | 'low',
  raw_bar_count, processed_bar_count,
  window_resynced, window_stable,
  fractal_count, bi_count, segment_count, center_count,
  current_bi, recent_bis, developing_bi,
  current_segment, prev_segment, candidate_segment,
  current_center, active_center, latest_center, price_vs_center,
  divergence,
  warnings: string[]
}
```

无论状态是完整、K 线不足还是笔不足，上述结构字段都始终存在。不可用对象返回 `null`，列表返回空数组，`price_vs_center` 返回 `none`，`divergence` 返回 `type: none` 并携带降级原因。调用方不需要根据状态猜测字段是否存在。

### status 规则

| status | 条件 |
|--------|------|
| `ok` | 有有效线段和中枢 |
| `partial` | 有线段但中枢不足，或有 warnings |
| `unreliable_segments` | 有笔但无有效线段 |
| `insufficient_bis` | 确认笔不足 3 |
| `insufficient_klines` | K 线不足 30 |

### reliability 规则

| reliability | 条件 |
|-------------|------|
| `high` | 请求历史与已收盘历史完整、时间定位可靠、至少两条跨窗口确认线段、具有独立多数确认的线段级中枢，并且没有 warning |
| `medium` | 历史数量完整且至少有一条跨窗口确认线段，但中枢、进入段、背驰证据或时间定位仍有待确认 |
| `low` | 历史/缓存存在未补齐缺口、确认结构过旧、只有笔或候选线段，或线段窗口尚未收敛 |

### warnings 语义

| warning | 含义 |
|---------|------|
| `history_bars_below_requested` | 桥接返回数量少于请求数量 |
| `raw_bars_too_few` | 排除未收盘柱后不足 30 根 |
| `processed_bars_too_few` | 包含处理后有效柱过少 |
| `insufficient_confirmed_bis` | 已确认笔不足 3 笔 |
| `segment_window_not_resynced` | 滚动窗口内尚未找到可用于重同步的线段端点 |
| `segment_window_unstable` | 完整窗口与内部后缀窗口的末端线段边界不一致 |
| `segments_not_confirmed` | 尚未形成可确认线段 |
| `no_valid_center` | 已有线段但尚未形成有效中枢 |
| `center_cross_window_unstable` | 可观察窗口未对同一组三线段中枢形成核心达成严格多数 |
| `center_entry_unconfirmed` | 中枢核心已确认，但进入段不在跨窗口公共结构中；中枢可展示，背驰与依赖进入段的买卖点不可判 |
| `structure_anchor_bootstrap_pending` | 尚未命中已持久化锚点；首次满足连续三根已收盘 K 线与跨窗口联合确认后只保存锚点，下一次精确命中前仍不公开依赖进入段的证据 |
| `divergence_evidence_unavailable` | 可比较的有效 MACD 力度证据不足；这是不可判，不是确认无背驰 |
| `divergence_cross_window_unstable` | 可判窗口对背驰方向或明确无背驰未达成严格多数 |
| `forming_evidence_unavailable` | 形成中背驰的有效证据不足 |
| `forming_cross_window_unstable` | 可判窗口对形成中背驰未达成严格多数 |
| `mt4_historical_offset_unverified` | MT4 仅按当前或缓存偏移换算，绝对 UTC 定位未验证；只有新鲜且来源隔离的时间键可用于结构确认 |
| `divergence_skipped_invalid_macd` | MACD 数据或面积无效，无法判定背驰 |

正常的“没有背驰”、不在中枢离开段、未创新高低和力度未缩减不会降低结构可靠性。

## 9. 数据边界与不变量

1. 最后一根 K 线视为未收盘柱，不进入正式分型、笔、线段、中枢和背驰。
2. 未收盘柱只可用于 `developing_bi`，其变化不得重绘已确认结构。
3. 普通指标只使用提示词指定的可见窗口；周期政策目标历史只用于缠论。达到目标后即使尚无线段或中枢也不再扩展，手动推理入口、自动调度入口和上下文构造器统一使用同一固定政策，不保留进程级粘性扩容。
4. 分型必须顶底交替；笔必须方向交替，且顶底极值满足最少原始 K 线间隔。
5. 正式线段至少包含 3 笔，滚动窗口截断的首段不会输出。
6. 中枢必须由至少 3 条确认线段的正宽度重叠形成，单点接触不算重叠。
7. 背驰只比较同一中枢的直接进入段与直接离开段，不跨中枢配对。
8. MACD 比较区间不得覆盖前 40 根暖机柱，相邻笔共享的原始索引只累计一次。
9. 所有降级状态保持固定输出字段，不使用字段缺失表达不可用。

---

## 10. 调试开关

环境变量控制详细日志：

```bash
DEBUG_CHAN=1          # 打印笔/线段明细
DEBUG_LLM_PAYLOAD=1  # 打印 AI payload 截断
```

默认只输出每周期一行摘要：

```
[Chan] H1: status=ok reliability=high raw=80 processed=76 fractals=12 bis=11 confirmed=10 segs=3 centers=1 warnings=none
```

---

## 11. AI 输入集成

- 提示词包含 `{{USE_CHAN}}` 时，chan 数据注入 AI payload
- 不包含时，自动剥离 chan 字段
- `chan.status !== 'ok'` 时，payload 保留 status/warnings/reliability 让模型知道结构不可信

模型应按以下顺序使用结构数据：

1. 先看 `status`、`reliability` 和 `warnings`。
2. 再看 `current_segment`、`candidate_segment` 和中枢位置。
3. 背驰只有 `type` 为 `top` 或 `bottom` 时才成立；`strong` 和 `weak` 表示力度证据数量，不代表交易指令。
4. `developing_bi` 仅为实时观察信息，不能当作确认笔或确认线段。

## 12. 当前能力边界

当前实现没有覆盖：

- 中枢级别递归和高级别中枢自动合成。
- 完整走势类型、走势必完美及同级别分解的全部递归定义。
- 中枢级别递归下的一、二、三类完整买卖点判定；当前只输出保守、可审计且默认不可直接执行的候选证据。
- 跨周期缠论结构的自动级别映射。

因此本模块输出的是供 AI 参考的保守结构事实，不直接产生买卖指令。交易方向、止损、止盈和仓位仍由推理及后端风险规则共同决定。

---

## 测试覆盖

| 测试组 | 用例数 | 覆盖内容 |
|--------|--------|----------|
| normalizeBarsForChan | 5 | 过滤、包含处理、idx 连续、raw_idx |
| detectFractals | 8 | 标准/非标准顶底分型、相等点、去重 |
| buildBis | 多组 | 笔数、方向交替、价格校验、确认笔 |
| buildSegments | 多组 | 标准特征序列、两种破坏情况、缺口、重同步和结构不变量 |
| buildCenters | 多组 | 核心区间、延伸、关闭和完整波动区间 |
| detectDivergence | 多组 | 真实三线段中枢、直接进出段、价格极值和 MACD 面积 |
| computeChan | 多组 | 未收盘柱隔离、固定目标/验证窗口、字段和告警 |
| calculateMacdSeries | 2 | 长度对齐、空数组 |
| early return warnings | 1 | 多 warning 同时保留 |

测试数量会随功能持续增长，以实际执行 `vitest run` 的结果为准，不在本文维护固定数量。

---

## 13. 背驰段定位输出

背驰定位以原始 K 线索引为坐标，不使用包含处理后的临时索引。每个确认线段增加：

- `start_index` / `end_index`：线段覆盖的原始 K 线下标。
- `start_time` / `end_time`：对应桥接行情中的原始时间值。
- `start_price` / `end_price` / `high` / `low`：用于图表定位和审计的价格范围。

`divergence` 表示最新确认线段的背驰结果。确认背驰同时携带：

- `state: confirmed`、`confirmed: true`。
- `center_id`：对应中枢。
- `entry_segment_id` / `departure_segment_id`：同一中枢的直接进入段和直接离开段。
- `entry_segment` / `departure_segment`：两段完整的时间、索引和价格定位信息。

`recent_divergences` 保存当前周期目标窗口内最近 6 个已确认背驰段，只收录 `top` 或 `bottom`，不收录普通的“无背驰”结果。

`forming_divergence` 只在候选线段紧接当前未闭合线段级中枢、且候选价格区间已经离开中枢时，临时把它视为候选离开段并执行相同力度比较；否则返回 `forming_departure_not_confirmed`。它始终输出 `state: forming`、`confirmed: false`，只能作为观察证据，不能称为已确认背驰，也不能单独触发交易。

AI 系统提示会强制区分确认背驰和形成中背驰，并要求先检查 `status`、`reliability`、`window_stable` 与 `warnings`。背驰仍只是行情结构证据，不等同于反转已经确认。
