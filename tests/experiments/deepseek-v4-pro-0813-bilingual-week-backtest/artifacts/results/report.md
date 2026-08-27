# DeepSeek v4 Pro 中英文策略/输出合同 2×2 历史模拟

> 这是使用冻结历史行情的模型行为对照，不是交易建议，也不是统计显著性结论。所有差异只能作为本样本描述。

## 结论摘要

- 方向/入场一致率：all-cell direction=1.0，entry=1.0；正式响应 signal 分布为 `{'hold': 32}`。
- 四组平均 confidence 为 `{'zh_zh': 0.92, 'zh_en': 0.895, 'en_zh': 0.92, 'en_en': 0.9225}`；逐点四组 confidence 平均跨度为 `0.0275`。只有少量决策点，不作显著性结论。
- JSON/结构合同为 32/32；严格语义合同为 4/32。差额来自 28/32 条“无记忆时 influence 应为空、模型却抄入说明句”的 instruction echo；各组率为 `{'zh_zh': 1.0, 'zh_en': 0.875, 'en_zh': 1.0, 'en_en': 0.625}`。
- 排除 experience_usage.influence 后，核心叙述保持简体中文的记录率为 `{'zh_zh': 1.0, 'zh_en': 1.0, 'en_zh': 1.0, 'en_en': 0.875}`；该指标只测输出语言，不测事实正确性。
- 自动跨字段/价格/RR 代理为 0/32。绑定当前响应哈希的逐条叙述审计覆盖 32/32 条，发现 14 条可直接证伪记录，组别分布为 `{'zh_zh': 3, 'zh_en': 4, 'en_zh': 3, 'en_en': 4}`。
- 可进入交易绩效分母的记录 0/32，实际成交 0；结构合同无效、未来 M1 不完整和不支持的 stop-limit 均被排除。
- 主批次用量：prompt tokens=2271092，completion tokens=33578；最大思考模式试验另行排除，不进入上述语言效应。

## 实验边界与基线证据

- 模型：`deepseek-v4-pro-0813`；API base URL：`https://ai-api.finpoints.tech/v1`。
- VM 权威运行时：`dev_codex` / `e311daa4d40895a3209cc1264745ba04d9ee7c04`；当前主工作树 HEAD：`f2394c0c563cc729d3a62e6464fcb263f4128635`；冻结快照运行时：`e311daa4d40895a3209cc1264745ba04d9ee7c04`；最终只读复核导出时间：`2026-08-27T09:55:14.357028+00:00`。若主工作树已前进，只允许复用 clean detached worktree 在 VM commit 上重建且文件哈希完全相同的快照，不能混入新本地 runtime。
- MT5 数据捕获时的代码 commit：`e31a91e3e85e9d34d66ec2da859c4c2f07bb2805`；其 data plan 已与本次 VM runtime plan 做逐字段等值校验。行情文件本身来自本机 MT5，不由该代码 commit 生成报价。
- 品种：`XAUUSD.s`；策略版本：`38`；决策点：`8`；正式调用目标：`32`。
- 计分窗口：`2026-08-20T08:00:45.345Z` 至 `2026-08-27T08:00:45.345Z`（最近 7 个日历日）；各周期 bars：`{'H1': 2115, 'M1': 7190, 'M5': 3617, 'M15': 2635, 'H4': 1175}`；未来回放最多 12 小时。
- 本机 MT5：`D:\Program Files\MetaTrader 5\terminal64.exe`；Python 包 `MetaTrader5 5.0.6147`，仓库 Worker 锁定 `5.0.5735`；broker offset：`10800` 秒。
- 动态输出合同版本 SHA-256：`c0e8f990788032c33a2839b5481d000fb9c375eeb4657dfbae62d3af5a802a69`；最近 inference snapshot 交叉验证：`{'strategy_version': 38, 'output_schema_version': 'c0e8f990788032c33a2839b5481d000fb9c375eeb4657dfbae62d3af5a802a69', 'prompt_hash': 'f029ca0ebc075c5665a673f3e421dd32c7dbd4feaf4b3ff4956db2be86abc835', 'created_at': '2026-08-27 17:52:16'}`。
- 策略正文 SHA-256：`04f30b707b59c35f570959e7597baffebf48afd2d9a8ac2a994ac0a067e87de3`；中文 schema：`640e8a3e26c09d135453ee10b4a2ef6f5ee1c68f074053c513e332fba422cbca`；英文正文：`3c2ad39014bc84bf495752336aa5330708cb435e4c89b7ef433fcb2a153dd95b`；英文 schema：`fca98f307955191a7cdc6cbe1189f57947f675f2495d2908b1bc8651c69015ba`。
- 语言文件大小：`{'strategy_zh_chars': 24805, 'strategy_zh_bytes': 53268, 'strategy_en_chars': 68355, 'strategy_en_bytes': 68446, 'schema_zh_bytes': 6691, 'schema_en_bytes': 9045}`；不同语言的 token/字节长度并不相同，因此报告同时列出 prompt tokens 与 request bytes。
- 市场数据 payload SHA-256：`192ac3705497b1c18405dd38dd3ae62a97a407ecaa0b0dbb3a33551f5e883f4f`；文件 SHA-256：`61b76dbb35ca27ed1596429dd7342e53ec29d34e4198884e916e80faebeae793`。
- 四个 cell：ZH-ZH（中文策略+中文输出合同）、ZH-EN、EN-ZH、EN-EN。策略因子切换正文及等义紧凑输入规则；输出合同因子只切换 system 中的合同块（标题、说明、固定响应语言规则），user task/market heading、keys、枚举、语义和简体中文响应要求均保持不变。
- 隔离校验：`{'formal_records': 32, 'formal_record_set_sha256': '86245ed857511bd64b0552358df3592f9d2af1eb971b541d369ff92e9061381f', 'call_order_balance': {'zh_zh': {0: 2, 1: 2, 2: 2, 3: 2}, 'zh_en': {1: 2, 0: 2, 3: 2, 2: 2}, 'en_zh': {2: 2, 3: 2, 0: 2, 1: 2}, 'en_en': {3: 2, 2: 2, 1: 2, 0: 2}}, 'each_group_occupied_each_order_twice': True, 'same_market_payload_within_each_pair': True}`。每组在调用顺序 0/1/2/3 各出现两次，同一决策点四组市场 payload hash 必须相同。
- 主批次参数：`{'temperature': 0.0, 'top_p': 1, 'max_tokens': 8192, 'translation_max_tokens': 8192, 'formal_timeout_seconds': 240, 'formal_retry_count': 1, 'formal_thinking': {'type': 'disabled'}, 'translation_thinking': {'type': 'disabled'}, 'stream': False, 'response_format': {'type': 'json_object'}}`。主效应只使用 thinking-disabled 正式记录。
- 正式记录之外的预检/中断尝试：`5` 组事件；这些请求无完整 usage，潜在计费未知，详见 experiment.json。
- 被排除的预实验：`[{'name': 'rejected-preexperiment-missing-compact-market-rule', 'records': 32}, {'name': 'rejected-preexperiment-schema-language-conflict', 'records': 9}]`，共 `41` 条；不进入任何分组统计。

