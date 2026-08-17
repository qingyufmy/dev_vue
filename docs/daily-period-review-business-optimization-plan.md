# AI 日复盘逐笔归因与策略经验优化方案

## 1. 方案状态

- 方案类型：规划与设计；本方案文档按仓库流程提交，除此之外不包含业务代码实现、数据修复、任务重跑或部署。
- 仓库基线：`main`，提交 `2ce36dc52156e512e7541ffd8fb2b186667eb64e`。
- 适用范围：AI 日复盘的来源筛选、冻结证据、模型输出、人工校对、经验沉淀、遗漏恢复和前端展示；月复盘仅处理兼容消费，不在本批次重做月复盘业务。
- 业务目标：逐笔回答“当时为什么下单、分析是否符合当时行情、为什么盈利或亏损、下次如何执行”，并把人工确认后的可靠结论转成明确、可执行、可追溯的策略经验。
- 数据边界：保留原始交易、信号、推理快照、成交、既有复盘版本和记忆版本；不得自动重写已经批准的历史复盘，不得自动修改策略。

## 2. 最终需求合同

### 2.1 复盘对象与完整性

每条同时满足以下条件的交易必须且只能进入一份日复盘：

1. `signal_outcomes.status = closed`，并且已经完全闭合；
2. 成交、信号、账户、策略归属准确，`attribution_status = attributed`；
3. `review_eligible_at` 已设置，冻结推理快照和成交证据可用；
4. 按 `terminal_instance_id + broker_server + login` 对应的终端服务器交易日归档；
5. 同一 `outcome_id` 只能归属一个有效日复盘来源；
6. 证据不足时必须显示具体缺失项，不得静默遗漏；
7. 服务停机、窗口错过或批量上限不得造成永久遗漏。

“生成窗口”只决定正常任务何时启动，不再决定一条符合条件的交易是否永远失去复盘资格。

### 2.2 事前判断与事后结果分离

逐笔复盘必须分成两个独立阶段：

- **事前判断质量**：只能使用信号生成时已经存在的策略版本、记忆版本、提示词、行情快照、已闭合 K 线、技术指标和结构证据；禁止使用开仓后的数据修正当时判断。
- **事后结果归因**：使用真实成交、持仓路径、止损止盈触达、最大有利/不利波动、退出原因及开仓后的行情解释盈利或亏损；事后结果不得反向改变事前判断事实。

盈利不自动代表决策正确，亏损不自动代表决策错误。正常策略亏损、行情随机性、分析错误和执行错误必须分别表达。

### 2.3 每笔交易的必填输出

新增日复盘输出合同 `daily-period-review-v3`。每个 `trade_assessment` 必须完整覆盖一个 `outcome_id`，至少包含：

```json
{
  "outcome_id": 123,
  "decision_quality": "good|mixed|poor|insufficient_evidence",
  "original_signal_logic": "当时信号的核心判断和交易假设",
  "technical_basis_assessment": "所用行情、指标或结构是否真实支持该判断",
  "market_alignment": "aligned|partly_aligned|conflict|insufficient_evidence",
  "strategy_alignment": "aligned|partly_aligned|conflict|insufficient_evidence",
  "risk_execution_assessment": "入场、仓位档位、止损、止盈和退出是否合理",
  "outcome_attribution": {
    "result": "profit|loss|breakeven",
    "primary_causes": ["明确原因"],
    "explanation": "为什么形成该结果",
    "avoidability": "avoidable|partly_avoidable|normal_strategy_loss|insufficient_evidence"
  },
  "next_time_rule": {
    "condition": "再次出现什么可观测条件",
    "action": "必须采取的明确行为",
    "risk_control": "仓位、止损、止盈或退出要求",
    "invalidation": "什么情况下该动作失效",
    "prohibited_action": "明确禁止的行为"
  },
  "issue_codes": ["稳定问题码"],
  "evidence_refs": ["服务器提供的证据引用"],
  "confidence": 0.8
}
```

规则：

