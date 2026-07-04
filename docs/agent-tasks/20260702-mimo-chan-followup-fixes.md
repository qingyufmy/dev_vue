# Mimo 任务：缠论计算后续审查问题修复

## 分支与仓库

- 仓库：`D:\dev_codex\wall-street-skill-local`
- 分支：`dev_codex`
- 只允许在 `dev_codex` 修改、提交、推送。
- 不要合并 `main`。

## 背景

上一轮 Mimo 已提交：

- `275d7b5 fix: harden chan calculation reliability`

Codex 复核后确认：上一轮已经修掉了“1 笔线段大量进入有效 segments”的核心问题，语法和测试也通过。但仍有 4 个需要返工的问题：

1. `buildBis()` 没有校验笔的价格方向，可能生成“向上笔但价格下跌”的错误笔。
2. `detectDivergence()` 仍然不依赖有效中枢，也没有校验同向段创新高/创新低，背驰仍可能误报。
3. `llm.js` 生成了 `cleanPrompt`，但实际发送模型时仍然用了 `fullPrompt`，导致 `{{USE_CHAN}}` 控制标签仍进入 system prompt。
4. `tests/ai/chan.test.js` 使用 `Math.random()` 构造数据，测试有潜在不稳定风险。

请只修复这 4 个问题，不要做无关重构。

## 当前工作区提醒

当前工作区可能存在：

- `.mimocode/`
- `docs/agent-tasks/`

不要删除用户已有文件，不要回滚非本任务相关改动。

## 结果文件要求

完成后写入：

`docs/agent-results/20260702-mimo-chan-followup-fixes-result.md`

结果文件必须包含：

- 本次提交 ID。
- 修改文件清单。
- 每个问题的具体修改位置，例如 `server/routes/ai/market-data.js:104`。
- 每个问题的修复说明。
- 新增或修改的测试说明。
- 执行过的验证命令和结果。
- 手动实测步骤。
- 剩余风险。

## 问题 1：`buildBis()` 必须校验笔的价格方向

### 当前问题

文件：

- `server/routes/ai/market-data.js`

当前 `buildBis()` 中，顶底分型只要满足交替和间隔，就会生成笔。

Codex 已复现：

```js
const f = [
  { idx: 0, raw_idx: 0, type: 'bottom', price: 100, high: 100, low: 100 },
  { idx: 5, raw_idx: 5, type: 'top', price: 90, high: 90, low: 90 },
]
buildBis(f, [])
```

当前错误返回：

```json
[{"dir":"up","start_price":100,"end_price":90}]
```

这是明显错误：底到顶的向上笔，结束价格必须高于开始价格。

### 修复要求

在 `buildBis()` 构造每一笔前增加价格方向校验：

1. 如果 `s.type === 'bottom' && e.type === 'top'`：
   - 笔方向是 `up`
   - 必须满足 `e.price > s.price`
   - 不满足时跳过，不生成笔，并可记录 warning 计数。
2. 如果 `s.type === 'top' && e.type === 'bottom'`：
   - 笔方向是 `down`
   - 必须满足 `e.price < s.price`
   - 不满足时跳过。
3. 如果出现其它异常类型组合，跳过。
4. 需要确保跳过非法笔后，后续合法笔的 `id` 仍连续。
5. 如果非法笔被跳过，`computeChan()` 的 `warnings` 应能体现，例如：
   - `invalid_bi_price_direction`

### 推荐实现方式

可以让 `buildBis()` 返回：

```js
{
  bis,
  warnings
}
```

或保持返回数组，但在 `computeChan()` 里用辅助函数统计。优先选择对现有调用影响最小的方式。

如果改变 `buildBis()` 返回结构，必须同步修改：

- `computeChan()`
- `tests/ai/chan.test.js`

### 测试要求

新增测试：

1. 底到顶但 `top.price <= bottom.price`，不生成 up 笔。
2. 顶到底但 `bottom.price >= top.price`，不生成 down 笔。
3. 合法 up/down 笔仍正常生成。

## 问题 2：背驰判断必须依赖有效中枢和创新高/创新低