## 翻译不变量

- 来源：`model_chunked_cached`；通过：`True`；与当前中文 source SHA 绑定：`True`。
- 错误：`[]`。JSON keys、枚举 token、周期、数字、占位符、字段路径必须保持不变。

## 分组指标

| cell | calls | HTTP 2xx | JSON | strict contract | structural contract | signals | entries | confidence | bull score | bear score | p50 ms | p95 ms | req B | resp B | prompt tok | completion tok | reason tok | all text Chinese | core narrative Chinese | no-memory instruction echo | contradiction proxy | performance eligible | performance excluded | fill | win/filled | MFE | MAE | 4h % | 12h % |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| zh_zh | 8 | 8 | 8 | 0 | 8 | {'hold': 8} | {'observe': 8} | 0.92 | 0.51 | 0.49 | 25431.2 | 32427.2 | 1566955 | 31904 | 559885 | 8322 |  | 1 | 1 | 1 | 0 | 0 | {'hold_has_no_trade_replay': 8} |  |  |  |  |  |  |
| zh_en | 8 | 8 | 8 | 1 | 8 | {'hold': 8} | {'observe': 8} | 0.895 | 0.5275 | 0.4725 | 27326.8 | 30682.6 | 1585907 | 32785 | 562165 | 8651 |  | 0.929341 | 1 | 0.875 | 0 | 0 | {'hold_has_no_trade_replay': 8} |  |  |  |  |  |  |
| en_zh | 8 | 8 | 8 | 0 | 8 | {'hold': 8} | {'observe': 8} | 0.92 | 0.51 | 0.49 | 27612 | 30480.1 | 1689571 | 32766 | 573381 | 8391 |  | 1 | 1 | 1 | 0 | 0 | {'hold_has_no_trade_replay': 8} |  |  |  |  |  |  |
| en_en | 8 | 8 | 8 | 3 | 8 | {'hold': 8} | {'observe': 8} | 0.9225 | 0.52 | 0.48 | 26894.8 | 29006.1 | 1708523 | 31948 | 575661 | 8214 |  | 0.942308 | 0.875 | 0.625 | 0 | 0 | {'hold_has_no_trade_replay': 8} |  |  |  |  |  |  |

### 合同错误与自动交叉字段矛盾代理