- 所有枚举和来源引用由服务端校验；模型不得编造 `outcome_id` 或证据引用。
- `decision_quality` 评价当时判断，不评价最终盈亏。
- `normal_strategy_loss` 只能在当时判断与策略执行均合理、亏损属于已知策略分布时使用。
- `insufficient_evidence` 必须指出缺失证据，不得同时生成确定性技术结论。
- `next_time_rule` 必须形成“条件—动作—风控—失效—禁止行为”，不得只写“谨慎、耐心、控制风险”。

### 2.4 日级汇总

日级结论只能在逐笔覆盖率达到 100% 后生成：

- `period_summary`：总结决策质量，不用盈亏替代判断；
- `repeated_issues`：每项必须引用至少两笔支持交易，只有一笔时标为单次问题；
- `strengths`：保留可重复的正确行为并关联交易；
- `risk_observations`：明确风险暴露、执行偏差及影响；
- `next_day_actions`：列出下一交易日可执行动作；
- `confidence`：结合最弱来源证据降低，不得只取平均值掩盖单笔证据不足。

系统统计仍由后端计算并只读展示，模型不得重算或修改交易数、胜率、净利润等事实。

### 2.5 策略经验记忆

日复盘确认后写入统一策略记忆库的权威来源改为结构化 `experience_rules`，不再让 `daily_lessons` 与 `memory_updates` 分别承担正文和元数据而产生遗漏。

每条规则至少包含：

```json
{
  "category": "general|market_regime|entry_setup|chan_structure|risk_execution",
  "condition": "明确且可观察的触发条件",
  "action": "明确行为",
  "risk_control": "风险控制",
  "invalidation": "失效条件",
  "prohibited_action": "禁止行为",
  "source_refs": ["outcome:123"],
  "confidence": 0.8
}
```

服务端把结构化规则确定性渲染为自然语言 Markdown，再追加到该策略唯一的统一记忆库。结构化字段只保留在复盘内容和审计元数据，不新增第二套运行时记忆，也不把机器化 `applicability` JSON 写入记忆正文。

记忆边界：

- 只有人工批准的当前复盘版本可以沉淀；
- 经验不得覆盖当前策略、独立风控、权限和执行安全；
- 不自动修改策略；
- 近义重复应在写入前确定性识别，无法安全合并时保留并交给后续压缩；
- 与策略冲突的经验只累计证据，至少三个**不同日复盘 case** 经人工确认并命中同一稳定冲突后，才提醒人工检查策略；
- 同一 case 的编辑版本、重试或重新生成不得重复增加冲突次数。

### 2.6 人工确认

人工确认必须能看到并校对：

- 每笔交易身份与真实盈亏；
- 原始信号逻辑和当时证据；
- 事前判断、事后归因、可避免性和下次规则；
- 将要写入策略记忆库的每条结构化经验；
- 策略冲突和证据来源。

任何逐笔必填字段无效、交易未覆盖、经验来源无效或证据状态变化时，确认按钮必须失败关闭。

## 3. 保留的现有能力与禁止扩大范围

### 3.1 直接复用

- `signal_outcomes`、`signal_outcome_deals` 的成交和归属链路；
- `inference_snapshots` 的冻结提示词、行情、策略运行时和内容哈希；
- `trade_review_cases` 的逐笔不可变证据准备；
- `period_review_cases/sources/jobs/versions/user_states` 状态机；
- `ai_model_tasks` 的租约、预算、重试和供应商尝试记录；
- `strategy_memory_libraries/revisions/pending_updates` 统一记忆库版本链路；
- 现有完整周期行情、持仓路径、Chan 能力门禁和市场连续性检查。

### 3.2 明确禁止

- 不恢复旧单笔模型 worker；日复盘继续一次聚合同一交易日的多笔证据；
- 不新增短期、长期、候选或影子记忆库；
- 不按策略 ID、名称或当前策略内容在服务端增加专用交易规则；
- 不由服务端判断技术方向或编写固定指标权重；
- 不自动确认复盘、自动修改策略、自动下单或补发交易；
- 不修改已经执行的旧迁移正文；
- 本方案实施不包含历史数据删除、生产数据库修复或生产部署。

## 4. 目标全链路

