# Mimo 任务：缠论计算保守化修复与验收

## 分支与仓库

- 仓库：`D:\dev_codex\wall-street-skill-local`
- 分支：`dev_codex`
- 只允许在 `dev_codex` 修改、提交、推送。
- 不要合并 `main`。

## 当前工作区提醒

当前工作区已有未提交改动：

- `public/ai/index.html`
- `server/routes/ai/llm.js`
- `server/routes/ai/market-data.js`
- `.mimocode/`

这些大概率是上一轮 Mimo 或本轮缠论调试留下的改动。请不要随意回滚用户已有改动。只围绕本任务修复缠论计算和必要日志开关。

## 背景

用户已经让 Mimo 增加了缠论计算，并贴出自动推理日志。日志中出现明显异常：

```text
[Chan] H1: ok (bis=23, segs=23, centers=2, price_vs=above, div=none)
[Chan] Segments(23): #1(up) bis=1 weak=true | #2(down) bis=1 weak=true | ...
```

这说明当前线段算法几乎把每一笔都切成一条线段，大量 `bis=1 weak=true` 的弱段仍被作为 `segments` 输出并参与后续中枢/背驰判断。这不是可信的缠论结构。

当前代码主要在：

- `server/routes/ai/market-data.js`
- `server/routes/ai/llm.js`

当前问题包括：

1. 分型前没有 K 线包含关系处理。
2. 笔构造过宽松，容易产生过多虚假笔。
3. 线段构造错误，允许 1 笔弱段进入有效线段数组。
4. 中枢合并使用扩大区间，实际应该保守使用交集区间。
5. 背驰判断过于简单，没有有效线段/中枢时也可能误判。
6. 默认日志太多，`LLM` payload 和缠论明细会刷屏，并可能输出账户/行情上下文。

## 总目标

把当前缠论计算从“粗略分型连接”改成“保守可用版缠论结构”。

原则：

- 宁可少输出，也不要输出错误线段、中枢、背驰。
- 如果结构不足，就返回 `partial` 或 `unreliable_segments`。
- 不要为了让 AI 有内容可读而构造虚假的线段。
- AI payload 里必须带 `status/reliability/warnings`，让模型知道结构是否可信。

本任务不要求实现完整缠论所有严谨细节，但必须修掉当前日志里的明显错误。

## 非目标

- 不改自动推理调度器。
- 不改桥接连接逻辑。
- 不改交易执行逻辑。
- 不改观摩模式逻辑。
- 不改前端 UI。
- 不处理上一轮安全权限修复遗留问题，除非这些问题阻塞本任务测试。

## 结果文件要求

完成后写入：

`docs/agent-results/20260702-mimo-chan-calculation-hardening-result.md`

结果文件必须包含：

- 本次提交 ID。
- 修改文件清单。
- 每个主要函数的修改位置，例如 `server/routes/ai/market-data.js:xx`。
- 说明当前实现是“保守缠论计算”，不是完整严格缠论。
- 明确列出仍未覆盖的缠论规则。
- 给出修复前后日志摘要对比，至少说明是否还会出现 `bis=23, segs=23` 这类异常。
- 手动实测步骤。
- 执行过的验证命令和结果。
- 剩余风险。

## 一、输出状态与可信度

在 `computeChan()` 返回结构中增加或规范以下字段：

```js
chan: {
  status,
  reliability,
  raw_bar_count,
  processed_bar_count,
  fractal_count,
  bi_count,
  segment_count,
  center_count,
  current_bi,
  recent_bis,
  current_segment,
  candidate_segment,
  current_center,
  price_vs_center,
  divergence,
  warnings
}
```

### status 规则

- `ok`：有可信笔、有效线段、可用中枢或结构状态。
- `partial`：有笔，但线段或中枢不足，只能作为辅助参考。
- `insufficient_klines`：K 线不足。
- `insufficient_bis`：有效笔不足。
- `unreliable_segments`：有笔，但无法确认有效线段，禁止输出背驰结论。

### reliability 规则

