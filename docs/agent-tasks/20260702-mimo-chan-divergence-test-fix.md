# Mimo 任务：缠论背驰方向判断与测试补齐

## 分支与仓库

- 仓库：`D:\dev_codex\wall-street-skill-local`
- 分支：`dev_codex`
- 只允许在 `dev_codex` 修改、提交、推送。
- 不要合并 `main`。

## 背景

上一轮提交：

- `c3e924d fix: tighten chan bi and divergence validation`

Codex 复核后确认上一轮修复了：

- 非法价格方向不再生成笔。
- `{{USE_CHAN}}` 已从 system prompt 中清理。
- `tests/ai/chan.test.js` 已去掉 `Math.random()`。

但仍存在一个实际逻辑 bug 和两个测试覆盖缺口：

1. `detectDivergence()` 固定先判断 `sameDown`，只要存在两个下行线段，就会直接返回下行分支结果，导致后面的上行顶背驰永远不会检查。
2. 背驰测试没有覆盖 `no_valid_center / no_price_extreme_break / not_after_center / top 成功 / bottom 成功`。
3. `llm.test.js` 没有覆盖 `{{USE_CHAN}}` 清理和 chan payload 保留/剥离。

请只修复这 3 个问题。

## 当前工作区提醒

当前工作区可能存在：

- `.mimocode/`
- `docs/agent-tasks/`

不要删除用户已有文件，不要回滚非本任务相关改动。

## 结果文件要求

完成后写入：

`docs/agent-results/20260702-mimo-chan-divergence-test-fix-result.md`

结果文件必须包含：

- 本次提交 ID，不要再写“待提交”。
- 修改文件清单。
- 每个问题的具体修改位置。
- 修复说明。
- 新增测试说明。
- 执行过的验证命令和结果。
- 手动实测步骤。
- 剩余风险。

## 问题 1：`detectDivergence()` 必须按最新有效线段方向判断

### 当前问题

文件：

- `server/routes/ai/market-data.js`

当前 `detectDivergence()` 逻辑大致是：

```js
const sameDown = validSegs.filter(s => s.dir === 'down')
if (sameDown.length >= 2) {
  ...
  return ...
}

const sameUp = validSegs.filter(s => s.dir === 'up')
if (sameUp.length >= 2) {
  ...
  return ...
}
```

问题：只要 `sameDown.length >= 2`，函数就会在下行分支直接返回，即使当前最新有效线段是上行，也不会检查顶背驰。

Codex 已用最小样例复现：

```js
const segs = [
  { id: 1, dir: 'down', bi_ids: [1, 2, 3], weak: false, low: 90, high: 120 },
  { id: 2, dir: 'up',   bi_ids: [4, 5, 6], weak: false, low: 95, high: 125 },
  { id: 3, dir: 'down', bi_ids: [7, 8, 9], weak: false, low: 95, high: 118 },
  { id: 4, dir: 'up',   bi_ids: [10, 11, 12], weak: false, low: 100, high: 130 },
]
const bis = []
for (let i = 1; i <= 12; i++) bis.push({ id: i, raw_start_idx: i - 1, raw_end_idx: i - 1 })
const macd = [10,10,10,10,10,10,10,10,10,1,1,1]
const centers = [{ status: 'confirmed', end_bi_id: 9 }]
detectDivergence(segs, bis, macd, centers)
```

当前错误结果：

```json
{"type":"none","reason":"not_after_center"}
```

期望结果：应该判断最新有效线段 `seg#4 up`，与前一个 `up` 段比较，满足创新高、MACD 面积缩小、中枢后，返回 `top`。

### 修复要求

重写 `detectDivergence()` 的方向选择逻辑：

1. 先得到有效线段：

```js
const validSegs = segments.filter(s => !s.weak && s.bi_ids.length >= MIN_BIS_PER_SEGMENT)
```

2. 如果有效线段不足 2，返回：

```js
{ type: 'none', strength: 'none', reason: 'insufficient_valid_segments', ... }
```

3. 如果没有有效中枢，返回：