```text
准确闭合 outcome
  -> 公平扫描未关联来源
  -> 按终端交易日建立/恢复日复盘 case
  -> 冻结每笔事前证据 + 事后路径证据
  -> 冻结当前策略/记忆作为优化参考
  -> daily-period-review-v3 模型调用
  -> 服务端逐笔覆盖、来源、枚举和经验规则校验
  -> 用户逐笔校对和编辑
  -> 人工确认当前版本
  -> 结构化 experience_rules 确定性渲染
  -> 统一策略记忆库新版本
  -> 冲突按不同 case 累计，达到三次后提示人工
```

历史事实和当前优化上下文必须分开命名：

- `historical_trade_context`：每笔交易当时冻结的策略、记忆、提示词和行情；
- `post_trade_context`：成交后路径和结果；
- `current_optimization_context`：复盘生成时冻结的当前策略和当前记忆，只用于判断现在是否仍需优化，不能改写历史评价。

## 5. 后端优化设计

### 5.1 公平扫描与遗漏恢复

修改 `eligibleOutcomeRows()`：

1. 新来源通道只查询尚未出现在有效 `period_review_sources` 中的 eligible outcome；
2. 使用 `review_eligible_at ASC, id ASC` 的稳定键集顺序，优先处理最早遗漏；
3. 已关联但证据不完整的来源继续进入维护通道；
4. 两个通道分别限流并按 `outcome_id` 去重，已完成来源不能反复占满批次；
5. 增加统计：未关联数量、最旧等待时间、按用户/策略分布和本轮推进游标。

把 00:30–02:00 保留为正常创建窗口，同时增加 `missed_window_recovery`：

- 仅处理已经结束且经过 grace period 的交易日；
- 每轮创建有限数量 case，复用现有唯一 scope 和 job 幂等键；
- 默认只排队证据准备，模型 worker 继续受现有全局容量和任务限流约束；
- 上线前只读统计历史积压量，根据数量设置恢复批次，禁止盲目一次性生成全部历史模型任务；
- 老于产品启用水位且从未具备完整证据的记录保留为可审计的 `ineligible/insufficient`，不得猜测补齐。

### 5.2 观摩源行情授权

替换 `loadPeriodMarketWindow()` 中 `users.role = admin` 的旧筛选：

- private 策略：冻结源必须属于被复盘用户和交易账户；
- platform 策略：冻结源必须与该平台策略绑定的 `ai_observer_sources.bridge_user_id/trading_account_id` 一致；
- 同时校验精确 `source_id/source_key/platform/broker_server/account_login`；
- 禁止只按经纪商或品种回退到其他账户；
- 精确授权的 MySQL 缓存优先，Bridge 仅在缓存覆盖不足时补取；休市或 Bridge 离线不能使已有完整缓存失效。

授权判断抽成通用纯函数和查询构造器，由日复盘行情与持仓路径读取共享，避免两套账户边界。

### 5.3 冻结证据合同

升级 `compactPeriodTradeEvidence()`，不再删除完成历史判断所需的全部事前证据。每笔保留：

- 原始信号、分析、reasoning、仓位档位、止损止盈；
- 快照 ID、内容哈希、策略 ID/版本/scope、模型和提示词哈希；
- 当时冻结的 `strategy_runtime`；
- 当时模型实际使用的行情摘要、指标、Chan 公共结构和必要已闭合 K 线；
- 原始系统/用户提示词可用性和引用；
- 风控决策、原始订单和批准订单；
- 真实成交、持仓路径、路径指标和退出原因。

为控制请求大小：

- 复用 `parseSnapshotJson()` 和现有压缩格式，不创建第二份快照；
- 每笔只携带策略声明周期和模型当时实际使用的 K 线；
- 同一日重复的完整策略正文和记忆正文只在顶层冻结一次，逐笔通过版本/hash 引用；
- 达到供应商输入上限时分批生成逐笔评估，再由服务端合并日级汇总；不得静默截断、删掉某笔交易或改用当前行情代替。

### 5.4 防止未来数据泄漏

模型输入明确分区：

- `pre_trade_frozen`：时间不得晚于信号生成时可见的最后闭合 K 线；
- `holding_path`：时间从入场延伸到退出，只用于路径和结果归因；
- `period_market`：完整交易日行情只用于日级环境和事后解释。

