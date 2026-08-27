# DeepSeek v4 Pro 中英文策略/schema 2×2 历史模拟

> 这是使用冻结历史行情的模型行为对照，不是交易建议，也不是统计显著性结论。所有差异只能作为本样本描述。

## 结论摘要

- 方向与入场方式：8 个决策点的四组均一致（all-cell direction=1.0，entry=1.0）；32 条正式响应全部为 `hold/observe`。本样本中语言没有改变最终交易动作。
- 分析强度发生漂移：四组平均 confidence 为 `{'zh_zh': 0.8975, 'zh_en': 0.745, 'en_zh': 0.9213, 'en_en': 0.9088}`；逐点四组 confidence 平均跨度为 `0.1925`。其中 ZH-EN 明显低于其余三组，但只有 8 个点，不能作显著性结论。
- JSON/结构合同为 32/32；严格语义合同为 7/32。差额来自 25/32 条“无记忆时 influence 应为空、模型却抄入说明句”的 instruction echo；各组率为 `{'zh_zh': 0.75, 'zh_en': 1.0, 'en_zh': 1.0, 'en_en': 0.375}`。
- 自动跨字段/价格/RR 代理为 0/32，但 32/32 逐条叙述事实审计发现 `12/32` 条可直接证伪的逻辑/事实矛盾，组别分布为 `{'zh_zh': 4, 'zh_en': 3, 'en_zh': 2, 'en_en': 3}`；另 20 条没有明确矛盾，但仍含无法独立复核的 Path A 全称判断。
- 因全部 `hold`，成交数为 0，无法比较收益率、胜率或不同语言的交易绩效；本轮回测只能评价决策稳定性、合同服从和延迟。
- 主批次用量：prompt tokens=2268068，completion tokens=34541；最大思考模式试验另行排除，不进入上述语言效应。

## 实验边界与基线证据

- 模型：`deepseek-v4-pro-0813`；API base URL：`https://ai-api.finpoints.tech/v1`。
- VM：`dev_codex` / `e311daa4d40895a3209cc1264745ba04d9ee7c04`；本地 commit：`e311daa4d40895a3209cc1264745ba04d9ee7c04`；最终只读复核导出时间：`2026-08-27T09:29:07.897009+00:00`。两者不一致时正式实验应停止。
- MT5 数据捕获时的代码 commit：`e31a91e3e85e9d34d66ec2da859c4c2f07bb2805`；其 data plan 已与本次 VM runtime plan 做逐字段等值校验。行情文件本身来自本机 MT5，不由该代码 commit 生成报价。
- 品种：`XAUUSD.s`；策略版本：`38`；决策点：`8`；正式调用目标：`32`。
- 计分窗口：`2026-08-20T08:00:45.345Z` 至 `2026-08-27T08:00:45.345Z`（最近 7 个日历日）；各周期 bars：`{'H1': 2115, 'M1': 7190, 'M5': 3617, 'M15': 2635, 'H4': 1175}`；未来回放最多 12 小时。
- 本机 MT5：`D:\Program Files\MetaTrader 5\terminal64.exe`；Python 包 `MetaTrader5 5.0.6147`，仓库 Worker 锁定 `5.0.5735`；broker offset：`10800` 秒。
- 动态输出合同版本 SHA-256：`c0e8f990788032c33a2839b5481d000fb9c375eeb4657dfbae62d3af5a802a69`；最近 inference snapshot 交叉验证：`{'strategy_version': 38, 'output_schema_version': 'c0e8f990788032c33a2839b5481d000fb9c375eeb4657dfbae62d3af5a802a69', 'prompt_hash': '2c493119ea42daeab9dcdf426125995a0a61d40c8b7552ea5787b48d14f073db', 'created_at': '2026-08-27 17:28:25'}`。
- 策略正文 SHA-256：`04f30b707b59c35f570959e7597baffebf48afd2d9a8ac2a994ac0a067e87de3`；中文 schema：`640e8a3e26c09d135453ee10b4a2ef6f5ee1c68f074053c513e332fba422cbca`；英文正文：`3c2ad39014bc84bf495752336aa5330708cb435e4c89b7ef433fcb2a153dd95b`；英文 schema：`fca98f307955191a7cdc6cbe1189f57947f675f2495d2908b1bc8651c69015ba`。
- 语言文件大小：`{'strategy_zh_chars': 24805, 'strategy_zh_bytes': 53268, 'strategy_en_chars': 68355, 'strategy_en_bytes': 68446, 'schema_zh_bytes': 6691, 'schema_en_bytes': 9045}`；不同语言的 token/字节长度并不相同，因此报告同时列出 prompt tokens 与 request bytes。
- 市场数据 payload SHA-256：`192ac3705497b1c18405dd38dd3ae62a97a407ecaa0b0dbb3a33551f5e883f4f`；文件 SHA-256：`61b76dbb35ca27ed1596429dd7342e53ec29d34e4198884e916e80faebeae793`。
- 四个 cell：ZH-ZH（中文策略+中文 schema）、ZH-EN、EN-ZH、EN-EN。策略语言决定正文版本，schema 语言只决定合同说明文字；四组都保持 VM 合同要求的简体中文回答语义。
- 隔离校验：`{'call_order_balance': {'zh_zh': {0: 2, 1: 2, 2: 2, 3: 2}, 'zh_en': {1: 2, 0: 2, 3: 2, 2: 2}, 'en_zh': {2: 2, 3: 2, 0: 2, 1: 2}, 'en_en': {3: 2, 2: 2, 1: 2, 0: 2}}, 'each_group_occupied_each_order_twice': True, 'same_market_payload_within_each_pair': True, 'pair_market_payload_hash_counts': {'h1-1787216400000': 1, 'h1-1787274000000': 1, 'h1-1787324400000': 1, 'h1-1787554800000': 1, 'h1-1787612400000': 1, 'h1-1787666400000': 1, 'h1-1787720400000': 1, 'h1-1787774400000': 1}}`。每组在调用顺序 0/1/2/3 各出现两次，同一决策点四组市场 payload hash 必须相同。
- 主批次参数：`{'temperature': 0.0, 'top_p': 1, 'max_tokens': 8192, 'translation_max_tokens': 8192, 'formal_timeout_seconds': 240, 'formal_retry_count': 1, 'formal_thinking': {'type': 'disabled'}, 'translation_thinking': {'type': 'disabled'}, 'stream': False, 'response_format': {'type': 'json_object'}}`。主效应只使用 thinking-disabled 正式记录。
- 正式记录之外的预检/中断尝试：`5` 组事件；这些请求无完整 usage，潜在计费未知，详见 experiment.json。
- 因语义冲突被排除的预实验记录：`9` 条；不进入任何分组统计。

