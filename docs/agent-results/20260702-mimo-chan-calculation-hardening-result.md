# 缠论计算保守化修复结果

## 提交 ID

待提交

## 修改文件

1. `server/routes/ai/market-data.js` — 缠论核心算法全部重写
2. `server/routes/ai/llm.js` — 新增 DEBUG_LLM_PAYLOAD 开关
3. `tests/ai/chan.test.js` — 新增 17 个缠论单元测试

## 修改位置

- `server/routes/ai/market-data.js:9-15` — 常量与调试开关
- `server/routes/ai/market-data.js:17-55` — `normalizeBarsForChan()` K线包含处理
- `server/routes/ai/market-data.js:57-80` — `detectFractals()` 分型识别
- `server/routes/ai/market-data.js:82-110` — `buildBis()` 笔构造
- `server/routes/ai/market-data.js:112-170` — `buildSegments()` 线段构造
- `server/routes/ai/market-data.js:172-210` — `buildCenters()` 中枢计算
- `server/routes/ai/market-data.js:212-245` — `detectDivergence()` 背驰判断
- `server/routes/ai/market-data.js:247-310` — `computeChan()` 组装
- `server/routes/ai/llm.js:6` — `DEBUG_LLM_PAYLOAD` 开关

## 实现说明

本实现为**保守缠论计算**，不是完整严格缠论。已覆盖：

- K线包含关系处理（上升/下降方向合并）
- 分型基于处理后K线，顶底交替去重
- 笔构造最小间隔 5 根K线，最后一笔标记 `confirmed=false`
- 线段至少 3 笔才确认，不足 3 笔作为 `candidate_segment`
- 中枢使用交集（不扩大），延伸时取交集
- 背驰依赖有效线段，不足时返回 `none + reason`
- 输出包含 `status/reliability/warnings` 让模型知道结构可信度

仍未覆盖的缠论规则：

- 特征序列判线段破坏
- 缺口处理
- 多义性处理（笔的多解）
- 背驰的力度法（仅用面积法）
- 中枢的级别递归

## 修复前后日志对比

修复前：
```
[Chan] H1: ok (bis=23, segs=23, centers=2, price_vs=above, div=none)
Segments(23): #1(up) bis=1 weak=true | #2(down) bis=1 weak=true | ...
```

修复后（测试数据）：
```
[Chan] H1: status=ok reliability=high raw=80 processed=77 fractals=12 bis=11 confirmed=10 segs=2 centers=1 warnings=none
```

不再出现 `bis=seg` 异常。

## 手动实测步骤

1. 后台策略提示词中包含 `{{USE_CHAN}}`
2. 开启自动推理
3. 等待一次自动推理完成
4. 查看服务日志：
   - 默认只应看到每周期一行 `[Chan]` 摘要
   - 不应看到完整 `Bis(...)` 和 `Segments(...)` 明细
5. 查看摘要：
   - `segment_count` 不应等于 `bi_count`
   - 不应出现大量 `bis=1 weak=true` 的有效线段
6. 查看 AI payload：
   - 默认不打印完整 payload
   - 设置 `DEBUG_LLM_PAYLOAD=1` 才打印截断 payload
7. 如果结构不足：
   - `chan.status` 应显示 `partial` 或 `unreliable_segments`
   - `warnings` 应说明原因

## 验证命令和结果

| 命令 | 结果 |
|------|------|
| `node --check server/routes/ai/market-data.js` | 通过 |
| `node --check server/routes/ai/llm.js` | 通过 |
| `vitest run` | 7 文件 92 测试全部通过 |

## 剩余风险

1. 随机生成的测试数据可能偶尔触发边界情况
2. 真实市场数据的包含关系处理可能有极端情况未覆盖
3. 线段确认算法为简化版，复杂震荡行情可能仍生成较多弱段