服务端记录每个分区的 `cutoff_utc_msc`、数据范围和 hash。校验器禁止模型在 `original_signal_logic`、`technical_basis_assessment` 和 `market_alignment` 中引用事后专属来源；无法机械证明时要求输出 `insufficient_evidence`。

### 5.5 v3 输出校验

在 `period-review.js` 中新增独立的 v3 规范化与校验函数：

- 交易 ID 集合必须精确覆盖所有来源；
- 每个对象只能引用对应 outcome 允许的事前/事后证据；
- 所有必填文本去控制字符并限制合理长度；
- `primary_causes`、`issue_codes` 去重并限制数量；
- `result` 必须与服务端净利润符号一致；
- `normal_strategy_loss` 必须同时满足非 `poor/conflict` 的判断组合，否则拒绝；
- 证据不足时禁止输出确定性 Chan 记忆和策略冲突；
- `experience_rules` 的来源必须来自当前日复盘 outcome；
- 服务端根据规则结构生成用户可见 Markdown，不接受模型直接提交任意记忆正文。

保留 v2 读取兼容；已有版本不回写。新建 case、未产生版本的安全重试以及人工明确要求重新生成的 case 使用 v3。

### 5.6 记忆沉淀与冲突计数

`derivationMemoryEntries()` 改为只消费 v3 `experience_rules`。对 v2 历史批准版本保留现有 `daily_lessons` 兼容路径，但不重新解释或改写。

冲突累计改为：

- 同一 `conflict_id + period_review_case_id` 只计一次；
- 持久 `evidence_count` 由 `COUNT(DISTINCT period_review_case_id)` 校准；
- 同一 case 新版本可更新证据内容，但不得增加次数；
- 达到阈值只设为 `attention_required`，不自动改策略或删除记忆；
- 历史计数修正必须先提供 dry-run 报告，生产执行另行授权。

### 5.7 状态、并发与恢复

- case、source、job、version、derivation 和 memory update 继续使用现有唯一键和事务锁；
- 证据升级生成新 `evidence_hash`，已有批准版本的证据不自动漂移；
- v3 模型任务冻结 contract version、source set hash、策略版本、记忆版本和三个时间分区 hash；
- worker 重启和租约恢复必须复用同一冻结输入；
- 供应商结果未知时不得创建第二个业务版本；
- 人工编辑与后台生成竞态时以 `current_version_id` CAS 拒绝旧结果；
- 模型结果成功但版本持久化失败时可以幂等恢复，不重复计费调用。

## 6. 前端优化设计

### 6.1 日复盘详情

逐笔判断从一行摘要改为可展开交易卡：

- 卡片头：品种、方向、开平仓时间、信号 ID、盈亏和决策质量；
- 事前区：原始逻辑、技术依据、行情匹配、策略符合度；
- 事后区：结果原因、可避免性、风控与执行；
- 行动区：条件、动作、风险控制、失效条件和禁止行为；
- 证据区：引用、证据状态和置信度。

逐笔字段允许人工修订；基础成交事实和证据引用只读。保存继续创建新版本，不覆盖模型版本。

### 6.2 经验规则编辑

在“确认并沉淀经验”前展示最终 `experience_rules`：

- 每条规则按条件、动作、风控、失效和禁止行为编辑；
- 明确显示来源交易；
- 允许删除错误经验，但不允许添加不存在的来源；
- 预览即将写入统一记忆库的自然语言文本；
- 存在策略冲突时单独提示，不把冲突文案混入普通经验。

### 6.3 状态与可访问性

- 展示逐笔覆盖率、证据完整率、等待确认、记忆写入和冲突状态；
- 内部错误码必须映射为中文；
- 桌面端和移动端都能返回列表并保留当前 case；
- 支持键盘展开、焦点状态和屏幕阅读器标签；
- 更新统一静态缓存键，避免新旧 HTML/JS 合同混用。

## 7. API 与兼容性

