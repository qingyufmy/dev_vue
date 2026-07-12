# 缠论结构计算说明文档

## 概述

本系统在 `server/routes/ai/market-data.js` 中实现了**保守版缠论结构计算**，用于为 AI 模型提供真实的价格结构数据（分型→笔→线段→中枢→背驰），替代模型自行从 K 线推测结构。

> **重要说明**：本实现是保守结构计算器。已覆盖标准特征序列、线段两种破坏情况和缺口后的第二特征序列；尚未覆盖中枢级别递归和完整走势类型递归。背驰仅比较同一中枢的直接进入段与直接离开段，并要求价格先创新高或新低。

提示词包含 `{{USE_CHAN}}` 时，每个相关周期先获取 300 根历史 K 线用于结构计算；重同步后仍无完整线段时，仅对该周期补取到 500 根。发送给模型的原始 K 线仍按 `MTF/ATF` 标签数量截取，普通指标也只使用该截取窗口。结构计算排除最后一根尚未收盘的 K 线。

`window_resynced` 是正常锚点元数据，不作为 warning。若桥接实际返回数量小于请求数量，则输出 `history_bars_below_requested`，并通过 `requested_history_count`、`received_history_count` 和 `history_sufficient` 说明降级原因。

没有处于中枢直接离开段、没有创新高低或力度未缩减都属于正常的“无背驰”状态，不降低结构可靠性；只有 MACD 数据缺失或面积无效才记录背驰计算 warning。

## 算法流程

```
原始 K 线 → 包含处理 → 分型识别 → 笔构造 → 线段构造 → 中枢计算 → 背驰判断
```

## 常量配置

```js
MIN_BARS_PER_BI = 5          // 成笔最少处理后 K 线数
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
2. 最小间隔：`MIN_BARS_PER_BI = 5`（处理后 K 线）
3. 价格方向校验：
   - 底→顶：`end_price > start_price`
   - 顶→底：`end_price < start_price`
4. 不满足则跳过，计入 `invalidCount`
5. 由两个已确认分型构成的笔标记为 `confirmed: true`
6. 未收盘 K 线不参与分型和正式笔构造
7. 最后一个确认分型到当前未收盘 K 线的实时变化单独输出为 `developing_bi`，不进入线段、中枢或背驰

### 输出

```js
{
  id, dir: 'up'|'down',
  start_idx, end_idx,
  raw_start_idx, raw_end_idx,  // 原始 K 线区间
  start_price, end_price,
  high, low,
  confirmed: boolean
}
```

---

## 5. 线段构造 (`buildSegments`)

### 规则

1. 有效线段至少 3 笔（`MIN_BIS_PER_SEGMENT`）
2. 上涨线段使用向下笔构造标准特征序列，只识别顶分型；下跌线段对称处理，只识别底分型
3. 特征序列先按方向处理包含关系，并按可确认前缀逐步寻找端点，确认后不允许后续元素跨端点重新合并
4. 第一、第二特征元素无缺口时，特征序列分型直接确认线段端点
5. 存在缺口时，从候选端点开始建立第二特征序列；只有出现相反分型才确认，原趋势先创新极值则候选失效
6. 滚动窗口首个可检测端点仅用于重同步，不输出截断首段；后续不足确认条件的笔保留为 `candidate_segment`
7. 每个线段记录完整 `high`/`low` 和组成笔 ID

### 输出

```js
{ segments: [...], candidate: { dir, bi_ids, start_price, end_price } | null, resynced: boolean }
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

### 中枢状态

| 状态 | 含义 |
|------|------|
| `confirmed` | 刚形成 |
| `extended` | 延伸中（交集更新） |
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
  strength: 'candidate' | 'none',
  reason: string,
  area_cur, area_prev,
  price_extreme_cur, price_extreme_prev
}
```

### 可能的 reason

| reason | 含义 |
|--------|------|
| `no_macd_data` | 无 MACD 数据 |
| `insufficient_valid_segments` | 有效线段不足 2 |
| `no_valid_center` | 无有效中枢 |
| `insufficient_same_direction_segments` | 同方向线段不足 2 |
| `not_after_center` | 不在中枢后 |
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
  status: 'ok' | 'partial' | 'insufficient_klines' | 'insufficient_bis' | 'unreliable_segments',
  reliability: 'high' | 'medium' | 'low',
  raw_bar_count, processed_bar_count,
  fractal_count, bi_count, segment_count, center_count,
  current_bi, recent_bis, developing_bi,
  current_segment, prev_segment, candidate_segment,
  current_center, active_center, latest_center, price_vs_center,
  divergence,
  warnings: string[]
}
```

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
| `high` | 有效线段 + 有效中枢 |
| `medium` | 有效线段，无中枢 |
| `low` | 仅笔或候选段 |

---

## 9. 调试开关

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

## 10. AI 输入集成

- 提示词包含 `{{USE_CHAN}}` 时，chan 数据注入 AI payload
- 不包含时，自动剥离 chan 字段
- `chan.status !== 'ok'` 时，payload 保留 status/warnings/reliability 让模型知道结构不可信

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
| computeChan | 多组 | 未收盘柱隔离、300 根历史重同步、字段和告警 |
| calculateMacdSeries | 2 | 长度对齐、空数组 |
| early return warnings | 1 | 多 warning 同时保留 |

共 36 个缠论相关测试，124 个全量测试。
