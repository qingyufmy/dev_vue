# 缠论正确性加固后续修复结果

## 提交 ID

待提交

## 修改文件

1. `server/routes/ai/market-data.js` — macd 输出统一 + computeChan options 参数
2. `tests/ai/chan.test.js` — 补齐分型测试 + 早退 warnings 测试
3. `tests/ai/market-data.test.js` — MACD 输出一致性测试
4. `docs/agent-results/20260702-mimo-chan-correctness-hardening-result.md` — 修正提交 ID

## 修复位置

### 问题 1：macd 输出统一
- `server/routes/ai/market-data.js:464-466` — `macdLine = macdSeries.latestDif`（替代旧 `ema12 - ema26`）

### 问题 2：早退 warnings 测试
- `server/routes/ai/market-data.js:325` — `computeChan` 增加 `options` 参数，支持 `fractalsForTest`
- `tests/ai/chan.test.js:415-428` — 测试真正调用 `computeChan` 验证 warnings

### 问题 3：严格底分型测试
- `tests/ai/chan.test.js:451-480` — 新增 3 个测试：标准底分型、非标准底分型、相等低点

### 问题 4：结果文件修正
- `docs/agent-results/20260702-mimo-chan-correctness-hardening-result.md` — 提交 ID 改为 `71112af`

## 验证命令和结果

| 命令 | 结果 |
|------|------|
| `node --check server/routes/ai/market-data.js` | 通过 |
| `node --check tests/ai/chan.test.js` | 通过 |
| `node --check tests/ai/market-data.test.js` | 通过 |
| `vitest run` | 7 文件 124 测试全部通过 |

## 手动实测步骤

1. 后台策略提示词加入 `{{USE_CHAN}}`
2. 自动推理选择 H1 或 M5
3. 等待一轮自动推理
4. 查看 `[Chan]` 摘要，确认无异常
5. 查看 AI payload 中 `macd.line - macd.signal ≈ macd.histogram`
6. 如果 `divergence.type=top/bottom`，检查 `area_cur/area_prev/price_extreme_cur/price_extreme_prev`
7. 确认 `area_cur` 不为 0

## 剩余风险

1. `DIVERGENCE_MIN_AREA_RATIO = 0.85` 可能需要根据实盘调优
2. 线段算法仍为简化版