```js
{ type: 'none', strength: 'none', reason: 'no_valid_center', ... }
```

4. 取最新有效线段：

```js
const current = validSegs[validSegs.length - 1]
```

5. 只按 `current.dir` 检查同方向背驰：

```js
const sameDir = validSegs.filter(s => s.dir === current.dir)
if (sameDir.length < 2) return { reason: 'insufficient_same_direction_segments' }
const prev = sameDir[sameDir.length - 2]
const cur = sameDir[sameDir.length - 1]
```

6. 如果 `cur.dir === 'up'`：

- 必须 `cur.high > prev.high`，否则返回 `no_price_extreme_break`。
- 必须 `cur` 位于中枢后，建议规则保持当前简化版：

```js
cur.bi_ids.some(id => id > lastCenter.end_bi_id)
```

- MACD 面积 `areaCur < areaPrev` 时返回：

```js
{
  type: 'top',
  strength: 'strong',
  reason: 'macd_area_divergence',
  area_cur,
  area_prev,
  price_extreme_cur: cur.high,
  price_extreme_prev: prev.high
}
```

7. 如果 `cur.dir === 'down'`：

- 必须 `cur.low < prev.low`，否则返回 `no_price_extreme_break`。
- 必须位于中枢后。
- MACD 面积 `areaCur < areaPrev` 时返回 `bottom`。

8. 不要再先固定检查 `sameDown`。

9. 返回对象必须始终带：

```js
type,
strength,
reason,
area_cur,
area_prev,
price_extreme_cur,
price_extreme_prev
```

## 问题 2：补齐背驰单元测试

文件：

- `tests/ai/chan.test.js`

当前只测了：

- 无有效线段
- 有效线段不足 2 个

必须新增测试，最好直接使用手写 `segments/bis/centers/macdHist`，不要依赖 K 线自然生成。

### 必须新增的测试用例

#### 1. 没有中枢时返回 `no_valid_center`

输入：

- 至少两个有效同方向线段。
- `centers=[]`

期望：

```js
result.type === 'none'
result.reason === 'no_valid_center'
```

#### 2. 上行没有创新高返回 `no_price_extreme_break`

输入：

- 最新有效线段为 `up`。
- 两个 up 段：`cur.high <= prev.high`。
- 有有效中枢且 `cur` 在中枢后。

期望：

```js
result.type === 'none'
result.reason === 'no_price_extreme_break'
```

#### 3. 下行没有创新低返回 `no_price_extreme_break`

输入：

- 最新有效线段为 `down`。
- 两个 down 段：`cur.low >= prev.low`。
- 有有效中枢且 `cur` 在中枢后。

期望同上。

#### 4. 最新线段不在中枢后返回 `not_after_center`

输入：

- 有有效中枢。
- 当前线段所有 `bi_ids` 都不大于 `center.end_bi_id`。
- 价格已经创新高或创新低。

期望：

```js
result.type === 'none'
result.reason === 'not_after_center'
```

#### 5. 顶背驰成功返回 `top`

输入建议：

```js
segments = [
  { id: 1, dir: 'down', bi_ids: [1,2,3], weak: false, low: 90, high: 120 },
  { id: 2, dir: 'up',   bi_ids: [4,5,6], weak: false, low: 95, high: 125 },
  { id: 3, dir: 'down', bi_ids: [7,8,9], weak: false, low: 95, high: 118 },
  { id: 4, dir: 'up',   bi_ids: [10,11,12], weak: false, low: 100, high: 130 },
]
centers = [{ status: 'confirmed', end_bi_id: 9 }]
```

MACD 让第 4 段面积小于第 2 段。

期望：

```js
result.type === 'top'
result.reason === 'macd_area_divergence'
result.price_extreme_cur === 130
result.price_extreme_prev === 125
```

这个用例必须覆盖 Codex 复现过的 bug，确保不会再被下行分支提前返回。

#### 6. 底背驰成功返回 `bottom`

构造最新有效线段为 `down`，后一 down 段创新低且 MACD 面积缩小，且在中枢后。

