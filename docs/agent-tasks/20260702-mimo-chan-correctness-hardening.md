# Mimo 任务：缠论计算正确性加固

## 分支与仓库

- 仓库：`D:\dev_codex\wall-street-skill-local`
- 分支：`dev_codex`
- 只允许在 `dev_codex` 修改、提交、推送。
- 不要合并 `main`。
- 不要删除 `.mimocode/`、`docs/agent-tasks/` 或其它用户已有文件。

## 背景

当前缠论计算已经经历了几轮修复，最新提交为：

- `00de6e9 fix: correct chan divergence direction tests`

Codex 再次全面核查后确认：现有测试可以通过，但缠论计算仍存在几个会影响真实信号判断的问题。尤其是背驰计算中的 MACD 面积存在索引错位，可能把后半段笔的 MACD 面积算成 `0`，从而误报强背驰。

本任务要求修复这些正确性问题，并补齐可复现单元测试。

## 结果文件要求

完成后写入：

`docs/agent-results/20260702-mimo-chan-correctness-hardening-result.md`

结果文件必须包含：

- 本次实际提交 ID，不要写“待提交”。
- 修改文件清单。
- 每个问题的具体修复位置。
- 修复说明。
- 新增/修改测试说明。
- 执行过的验证命令和结果。
- 手动实测步骤。
- 剩余风险。

## 当前重点文件

主要修改：

- `server/routes/ai/market-data.js`
- `tests/ai/chan.test.js`
- `tests/ai/market-data.test.js`，如需要覆盖 `calculateMarketData()` 的 MACD 对齐场景。

不要无关重构 UI、调度器、桥接、数据库结构。

---

## 问题 1：背驰 MACD 面积索引错位，必须修复

### 当前问题

文件：

- `server/routes/ai/market-data.js`

当前 `calculateMarketData()` 中的 MACD 历史数组：

```js
const macdHistory = []
if (n >= 26) {
  ...
  for (let i = 12; i < n; i++) {
    ...
    if (i >= 26) {
      ...
      macdHistory.push(e12 - e26)
    }
  }
}
```

这个数组存在两个问题：

1. `macdHistory.length` 小于原始 K 线数量。
2. 数组下标不是原始 K 线下标。

但 `detectDivergence()` 中直接用笔的原始 K 线索引读取：

```js
for (let j = bi.raw_start_idx; j <= bi.raw_end_idx && j < macdHist.length; j++) {
  area += Math.abs(macdHist[j] || 0)
}
```

这会导致后半段笔的 `raw_start_idx/raw_end_idx` 大于 `macdHist.length - 1` 时，面积被算成 `0`。

Codex 已复现：

```text
short   => {"type":"top","area_cur":0,"area_prev":15}
aligned => {"type":"none","area_cur":15,"area_prev":15}
```

这说明当前可能误报顶背驰/底背驰。

### 修复要求

必须让传入 `computeChan()` / `detectDivergence()` 的 MACD histogram 数组与原始 `rates` 一一对齐：

- `macdHist.length === rates.length`
- `macdHist[i]` 对应 `rates[i]`
- 前期无法稳定计算 DEA/histogram 的位置可以填 `0`，但数组长度不能短。

建议实现：

1. 在 `calculateMarketData()` 中抽出或新增 `calculateMacdSeries(closes)`。
2. 返回结构建议包含：

```js
{
  difSeries,
  deaSeries,
  histSeries,
  latestDif,
  latestDea,
  latestHist
}
```

3. `histSeries` 长度必须等于 `closes.length`。
4. `computeChan(rates, timeframe, histSeries)` 必须使用 histogram 序列，不要再使用 DIF 序列。
5. `macd.line/signal/histogram` 的最新值也应来自同一套序列，避免两套算法不一致。

### MACD 计算建议

可使用常规 EMA：

```js
EMA_today = close_today * k + EMA_yesterday * (1 - k)
k = 2 / (period + 1)
```

建议：

- `ema12Series` 长度等于 `closes.length`。
- `ema26Series` 长度等于 `closes.length`。
- `difSeries[i] = ema12Series[i] - ema26Series[i]`。
- `deaSeries` 对 `difSeries` 做 9 周期 EMA。
- `histSeries[i] = difSeries[i] - deaSeries[i]`。

如果沿用项目当前的 `macd.histogram = line - signal` 口径，不要乘以 2，保持兼容。