## 翻译不变量

- 来源：`model_chunked_cached`；通过：`True`。
- 错误：`[]`。JSON keys、枚举 token、周期、数字、占位符、字段路径必须保持不变。

## 分组指标

| cell | calls | HTTP 2xx | JSON | strict contract | structural contract | signals | entries | confidence | bull score | bear score | p50 ms | p95 ms | req B | resp B | prompt tok | completion tok | reason tok | Chinese-output adherence | no-memory instruction echo | contradiction proxy | fill | win/filled | MFE | MAE | 4h % | 12h % |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| zh_zh | 8 | 8 | 8 | 2 | 8 | {'hold': 8} | {'observe': 8} | 0.8975 | 0.51 | 0.49 | 32205.5 | 47912.8 | 1563811 | 33912 | 559157 | 8952 |  | 1 | 0.75 | 0 | 0 |  |  |  |  |  |
| zh_en | 8 | 8 | 8 | 0 | 8 | {'hold': 8} | {'observe': 8} | 0.745 | 0.535 | 0.465 | 27413.3 | 31100 | 1582627 | 33529 | 561421 | 8837 |  | 0.923077 | 1 | 0 | 0 |  |  |  |  |  |
| en_zh | 8 | 8 | 8 | 0 | 8 | {'hold': 8} | {'observe': 8} | 0.92125 | 0.505 | 0.495 | 28466.4 | 37842.3 | 1685851 | 31893 | 572613 | 8159 |  | 1 | 1 | 0 | 0 |  |  |  |  |  |
| en_en | 8 | 8 | 8 | 5 | 8 | {'hold': 8} | {'observe': 8} | 0.90875 | 0.495 | 0.505 | 29421.4 | 45099.4 | 1704667 | 33036 | 574877 | 8593 |  | 0.961538 | 0.375 | 0 | 0 |  |  |  |  |  |

### 合同错误与确定性矛盾

| cell | validation errors | contradiction rows | contradiction rate |
| --- | --- | --- | --- |
| zh_zh | {'experience_influence_nonempty_without_memory': 6} | 0 | 0 |
| zh_en | {'experience_influence_nonempty_without_memory': 8} | 0 | 0 |
| en_zh | {'experience_influence_nonempty_without_memory': 8} | 0 | 0 |
| en_en | {'experience_influence_nonempty_without_memory': 3} | 0 | 0 |

