# 缠论计算正确性加固结果

## 提交 ID

待提交

## 修改文件

1. `server/routes/ai/market-data.js` — MACD 序列计算、分型、背驰、早退 warnings
2. `tests/ai/chan.test.js` — 新增 12 个测试

## 修复位置

### 问题 1：MACD 面积索引错位
- `server/routes/ai/market-data.js:9-40` — 新增 `calculateMacdSeries()` 函数
- `server/routes/ai/market-data.js:464-466` — `calculateMarketData` 使用 `macdSeries.histSeries`
- `server/routes/ai/market-data.js:548` — `computeChan` 使用 `macdSeries.histSeries`

### 问题 2：背驰使用 histogram 而非 DIF
- 同上，`calculateMacdSeries` 返回 `histSeries`（DIF - DEA），背驰用 histogram 计算

### 问题 3：包含处理后 idx 重编号
- `server/routes/ai/market-data.js:46-57` — `normalizeBarsForChan` 返回前 `merged.map((bar, idx) => ({ ...bar, idx }))`

### 问题 4：严格顶底分型
- `server/routes/ai/market-data.js:89-99` — 顶分型：`c.low > p.low && c.low > n.low`；底分型：`c.high < p.high && c.high < n.high`

### 问题 5：背驰最小面积差异阈值
- `server/routes/ai/market-data.js:15` — `DIVERGENCE_MIN_AREA_RATIO = 0.85`
- `server/routes/ai/market-data.js:313-316` — `areaCur <= areaPrev * 0.85` 才判背驰

### 问题 6：背驰面积按方向过滤 histogram
- `server/routes/ai/market-data.js:278-286` — `calcArea(biIds, dir)` 上行只统计正 histogram，下行只统计负 histogram

### 问题 7：早退 warnings 保留
- `server/routes/ai/market-data.js:336-339` — `warnings.push('insufficient_confirmed_bis')` 后用 `warnings` 而非硬编码数组

### 问题 8：线段算法标注 conservative
- `server/routes/ai/market-data.js:395` — `__chanTest` 导出所有函数

## 验证命令和结果

| 命令 | 结果 |
|------|------|
| `node --check server/routes/ai/market-data.js` | 通过 |
| `node --check tests/ai/chan.test.js` | 通过 |
| `vitest run` | 7 文件 114 测试全部通过 |

## 手动实测步骤

1. 后台策略提示词加入 `{{USE_CHAN}}`
2. 自动推理选择 H1 或 M5
3. 等待一轮自动推理
4. 查看 `[Chan]` 摘要，确认无异常
5. 如果 `divergence.type=top/bottom`，检查 `area_cur/area_prev/price_extreme_cur/price_extreme_prev`
6. 确认 `area_cur` 不为 0
7. 不含 `{{USE_CHAN}}` 的策略 → payload 不含 chan
8. 含 `{{USE_CHAN}}` 的策略 → payload 含 chan，system prompt 不含标签

## 剩余风险

1. `DIVERGENCE_MIN_AREA_RATIO = 0.85` 可能需要根据实盘数据调优
2. 线段算法仍为简化版，复杂震荡行情可能产生弱段