- `high`：有有效线段和有效中枢。
- `medium`：有有效笔和至少一个有效线段，但中枢不足。
- `low`：只有笔或候选线段。

`warnings` 中要写清楚原因，例如：

- `raw_bars_too_few`
- `processed_bars_too_few`
- `segments_not_confirmed`
- `no_valid_center`
- `divergence_skipped_no_valid_segment`

## 二、K 线包含关系处理

新增函数建议：

```js
function normalizeBarsForChan(rates) {}
```

要求：

1. 输入按时间升序处理。
2. 转成数字字段：`open/high/low/close/time/raw_idx`。
3. 过滤无效 K 线：
   - high/low/open/close 不是有限数字时过滤。
   - high < low 时过滤。
4. 先处理包含关系，再识别分型。
5. 包含关系判断：
   - 当前 high <= 上一 high 且当前 low >= 上一 low
   - 或当前 high >= 上一 high 且当前 low <= 上一 low
6. 合并方向：
   - 上升方向：取更高 high、更高 low。
   - 下降方向：取更低 high、更低 low。
   - 没有方向时，先根据最近两个非包含 K 线判断；仍无法判断时保守取覆盖区间，但要标记 warning。
7. 保留原始索引范围：
   - `raw_start_idx`
   - `raw_end_idx`

验收点：

- 分型识别必须基于处理后的 K 线。
- 返回里有 `raw_bar_count` 和 `processed_bar_count`。

## 三、分型识别修复

修改 `detectFractals()`：

1. 基于处理后的 K 线。
2. 顶分型：
   - 当前 high > 前 high 且当前 high > 后 high。
   - 当前 low >= min(前 low, 后 low) 可作为保守条件。
3. 底分型：
   - 当前 low < 前 low 且当前 low < 后 low。
   - 当前 high <= max(前 high, 后 high) 可作为保守条件。
4. 同类型连续分型只保留更极端：
   - 顶保留更高 high。
   - 底保留更低 low。
5. 顶底必须交替。
6. 输出字段建议：

```js
{
  idx,
  raw_idx,
  type: 'top' | 'bottom',
  price,
  high,
  low,
  time
}
```

## 四、笔构造修复

修改 `buildBis()`：

1. 顶底交替才可能成笔。
2. 成笔最小间隔建议改为：
   - `MIN_BARS_PER_BI = 4` 或 `5`
   - 不要继续使用现在太宽松的 `KLINE_PER_BI = 3` 语义。
3. 价格必须有效：
   - 底到顶：顶价格 > 底价格。
   - 顶到底：底价格 < 顶价格。
4. 如果同类型分型更极端，替换当前候选端点，不新增笔。
5. 最后一笔如果未被后续分型充分确认，标记：
   - `confirmed: false`
6. 只有 `confirmed !== false` 的笔才能参与线段、中枢、背驰。
7. `recent_bis` 可以展示未确认笔，但必须带 `confirmed`。

建议笔结构：

```js
{
  id,
  dir: 'up' | 'down',
  start_idx,
  end_idx,
  raw_start_idx,
  raw_end_idx,
  start_price,
  end_price,
  high,
  low,
  confirmed
}
```

## 五、线段构造修复

当前最大错误在 `buildSegments()`。

必须满足：

1. 有效线段至少 3 笔。
2. 1 笔或 2 笔只能作为 `candidate_segment`，不能进入 `segments`。
3. `weak=true` 的段不要放进有效 `segments` 主数组。
4. 不允许出现正常行情下 `segment_count === bi_count` 的结果。
5. 线段破坏不能由单笔反向突破立即确认。反向段必须形成至少 3 笔候选，才确认新线段。

可以采用保守简化算法：

1. 使用已确认笔数组 `confirmedBis`。
2. 从连续 3 笔开始寻找候选段。
3. 候选段方向按第一笔方向。
4. 满足推进关系后确认线段：
   - 上线段：后续同向高点能够延伸，反向笔不立即破坏。
   - 下线段：后续同向低点能够延伸，反向笔不立即破坏。
