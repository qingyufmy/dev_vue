# Mimo 任务：缠论正确性加固后续修复

## 分支与仓库

- 仓库：`D:\dev_codex\wall-street-skill-local`
- 分支：`dev_codex`
- 只允许在 `dev_codex` 修改、提交、推送。
- 不要合并 `main`。
- 不要删除 `.mimocode/`、`docs/agent-tasks/` 或其它用户已有文件。

## 背景

上一轮 Mimo 已完成：

- 提交：`71112af fix: harden chan calculation correctness`
- 结果文件：`docs/agent-results/20260702-mimo-chan-correctness-hardening-result.md`

Codex 复核确认，大部分核心问题已经修好：

- MACD histogram 已按 K 线长度对齐。
- `computeChan()` 已使用 `macdSeries.histSeries`。
- 包含处理后 `idx` 已重新编号。
- 严格顶分型/非标准顶分型逻辑已修复。
- 背驰等面积场景不再误报。
- `npm.cmd test` 通过，当前为 `7 files / 114 tests passed`。

但仍有 4 个遗留问题需要小范围修复。本任务只修这些问题，不要再大改缠论算法、自动推理、桥接、数据库或 UI。

## 结果文件要求

完成后写入：

`docs/agent-results/20260702-mimo-chan-output-tests-followup-result.md`

结果文件必须包含：

- 本次实际提交 ID，不要写“待提交”。
- 修改文件清单。
- 每个问题的具体修复位置。
- 修复说明。
- 新增/修改测试说明。
- 执行过的验证命令和结果。
- 手动实测步骤。
- 剩余风险。

同时，请修正上一轮结果文件中的提交 ID：

- `docs/agent-results/20260702-mimo-chan-correctness-hardening-result.md`

把里面的“待提交”替换为上一轮实际提交：

- `71112af fix: harden chan calculation correctness`

## 修改范围

主要允许修改：

- `server/routes/ai/market-data.js`
- `tests/ai/chan.test.js`
- `tests/ai/market-data.test.js`
- `docs/agent-results/20260702-mimo-chan-correctness-hardening-result.md`
- `docs/agent-results/20260702-mimo-chan-output-tests-followup-result.md`

如果确实需要修改其它文件，必须在结果文件中说明原因。

---

## 问题 1：`macd.line/signal/histogram` 必须来自同一套 MACD 序列

### 当前问题

文件：

- `server/routes/ai/market-data.js`

当前代码大致为：

```js
const ema12 = ema(closes, 12)
const ema26 = ema(closes, 26)
const macdLine = ema12 - ema26
const macdSeries = calculateMacdSeries(closes)
const macdSignal = macdSeries.latestDea
const macdHistogram = macdSeries.latestHist
```

后续输出：

```js
macd: {
  line: round5(macdLine),
  signal: round5(macdSignal),
  histogram: round5(macdHistogram),
}
```

问题：`line` 使用旧 `ema()` 算法，`signal/histogram` 使用新 `calculateMacdSeries()`。这会导致：

```text
macd.line - macd.signal !== macd.histogram
```

Codex 已复现：

```json
{
  "marketLine": 7.21835,
  "latestDif": 7.18915,
  "marketSignal": 6.86868,
  "latestDea": 6.86868,
  "marketHist": 0.32047,
  "latestHist": 0.32047
}
```

### 修复要求

必须让 `macd.line/signal/histogram` 全部来自同一套 `calculateMacdSeries()`：

```js
const macdSeries = calculateMacdSeries(closes)
const macdLine = macdSeries.latestDif
const macdSignal = macdSeries.latestDea
const macdHistogram = macdSeries.latestHist
```

然后输出：

```js
macd: {
  line: round5(macdLine),
  signal: round5(macdSignal),
  histogram: round5(macdHistogram),
  trend: macdHistogram > 0 ? 'bullish' : macdHistogram < 0 ? 'bearish' : 'neutral',
}
```

原来的 `ema12/ema26` 指标字段仍可保留现有算法，不强制改：

```js
ema_12
ema_26
```

但 `macd.line` 不能再用旧 `ema12 - ema26`。

### 必须新增测试