| cell | validation errors | automatic proxy rows | automatic proxy rate |
| --- | --- | --- | --- |
| zh_zh | {'experience_influence_nonempty_without_memory': 8} | 0 | 0 |
| zh_en | {'experience_influence_nonempty_without_memory': 7} | 0 | 0 |
| en_zh | {'experience_influence_nonempty_without_memory': 8} | 0 | 0 |
| en_en | {'experience_influence_nonempty_without_memory': 5} | 0 | 0 |

`strict contract` 包含所有结构、字段关系和“无记忆时必须为空”的语义要求；`structural contract` 只豁免无记忆说明句回声，其他错误仍失败。成交回放采用 structural contract 作为机械资格门槛：单纯的 experience_usage 说明句回声不改变 signal、entry、价格或保护字段，因此保留为严格语义失败指标，但不单独使一个本可执行的信号失去回放资格。contradiction proxy 只统计可由 JSON 内部关系或价格/RR 算术直接证伪的矛盾；无法从结构化行情自动核验的自然语言陈述不计入，因此它不是完整幻觉率。语言偏离单独作为 adherence 指标，也不自动算幻觉。`no-memory instruction echo` 指模型没有按要求返回空字符串，反而抄写 schema 说明句；它是语义合同失败，不是市场事实幻觉。

## 32/32 叙述事实审计

该层逐条核对 `analysis/reasoning/key_reasons/risk_factors` 与同一请求的冻结 market JSON；审计 JSON 的 formal_record_set_sha256 必须与当前正式 request/response 哈希集合一致，否则报告构建会失败。完整逐条结论与证据路径见 `narrative-fact-audit.md/json`。

| explicit contradictions | rate | by group | invented numbers | contains unverifiable path claim | fully supported whole narrative | gate sequence consistent | gate sequence inconsistent | H1 unclear but H4 disabled |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 14 | 0.4375 | {'zh_zh': 3, 'zh_en': 4, 'en_zh': 3, 'en_en': 4} | 0 | 32 | 0 | 5 | 27 | 15 |

| contradiction rate by group | strategy EN-ZH | output-contract EN-ZH | interaction |
| --- | --- | --- | --- |
| {'zh_zh': 0.375, 'zh_en': 0.5, 'en_zh': 0.375, 'en_en': 0.5} | 0 | 0.125 | 0 |

这里的直接矛盾率只统计能由同一冻结请求直接证伪的陈述；无法独立核验的形态/路径判断单列，不能被解释为已证实正确。样本规模有限，组间差异仅作描述。

## 主效应与交互（描述性）

策略语言、输出合同块语言的差值和交互项均来自四个 cell 的样本均值；不作显著性推断。

| metric | strategy EN-ZH | output-contract EN-ZH | interaction |
| --- | --- | --- | --- |
| transport_success_rate | 0 | 0 | 0 |
| json_parse_rate | 0 | 0 | 0 |
| contract_compliance_rate | 0.125 | 0.25 | 0.25 |
| structural_contract_compliance_rate | 0 | 0 | 0 |
| natural_language_adherence_rate | 0.0064831 | -0.0641754 | 0.0129662 |
| core_narrative_chinese_compliance_rate | -0.0625 | -0.0625 | -0.125 |
| deterministic_contradiction_rate | 0 | 0 | 0 |
| fill_rate |  |  |  |
| win_rate_among_filled |  |  |  |
| latency.p50_ms | 874.444 | 589.186 | -2612.84 |
| latency.p95_ms | -1811.82 | -1609.25 | 270.51 |
| request_bytes_total | 122616 | 18952 | 0 |
| response_bytes_total | 12.5 | 31.5 | -1699 |
| prompt_tokens_mean | 1687 | 285 | 0 |
| completion_tokens_mean | -23 | 9.5 | -63.25 |
| confidence_mean | 0.01375 | -0.01125 | 0.0275 |
| bullish_score_mean | -0.00375 | 0.01375 | -0.0075 |
| bearish_score_mean | 0.00375 | -0.01375 | 0.0075 |
| no_memory_instruction_echo_rate | -0.125 | -0.25 | -0.25 |

## 最大思考模式尾延迟试验（不纳入语言效应）

该试验使用同一模型与 `thinking.type=enabled / reasoning_effort=max`，只用于判断传输尾延迟是否足以淹没语言差异。

| persisted | success | failed | successful latency ms | network/timeout attempts | prompt tok | completion tok | reasoning tok | failure errors |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 2 | 1 | 1 | [83523.634] | 1 | 70139 | 3472 | 2522 | ['api_request_failed:524'] |

未取得 HTTP 响应的中断/超时请求是否计费无法从客户端判定，须以供应商账单为准。

## ZH-ZH 与 EN-EN 对照

