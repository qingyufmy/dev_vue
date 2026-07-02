# 缠论后续修复结果

## 提交 ID

待提交

## 修改文件

1. `server/routes/ai/market-data.js` — buildBis 价格校验 + detectDivergence 依赖中枢
2. `server/routes/ai/llm.js` — cleanPrompt 替代 fullPrompt
3. `tests/ai/chan.test.js` — 去掉随机数据 + 新增测试

## 问题 1：buildBis() 价格方向校验

修改位置：`server/routes/ai/market-data.js:87-120`

- 新增 `invalidCount` 计数器
- up 笔：`e.price <= s.price` 时跳过
- down 笔：`e.price >= s.price` 时跳过
- 返回格式改为 `{ bis, invalidCount }`
- `computeChan()` 读取 `invalidCount` 写入 warnings

## 问题 2：背驰依赖有效中枢和创新高/低

修改位置：`server/routes/ai/market-data.js:175-185, 235-275`

- `buildSegments()` 增加 `high/low` 字段
- `detectDivergence()` 增加 `centers` 参数
- 无有效中枢 → `reason: 'no_valid_center'`
- 无创新高/低 → `reason: 'no_price_extreme_break'`
- 不在中枢后 → `reason: 'not_after_center'`
- `computeChan()` 传入 `validCenters` 并处理 warnings

## 问题 3：{{USE_CHAN}} 不进入 system prompt

修改位置：`server/routes/ai/llm.js:88-90, 125`

- `cleanPrompt` 去掉 `{{USE_CHAN}}` 并清理多余空行
- system prompt 使用 `cleanPrompt` 而非 `fullPrompt`

## 问题 4：缠论测试去掉随机数据

修改位置：`tests/ai/chan.test.js:6-14, 180, 191`

- `makeRates()` 改用 `Math.sin + 取模` 确定性波形
- MACD 数组改用 `Math.sin(i * 0.3) * 5`
- 新增 2 个测试：非法价格方向不生成笔、合法笔正常生成

## 验证命令和结果

| 命令 | 结果 |
|------|------|
| `node --check server/routes/ai/market-data.js` | 通过 |
| `node --check server/routes/ai/llm.js` | 通过 |
| `node --check tests/ai/chan.test.js` | 通过 |
| `vitest run` | 7 文件 94 测试全部通过 |

## 手动实测步骤

1. 后台策略提示词加入 `{{USE_CHAN}}`
2. 开启自动推理，等待一次运行
3. 查看日志摘要：segment_count 不等于 bi_count
4. 含 `{{USE_CHAN}}` 的策略：payload 含 chan，system prompt 不含标签
5. 不含 `{{USE_CHAN}}` 的策略：payload 不含 chan

## 剩余风险

1. 真实行情的包含关系边界情况可能需要更多测试
2. 中枢后的判断依赖 `end_bi_id`，极端情况下可能误判