期望：

```js
result.type === 'bottom'
result.reason === 'macd_area_divergence'
```

## 问题 3：补齐 `{{USE_CHAN}}` 的 LLM 测试

文件：

- `tests/ai/llm.test.js`

当前没有测试：

- system prompt 是否去掉 `{{USE_CHAN}}`
- 有标签时 payload 是否保留 `chan`
- 无标签时 payload 是否剥离 `chan`

### 要求

按现有 `llm.test.js` 的 mock fetch 风格新增测试。

必须覆盖：

#### 1. 有 `{{USE_CHAN}}` 时，system prompt 不包含原始标签

构造：

```js
config.system_prompt = '分析市场 {{USE_CHAN}}'
market.strategy_context.timeframes.H1.summary.chan = { status: 'ok' }
```

拦截 fetch body，检查：

```js
body.messages[0].content.includes('{{USE_CHAN}}') === false
```

#### 2. 有 `{{USE_CHAN}}` 时，payload 保留 `chan`

检查 user message JSON 中仍包含：

```js
strategy_context.timeframes.H1.summary.chan
```

#### 3. 无 `{{USE_CHAN}}` 时，payload 剥离 `chan`

构造没有标签的 system prompt，仍传入带 `chan` 的 market。

检查 user message JSON 中：

```js
strategy_context.timeframes.H1.summary.chan === undefined
```

### 注意

- 不要向日志或测试输出真实 API key。
- 使用测试里的假 key。
- 如果现有 `requestJsonObject` mock 方式会进行 JSON 修复流程，确保 mock 返回合法 AI JSON，避免测试跑偏。

## 验证命令

必须执行：

```powershell
node --check server/routes/ai/market-data.js
node --check server/routes/ai/llm.js
node --check tests/ai/chan.test.js
node --check tests/ai/llm.test.js
npm.cmd test
git diff --check
```

## 手动实测要求

Mimo 结果文件必须写给用户的手动实测步骤：

1. 后台策略提示词加入 `{{USE_CHAN}}`。
2. 开启自动推理，等待一次运行。
3. 查看日志：
   - 默认只看到 `[Chan]` 摘要，不出现完整 Bis/Segments 明细。
4. 如果 `divergence.type=top/bottom`：
   - 检查返回对象包含 `area_cur/area_prev/price_extreme_cur/price_extreme_prev`。
   - 确认日志或调试输出能说明它经过了有效中枢、创新高/低、中枢后检查。
5. 用不含 `{{USE_CHAN}}` 的策略跑一次：
   - payload 不包含 `chan`。
6. 用包含 `{{USE_CHAN}}` 的策略跑一次：
   - payload 包含 `chan.status/reliability/warnings`。
   - system prompt 不包含 `{{USE_CHAN}}` 原始标签。

## 提交要求

1. 修复完成后提交到 `dev_codex`。
2. commit message 建议：

```text
fix: correct chan divergence direction tests
```

3. 推送到 `origin/dev_codex`。
4. 写结果文件：

`docs/agent-results/20260702-mimo-chan-divergence-test-fix-result.md`

## 自查清单

- [ ] `detectDivergence()` 按最新有效线段方向判断。
- [ ] 不再固定先检查 down 再检查 up。
- [ ] 顶背驰必须创新高。
- [ ] 底背驰必须创新低。
- [ ] 背驰必须有有效中枢。
- [ ] 背驰必须在中枢后。
- [ ] 背驰测试覆盖 no_valid_center。
- [ ] 背驰测试覆盖 no_price_extreme_break。
- [ ] 背驰测试覆盖 not_after_center。
- [ ] 背驰测试覆盖 top 成功。
- [ ] 背驰测试覆盖 bottom 成功。
- [ ] LLM 测试覆盖 `{{USE_CHAN}}` 清理。
- [ ] LLM 测试覆盖有标签保留 chan。
- [ ] LLM 测试覆盖无标签剥离 chan。
- [ ] 验证命令全部通过。