`strict contract` 包含所有结构、字段关系和“无记忆时必须为空”的语义要求；`structural contract` 只豁免无记忆说明句回声，其他错误仍失败。contradiction proxy 只统计可由 JSON 内部关系或价格/RR 算术直接证伪的矛盾；无法从结构化行情自动核验的自然语言陈述不计入，因此它不是完整幻觉率。语言偏离单独作为 adherence 指标，也不自动算幻觉。`no-memory instruction echo` 指模型没有按要求返回空字符串，反而抄写 schema 说明句；它是语义合同失败，不是市场事实幻觉。

## 32/32 叙述事实审计

该层逐条核对 `analysis/reasoning/key_reasons/risk_factors` 与同一请求的冻结 market JSON；不调用外部系统，不重算 Chan、谐波或主观 K 线形态。完整矩阵与字段路径见 `narrative-fact-audit.md/json`。

| explicit contradictions | rate | by group | invented numbers | contains unverifiable path claim | fully supported whole narrative | gate sequence consistent | gate sequence inconsistent | H1 unclear but H4 disabled |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 12 | 0.375 | {'zh_zh': 4, 'zh_en': 3, 'en_zh': 2, 'en_en': 3} | 0 | 32 | 0 | 6 | 26 | 13 |

主要问题不是编造新数字，而是把真实字段解释反，或把不存在的 recent event 写成“已失效”。两个决策点四组都在 close<SMA20、3/10 动量为负、MACD bearish 时仍把确定性 H1 直映射判成“不明确”。

12/32 的组别率为 ZH-ZH 4/8、ZH-EN 3/8、EN-ZH 2/8、EN-EN 3/8；样本太小且差距有限，不能据此判定中文或英文天然更容易产生事实矛盾。

32/32 的 Path A 0/6 判断都缺少可独立复核的时间、价格或结构锚点，所以“无明确矛盾”不等于“完整正确”。虽然 failure 序列只有 6/32 符合最早阻断项纪律，但冻结布尔事实也没有展示完整可入场链，最终 hold 仍属保守且可理解。

## 主效应与交互（描述性）

策略语言、schema 语言的差值和交互项均来自四个 cell 的样本均值；不作显著性推断。

| metric | strategy EN-ZH | schema EN-ZH | interaction |
| --- | --- | --- | --- |
| transport_success_rate | 0 | 0 | 0 |
| json_parse_rate | 0 | 0 | 0 |
| contract_compliance_rate | 0.1875 | 0.1875 | 0.875 |
| structural_contract_compliance_rate | 0 | 0 | 0 |
| natural_language_adherence_rate | 0.0192308 | -0.0576923 | 0.0384615 |
| deterministic_contradiction_rate | 0 | 0 | 0 |
| fill_rate | 0 | 0 | 0 |
| win_rate_among_filled |  |  |  |
| latency.p50_ms | -865.503 | -1918.61 | 5747.29 |
| latency.p95_ms | 1964.44 | -4777.9 | 24069.9 |
| request_bytes_total | 122040 | 18816 | 0 |
| response_bytes_total | -1256 | 380 | 1526 |
| prompt_tokens_mean | 1682 | 283 | 0 |
| completion_tokens_mean | -64.8125 | 19.9375 | 68.625 |
| confidence_mean | 0.09375 | -0.0825 | 0.14 |
| bullish_score_mean | -0.0225 | 0.0075 | -0.035 |
| bearish_score_mean | 0.0225 | -0.0075 | 0.035 |
| no_memory_instruction_echo_rate | -0.1875 | -0.1875 | -0.875 |

## 最大思考模式尾延迟试验（不纳入语言效应）

该试验使用同一模型与 `thinking.type=enabled / reasoning_effort=max`，只用于判断传输尾延迟是否足以淹没语言差异。

| persisted | success | failed | successful latency ms | network/timeout attempts | prompt tok | completion tok | reasoning tok | failure errors |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 2 | 1 | 1 | [83523.634] | 1 | 70139 | 3472 | 2522 | ['api_request_failed:524'] |

未取得 HTTP 响应的中断/超时请求是否计费无法从客户端判定，须以供应商账单为准。

## ZH-ZH 与 EN-EN 对照

| ZH-ZH vs EN-EN direction | ZH-ZH vs EN-EN entry | all-cell direction | all-cell entry | both contract pass | mean confidence span | mean bull-score span | mean bear-score span | absolute price diffs |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | 1 | 1 | 1 | 0.125 | 0.1925 | 0.07375 | 0.07375 | n/a (all hold) |