建议在 `tests/ai/market-data.test.js` 增加测试：

```js
it('MACD输出line/signal/histogram来自同一套序列', () => {
  const rates = generateRates(80)
  const result = calculateMarketData('XAUUSD', 'M5', rates, baseAccount, basePositions)
  expect(Math.abs((result.macd.line - result.macd.signal) - result.macd.histogram)).toBeLessThan(0.00002)
})
```

注意 `round5` 后有浮点误差，断言不要使用严格相等。

也可以通过 `__chanTest.calculateMacdSeries` 与 `calculateMarketData().macd.line` 对比：

```js
const series = __chanTest.calculateMacdSeries(rates.map(r => parseFloat(r.close)))
expect(result.macd.line).toBeCloseTo(series.latestDif, 5)
expect(result.macd.signal).toBeCloseTo(series.latestDea, 5)
expect(result.macd.histogram).toBeCloseTo(series.latestHist, 5)
```

---

## 问题 2：早退 warnings 测试没有真正覆盖 `computeChan()`

### 当前问题

文件：

- `tests/ai/chan.test.js`

当前新增的测试名称是“invalid_bi 和 insufficient_bis 同时出现”，但实际只调用了：

```js
const { bis, invalidCount } = buildBis(fractals, bars)
expect(invalidCount).toBeGreaterThan(0)
```

这个测试没有调用 `computeChan()`，也没有验证返回的 `warnings`。

上一轮任务要求是：早退时不要丢失已有 warnings。也就是 `computeChan()` 返回时应同时保留：

- `invalid_bi_price_direction`
- `insufficient_confirmed_bis`

### 修复要求

必须增加一个真正调用 `computeChan()` 的测试，证明早退 warnings 不丢。

可以采用以下方式之一：

#### 方案 A：构造真实 rates 触发

优先尝试用真实 rates 构造一个能触发非法笔方向且 confirmed bi 不足的样本，然后：

```js
const result = computeChan(rates, 'M5', hist)
expect(result.status).toBe('insufficient_bis')
expect(result.warnings).toContain('invalid_bi_price_direction')
expect(result.warnings).toContain('insufficient_confirmed_bis')
```

#### 方案 B：允许小范围测试钩子

如果通过真实 rates 很难稳定构造，可以给 `computeChan()` 增加一个仅测试用的可选 options 参数，默认不影响生产：

```js
function computeChan(rates, timeframe, macdHist, options = {}) {
  ...
  const fractals = options.fractalsForTest || detectFractals(bars)
  ...
}
```

要求：

- 默认行为完全不变。
- options 只用于测试。
- 不要把测试字段放入正常返回 payload。

然后测试：

```js
const rates = makeRates(30)
const fractalsForTest = [
  { idx: 0, raw_start_idx: 0, raw_end_idx: 0, type: 'bottom', price: 100, high: 100, low: 100, time: 't0' },
  { idx: 5, raw_start_idx: 5, raw_end_idx: 5, type: 'top', price: 90, high: 90, low: 90, time: 't5' },
]
const result = computeChan(rates, 'M5', Array(30).fill(0), { fractalsForTest })
expect(result.warnings).toContain('invalid_bi_price_direction')
expect(result.warnings).toContain('insufficient_confirmed_bis')
```

如果使用 options，请同时确保 `__chanTest.computeChan` 测试可以访问。

---

## 问题 3：严格底分型相关测试未补齐

### 当前问题

文件：

- `tests/ai/chan.test.js`

上一轮要求补齐：

1. 标准顶分型可识别。
2. 标准底分型可识别。
3. 非标准顶分型不识别。
4. 非标准底分型不识别。
5. 相等高点/低点不识别分型。

当前只覆盖了：

- 标准顶分型可识别。
- 非标准顶分型不识别。
- 相等高点不识别。

缺少：

- 标准底分型可识别。
- 非标准底分型不识别。
- 相等低点不识别。

### 修复要求

在 `tests/ai/chan.test.js` 的 `detectFractals strict` 测试组中补齐以下测试。

#### 标准底分型可识别

