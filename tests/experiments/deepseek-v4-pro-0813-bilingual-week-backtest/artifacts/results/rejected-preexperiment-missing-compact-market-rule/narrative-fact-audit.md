# 32 条正式响应叙述事实审计

审计覆盖全部 32 条正式响应（8 个决策点 × 4 组），逐条把 `analysis`、`reasoning`、`key_reasons` 和 `risk_factors` 对照到同一请求中的冻结 market JSON。没有调用外部系统，也没有重算 Chan、谐波或主观 K 线形态。

## 结论

- 严格保守口径下，12/32（37.5%）存在可直接证伪的叙述矛盾：ZH-ZH 4、ZH-EN 3、EN-ZH 2、EN-EN 3。四组差异很小，不能据此断言某一种语言更容易产生事实矛盾。
- 20/32 没有发现可直接证伪的事实；这不等于完全正确。32/32 都包含至少一项无法从现有字段独立复核的 Path A 全称判断，因此完整叙述“完全受支持”为 0/32。
- 没有发现模型编造一个不在该冻结请求中的数值。问题集中在：把真实数值的逻辑方向判断反、把不存在的 recent event 描述为“已失效”、或违反策略的门槛降级顺序。
- 表层输出合同（`hold/observe`、`hard_gate_status=fail`、failures 非空）为 32/32 一致；但按“只列最早已检查阻断项、unchecked 不得列为 failure”的策略纪律，只有 6/32 的 failure 序列自洽，26/32 不自洽；另有 13/32 在 H1 不明确时没有启用 H4。
- 冻结布尔事实没有显示任何一条已经形成完整 Path B+M5+EMA34 或 Path C 链。因此 `hold` 总体保守且可理解；但 Path A 和主观价格行为没有独立裁判，不能证明 32 个 `hold` 都是最优决策。

## 代表性矛盾

1. `h1-1787324400000 / zh_zh`：叙述称 H1 非 Chan 四项全部同向、3 周期动量为正；冻结值 `momentum_3_pct=-0.119`，并非四项同向。
2. `h1-1787554800000 / en_en`：叙述称 M5 `recent_confirmed.up.reclaim.found=true` 且事件已失效；冻结值为 `found=false`、`reclaim.found=false`、`still_valid=null`，该事件不存在。同一时点 ZH-EN 和 ZH-ZH 也出现相近事件状态误述。
3. `h1-1787666400000` 与 `h1-1787720400000` 的四组：均准确引用 close<SMA20、3/10 周期动量为负、MACD bearish，却仍把确定性 H1 直映射判为“不完全同向/不明确”。

完整的逐记录列表、冻结字段路径和审计边界见同目录的 `narrative-fact-audit.json`。