- 现有 `/api/ai/period-reviews` 路由和外层响应保持兼容；
- `period_review_versions.content_json.output_contract_version` 区分 v2/v3；
- v2 版本继续按旧字段只读显示，人工编辑仍走 v2 校验；
- v3 版本使用新的逐笔编辑器和经验规则编辑器；
- 不把 v2 内容静默转换为 v3；需要重新生成时由用户明确触发并创建新版本；
- `/api` 与 `/aurum-api` 兼容路径不变；
- 列表接口保持轻量，不返回完整 K 线或提示词；只有有权限的详情接口返回经过裁剪和脱敏的证据摘要。

## 8. 数据库与迁移策略

优先复用现有 JSON、hash、版本和来源表。本批次代码实现原则上不需要新增第二套复盘表。

实施阶段先验证是否需要一个追加迁移，可能范围仅限：

- 为公平扫描增加合适的 `signal_outcomes(status, review_eligible_at, id)` 或来源反查索引；
- 为 `period_review_sources(outcome_id, period_case_id)` 补充查询索引；
- 若真实 MySQL 证明有必要，再增加冲突 case 级唯一约束。

任何迁移必须：

- 使用新 ID 追加到 `server/migrations.js`，不得修改既有 192 条迁移；
- 幂等创建索引并评估在线锁表影响；
- 不批量生成复盘、不调用模型、不删除历史 occurrence；
- 生产迁移前先统计表规模和预计锁时间。

历史冲突计数、漏建 case 和旧复盘内容属于数据修复，使用 dry-run 默认的专用脚本，必须单独授权，不放进应用启动迁移。

## 9. 实施批次

### 批次 A：v3 合同与冻结证据

预计文件：

- `server/routes/ai/period-review.js`
- `server/routes/ai/review-workflow.js`
- `server/routes/ai/period-market-evidence.js`
- `server/routes/ai/inference-snapshots.js`（仅在现有快照缺少必需字段时补充）
- 对应后端测试

验收：模型输入能逐笔区分事前/事后/当前上下文，v3 校验完整覆盖交易和必填业务字段，未来数据不能进入事前判断。

### 批次 B：公平扫描、窗口恢复和行情授权

预计文件：

- `server/routes/ai/period-review.js`
- `server/routes/ai/period-market-evidence.js`
- 观摩源访问辅助模块
- 必要的新迁移和测试

验收：超过批量上限仍能持续推进最旧未关联交易；错过窗口可受控恢复；离线观摩源的完整缓存可以在精确授权后用于复盘。

### 批次 C：经验规则与冲突去重

预计文件：

- `server/routes/ai/period-review.js`
- `server/routes/ai/strategy-memory-library.js`
- `server/routes/ai/strategy-memory-semantics.js`
- 记忆库和冲突测试

验收：批准的 v3 经验无遗漏地进入唯一统一记忆库；模糊或无来源规则被拒绝；同一 case 的多个版本只累计一次冲突。

### 批次 D：前端逐笔校对

预计文件：

- `public/ai/app.js`
- `public/ai/styles.css`
- `public/ai/index.html` 或其他统一静态入口缓存键
- 前端静态和浏览器测试

验收：用户可以识别、查看、修订每笔结论和经验规则，确认前能预览实际写入文本，移动端可完整操作并返回列表。

### 批次 E：只读积压审计与端到端验收

- 提供日复盘积压只读检查脚本；
- 统计未关联 outcome、错过窗口日期、证据不完整原因、旧冲突重复 case；
- 在测试环境生成一份 v3 日复盘并人工确认；
- 核对 case/version/job/model task/derivation/pending update/revision 全链路；
- 数据回填、生产部署和历史修正继续等待单独授权。

## 10. 测试与验收矩阵

### 10.1 逐笔合同

- 盈利但事前判断错误；
- 亏损但属于正常策略亏损；
- 分析正确但执行/止损错误；
- 行情、策略或 Chan 证据不足；
- 多策略版本同日交易；
- 外部干预、部分成交、多次退出；
- 每笔 ID 缺失、重复、跨来源引用和伪造来源均失败。

### 10.2 扫描与恢复

- 501 条及更多 eligible outcome 分多轮全部推进；
- 已完成来源不再占用新来源批次；
- 多用户高频账户不能饿死低频账户；
- 错过创建窗口后只创建一个 case/job；
- 重启、并发 scheduler 和租约恢复不重复创建版本或调用模型；
- 大历史积压受限速和容量门禁控制。