### 必须新增测试

在 `tests/ai/chan.test.js` 或 `tests/ai/market-data.test.js` 增加测试：

1. `calculateMarketData()` 传入 80 根 K 线时，内部用于缠论背驰的 histogram 不会因为长度短导致面积为 0。
2. 可以通过 `__chanTest` 暴露一个纯函数，比如 `calculateMacdSeries`，测试：

```js
const series = calculateMacdSeries(closes)
expect(series.histSeries.length).toBe(closes.length)
expect(series.difSeries.length).toBe(closes.length)
expect(series.deaSeries.length).toBe(closes.length)
```

3. 增加一个背驰复现测试：当所有 histogram 面积相等时，不应返回 `top/bottom`。

示例：

```js
const segs = [
  { id: 1, dir: 'down', bi_ids: [1,2,3], weak: false, high: 120, low: 90 },
  { id: 2, dir: 'up', bi_ids: [4,5,6], weak: false, high: 125, low: 95 },
  { id: 3, dir: 'down', bi_ids: [7,8,9], weak: false, high: 118, low: 95 },
  { id: 4, dir: 'up', bi_ids: [10,11,12], weak: false, high: 130, low: 100 },
]
const bis = []
for (let i = 1; i <= 12; i++) {
  const raw = 40 + i
  bis.push({ id: i, raw_start_idx: raw, raw_end_idx: raw })
}
const hist = Array(80).fill(5)
const centers = [{ status: 'confirmed', end_bi_id: 9 }]
const result = detectDivergence(segs, bis, hist, centers)
expect(result.type).toBe('none')
expect(result.reason).toBe('no_macd_divergence')
expect(result.area_cur).toBeGreaterThan(0)
expect(result.area_prev).toBeGreaterThan(0)
```

---

## 问题 2：背驰面积必须使用 MACD histogram，不要使用 DIF

### 当前问题

当前 `macdHistory.push(e12 - e26)` 存的是 DIF，不是 histogram。

背驰判断中说的是 `macd_area_divergence`，但实际比较的是 DIF 面积，不是红绿柱面积。这个语义和技术逻辑都不一致。

### 修复要求

1. `detectDivergence()` 的 `macdHist` 参数语义保持为 histogram 序列。
2. `calculateMarketData()` 传给 `computeChan()` 的必须是 histogram 序列。
3. `macd` 输出字段：

```js
macd: {
  line: latestDif,
  signal: latestDea,
  histogram: latestHist,
  trend: latestHist > 0 ? 'bullish' : latestHist < 0 ? 'bearish' : 'neutral',
}
```

4. 如果新增 `calculateMacdSeries()`，请加入 `__chanTest` 或其它测试导出对象，便于单元测试。

---

## 问题 3：包含处理后必须重新编号 processed idx

### 当前问题

文件：

- `server/routes/ai/market-data.js`

`normalizeBarsForChan()` 初始设置：

```js
bars.push({ idx: bars.length, raw_idx: i, ... })
```

但经过包含合并后，返回的 `merged` 中 `idx` 仍可能保留原来的原始序号。

Codex 复现：

- 原始 10 根 K 线。
- 包含处理后只剩 2 根处理 K 线。
- 第二根处理 K 线的 `idx` 仍是 `9`。

随后 `buildBis()` 用：

```js
if (f.idx - last.idx >= MIN_BARS_PER_BI - 1)
```

这会把真实处理后只有 1 根间隔的情况误判为间隔足够。

### 修复要求

`normalizeBarsForChan()` 返回前必须对处理后的 K 线重新编号：

```js
return merged.map((bar, idx) => ({
  ...bar,
  idx,
  raw_start_idx: bar.raw_start_idx ?? bar.raw_idx,
  raw_end_idx: bar.raw_end_idx ?? bar.raw_idx,
}))
```

同时：

1. 初始 `bars` 中建议直接包含：

```js
raw_start_idx: i,
raw_end_idx: i
```

2. 包含合并时正确维护 `raw_start_idx/raw_end_idx`。
3. `detectFractals()` 生成分型时保留 `raw_start_idx/raw_end_idx`。
4. `buildBis()` 中的：

```js
raw_start_idx
raw_end_idx
```

应该覆盖起点分型到终点分型之间的原始 K 线区间，建议使用：