5. 新线段必须由至少 3 笔反向候选确认。
6. 当前不足 3 笔的尾部结构放到 `candidate_segment`。

如果暂时无法严谨实现线段确认，宁可：

```js
segments: []
candidate_segment: {...}
status: 'unreliable_segments'
```

不要输出一堆 1 笔线段。

## 六、中枢计算修正

修改 `buildCenters()`。

当前合并逻辑会扩大中枢区间，这是错误的。必须改为交集。

### 中枢形成

连续三笔或三段区间有重叠才形成中枢。

区间计算：

```js
const low = Math.min(start_price, end_price)
const high = Math.max(start_price, end_price)
const zl = Math.max(r1.low, r2.low, r3.low)
const zh = Math.min(r1.high, r2.high, r3.high)
if (zl < zh) center成立
```

### 中枢延伸

延伸时仍取交集，不取并集：

```js
const nextZl = Math.max(existing.zl, next.low)
const nextZh = Math.min(existing.zh, next.high)
if (nextZl < nextZh) {
  existing.zl = nextZl
  existing.zh = nextZh
  existing.status = 'extended'
} else {
  existing.status = 'closed'
  // 尝试从新窗口重新形成中枢
}
```

建议字段：

```js
{
  id,
  zl,
  zh,
  start_bi_id,
  end_bi_id,
  bi_ids,
  level,
  status: 'forming' | 'confirmed' | 'extended' | 'closed'
}
```

## 七、背驰判断保守化

修改 `detectDivergence()`。

要求：

1. 没有有效线段或有效中枢，不判断背驰：

```js
return { type: 'none', strength: 'none', reason: 'no_valid_segment_or_center' }
```

2. 顶背驰至少满足：
   - 后一上攻创新高。
   - 当前 MACD 面积或力度小于前一次同向上攻。
   - 最好发生在离开中枢之后。

3. 底背驰至少满足：
   - 后一下跌创新低。
   - 当前 MACD 面积或力度小于前一次同向下跌。

4. MACD 面积必须按原始 K 线索引计算，不能用处理后索引直接错位。
5. 输出必须带原因：

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

## 八、日志与性能

当前日志刷屏：

- `[Chan] Bis(...)`
- `[Chan] Segments(...)`
- `[LLM] Payload to model (...)`

要求：

1. 新增调试开关：

```js
const DEBUG_CHAN = process.env.DEBUG_CHAN === '1'
const DEBUG_LLM_PAYLOAD = process.env.DEBUG_LLM_PAYLOAD === '1'
```

2. 默认只打印摘要：

```text
[Chan] H1: status=partial reliability=low raw=80 processed=... fractals=... bis=... segs=... centers=... warnings=...
```

3. 只有 `DEBUG_CHAN=1` 时才打印完整 Bis/Segments 明细。
4. 只有 `DEBUG_LLM_PAYLOAD=1` 时才打印完整/截断 payload。
5. 不要默认打印账户详情、持仓详情或完整 AI payload。

## 九、避免重复计算

日志里 H1 被打印两次，可能是主周期计算一次、策略上下文又计算一次。

要求：

1. 查 `calculateMarketData()` 和策略上下文构建链路。
2. 如果同一轮同一 `symbol + timeframe + rates` 被重复计算，增加本轮缓存或复用已有 `summary.chan`。
3. 如果短期不好改，至少结果文件说明原因，并保证默认日志不刷屏。

## 十、AI 输入兼容

`server/routes/ai/llm.js` 中已有 `{{USE_CHAN}}` 判断。

要求：

1. 没有 `{{USE_CHAN}}` 的策略，仍然要剥离 `chan`。
2. 有 `{{USE_CHAN}}` 的策略，传入新结构。
3. 如果 `chan.status !== 'ok'`，AI payload 中必须保留 status/warnings/reliability，让模型知道不能强依赖。
4. 默认不要打印完整 payload。

## 十一、测试要求

请尽量新增单元测试。建议把缠论核心函数导出为测试专用函数，或在同文件中导出：