## 逐样本四格对照

| pair | decision UTC | signals ZH-ZH/ZH-EN/EN-ZH/EN-EN | entries | confidence | confidence span | bull-score span | bear-score span | all direction same | all entry same | backtest status | return % |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| h1-1787216400000 | 2026-08-20T09:00:00.000Z | hold/hold/hold/hold | observe/observe/observe/observe | 0.92/0.72/0.92/0.82 | 0.2 | 0.1 | 0.1 | True | True | not_applicable/not_applicable/not_applicable/not_applicable | -/-/-/- |
| h1-1787274000000 | 2026-08-21T01:00:00.000Z | hold/hold/hold/hold | observe/observe/observe/observe | 0.82/0.92/0.93/0.92 | 0.11 | 0.13 | 0.13 | True | True | not_applicable/not_applicable/not_applicable/not_applicable | -/-/-/- |
| h1-1787324400000 | 2026-08-21T15:00:00.000Z | hold/hold/hold/hold | observe/observe/observe/observe | 0.82/0.72/0.92/0.92 | 0.2 | 0.06 | 0.06 | True | True | not_applicable/not_applicable/not_applicable/not_applicable | -/-/-/- |
| h1-1787554800000 | 2026-08-24T07:00:00.000Z | hold/hold/hold/hold | observe/observe/observe/observe | 0.93/0.72/0.92/0.92 | 0.21 | 0.07 | 0.07 | True | True | not_applicable/not_applicable/not_applicable/not_applicable | -/-/-/- |
| h1-1787612400000 | 2026-08-24T23:00:00.000Z | hold/hold/hold/hold | observe/observe/observe/observe | 0.92/0.72/0.92/0.92 | 0.2 | 0.06 | 0.06 | True | True | not_applicable/not_applicable/not_applicable/not_applicable | -/-/-/- |
| h1-1787666400000 | 2026-08-25T14:00:00.000Z | hold/hold/hold/hold | observe/observe/observe/observe | 0.92/0.72/0.92/0.92 | 0.2 | 0.07 | 0.07 | True | True | not_applicable/not_applicable/not_applicable/not_applicable | -/-/-/- |
| h1-1787720400000 | 2026-08-26T05:00:00.000Z | hold/hold/hold/hold | observe/observe/observe/observe | 0.92/0.72/0.92/0.93 | 0.21 | 0.03 | 0.03 | True | True | not_applicable/not_applicable/not_applicable/not_applicable | -/-/-/- |
| h1-1787774400000 | 2026-08-26T20:00:00.000Z | hold/hold/hold/hold | observe/observe/observe/observe | 0.93/0.72/0.92/0.92 | 0.21 | 0.07 | 0.07 | True | True | not_applicable/not_applicable/not_applicable/not_applicable | -/-/-/- |

## 回测规则

- 只使用决策点之后的 M1；同一根 M1 同时触发止损和止盈时止损优先。市价单按首根未来 M1 开盘价，限价/止损按触发价；stop-limit 明确标记 unsupported，不猜测成交。
- 输出 `filled`、TP/SL/timeout/no_trigger、MFE、MAE、4h/12h 方向收益；hold 不进行成交回放，未来方向收益仍只作方向参照。

## 局限性与风险

- 这是有限决策点的历史模拟，样本量小，不能代表未来效果，也不能据此声称统计显著。
- MT5 数据使用本机终端和 broker server epoch 校准；窗口、缺口、报价、点差、滑点、成交延迟、资金费和真实账户风控未完全模拟。
- 本实验固定空仓、无持仓管理 schema；模型输出自然语言可能存在不可验证陈述，JSON 合同合规不等于事实正确。
- 英文策略与 schema 由同一模型分块翻译；已验证 key/枚举/周期/数字/路径和残留中文，但没有独立人工逐句认证语义等价。翻译措辞或篇幅差异仍可能是观测差异的一部分。
- 幻觉代理只覆盖结构化交叉字段、价格方向和实际盈亏比等确定性矛盾；未做外部事实检索，也未把语言不遵从当作事实幻觉。
- Python MetaTrader5 包版本、VM 与本地代码版本及模型服务端行为均是环境依赖；结果必须结合 sidecar hashes、请求/响应哈希和原始 JSON 审核。
- API 429/5xx/网络错误按受限指数退避；成功请求按 decision_id+cell 单独落盘，默认重跑跳过成功记录。成本应以 usage、request/response bytes 为准。