```js
raw_start_idx: Math.min(s.raw_start_idx ?? s.raw_idx, e.raw_start_idx ?? e.raw_idx),
raw_end_idx: Math.max(s.raw_end_idx ?? s.raw_idx, e.raw_end_idx ?? e.raw_idx),
```

### 必须新增测试

在 `tests/ai/chan.test.js` 增加测试：

1. 包含处理后 `idx` 必须连续：

```js
const bars = normalizeBarsForChan(rates)
bars.forEach((bar, idx) => expect(bar.idx).toBe(idx))
```

2. 构造“10 根原始 K 线合并后只剩 2 根”的场景，确认第二根 `idx === 1`，不是 `9`。
3. 确认每根处理后 K 线都有 `raw_start_idx/raw_end_idx`，且 `raw_start_idx <= raw_end_idx`。

---

## 问题 4：分型识别条件偏宽，必须改成标准顶底分型

### 当前问题

当前顶分型：

```js
c.high > p.high && c.high > n.high && c.low >= Math.min(p.low, n.low)
```

这个条件太宽。只要中间 K 线高点高于两侧，低点不低于两侧中的最低点，就会被识别为顶分型。

Codex 已复现：

```js
const bars = [
  { idx:0, raw_idx:0, high:100, low:100 },
  { idx:1, raw_idx:1, high:120, low:95 },
  { idx:2, raw_idx:2, high:110, low:90 },
]
```

当前会识别出 `top`，但中间 K 线低点 `95` 并没有高于右侧低点 `90`，不应作为标准顶分型。

### 修复要求

在完成包含处理后，分型规则改为严格标准：

顶分型：

```js
c.high > p.high && c.high > n.high && c.low > p.low && c.low > n.low
```

底分型：

```js
c.low < p.low && c.low < n.low && c.high < p.high && c.high < n.high
```

注意：

- 使用严格大于/小于。
- 相等时不生成分型。
- 如果担心黄金、外汇报价浮点误差，可以定义极小 epsilon，但不要把相等误认为分型。

### 必须新增测试

在 `tests/ai/chan.test.js` 增加：

1. 标准顶分型可识别。
2. 标准底分型可识别。
3. 非标准顶分型不识别。
4. 非标准底分型不识别。
5. 相等高点/低点不识别分型。

---

## 问题 5：背驰判断需要增加最小差异阈值，避免轻微变小就判 strong

### 当前问题

当前逻辑：

```js
if (areaCur < areaPrev) return { type: 'top', strength: 'strong', ... }
```

只要当前面积小一点点，就返回 `strong` 背驰。真实行情中，这会让背驰过敏感。

### 修复要求

增加最小面积差异阈值，建议：

```js
const DIVERGENCE_MIN_AREA_RATIO = 0.85
```

只有：

```js
areaCur > 0 &&
areaPrev > 0 &&
areaCur <= areaPrev * DIVERGENCE_MIN_AREA_RATIO
```

才判定背驰。

如果只是略小，比如 `areaCur = 99, areaPrev = 100`，应返回：

```js
{
  type: 'none',
  reason: 'macd_area_not_shrunk_enough',
  ...
}
```

### 必须新增测试

1. `areaCur = 99, areaPrev = 100` 不应判背驰。
2. `areaCur = 50, areaPrev = 100` 可以判背驰。
3. `areaCur = 0` 不应判强背驰，应返回明确 reason，比如 `invalid_macd_area`。

---

## 问题 6：背驰面积建议按方向过滤 histogram

### 当前问题

当前 `calcArea()`：

```js
area += Math.abs(macdHist[j] || 0)
```

这会把上行段中的绿柱、下行段中的红柱也算入面积。对于背驰力度比较，建议按方向过滤：

- 上行段只统计正 histogram。
- 下行段只统计负 histogram 的绝对值。

### 修复要求

可以把 `calcArea(biIds)` 改为：

```js
function calcArea(biIds, dir) {
  ...
  const v = macdHist[j] || 0
  if (dir === 'up' && v > 0) area += v
  if (dir === 'down' && v < 0) area += Math.abs(v)
}
```

然后：

```js
const areaPrev = calcArea(prev.bi_ids, cur.dir)
const areaCur = calcArea(cur.bi_ids, cur.dir)
```

也可以使用 `prev.dir` 和 `cur.dir`，由于它们是同方向线段，结果应一致。

### 必须新增测试