### 当前问题

文件：

- `server/routes/ai/market-data.js`

当前 `detectDivergence(segments, bis, macdHist)` 只要最近两个同方向线段 MACD 面积变小，就可能返回 `top/bottom`。

Codex 已复现：没有传入任何中枢概念时，也能返回：

```json
{"type":"top","strength":"strong","reason":"macd_area_divergence"}
```

这不符合上一轮方案中“没有有效线段或有效中枢，不判断背驰”的要求。

### 修复要求

修改 `detectDivergence()` 签名，建议：

```js
function detectDivergence(segments, bis, macdHist, centers = [])
```

要求：

1. 没有有效线段时：

```js
return { type: 'none', strength: 'none', reason: 'insufficient_valid_segments' }
```

2. 没有有效中枢时：

```js
return { type: 'none', strength: 'none', reason: 'no_valid_center' }
```

3. 顶背驰必须同时满足：
   - 至少两个有效上行线段。
   - 后一个上行线段的高点高于前一个上行线段的高点。
   - 后一个上行线段 MACD 面积小于前一个上行线段。
   - 存在有效中枢，且后一个上行线段应是中枢后的离开或推进结构。简化版可以先要求：用于比较的后一线段 `bi_ids` 至少有一个 id 大于最近有效中枢 `end_bi_id`。
4. 底背驰必须同时满足：
   - 至少两个有效下行线段。
   - 后一个下行线段的低点低于前一个下行线段的低点。
   - 后一个下行线段 MACD 面积小于前一个下行线段。
   - 后一个下行线段至少有一个 `bi_id` 大于最近有效中枢 `end_bi_id`。
5. 返回对象必须带完整字段：

```js
{
  type: 'top' | 'bottom' | 'none',
  strength: 'strong' | 'weak' | 'none',
  reason,
  area_cur,
  area_prev,
  price_extreme_cur,
  price_extreme_prev
}
```

6. 如果面积变小但没有创新高/新低，返回：

```js
{ type: 'none', strength: 'none', reason: 'no_price_extreme_break' }
```

7. 如果面积变小且创新高/新低，但不在中枢后，返回：

```js
{ type: 'none', strength: 'none', reason: 'not_after_center' }
```

### 线段高低点计算

当前 segment 只有 `start_price/end_price`。为了判断创新高/新低，建议：

1. 在 `buildSegments()` 创建 segment 时增加：

```js
high: Math.max(...segmentBis.map(b => b.high 或 start/end 最大值))
low: Math.min(...segmentBis.map(b => b.low 或 start/end 最小值))
```

2. `detectDivergence()` 使用：
   - up segment 的 `high`
   - down segment 的 `low`

### computeChan 调用更新

当前：

```js
const divergence = detectDivergence(validSegs, allBis, macdHist)
```

应改为：

```js
const divergence = detectDivergence(validSegs, allBis, macdHist, validCenters)
```

并根据 `divergence.reason` 写入更准确的 warnings：

- `divergence_skipped_no_valid_center`
- `divergence_skipped_not_after_center`
- `divergence_skipped_no_price_extreme_break`

### 测试要求

新增或修改测试：

1. 没有中枢时，即使 MACD 面积缩小，也返回 `type=none, reason=no_valid_center`。
2. 有中枢但后一上行段没有创新高，返回 `type=none, reason=no_price_extreme_break`。
3. 有中枢、后一上行段创新高、MACD 面积缩小，返回 `type=top`。
4. 有中枢、后一下行段创新低、MACD 面积缩小，返回 `type=bottom`。
5. 后一段没有位于中枢后，返回 `type=none, reason=not_after_center`。

## 问题 3：`{{USE_CHAN}}` 标签不能进入模型 system prompt

### 当前问题

文件：

- `server/routes/ai/llm.js`

当前代码：

```js
const useChan = /\{\{USE_CHAN\}\}/.test(config.system_prompt || '')
const cleanPrompt = fullPrompt.replace(/\{\{USE_CHAN\}\}/g, '')
...
messages: [
  { role: 'system', content: fullPrompt },
  ...
]
```