```js
export const __chanTest = {
  normalizeBarsForChan,
  detectFractals,
  buildBis,
  buildSegments,
  buildCenters,
  detectDivergence,
  computeChan,
}
```

新增测试文件建议：

`tests/ai/chan.test.js`

至少覆盖：

1. 包含关系处理：
   - 输入包含 K 线，输出处理后数量减少。
   - 上升/下降方向合并 high/low 正确。
2. 分型去重：
   - 连续顶分型只保留更高顶。
   - 连续底分型只保留更低底。
3. 最小成笔：
   - 距离不足不成笔。
   - 价格方向不成立不成笔。
4. 禁止 1 笔线段：
   - 只有 1-2 笔时 `segments=[]`，只返回 `candidate_segment`。
   - 不能出现每笔都变成线段。
5. 中枢交集：
   - 三个区间有重叠时 `zl=max(low)`、`zh=min(high)`。
   - 延伸时中枢区间不会扩大。
6. 背驰保守：
   - 没有有效线段或中枢时，返回 `type=none` 且 reason 清楚。

## 十二、验收标准

用用户这次日志对应的自动推理场景再次运行后，必须满足：

1. 不再出现：

```text
H1: ok (bis=23, segs=23, ...)
Segments(23): #1(up) bis=1 weak=true | ...
```

2. 有效 `segment_count` 不能等于 `bi_count`。
3. `weak` 段不能参与中枢和背驰。
4. 如果只有弱段，应返回 `status=partial` 或 `unreliable_segments`。
5. 中枢区间不会越合并越大。
6. `divergence.type='none'` 时必须带 `reason`。
7. 默认日志只输出每周期一行摘要。
8. 没有 `{{USE_CHAN}}` 的策略仍然不会把 `chan` 发给模型。

## 十三、验证命令

至少执行：

```powershell
node --check server/routes/ai/market-data.js
node --check server/routes/ai/llm.js
npm.cmd test
git diff --check
```

如果新增了测试文件，确认 `npm.cmd test` 包含新测试。

## 十四、提交要求

1. 修复完成后提交到 `dev_codex`。
2. commit message 建议：

```text
fix: harden chan calculation reliability
```

3. 推送到 `origin/dev_codex`。
4. 写结果文件：

`docs/agent-results/20260702-mimo-chan-calculation-hardening-result.md`

## 十五、结果文件中必须给用户的手动实测步骤

Mimo 结果文件必须写清楚用户怎么手动测：

1. 后台策略提示词中包含 `{{USE_CHAN}}`。
2. 开启自动推理。
3. 等待一次自动推理完成。
4. 查看服务日志：
   - 默认只应看到每周期一行 `[Chan]` 摘要。
   - 不应看到完整 `Bis(...)` 和 `Segments(...)` 明细，除非设置了 `DEBUG_CHAN=1`。
5. 查看摘要：
   - `segment_count` 不应等于 `bi_count`。
   - 不应出现大量 `bis=1 weak=true` 的有效线段。
6. 查看 AI payload：
   - 默认不打印完整 payload。
   - 设置 `DEBUG_LLM_PAYLOAD=1` 才打印截断 payload。
7. 如果结构不足：
   - `chan.status` 应显示 `partial` 或 `unreliable_segments`。
   - `warnings` 应说明原因。

## 十六、自查清单

- [ ] 已处理 K 线包含关系。
- [ ] 分型基于处理后 K 线。
- [ ] 笔构造更保守，最后未确认笔有 `confirmed=false`。
- [ ] 有效线段至少 3 笔。
- [ ] 1-2 笔结构只作为候选段，不进入 `segments`。
- [ ] 中枢使用交集，不使用并集扩大。
- [ ] 背驰判断依赖有效线段/中枢，否则返回 none + reason。
- [ ] 默认日志降噪。
- [ ] `{{USE_CHAN}}` 逻辑保持兼容。
- [ ] 新增或更新测试。
- [ ] 结果文件写清修改位置和手动实测步骤。