### 10.3 行情与时间

- private 用户源、平台 observer source 和管理员兼容源分别授权；
- 相同 broker 的其他账户不能被读取；
- Bridge 离线但缓存完整时可生成；
- 缓存缺口、源身份变化、终端时钟未校准时失败关闭；
- 周末、休市、夏令时和跨终端日边界不误归档；
- 事前证据 cutoff 不包含未来 K 线。

### 10.4 记忆与冲突

- `experience_rules` 全量确定性渲染并写入；
- 条件、动作、风控或来源缺失时拒绝；
- 同一批准版本重试幂等；
- 同一 case 多版本只计一次冲突；
- 三个不同批准 case 才进入提醒；
- 与策略冲突只提醒，不修改策略；
- 容量不足和压缩失败时已批准经验不丢失。

### 10.5 前端与浏览器

- 逐笔展开、编辑、保存、版本冲突和重新加载；
- 经验预览与真实持久化文本一致；
- 已批准版本只读；
- v2/v3 混合历史可正常查看；
- 列表分页、长时间轮询、断网恢复、移动端返回和键盘操作；
- 用户可见文案不暴露内部错误码。

### 10.6 验证命令

实施后至少运行：

```powershell
node --check server/routes/ai/period-review.js
node --check server/routes/ai/review-workflow.js
node --check server/routes/ai/period-market-evidence.js
node --check server/routes/ai/strategy-memory-library.js
node --check public/ai/app.js

npx vitest run tests/ai/period-review.test.js `
  tests/ai/period-review-monthly-checkpoints.test.js `
  tests/ai/review-workflow.test.js `
  tests/ai/review-market-path.test.js `
  tests/ai/strategy-memory-library.test.js `
  tests/ai/strategy-memory-semantics.test.js `
  tests/ai/strategy-memory-consistency.test.js `
  tests/ai/frontend-governance.test.js `
  tests/ai/session-kline-review-frontend.test.js

npm test
```

真实 MySQL、Redis、Bridge、MT4/MT5、模型供应商和浏览器验收不能由 mocks 代替。基线全量测试为 3276/3278；两项既有失败来自嵌套 PowerShell 缺少 `Get-FileHash`，与日复盘无关，实施后不得增加新的失败。

## 11. 上线、观测与回滚

### 11.1 上线顺序

1. 部署兼容读取、v3 校验和新前端，但暂不启用 missed-window recovery；
2. 验证迁移、健康检查、v2 历史读取和新 v3 case；
3. 小批启用 v3 日复盘，观察模型输入大小、完成率、修复请求次数和平均成本；
4. 只读统计历史积压并设置恢复批次；
5. 最后启用 missed-window recovery；
6. 任何历史数据修正另行 dry-run 和授权。

### 11.2 观测指标

- eligible、unassociated、incomplete、queued、succeeded、failed 数量；
- 最旧未关联交易等待时间；
- 每份日复盘逐笔覆盖率和证据完整率；
- v3 校验失败码和模型修复次数；
- 模型请求字节、响应字节、耗时和成本；
- 记忆规则数量、写入成功率、压缩状态和冲突 distinct-case 数；
- observer source 缓存命中率和 Bridge 补取率。

### 11.3 回滚条件

出现以下任一情况，立即停止新 v3 任务领取和恢复通道：

- 事前证据包含开仓后数据；
- 交易遗漏、重复归档或跨账户/跨观摩源读取；
- 同一 case 生成多个有效业务版本；
- 批量恢复造成模型队列、费用或供应商限流失控；
- 批准经验未进入对应统一记忆库，或写入错误策略；
- 人工编辑被后台旧结果覆盖；
- v2 历史无法读取。

代码回滚不得删除已经生成的 v3 版本或记忆修订；只暂停 worker 和恢复通道，保留完整审计链路。

## 12. 第一轮复审：需求覆盖、最小改动与过度设计

### 12.1 复审发现

