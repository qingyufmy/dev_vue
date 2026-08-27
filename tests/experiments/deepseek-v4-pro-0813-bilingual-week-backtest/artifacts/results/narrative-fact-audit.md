# 正式批次叙述事实审计

## 结论

本次对 `artifacts/results/calls` 当前 32 条正式成功响应进行了完整只读核查，覆盖 8 个决策点和 `zh_zh`、`zh_en`、`en_zh`、`en_en` 四组。每条响应只与自身 `record.request` 中的冻结行情 JSON 对照；未调用模型、虚拟机、MT5 或网络，也未用 `rejected-preexperiment-*` 作为结论来源。

正式记录集 SHA-256：`86245ed857511bd64b0552358df3592f9d2af1eb971b541d369ff92e9061381f`。

| 指标 | 结果 |
| --- | ---: |
| 正式记录 | 32 |
| 明确矛盾记录 | 14（43.75%） |
| 未发现可直接证伪事实的记录 | 18 |
| 叙述中出现但冻结请求中完全不存在的数字 | 0 |
| 整条叙述可判定为完全支持 | 0 |
| 至少含一个不可独立核验路径判断 | 32 |
| 表面 hold 合约一致 | 32 |
| 完整硬门槛顺序自洽 | 5 |
| 完整硬门槛顺序不自洽 | 27 |
| H1 不明确但实际未启用 H4 | 15 |

“明确矛盾”采用保守口径：只有直接冲突于冻结字段、把事件放错周期、把不存在的事件写成已失效事件，或违反 H1 非 Chan 四字段确定性直映射时才计入。需要重新识别 Chan、谐波、HH/HL、裸 K、假突破或关键位反应的结论不硬判为幻觉，而归入“不可独立核验”。

## 分组统计

| 组别 | 记录数 | 明确矛盾 | 未直接证伪 | 硬门槛顺序自洽 |
| --- | ---: | ---: | ---: | ---: |
| `zh_zh` | 8 | 3 | 5 | 2 |
| `zh_en` | 8 | 4 | 4 | 0 |
| `en_zh` | 8 | 3 | 5 | 2 |
| `en_en` | 8 | 4 | 4 | 1 |
| 合计 | 32 | 14 | 18 | 5 |

## 逐组、逐样本矩阵

标记说明：

- `C`：存在至少一项明确矛盾。
- `N`：未发现可直接证伪事实，但仍可能含不可独立核验判断。
- `G✓`：reasoning 状态和 `hard_gate_failures` 的完整先后顺序自洽。
- `G✗`：存在跳过 H4、写入未检查项、保留已被备选路径解决的失败项，或越过前序门槛检查下游等问题。

| 决策点 | `en_en` | `en_zh` | `zh_en` | `zh_zh` |
| --- | --- | --- | --- | --- |
| `h1-1787216400000` | N / G✗ | N / G✗ | N / G✗ | N / G✗ |
| `h1-1787274000000` | N / G✗ | N / G✗ | N / G✗ | N / G✗ |
| `h1-1787324400000` | N / G✗ | N / G✓ | C / G✗ | N / G✗ |
| `h1-1787554800000` | C / G✓ | C / G✗ | C / G✗ | C / G✓ |
| `h1-1787612400000` | N / G✗ | N / G✓ | N / G✗ | N / G✓ |
| `h1-1787666400000` | C / G✗ | C / G✗ | C / G✗ | C / G✗ |
| `h1-1787720400000` | C / G✗ | C / G✗ | C / G✗ | C / G✗ |
| `h1-1787774400000` | C / G✗ | N / G✗ | N / G✗ | N / G✗ |

## 明确矛盾证据

### 1. M15 事件跨周期误引

`h1-1787324400000 / zh_en` 称 M15 `recent_confirmed.up` 的年龄为 5 根 M15 已收盘 K 线。

冻结字段：

- `strategy_context.timeframes.M15.summary.support_resistance.two_closed_bar_breakout.recent_confirmed.up.found=false`
- 同路径 `age_closed_bars=null`

年龄为 5 的近期 up 事件存在于 H1，而不是 M15。该记录因此属于明确的周期归属错误。

### 2. 把不存在的 M15/M5 事件写成“已失效”

`h1-1787554800000` 四组均出现此类问题：

- `en_en` 明确写成 M15 `recent_confirmed.up found=true、still_valid=false`。
- `en_zh`、`zh_en` 把 M15 up 事件描述为“已失效”。
- `zh_zh` 还把 Path C 的反向突破回收事件描述为“已失效”。

冻结 M15 事实是：

- `recent_confirmed.up.found=false`
- `recent_confirmed.up.still_valid=null`

冻结 M5 反向 down 事实是：

- `recent_confirmed.down.found=false`
- `recent_confirmed.down.reclaim.found=false`

这里不是“存在但失效”，而是事件生命周期根本不存在。

### 3. H1 四字段全部空头，却判为“未全部同向”