| ZH-ZH vs EN-EN direction | ZH-ZH vs EN-EN entry | all-cell direction | all-cell entry | both contract pass | mean confidence span | mean bull-score span | mean bear-score span | absolute price diffs |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | 1 | 1 | 1 | 0 | 0.0275 | 0.04125 | 0.04125 | n/a (all hold) |

## 逐样本四格对照

| pair | decision UTC | signals ZH-ZH/ZH-EN/EN-ZH/EN-EN | entries | confidence | confidence span | bull-score span | bear-score span | all direction same | all entry same | backtest status | return % |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| h1-1787216400000 | 2026-08-20T09:00:00.000Z | hold/hold/hold/hold | observe/observe/observe/observe | 0.92/0.82/0.92/0.92 | 0.1 | 0.04 | 0.04 | True | True | not_applicable/not_applicable/not_applicable/not_applicable | -/-/-/- |
| h1-1787274000000 | 2026-08-21T01:00:00.000Z | hold/hold/hold/hold | observe/observe/observe/observe | 0.92/0.82/0.92/0.92 | 0.1 | 0.1 | 0.1 | True | True | not_applicable/not_applicable/not_applicable/not_applicable | -/-/-/- |
| h1-1787324400000 | 2026-08-21T15:00:00.000Z | hold/hold/hold/hold | observe/observe/observe/observe | 0.92/0.92/0.92/0.92 | 0 | 0.06 | 0.06 | True | True | not_applicable/not_applicable/not_applicable/not_applicable | -/-/-/- |
| h1-1787554800000 | 2026-08-24T07:00:00.000Z | hold/hold/hold/hold | observe/observe/observe/observe | 0.92/0.92/0.92/0.92 | 0 | 0.04 | 0.04 | True | True | not_applicable/not_applicable/not_applicable/not_applicable | -/-/-/- |
| h1-1787612400000 | 2026-08-24T23:00:00.000Z | hold/hold/hold/hold | observe/observe/observe/observe | 0.92/0.92/0.92/0.92 | 0 | 0.06 | 0.06 | True | True | not_applicable/not_applicable/not_applicable/not_applicable | -/-/-/- |
| h1-1787666400000 | 2026-08-25T14:00:00.000Z | hold/hold/hold/hold | observe/observe/observe/observe | 0.92/0.92/0.92/0.93 | 0.01 | 0 | 0 | True | True | not_applicable/not_applicable/not_applicable/not_applicable | -/-/-/- |
| h1-1787720400000 | 2026-08-26T05:00:00.000Z | hold/hold/hold/hold | observe/observe/observe/observe | 0.92/0.92/0.92/0.92 | 0 | 0.03 | 0.03 | True | True | not_applicable/not_applicable/not_applicable/not_applicable | -/-/-/- |
| h1-1787774400000 | 2026-08-26T20:00:00.000Z | hold/hold/hold/hold | observe/observe/observe/observe | 0.92/0.92/0.92/0.93 | 0.01 | 0 | 0 | True | True | not_applicable/not_applicable/not_applicable/not_applicable | -/-/-/- |

## 回测规则

- 只使用决策点之后的 M1；同一根 M1 同时触发止损和止盈时止损优先。市价单按首根未来 M1 开盘价，限价/止损按触发价；stop-limit 明确标记 unsupported，不猜测成交。
- 输出 `filled`、TP/SL/timeout/no_trigger、MFE、MAE、4h/12h 方向收益；hold 不进行成交回放，也不计算方向收益，只记录未来窗口覆盖状态。

## 局限性与风险

- 这是有限决策点的历史模拟，样本量小，不能代表未来效果，也不能据此声称统计显著。
- MT5 数据使用本机终端和 broker server epoch 校准；窗口、缺口、报价、点差、滑点、成交延迟、资金费和真实账户风控未完全模拟。
- 本实验固定空仓、无持仓管理 schema；模型输出自然语言可能存在不可验证陈述，JSON 合同合规不等于事实正确。
- 英文策略与 schema 由同一模型分块翻译；已验证 key/枚举/周期/数字/路径和残留中文，但没有独立人工逐句认证语义等价。翻译措辞或篇幅差异仍可能是观测差异的一部分。
- 幻觉代理只覆盖结构化交叉字段、价格方向和实际盈亏比等确定性矛盾；未做外部事实检索，也未把语言不遵从当作事实幻觉。
- Python MetaTrader5 包版本、VM 与本地代码版本及模型服务端行为均是环境依赖；结果必须结合 sidecar hashes、请求/响应哈希和原始 JSON 审核。
- 供应商响应中的 model 字段回显为 `deepseek-v4-pro-0813`，但第三方兼容 API 背后的实际权重、路由与服务端版本无法由客户端独立证明。
- API 429/5xx/网络错误按受限指数退避；成功请求按 decision_id+cell 单独落盘，默认重跑跳过成功记录。成本应以 usage、request/response bytes 为准。
