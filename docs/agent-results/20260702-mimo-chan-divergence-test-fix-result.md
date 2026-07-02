# 缠论背驰方向判断与测试补齐结果

## 提交 ID

待提交

## 修改文件

1. `server/routes/ai/market-data.js` — detectDivergence 重写方向选择逻辑
2. `tests/ai/chan.test.js` — 新增 6 个背驰测试
3. `tests/ai/llm.test.js` — 新增 3 个 USE_CHAN 测试

## 问题 1：detectDivergence 按最新线段方向判断

修改位置：`server/routes/ai/market-data.js:238-290`

旧逻辑：先检查 sameDown，有 2 个下行段就直接返回，上行顶背驰永远不检查。
新逻辑：取最新有效线段 `current`，只按 `current.dir` 检查同方向背驰。

## 问题 2：背驰测试补齐

修改位置：`tests/ai/chan.test.js:181-250`

新增 6 个测试：
1. 无中枢 → `no_valid_center`
2. 上行无创新高 → `no_price_extreme_break`
3. 下行无创新低 → `no_price_extreme_break`
4. 不在中枢后 → `not_after_center`
5. 顶背驰成功 → `top` + `price_extreme_cur=130, prev=125`
6. 底背驰成功 → `bottom`

## 问题 3：LLM 测试覆盖 USE_CHAN

修改位置：`tests/ai/llm.test.js:202-248`

新增 3 个测试：
1. 有标签时 system prompt 不含 `{{USE_CHAN}}`
2. 有标签时 payload 保留 chan
3. 无标签时 payload 剥离 chan

## 验证命令和结果

| 命令 | 结果 |
|------|------|
| `node --check server/routes/ai/market-data.js` | 通过 |
| `node --check tests/ai/chan.test.js` | 通过 |
| `node --check tests/ai/llm.test.js` | 通过 |
| `vitest run` | 7 文件 103 测试全部通过 |

## 手动实测步骤

1. 后台策略提示词加入 `{{USE_CHAN}}`
2. 开启自动推理，等待一次运行
3. 日志只显示 `[Chan]` 摘要
4. 如果 `divergence.type=top/bottom`，检查包含 `area_cur/area_prev/price_extreme_cur/price_extreme_prev`
5. 用不含 `{{USE_CHAN}}` 的策略跑一次，payload 不含 chan
6. 用含 `{{USE_CHAN}}` 的策略跑一次，payload 含 chan，system prompt 不含标签

## 剩余风险

1. 真实行情中背驰判断可能因 MACD 面积计算精度有微小偏差
2. 中枢后的判断依赖 `end_bi_id`，极端边界可能误判