1. 仅扩写模型提示词不能保证逐笔归因和明确行为，必须升级服务端输出合同和校验。
2. 直接把完整日行情交给模型并要求其自行按时间截断，仍可能产生未来数据泄漏；必须由服务端显式分区。
3. 再建“经验候选库”会违反每个策略只有一个权威记忆库的既定要求。
4. 为每种策略在服务端定义技术正确性会破坏“策略唯一分析权威”边界。
5. 无限制回补所有历史会产生不可控费用和队列压力。

### 12.2 第一轮调整

- 把提示词优化降为合同的一部分，核心改为结构化 v3 输出与服务端验证。
- 增加 `pre_trade_frozen/holding_path/period_market` 三分区，防止模型自行猜测时间边界。
- `experience_rules` 只存在于复盘版本和来源元数据，最终确定性渲染到现有统一记忆库，不新增运行时层级。
- 技术评价继续由当前策略正文和冻结行情驱动，服务端只验证结构、来源、时间和权限，不改写交易结论。
- missed-window recovery 改为只读盘点后限速启用，模型 worker 继续受现有容量门禁控制。

### 12.3 第一轮剩余风险

- v3 输出比 v2 更长，模型请求大小、生成耗时和修复次数会上升。
- 结构化必填字段能减少空泛结论，但不能完全替代人工判断内容质量。
- 多笔交易日可能需要分块；分块必须保持同一冻结策略/记忆和来源集合，不能牺牲可复现性。

第一轮结论：需求覆盖完整，未引入第二套记忆或服务端专用交易方法，方案可进入兼容性复审。

## 13. 第二轮复审：兼容性、数据、并发、异常恢复与连带 Bug

### 13.1 复审发现

1. 如果原地把 v2 内容解释为 v3，旧批准复盘会被错误改写，前端也无法区分编辑合同。
2. 如果恢复通道与正常窗口同时运行，可能并发创建相同 case/job。
3. 只删除 `role=admin` 条件会扩大行情读取权限，必须同时验证冻结源与策略/账户绑定。
4. 冲突改按 case 计数后，既有 `evidence_count` 可能高于 distinct case，需要数据校准但不能在启动时猜测修复。
5. 逐笔证据增加后可能超过供应商输入上限，静默裁剪会重新造成交易遗漏。
6. 前端如果先上线 v3 编辑器而后端或静态缓存仍是 v2，会提交不兼容内容。

### 13.2 第二轮调整

- 明确 v2 只读/原合同编辑兼容，只有新生成版本使用 v3，不做静默转换。
- 恢复通道复用现有 case scope、source 唯一键、job slot 和事务锁，并新增并发测试。
- 行情授权改为 scope-aware 的精确源绑定，不采用简单放宽角色过滤。
- 历史冲突计数通过 dry-run 专用脚本报告，生产修正单独授权；新代码从此按 distinct case 计数。
- 超限时采用同一冻结上下文的逐笔分块和确定性日级合并，禁止截断或遗漏来源。
- 前后端兼容读取先部署，统一更新所有 AI 前端入口缓存键后才启用 v3 生成。

### 13.3 安全与时间检查

- API 继续校验用户、策略 scope、observer source 绑定和交易账户归属；详情响应不泄露完整秘密、凭据或其他账户数据。
- 所有跨系统排序和 cutoff 使用 UTC；日归档继续使用对应终端服务器时间和已验证时差，不回退北京时间或固定 UTC+3。
- 证据、任务、版本、记忆更新和冲突 occurrence 均保留幂等身份；租约失效结果不能晚到覆盖新版本。
- 任何生产数据库修正、任务重跑、部署或模型大规模回补均需要独立授权。

### 13.4 第二轮剩余风险与实施判定

- 历史快照如果本身缺少当时策略正文或行情，只能输出证据不足，不能通过当前策略补造。
- 大交易日的分块合并会增加模型调用次数；实施前需用真实请求字节和供应商上限确定分块阈值。
- 精确 observer source 绑定依赖现有绑定数据正确；上线前必须只读核对异常绑定和重复来源。
- 结构化经验的近义去重仍可能误合并；第一版只合并规范化后完全相同的规则，语义近似交给月度压缩和人工确认。

第二轮结论：已补齐旧版本兼容、权限、时间、并发、恢复、容量、测试和回滚边界。方案可实施，但实施授权不包含生产数据修正、历史批量回补或部署。