1. 顶背驰面积只统计正 histogram。
2. 底背驰面积只统计负 histogram。
3. 反向 histogram 不应让背驰成立。

如果本次实现方向过滤风险较大，至少必须先修问题 1-5，并在结果文件中说明问题 6 未实现及原因。但优先建议一起修。

---

## 问题 7：早退时不要丢失已有 warnings

### 当前问题

`computeChan()` 中先收集了：

```js
if (bars.length < 10) warnings.push('processed_bars_too_few')
if (invalidCount > 0) warnings.push('invalid_bi_price_direction')
```

但后面如果：

```js
if (confirmedBis.length < 3) {
  return { ..., warnings: ['insufficient_confirmed_bis'] }
}
```

前面已经收集的 warning 会丢失。

### 修复要求

早退时必须保留已有 warnings：

```js
warnings.push('insufficient_confirmed_bis')
return { ..., warnings }
```

同理检查其它早退分支，不要丢已有 warnings。

### 必须新增测试

构造一个会触发 `invalid_bi_price_direction` 且 confirmed bi 不足的场景，确认返回 warnings 同时包含：

- `invalid_bi_price_direction`
- `insufficient_confirmed_bis`

如果通过公开 `computeChan()` 不容易构造，则至少对 `buildBis()` 保持现有测试，并给 `computeChan()` 增加一个能同时触发多 warning 的可控样本。

---

## 问题 8：线段算法仍是简化版，本次不要大改，但要标注为 conservative

### 当前情况

`buildSegments()` 目前不是完整缠论特征序列线段算法。它是保守简化算法。

本次不要求重写完整线段算法，否则风险较大。

### 要求

1. 不要把当前线段算法宣称为“严格缠论线段”。
2. `computeChan()` 返回中可以保留 `reliability`。
3. 如有必要，在 `warnings` 中加入：

```js
'segments_conservative'
```

但不要让这个 warning 导致所有正常结果都变成低可靠。建议只在文档/注释和结果文件中说明。

4. 检查这行：

```js
segStart = broken ? segEnd : segEnd
```

两边一样。如果保留，请加注释说明为什么下一段从 `segEnd` 开始；如果这是疏漏，请修正为更合理的推进方式并补测试。

---

## 测试要求

必须执行：

```bash
node --check server/routes/ai/market-data.js
node --check tests/ai/chan.test.js
node --check tests/ai/market-data.test.js
npm.cmd test
git diff --check
```

如果某个测试命令失败，必须修复后再提交。不要带失败测试提交。

## 手动实测要求

Mimo 完成后，请在结果文件中写明用户如何手动验证：

1. 后台策略提示词加入 `{{USE_CHAN}}`。
2. 自动推理选择一个常用周期，比如 `M5` 或 `H1`。
3. 等待一轮自动推理。
4. 查看后端日志 `[Chan]` 摘要，确认没有异常报错。
5. 如果返回 `divergence.type=top/bottom`，检查 payload 中：
   - `area_cur`
   - `area_prev`
   - `price_extreme_cur`
   - `price_extreme_prev`
6. 确认 `area_cur` 不应无故为 `0`。
7. 用不含 `{{USE_CHAN}}` 的策略跑一次，确认 payload 不包含 `chan`。
8. 用含 `{{USE_CHAN}}` 的策略跑一次，确认 payload 包含 `chan`，但 system prompt 不包含原始 `{{USE_CHAN}}` 标签。

## 提交要求

完成后：

```bash
git status --short
git add server/routes/ai/market-data.js tests/ai/chan.test.js tests/ai/market-data.test.js docs/agent-results/20260702-mimo-chan-correctness-hardening-result.md
git commit -m "fix: harden chan calculation correctness"
git push origin dev_codex
```

如果 `tests/ai/market-data.test.js` 没有修改，不要强行 add。按实际修改文件提交。

## 验收标准

Codex 复核时会重点检查：

- `histSeries.length === rates.length`。
- `computeChan()` 使用的是 MACD histogram，不是 DIF。
- `detectDivergence()` 不会因为 histogram 数组短而把后半段面积算成 0。
- 包含处理后的 `idx` 连续。
- `raw_start_idx/raw_end_idx` 保留原始 K 线区间。
- 分型规则改为严格顶底分型。
- 轻微面积缩小不会直接判 strong 背驰。
- 早退 warnings 不丢失。
- 新增测试覆盖上述场景。
- `npm.cmd test` 全部通过。