`cleanPrompt` 没有使用，实际发给模型的 system prompt 仍包含 `{{USE_CHAN}}`。

### 修复要求

1. `cleanPrompt` 必须用于 system prompt：

```js
{ role: 'system', content: cleanPrompt }
```

2. `useChan` 判断仍基于原始 `config.system_prompt`。
3. `cleanPrompt` 建议顺手清理多余空行：

```js
const cleanPrompt = fullPrompt.replace(/\{\{USE_CHAN\}\}/g, '').replace(/\n{3,}/g, '\n\n').trim()
```

4. 确保没有 `{{USE_CHAN}}` 的策略仍按原逻辑剥离 `chan`。
5. 确保有 `{{USE_CHAN}}` 的策略仍保留 `chan` 数据。

### 测试要求

在 `tests/ai/llm.test.js` 中新增或调整测试：

1. system prompt 带 `{{USE_CHAN}}` 时，传给 fetch 的 messages[0].content 不包含 `{{USE_CHAN}}`。
2. system prompt 带 `{{USE_CHAN}}` 时，payload 仍保留 `chan`。
3. system prompt 不带 `{{USE_CHAN}}` 时，payload 中剥离 `chan`。

如果现有测试不方便直接检查 fetch body，请按现有 `llm.test.js` 的 mock fetch 风格实现。

## 问题 4：缠论测试不能使用随机数据

### 当前问题

文件：

- `tests/ai/chan.test.js`

当前 `makeRates()` 使用：

```js
Math.random()
```

这会导致测试长期存在偶发不稳定风险。

### 修复要求

1. 去掉所有测试中的 `Math.random()`。
2. 使用确定性波形，例如：

```js
const wave = Math.sin(i * 0.5) * 20
const jitter = ((i * 7) % 5) * 0.8
```

或手写固定高低点序列。

3. 对需要明确形成笔/线段/中枢/背驰的测试，优先使用手写固定 `bis/segments/centers`，不要依赖随机 K 线自然生成。
4. 新测试必须可重复。

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

1. 后台策略提示词中加入 `{{USE_CHAN}}`。
2. 开启自动推理，等待一次运行完成。
3. 查看日志：
   - 默认只看到每周期一行 `[Chan]` 摘要。
   - 不应出现完整 `Bis(...)`、`Segments(...)` 明细，除非 `DEBUG_CHAN=1`。
4. 查看 `[Chan]` 摘要：
   - 不应出现 `segment_count === bi_count`。
   - 不应出现大量 `bis=1 weak=true` 的有效线段。
5. 如果日志中出现 `divergence.type=top/bottom`：
   - 结果对象必须带 `area_cur/area_prev/price_extreme_cur/price_extreme_prev`。
   - 必须能说明它经过了有效中枢和创新高/新低检查。
6. 用一个不含 `{{USE_CHAN}}` 的策略跑一次：
   - AI payload 中不应包含 `chan`。
7. 用一个包含 `{{USE_CHAN}}` 的策略跑一次：
   - AI payload 中应包含 `chan.status/reliability/warnings`。
   - system prompt 不应含 `{{USE_CHAN}}` 原始标签。

## 提交要求

1. 修复后提交到 `dev_codex`。
2. commit message 建议：

```text
fix: tighten chan bi and divergence validation
```

3. 推送到 `origin/dev_codex`。
4. 写结果文件：

`docs/agent-results/20260702-mimo-chan-followup-fixes-result.md`

## 自查清单

- [ ] 非法价格方向不会生成笔。
- [ ] 合法笔仍正常生成。
- [ ] 背驰必须依赖有效中枢。
- [ ] 顶背驰要求创新高。
- [ ] 底背驰要求创新低。
- [ ] 背驰要求后一段位于中枢之后。
- [ ] `{{USE_CHAN}}` 不进入 system prompt。
- [ ] 有 `{{USE_CHAN}}` 时仍保留 chan payload。
- [ ] 无 `{{USE_CHAN}}` 时仍剥离 chan payload。
- [ ] 缠论测试去掉 `Math.random()`。
- [ ] 所有验证命令通过。