`h1-1787666400000` 的四组都引用了下列冻结值：

- `last_closed_bar.close=4616.56 < sma_20=4643.6795`
- `momentum_3_pct=-0.49`
- `momentum_10_pct=-0.37`
- `macd.trend=bearish`

四字段全部满足确定性空头直映射，响应却以不可用的 Chan `trend_state=up` 为由写成“四项未全部同向”或“H1 不明确”。其中多组还忽略了 M15 已存在的有效近期 down 事件：`found=true`、`complete=true`、`age_closed_bars=1`、`still_valid=true`。

### 4. 第二个四字段全空决策点仍被判不明确

`h1-1787720400000` 四组同样存在确定性矛盾：

- `last_closed_bar.close=4640.63 < sma_20=4646.487`
- `momentum_3_pct=-0.352`
- `momentum_10_pct=-0.167`
- `macd.trend=bearish`

响应逐项列出这些值后，仍称“四项并非全部同向”。

### 5. 把 H1 down 事件误写成 M15 down 事件

`h1-1787774400000 / en_en` 称 M15 `recent_confirmed` “仅有 down 事件”。冻结 M15 实际为：

- `recent_confirmed.down.found=false`
- `recent_confirmed.down.complete=false`
- `recent_confirmed.down.age_closed_bars=null`

近期 down 事件存在于 H1，不在 M15。

每条明确矛盾记录的完整 `request_sha256`、`response_sha256`、字段路径、冻结证据和冲突陈述见 `narrative-fact-audit.json`。

## 数值审计

从 `analysis`、`reasoning`、`key_reasons`、`risk_factors` 和 `decision_summary` 抽取的叙述数字，除固定策略常量外，均可在同一请求的冻结 JSON 中找到；`invented_numeric_values_found=0`。

这不代表所有数值使用都正确。跨周期误引仍可使用一个真实存在的数字，例如把 H1 的事件年龄 5 写成 M15 年龄 5。因此数值集合匹配之后，仍对所有明确矛盾进行了人工周期和字段路径核查。

## 不可独立核验的路径判断

32 条记录都至少包含一个不能只靠冻结结构直接裁决的路径判断：

- 多数响应将 M15 Path A 写成 `0/6`，但对 PRZ、裸 K、假突破和关键位反应没有给出完整的已收盘时间、关键价格和结构锚点。
- `h1-1787612400000 / en_zh` 将 M15-5 假突破判为唯一通过票，但冻结输入没有独立的假突破裁判；响应也没有给出满足完整策略定义的系统关键位、突破、回收和确认链。因此该票只列为不可独立核验，不直接判为事实错误。
- 部分响应用未锚定的“近期形成 HH/HL”或普通价格结构覆盖混合直映射。这类趋势解释没有重算，不能作为完全支持证据。

因此，`fully_supported_entire_narratives=0` 不等于 32 条全是幻觉；它表示没有一条响应的全部叙述都能由冻结结构逐项直接裁决。

## Hold 与硬门槛顺序

表面合约上，32/32 均满足：

- `signal_type=hold`
- `entry_method=observe`
- `position_action=observe`
- `hard_gate_status=fail`
- `hard_gate_failures` 非空

完整顺序上仅 5/32 自洽。判定同时检查 reasoning 状态和 failure 列表，而不是只检查 `hold/fail` 外观。

代表性问题：

- `h1-1787216400000 / en_en`：H1 不明确且 H4 未启用，却继续列出 M15 阻断项，并把 `M5_trigger_unchecked`、`M1_ema34_unchecked` 写入 failures。
- `h1-1787274000000 / zh_en`：H4 已报通过，但仍把 `H1_trend_unclear` 保留为硬失败，没有让 H4 降级判断解决最终方向。
- `h1-1787554800000 / en_zh`：M15 Path A、B 均失败后，常规 M5 仍被标成 `Fail`，而不是 `Not Checked`。
- `h1-1787774400000 / en_en`：把 `M1_ema34_not_checked` 写入硬失败，并越过更早的趋势/M15 阻断项将常规 M5 标为失败。

按响应正文是否实际执行 H4 判断统计，15 条在 H1 不明确时未启用 H4：`en_en=5`、`en_zh=3`、`zh_en=4`、`zh_zh=3`。`h1-1787274000000 / zh_zh` 的 reasoning 写成 `H4=[未启用/降级后仍不明确]`，但 analysis 实际检查了 H4，因此未计入这 15 条；该混合状态本身属于措辞不一致。

## 边界与局限

- 本审计不能证明每个 `hold` 都是经济上的最优决策。
- 未重算主观 Chan、谐波、HH/HL、K 线形态或关键位反应。
- 未把“解释不同”自动升级为事实矛盾；只有冻结字段可以直接裁决时才计入 14 条明确矛盾。
- 未读取或使用预实验拒绝样本、最大思考试跑或外部运行态作为结论证据。