```js
const bars = [
  { idx: 0, raw_start_idx: 0, raw_end_idx: 0, high: 120, low: 100, time: 't0' },
  { idx: 1, raw_start_idx: 1, raw_end_idx: 1, high: 115, low: 80, time: 't1' },
  { idx: 2, raw_start_idx: 2, raw_end_idx: 2, high: 125, low: 90, time: 't2' },
]
const fractals = detectFractals(bars)
expect(fractals.some(f => f.type === 'bottom')).toBe(true)
```

#### 非标准底分型不识别

中间 K 线低点创新低，但高点没有低于左右两根之一，不应识别：

```js
const bars = [
  { idx: 0, raw_start_idx: 0, raw_end_idx: 0, high: 120, low: 100, time: 't0' },
  { idx: 1, raw_start_idx: 1, raw_end_idx: 1, high: 125, low: 80, time: 't1' },
  { idx: 2, raw_start_idx: 2, raw_end_idx: 2, high: 130, low: 90, time: 't2' },
]
const fractals = detectFractals(bars)
expect(fractals.some(f => f.type === 'bottom')).toBe(false)
```

#### 相等低点不识别

```js
const bars = [
  { idx: 0, raw_start_idx: 0, raw_end_idx: 0, high: 120, low: 80, time: 't0' },
  { idx: 1, raw_start_idx: 1, raw_end_idx: 1, high: 115, low: 80, time: 't1' },
  { idx: 2, raw_start_idx: 2, raw_end_idx: 2, high: 125, low: 90, time: 't2' },
]
const fractals = detectFractals(bars)
expect(fractals.some(f => f.type === 'bottom')).toBe(false)
```

---

## 问题 4：结果文件提交 ID 不能再写“待提交”

### 当前问题

文件：

- `docs/agent-results/20260702-mimo-chan-correctness-hardening-result.md`

当前内容：

```md
## 提交 ID

待提交
```

实际上一轮提交是：

```text
71112af fix: harden chan calculation correctness
```

### 修复要求

1. 修正上一轮结果文件：

```md
## 提交 ID

71112af fix: harden chan calculation correctness
```

2. 本轮新结果文件 `docs/agent-results/20260702-mimo-chan-output-tests-followup-result.md` 必须写本轮实际提交 ID。
3. 不要再写“待提交”。

---

## 验证命令

必须执行：

```bash
node --check server/routes/ai/market-data.js
node --check tests/ai/chan.test.js
node --check tests/ai/market-data.test.js
npm.cmd test
git diff --check
```

如果某条命令失败，必须修复后再提交。

## 手动实测要求

结果文件中必须说明如何手动验证：

1. 后台策略提示词加入 `{{USE_CHAN}}`。
2. 自动推理选择一个常用周期，比如 `M5` 或 `H1`。
3. 等待一轮自动推理。
4. 查看后端日志 `[Chan]` 摘要，确认没有异常报错。
5. 查看 AI payload 中 `macd`：
   - `line`
   - `signal`
   - `histogram`
6. 确认 `line - signal` 约等于 `histogram`。
7. 如果返回 `divergence.type=top/bottom`，检查：
   - `area_cur`
   - `area_prev`
   - `price_extreme_cur`
   - `price_extreme_prev`
8. 确认 `area_cur` 不应无故为 `0`。

## 提交要求

完成后：

```bash
git status --short
git add server/routes/ai/market-data.js tests/ai/chan.test.js tests/ai/market-data.test.js docs/agent-results/20260702-mimo-chan-correctness-hardening-result.md docs/agent-results/20260702-mimo-chan-output-tests-followup-result.md
git commit -m "fix: align chan macd output and tests"
git push origin dev_codex
```

如果某个文件没有修改，不要强行 add。按实际修改文件提交。

## 验收标准

Codex 复核时会重点检查：

- `calculateMarketData().macd.line` 使用 `macdSeries.latestDif`。
- `macd.line - macd.signal` 约等于 `macd.histogram`。
- `computeChan()` 早退 warnings 的测试真正调用了 `computeChan()`。
- 严格底分型测试已补齐。
- 上一轮结果文件不再写“待提交”。
- 本轮结果文件写真实提交 ID。
- `npm.cmd test` 全部通过。
