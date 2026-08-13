# 复盘证据连续性、缠论一致性与统一策略记忆库最终实施方案

## 1. 方案状态

- 方案类型：最终合并实施方案；本地实现与综合回归已完成，生产部署前验收仍为 partial。
- 目标分支：`dev_codex`。
- 基线提交：`2fdc999e55c67db26c990d5bbfcf5179777089fc`。
- 当前工作树：Chan 冻结能力、统一记忆沉淀门禁、语义守恒压缩和前端实时状态已在共享脏工作树完成且未提交；不能把已完成修复回退为基线旧行为。
- 业务优先级：高；Chan 复盘证据修复和统一记忆库优化作为一个发布批次实施、验收和部署。
- 数据边界：本方案不直接修改数据库、不自动重跑历史复盘、不自动删除或改写既有记忆库内容。

## 2. 最终业务合同

复盘是否需要缠论，必须与被复盘信号产生时的策略配置完全一致：

1. 信号产生时策略启用了缠论：
   - 复盘才计算缠论；
   - 使用该策略当时配置的周期；
   - 每个受支持周期使用 Chan v6 正式目标窗口和验证窗口；
   - 把各周期原始 `chan` 结构、质量字段和能力字段直接交给复盘模型；
   - 不生成跨周期方向汇总，不由后端判断方向冲突。
2. 信号产生时策略未启用缠论：
   - 复盘不计算缠论；
   - 复盘证据不输出 `chan:null` 等占位结构；
   - 模型提示词、必填输出结构、诊断结论和记忆候选均不得要求或评价缠论。
3. 无法从冻结证据确认当时是否启用缠论：
   - 不使用当前可变的策略配置猜测历史状态；
   - 按 `unknown` 失败关闭，不计算、不生成缠论结论；
   - 复盘证据明确记录 `chan_requirement_unknown`，防止模型把“没有提供”解释成“策略未启用”或“结构异常”。

“与策略一致”指信号当时的冻结策略能力，不是复盘执行时 `auto_prompt_types` 中可能已经变化的最新开关。

### 2.1 统一策略记忆库合同

1. 每个策略只维护一个权威记忆库，不再按短期、长期或按需检索层级参与新的模型推理。
2. 所有与某一策略有关的模型请求都传入该策略当时冻结的完整记忆库：
   - 手动分析、自动分析、模型对比；
   - 单笔复盘、日复盘、月复盘及月复盘分块合并；
   - 记忆整理与压缩。
3. 模型连接测试、模型资料验证、无策略归属的平台管理任务等非策略业务请求不注入记忆库。
4. 记忆库只是经验参考，当前策略、独立风控、权限和实时行情始终优先；记忆不得覆盖策略或直接触发交易。
5. 人工编辑创建新版本，不覆盖旧版本；每次模型请求冻结版本号和内容哈希并记录注入日志，重试不得漂移到新版本。
6. 日/月复盘只有在人工确认后才能沉淀。复盘确认、记忆写入和可选压缩是三个可审计状态，不能把“已确认”误报为“已写入”。
7. 记忆与策略疑似冲突只累计证据；达到默认三次且来源互相独立后提示人工修改策略，系统不得自动改策略。
8. `applicable_when/avoid_when/适用条件` 不再进入统一记忆库正文或模型载荷。来源身份、证据范围和验证结果只作为服务端审计元数据保留，不作为模型的额外交易规则。

### 2.2 复盘到记忆的共同失败关闭原则

- 普通复盘证据不足：不生成可确认复盘，不写记忆。
- Chan 禁用：普通复盘可生成，但输出和记忆候选完全不包含 Chan 评价。
- Chan 未知或证据不足：普通复盘可生成，但不得形成确定性 Chan 结论、冲突证据或 Chan 记忆。
- 复盘已确认但压缩失败：已经确定性写入的记忆必须保留，只把整理任务标为失败。
- 任何来源、版本、内容哈希或策略归属校验失败：不应用候选结果，保留当前权威版本并给出可重试状态。

## 3. 已证实问题与修复映射

### 3.1 日/月复盘没有使用 v6 正式窗口

当前 `period-market-evidence.js` 固定使用 200 根前置 K 线，并把实际获取数量作为
`requestedChanHistoryCount`。这会让不足 800–1200 根的结果相对于错误请求数显示
`history_sufficient=true` 或 `data_complete=true`。

修复：

- 删除固定 `CHAN_LOOKBACK_BARS = 200` 作为缠论历史需求的做法。
- 对启用缠论的周期调用 `getChanWindowPolicy(timeframe)`：
  - M5：目标 800，验证 600/700/800；
  - M15：目标 1000，验证 800/900/1000；
  - H1：目标 1200，验证 1000/1100/1200；
  - H4：目标 800，验证 600/700/800。
- 行情读取范围取以下最大值：
  - 完整复盘期间所需 K 线；
  - 指标预热需求；
  - Chan v6 目标窗口。
- 传入计算器的 `requestedChanHistoryCount`、`chanMaximumHistoryCount`、
  `chanValidationWindowCounts` 和 `chanWindowPolicyVersion` 必须来自同一窗口政策，禁止使用
  `loaded.rates.length` 伪装目标窗口。
- 未启用缠论时不额外请求 800–1200 根历史，只保留普通指标和复盘期间行情所需数量。

### 3.2 单笔交易复盘无条件计算缠论

当前 `review-market-path.js` 不读取信号当时的策略开关，始终使用 `computeChan:true`，并通常只保留入场前约 80 根 K 线。

修复：

- `buildReviewMarketPath()` 增加显式、不可省略的 `chanRequirement` 参数。
- 只有 `chanRequirement.status === 'enabled'` 时才设置 `computeChan:true`。
- 已启用时，按每周期正式政策加载完整目标窗口；普通持仓路径展示仍可只保留原有小窗口，额外 Chan 历史不进入前端普通 K 线数组。
- 未启用或未知时，不执行 `calculateMarketData()` 的 Chan 分支，`post_trade_structure[tf]` 只保留普通指标。
- 复盘是只读计算：不得保存新的 `chan_structure_anchors`，不得污染实时行情锚点。

### 3.3 复盘证据删除了关键可靠性字段

当前两处 `slimChan()` 删除了窗口政策、历史完整性、结构拓扑、锚点和
`evidence_capabilities`，模型无法区分“没有结构”和“证据不可靠”。

修复：

- 不重新设计第二套缠论摘要；复用实时模型已经使用的原始 Chan v6 公共结构。
- 允许移除非枚举内部计算数组，但必须完整保留以下公共合同：
  - `algorithm_version`、`rule_profile`、`timeframe`；
  - `status`、`reliability`、`warnings`；
  - `requested_history_count`、`received_history_count`、`history_sufficient`；
  - `requested_closed_history_count`、`closed_history_sufficient`；
  - `maximum_history_count`、`validation_window_counts`、`window_policy_version`、`window_selection`；
  - `cache_internal_gap_unresolved`、连续性和时钟可靠性字段；
  - `window_stable`、`structure_topology_reliable`、`structure_anchor`；
  - `evidence_capabilities`；
  - 笔、线段、中枢、背驰、趋势和买卖点候选的公开结构。
- 推理快照中的“当时结构”和复盘重新计算的“事后结构”必须分区存放，不得互相覆盖。

### 3.4 复盘提示词错误宣称完整窗口

当前日复盘提示词无条件声明“缠论结构已基于完整窗口计算”，即使策略未启用或只拿到 200 根历史。

修复：

- 提示词根据证据动态生成：
  - 全部禁用：完全不加入缠论规则和缠论诊断字段；
  - 启用且数据完整：说明使用 v6 正式窗口，但仍要求按能力字段判断哪些结构可用；
  - 启用但数据不完整：明确只能报告证据不足，不得判定计算错误、确认背驰或策略方向错误；
  - 混合配置：明确列出只有哪些 `outcome_id` 适用缠论。
- 禁止用 `period_market.status=complete` 代替 Chan 数据完整性判断。
- “没有中枢”“固定窗口未收敛”“锚点待确认”“行情缺口”和“策略未启用缠论”必须是不同状态。

### 3.5 周末缺口判断过宽

当前只要缺口区间碰到星期六或星期日，就可能把包含周五、周一正常交易时段的大段缺失当作正常周末闭市。

修复：

- 用明确的市场休市区间覆盖检查代替“区间跨过周末即放行”。
- 一个缺口只有在缺失部分全部落入允许的周末闭市窗口时，才能标记为
  `weekend_closure`。
- 缺口若包含周五收市前或周一开市后的工作日区间，超出部分继续标记为
  `suspicious_gap`，并使 `cache_internal_gap_unresolved=true`。
- 日复盘的 `assessReviewCandleCoverage()` 与实时 `inspectRateContinuity()` 复用同一个闭市分类器，禁止保留两套不同的周末宽松规则。
- 圣诞节、元旦等固定休市仍使用现有保守白名单；未知工作日长缺口继续失败关闭。
- 在实现前冻结一份带版本号的 `market_session_policy`，明确支持品种、周五收市、周日/周一开市、
  时区和夏令时处理。判断单位是“理论上缺失的每根 K 线开盘时间”，只有全部落入已知休市窗口才放行；
  任一部分落在正常交易时段即为 suspicious。经纪商会话或时区无法确认时失败关闭，不以 UTC 星期几猜测。

### 3.6 启用缠论时仍允许配置不支持周期

策略允许 M1、M30、D1，但 Chan v6 当前只支持 M5、M15、H1、H4。

修复：

- 策略未启用缠论时，仍允许 M1/M30/D1 作为普通行情周期。
- 策略启用缠论时，所有要求计算缠论的周期必须位于 v6 支持集合。
- 用户端、管理端和后端保存接口使用同一验证结果：
  - 拒绝无效组合并返回稳定错误码 `chan_timeframe_unsupported`；
  - 错误信息列出不支持周期，不静默保存后等运行时才返回空结构。
- 历史已保存的无效组合在读取时不修改数据；运行时继续失败关闭，并在 UI 标明需要编辑策略。

## 4. 冻结策略能力解析

### 4.1 权威来源顺序

新增纯函数 `resolveFrozenChanRequirement()`，按以下顺序解析每个被复盘信号：

1. 冻结推理快照独立列 `strategy_runtime_json` 中显式的
   `use_chan_analysis=true|false`：这是新快照唯一可以同时证明 enabled 和 disabled 的权威来源；
2. 冻结推理快照 `market_snapshot.strategy_context.timeframes[*].summary.chan`：只用于旧快照兼容确认 enabled；
3. 旧快照兼容字段 `chan_timeframe_alignment` 或 `chan_structures`：只用于确认旧信号当时启用了缠论；
4. 冻结信号 `market_data_json` 中的相同原始结构证据：只用于确认 enabled；
5. 没有显式 `use_chan_analysis=false` 且不存在可证明 enabled 的旧证据时，一律返回 `unknown`。

禁止通过“快照完整但没有 Chan 键”“`strategy_context` 正文仍在”或
`evidence_status=complete` 推导 disabled。行情证据完整只证明当时保存的行情正文达到快照合同，
不证明某项策略能力明确关闭；旧链路漏写、旧 Schema 与容量裁剪都可能造成 Chan 字段缺失。

不得回退查询当前 `auto_prompt_types.use_chan_analysis` 来解释已经产生的旧信号。

返回结构：

```js
{
  status: 'enabled' | 'disabled' | 'unknown',
  source: 'inference_snapshot_strategy_runtime' | 'inference_snapshot_raw_chan' | 'legacy_snapshot_marker' |
    'signal_market_data' | 'explicit_frozen_disabled' | 'unresolved',
  timeframes: ['M5', 'M15', 'H1', 'H4'],
  strategy_version: 1,
}
```

新推理快照应补充显式的冻结能力字段，例如：

```js
strategy_runtime: {
  // 现有字段保持不变
  use_chan_analysis: true,
  chan_timeframes: ['M15', 'H1'],
  chan_window_policy_version: 'chan_window_v6'
}
```

显式字段用于未来复盘；原始 `summary.chan` 扫描继续作为旧快照兼容路径。

显式字段不能只在 `inference-snapshots.js` 序列化时临时推导。自动推理和手动推理必须在
`scheduler.js`、`strategy.js` 构造传给 `persistInferenceSnapshotTx()` 的运行时快照时就写入：

- `use_chan_analysis`；
- 策略当时配置且要求计算 Chan 的 `chan_timeframes`；
- `chan_window_policy_version`；
- 策略 ID、策略版本和能力合同版本。

该基础运行时快照必须始终存在，不能因为 EMA34/结构化策略编译器关闭而变成 `null`；
编译策略产生的 workflow、indicator 和 constraint 字段继续作为可选扩展合并进去。

### 4.2 多信号日复盘

日复盘可能包含同一策略 ID 的多个版本。证据中增加：

```js
chan_requirement: {
  status: 'enabled' | 'disabled' | 'mixed' | 'unknown',
  enabled_outcome_ids: [],
  disabled_outcome_ids: [],
  unknown_outcome_ids: [],
  timeframes_by_outcome: {},
  window_policy_version: 'chan_window_v6'
}
```

- 全部禁用：不计算 period-level Chan，输出合同不包含缠论诊断。
- 全部启用：按冻结周期并集计算 period-level Chan。
- 混合：只为 `enabled_outcome_ids` 计算和要求缠论诊断；模型不得把结果应用到禁用信号。
- 存在 unknown：unknown 信号不得生成缠论结论；是否影响整个复盘完整性由普通交易证据决定，但必须在证据元数据中可见。

### 4.3 复盘可生成性与 Chan 证据状态分离

当前实现把 `period_market.status` 合并进 `period_review_cases.evidence_status`，而 worker 只领取
`evidence_status=complete` 的任务。若直接把 Chan 缺历史标成 period market partial，会使模型完全不被调用，
与“生成普通复盘、Chan 仅返回证据不足”的目标冲突。

修复后必须拆成两个正交判断：

- `review_input_status`：成交归因、冻结信号、快照、历史提示词、持仓路径和普通复盘期间行情是否足以生成复盘；
- `chan_evidence_status`：`not_applicable|complete|partial|unsupported|unavailable|unknown`。

只有普通复盘核心证据缺失时才阻止日/月复盘任务领取。Chan 为
`partial/unsupported/unavailable/unknown` 时仍可生成普通交易复盘，但模型合同只允许输出证据不足，
并禁止形成确定性 Chan 诊断、策略冲突或 Chan 记忆。数据库现有 `evidence_json` 可以承载两类状态，
不要求新增列；`period_review_cases.evidence_status` 继续代表 `review_input_status`，不得再由 Chan partial 单独降级。

## 5. 日、月和单笔复盘输出合同

### 5.1 单笔交易证据

- `inference_time.snapshot.market_snapshot`：保留信号产生时模型实际看到的 Chan 结构。
- `post_trade.post_trade_structure`：只在当时策略启用时加入重新计算的 Chan 结构。
- `path_evidence` 增加 `chan_requirement_status`、`chan_evidence_status` 和原因。
- 禁用时不加入 `chan` 键，不使用 `null` 暗示计算失败。

### 5.2 日复盘

- `period_market.schema_version` 升级，建议由 2 升至 3。
- `period_market` 增加 `chan_requirement` 和每周期 `chan_evidence_status`。
- 只有适用缠论的 outcome 才出现在 `chan_diagnoses` 必填集合中。
- 全部禁用时，动态输出 Schema 不包含：
  - `chan_diagnoses`；
  - `period_chan_assessment`；
  - `chan_structure` 类记忆候选要求。
- 启用但证据不完整时，可以输出 `insufficient_evidence`，但不得生成确定性“计算错误”记忆。

### 5.3 月复盘

- 月复盘只汇总日复盘已经标记为 Chan 适用的观察。
- 当整月没有启用缠论的来源时，输出 Schema 不包含 `chan_issue_summary` 和
  `chan_observations`。
- 混合月份保留来源引用，任何 Chan 记忆候选必须引用至少一个启用缠论的日复盘/交易。

### 5.4 统一策略记忆库写入门槛

- `category='chan_structure'` 的记忆候选必须同时满足：
  - 来源信号 `chan_requirement=enabled`；
  - 引用真实存在且适用的 Chan 证据；
  - 未把 `unknown/disabled` 当作结构异常；
  - 数据不完整时不得形成确定性计算错误或策略规则结论。
- 该门槛在复盘内容验证和记忆库合并前各校验一次，防止模型输出越界。
- 两次校验之间禁止先把候选扁平化为纯 Markdown。复盘确认后的衍生任务必须把结构化
  `memory_updates`（至少包含 `text`、`category`、`source_refs`）及其来源 review/outcome 身份传入
  `enqueueApprovedStrategyMemoryUpdate()`；记忆服务重新加载已批准复盘和冻结
  `chan_requirement` 做第二次权威校验后，才由服务端确定性生成最终 Markdown。
- 第二次校验所需的候选类别、来源 case/version/outcome 和验证合同版本写入现有
  `source_refs_json`/修订 `source_metadata_json`，保证任务重试、压缩和审计时仍能证明来源；
  不把 `applicable_when/avoid_when` 等旧检索条件重新写进统一记忆库正文。
- `daily_lessons`、`recurring_patterns`、`next_month_actions` 等兼容字段若缺少结构化类别和来源，
  只能作为 `general` 候选；不得通过文本关键词猜测并升级成 `chan_structure`。

### 5.5 确认沉淀与状态合同

复盘确认后采用“先安全写入、后可选整理”的顺序：

1. 对已批准版本创建幂等的 `strategy_memory_pending_updates`，唯一键仍由策略、复盘版本和更新类型组成。
2. 若确定性追加后不超过容量，在同一事务内创建真实记忆修订并把 pending 标为 merged；不得只写
   `merged_revision_id` 或只修改派生任务状态。
3. 若追加会超过容量，pending 保持 pending，并冻结旧库版本、哈希、待合并更新 ID 和压缩目标后入队。
4. 月复盘即使需要整理，也必须先创建包含月复盘内容的权威修订；后续压缩失败不能造成“确认成功但记忆不存在”。
5. 页面和 API 统一使用以下 `memory_application_status`：
   - `queued`：确认完成，等待服务端写入；
   - `applying`：正在确定性创建记忆修订；
   - `applied`：内容已写入，当前不需要压缩；
   - `compression_queued`：内容已写入，等待整理；
   - `compression_running`：内容已写入，正在整理；
   - `compression_failed_memory_preserved`：内容已写入，仅整理失败；
   - `completed`：写入和所需整理均已完成；
   - `failed`：记忆正文未能持久化，必须显示可重试错误。
6. 状态判定必须同时验证来源复盘版本、pending ID、修订所属策略、版本号、父子哈希变化和压缩结果修订；
   不能仅凭某个 `merged_revision_id` 非空或策略最近一次全局压缩成功就报告完成。

### 5.6 记忆与策略冲突合同

- 模型只能提出结构化冲突候选：冲突类别、记忆原文、策略原文、差异摘要、建议人工检查项和来源引用。
- 服务端重新加载当前策略和来源记忆后生成稳定 `conflict_key`；相同冲突的重复观察累计到同一记录。
- `evidence_count` 以不同已批准复盘版本为单位去重；同一复盘重试或同一来源重复输出不得增加次数。
- 默认阈值为 3。阈值之前状态为 `observing`，达到阈值后为 `attention_required`，只提示人工打开策略编辑器。
- 人工可以解决、驳回或记录说明；任何状态都不自动修改策略，也不从记忆正文静默删除经验。
- Chan 类冲突还必须通过 5.4 的双重来源校验；partial、unknown、disabled 或 unsupported 证据不能累计冲突次数。

### 5.7 统一记忆库注入合同

- 运行时读取必须以策略 ID 为键并重新校验策略 scope、owner、可见性和启用状态，禁止从用户默认模型或其他策略回退记忆。
- 一次业务任务首次读取后冻结 `version_no`、`content_hash` 和完整 `content_text`；月复盘所有分块和最终合并复用同一快照。
- 模型输入中只出现一个 `<strategy_memory_library>`/`strategy_memory_library` 区块，不再同时拼接旧短期、长期、摘要或适用条件。
- 注入前验证正文哈希、字符数和版本修订一致；异常时该策略模型请求失败关闭为
  `strategy_memory_library_unavailable`，不得静默改用旧表。
- 记录 usage kind、策略、版本、哈希、模型任务和业务来源，用于证明手动分析、自动分析、复盘和对比实际使用了哪一版记忆。
- 压缩任务本身读取冻结策略与冻结记忆，但 pending 更新由服务端确定性追加，避免模型遗漏刚确认的经验。

### 5.8 整理与压缩语义合同

“整理并压缩”是有损风险受控的知识整合，不是普通摘要，也不是强制缩短：

1. 允许：统一标题和表达、删除重复措辞、把等价经验合并、提高信息密度、保留更清晰的核心逻辑。
2. 必须保留：原子交易规则、前置条件、例外与反例、所有数值和比较方向、品种、周期、方向、入场方式、
   风险边界、否定词、置信度、不确定性和未解决冲突。
3. 禁止：创造新规则、扩大适用范围、删除看似少见的反例、替策略裁决冲突、修改风险限制、把观察改写为确定结论。
4. 策略是最高权威。发现冲突时保留经验原意并形成冲突候选，压缩过程不得自动重写策略或删除证据。
5. `target_chars` 是结果上限而不是必须达到的压缩比例；已经精炼的内容允许
   `succeeded_noop`，不创建重复修订。
6. 自动容量压缩仅在追加将超过容量或当前内容达到容量阈值时触发；月复盘执行“检查并整理”，没有实质改善可 noop。
7. 人工入口文案改为“整理并压缩”，显示当前字符数、容量和目标上限，避免把 noop 误解为失败。

压缩输入在调用模型前生成不可变语义清单。至少包含：

- 每个 Markdown 逻辑块的稳定 `source_block_id` 和内容哈希；
- 抽取出的数字、百分比、价格、时间、周期、方向、品种和否定关系；
- 策略/风险引用、反例、不确定性和冲突标识；
- 来源版本和父内容哈希。

模型输出升级为：

```json
{
  "content_text": "整理后的完整 Markdown",
  "coverage_map": [
    { "source_block_id": "...", "result_section": "...", "disposition": "preserved|merged_duplicate" }
  ],
  "unresolved_conflicts": [],
  "removed_redundancies": []
}
```

服务端应用前必须执行：JSON Schema、字符上限、所有 source block 覆盖、数值/枚举/否定锚点保持、
冲突和反例保持、新事实与策略覆盖禁止、父版本/哈希 CAS。任一检查失败都将 job 标为失败或可重试，
记录 `result_validation_status/result_validation_json`，但不改变权威记忆正文。

首版可采用“确定性锚点校验 + 独立语义验证模型”的双层验证；语义验证无法证明双向一致时失败关闭。
后续若引入更强的原子块持久化，也必须保持人工可读 Markdown 是唯一注入正文，不能重新变回按需检索的多层记忆。

### 5.9 压缩任务、状态查询与前端动画

- `POST /api/ai/strategy-memories/:strategyId/compress` 返回 `202` 和 `job_id` 后，前端不得把“已排队”当成完成。
- 新增按策略和 job ID 授权的只读状态接口，或在详情接口返回
  `active_compression_job`、`latest_compression_result`；响应包含阶段、源/结果版本、前后字符数、错误码和完成时间。
- 状态机固定为 `queued -> leased/running -> validating -> applying -> succeeded|succeeded_noop|failed|stale|status_unknown`。
- 用户端和管理端在任务活跃时每 2 秒轮询；标签页隐藏时暂停，恢复时立即刷新，终态或超时后停止。WebSocket 可作为后续优化，但不能成为唯一状态来源。
- 手动排队成功后应唤醒同进程 worker，60 秒定时扫描继续作为恢复兜底，减少“按钮点击后长时间等待领取”。
- 动画使用不确定进度，不显示伪造百分比，并支持 `prefers-reduced-motion`：
  - queued：“等待整理”；
  - running：“正在整理记忆……”；
  - validating/applying：“正在校验并保存……”；
  - succeeded：“整理完成，X → Y 字”；
  - succeeded_noop：“整理完成，当前内容已足够精炼，无需修改”；
  - failed/stale：“原记忆已保留”，提供刷新或重试。
- 活跃任务期间禁止再次压缩和恢复版本。人工编辑区若已有未保存内容，不得被轮询结果覆盖；应锁定编辑或保留草稿并提示刷新冲突。

## 6. 证据完整性与状态定义

每个周期分别输出：

- `not_applicable`：策略未启用缠论，不计算；
- `complete`：达到正式目标窗口，已收盘历史完整，连续性和时间键满足数据能力要求；
- `partial`：策略启用，但目标窗口、连续性、时钟或固定窗口收敛存在不足；
- `unsupported`：策略启用但周期不受 v6 支持，历史配置兼容失败关闭；
- `unavailable`：行情源不可用或计算异常。

状态判断原则：

- 以 `evidence_capabilities.data_complete` 判断数据完整性；
- `segment_direction_usable=false` 不等于数据缺失，可能只是结构未形成或窗口未收敛；
- `center_structure_usable=false` 不得描述成行情缺失；
- `entry_structure_usable/divergence_usable=false` 时不得形成买卖点或背驰确定性结论；
- 复盘计算不得通过降低 `requestedChanHistoryCount` 把缺失历史包装成完整数据。

## 7. 文件级实施范围

### 7.1 后端

- `server/routes/ai/inference-snapshots.js`
  - 冻结显式 Chan 能力和周期政策；
  - 保持旧快照兼容。
- `server/routes/ai/strategy.js`、`server/routes/ai/scheduler.js`
  - 手动与自动推理都构造始终存在的基础 `strategy_runtime_json`；
  - 在持久化前冻结显式 Chan 开关、周期和窗口政策版本。
- `server/routes/ai/review-workflow.js`
  - 从冻结快照解析每笔信号的 Chan 需求；
  - 把需求传给 `buildReviewMarketPath()`；
  - 将逐笔需求保留到 `compactPeriodTradeEvidence()`，避免日复盘压缩证据后丢失开关；
  - 禁用时不生成 post-trade Chan。
- `server/routes/ai/review-market-path.js`
  - 条件计算；
  - v6 正式窗口；
  - 保留公共原始结构和能力字段；
  - 不持久化锚点。
- `server/routes/ai/period-market-evidence.js`
  - 删除固定 200 根 Chan 前置窗口；
  - 从 sources 的冻结能力构建周期计划；
  - 生成 `chan_requirement` 和逐周期证据状态；
  - 禁用时不计算。
- `server/routes/ai/period-review.js`
  - 动态日/月输出 Schema 与提示词；
  - 只校验适用 outcome 的 Chan 诊断；
  - 记忆候选适用性门槛；
  - period market schema 升级和刷新判定。
- `server/routes/ai/strategy-memory-library.js`
  - 接收并保留结构化记忆候选与来源身份；
  - 在确定性生成 Markdown、入队或直接合并前执行第二次 Chan 来源校验；
  - 保证确认沉淀、真实修订、pending 和压缩任务之间的事务完整性；
  - 实现压缩前不可变语义清单、压缩后确定性锚点校验和冲突证据去重。
- `server/routes/ai/strategy-memory-compression.js`
  - 输出结构升级为正文、覆盖映射、未解决冲突和去重说明；
  - 增加 validating 阶段、双层语义验证、失败保留、手动唤醒和恢复逻辑；
  - 继续使用模型物理输入/上下文/输出上限，不恢复任何任务级输出 token 硬上限。
- `server/routes/ai/index.js`
  - 增加授权压缩状态接口；
  - 统一返回当前任务和最近一次终态，保证用户端与管理端使用相同合同。
- `server/routes/ai/llm.js`、`server/routes/ai/manual-trade-review.js`
  - 保证所有策略相关调用仅注入一份完整、冻结的统一记忆库；
  - 记忆正文继续按不可信经验数据处理，不能成为系统指令。
- `server/migrations.js`
  - 保留已发布的 181/182 内容不变；若状态、语义清单或验证结果需要新字段，只追加新幂等迁移；
  - 不通过迁移重写现有记忆正文，不重新导入已退役短期/长期记忆。
- `server/routes/ai/market-session-calendar.js`
  - 收紧周末休市区间覆盖。
- `server/routes/ai/platform-market-data.js`
  - 实时连续性与复盘覆盖复用统一闭市分类。
- `server/routes/ai/strategy-ownership.js`、`server/routes/ai/strategy-policy.js`
  - 保存时验证启用 Chan 的周期集合。

### 7.2 前端

- `public/ai/app.js`、`public/admin/app.js`
  - 策略编辑时显示不支持周期；
  - 服务端仍为最终权威，前端校验不能替代后端校验；
  - “立即压缩”改为“整理并压缩”，显示容量、目标上限和真实终态；
  - 两端共享压缩轮询状态、动画、失败保留和 noop 文案，禁止用一次详情刷新假装实时完成。
- 复盘展示仅在证据标记 Chan 适用时显示缠论板块；禁用时不显示“无数据”或“计算失败”。
- 复盘确认后持续显示 `memory_application_status`，直到真实修订存在且可由当前记忆库版本证明已应用。

### 7.3 文档

- 更新 `docs/chan-theory-specification.md`：
  - 修正旧 `chan_structure_v4` 示例为 v6；
  - 增加复盘继承冻结策略能力合同；
  - 明确复盘不做跨周期后端仲裁。
- 本方案与 `docs/chan-raw-structure-direct-model-plan.md` 的原始结构直传合同保持一致。
- 更新统一策略记忆库说明：移除短期/长期/适用条件的用户文案，记录整理压缩、noop、失败保留和版本恢复合同。

## 8. 测试方案

### 8.1 策略开关矩阵

1. 策略启用 Chan：单笔、日、月复盘均计算，使用冻结周期。
2. 策略禁用 Chan：三条复盘链均不调用 Chan 计算器，模型输入无 Chan，输出 Schema 无 Chan 诊断。
3. 策略在交易后由关改开：旧交易复盘仍不计算。
4. 策略在交易后由开改关：旧交易复盘仍按冻结能力计算。
5. 旧快照只有 legacy 标记：识别为 enabled，但不重新引入方向汇总。
6. 快照无法解析：状态 unknown，不查询当前策略猜测。

### 8.2 窗口与能力矩阵

- M5/M15/H1/H4 分别断言请求 800/1000/1200/800。
- 少一根目标历史时，`data_complete=false` 或周期状态为 partial，不得伪装完整。
- 完整历史但没有中枢时，数据可以 complete，但中枢、进入段和背驰能力为 false。
- 禁用 Chan 时不得额外请求目标历史。
- 普通前端持仓路径 K 线数量不因 Chan 历史扩大。

### 8.3 多版本日/月复盘

- 全部 enabled、全部 disabled、enabled/disabled 混合、含 unknown 四种组合。
- `chan_diagnoses` 只覆盖 enabled outcome IDs。
- disabled/unknown 来源不能生成 `chan_structure` 记忆更新。
- 月复盘不能把无适用来源的普通交易问题汇总成 Chan 问题。

### 8.4 连续性

- 标准周末闭市缺口通过。
- 周五正常交易时段提前缺失失败。
- 周一开市后延迟数小时仍缺失失败。
- 同一缺口一部分为周末、一部分为工作日时失败。
- 圣诞/元旦白名单通过，未知节假日和普通工作日长缺口失败。
- 实时与复盘覆盖函数对同一组 K 线返回一致分类。
- 覆盖夏令时切换、经纪商时区未知和未支持品种，未知时必须失败关闭。

### 8.5 配置验证

- Chan 关闭 + M1/M30/D1：允许。
- Chan 开启 + M5/M15/H1/H4：允许。
- Chan 开启 + 任一 M1/M30/D1：用户端、管理端和后端均拒绝。
- 历史无效策略运行时失败关闭，不自动修改数据库。

### 8.6 回归命令

实施后至少运行：

```powershell
node --check server/routes/ai/inference-snapshots.js
node --check server/routes/ai/strategy.js
node --check server/routes/ai/scheduler.js
node --check server/routes/ai/review-workflow.js
node --check server/routes/ai/review-market-path.js
node --check server/routes/ai/period-market-evidence.js
node --check server/routes/ai/period-review.js
node --check server/routes/ai/market-session-calendar.js
node --check server/routes/ai/platform-market-data.js
node --check server/routes/ai/strategy-ownership.js
node --check server/routes/ai/strategy-memory-library.js
node --check server/routes/ai/strategy-memory-compression.js
node --check server/routes/ai/index.js
node --check public/ai/app.js
node --check public/admin/app.js
npx vitest run tests/ai/chan.test.js tests/ai/platform-market-data.test.js `
  tests/ai/inference-snapshots.test.js tests/ai/review-market-path.test.js `
  tests/ai/review-workflow.test.js tests/ai/period-review.test.js `
  tests/ai/strategy.test.js tests/ai/scheduler.test.js tests/ai/strategy-policy.test.js `
  tests/ai/strategy-ownership.test.js tests/ai/strategy-memory-library.test.js `
  tests/ai/strategy-memory-compression.test.js tests/ai/model-task-runtime.test.js `
  tests/ai/frontend-governance.test.js
npx vitest run
git diff --check
```

### 8.7 统一记忆库与注入矩阵

- 手动分析、自动分析、模型对比、单笔复盘、日复盘、月复盘分块与合并均断言同一策略记忆版本和哈希。
- 策略 A 不能读取策略 B；私有策略不能跨用户；平台策略按现有可见性和默认/显式绑定解析。
- 一次任务运行期间人工保存 vN+1，已开始任务仍完整使用 vN；新任务才读取 vN+1。
- 模型输入不存在旧短期、长期、summary、`applicable_when`、`avoid_when` 或“适用条件”区块。
- 空记忆库仍传入版本化空库合同，不回退旧表；哈希/修订损坏时稳定失败关闭。
- 每条成功请求都有注入日志；日志只保存版本、哈希和关联身份，不重复存储敏感提示词。

### 8.8 确认沉淀、冲突与并发矩阵

- 日/月复盘确认一次、重复确认、任务重试和服务重启均只产生一条逻辑更新和一个真实修订。
- 月复盘正文先写入，随后压缩失败，记忆库仍能看到该月复盘内容，状态为
  `compression_failed_memory_preserved`。
- 旧压缩运行期间确认新复盘：能直接追加则旧 job 因 CAS stale；不能追加则新 pending 被下一个冻结 job 完整处理，不能丢失。
- `merged_revision_id` 指向错误策略、错误来源或相同父哈希时不得报告 applied/completed。
- 相同冲突同一复盘重试不累加；三个独立批准版本达到阈值后才提示人工修改策略。
- Chan disabled/unknown/partial/unsupported 的候选不能写入 Chan 记忆或冲突次数。

### 8.9 压缩语义与任务矩阵

- 完全相同输出为 `succeeded_noop`，不创建版本，前端显示“无需修改”。
- 删除或改变数字、周期、方向、否定词、反例、风险边界、冲突任一项时验证失败，原版本不变。
- 新增来源不存在的规则或把观察改为确定规则时验证失败。
- 多个重复逻辑可合并，但 `coverage_map` 必须覆盖全部 source block，且正文双向语义一致。
- 输出超过目标、JSON 不完整、provider 超时、status unknown、worker 重启、租约丢失和版本 stale 均有稳定终态且不会重复调用未知 provider 结果。
- 人工排队后页面在 2 秒内进入活跃状态；完成后自动刷新版本和字符数；隐藏标签页不持续轮询。
- 活跃时重复点击、恢复版本和带未保存编辑草稿的刷新不会覆盖数据。

### 8.10 浏览器、数据库与真实模型验收

- 使用真实本地 MySQL 验证确认复盘到修订、pending、job、模型任务和注入日志的完整链路；mock 只能作为回归证据。
- 在用户端和管理端进行真实浏览器走查：加载、空库、人工保存、排队、运行、noop、成功、失败、stale、重试和减少动态效果。
- 用至少三类冻结样本做真实模型压缩回放：重复经验、小型已精炼记忆、含数值/反例/冲突的高风险记忆。
- 不触发真实订单；部署后只使用自然产生的复盘或明确授权的测试 case 验证。

## 9. 历史数据、迁移与刷新策略

- Chan 代码和 JSON 证据 Schema 可通过版本字段升级；统一记忆库新增的 durable 状态若现有 181/182 字段不足，必须追加新迁移，禁止修改已执行迁移正文。
- 181 负责统一库、修订、pending、冲突、压缩 job、注入日志及一次性旧数据导入；182 只补压缩结果哈希与校验字段。实施前要与目标数据库只读核对迁移记录和列集合。
- 旧短期、长期、摘要表继续只读保留用于审计和代码回滚，但新写入、新推理和新压缩不得再访问这些表。旧 API 保持明确 410，不恢复双写。
- 181 历史导入正文可能包含“适用条件”和迁移来源文字。不得直接用新迁移批量改写；先提供只读扫描和逐策略预览，只有用户明确确认后才通过正常“人工新版本”机制清理。
- `period_market.schema_version` 升级后，仅从未产生任何 `current_version_id` 的复盘可按现有机制自动重建。
- 已产生 AI 草稿、人工编辑版本或已批准版本的复盘不得后台静默重建；需要时只能由用户明确发起刷新，
  并保留旧版本、来源哈希和可回滚关系。
- 已批准复盘不得自动撤销、重跑或改写，避免在没有人工确认时改变记忆来源。
- 已合并到统一记忆库的历史 Chan 结论不得自动删除。部署后先只读统计：
  - 由禁用 Chan 的来源生成的 `chan_structure` 更新；
  - 由不足目标窗口的复盘生成的确定性 Chan 结论；
  - 受周末缺口误判影响的证据。
- 如需修复历史记忆，另做带精确影响数量、来源版本、回滚和人工确认的修复任务。
- 现有 case 1201 的纠正属于单独已授权的数据任务，不作为本方案部署时的通用迁移或自动 backfill 模板。

## 10. 分阶段实施顺序

### 阶段 A：冻结合同与现状保护

1. 冻结 `chan_requirement`、统一记忆注入、确认沉淀、压缩状态和语义校验合同。
2. 给当前未提交统一记忆实现补齐集成回归，先证明已修复的“月复盘先写入、失败保留、pending 不丢”行为。
3. 对 181/182 和旧记忆 API 做迁移/引用核查；任何新列只追加迁移。

验收门：现有统一库数据不被改写；旧短期/长期链没有运行时写入或注入调用；定向测试全绿。

### 阶段 B：冻结能力、条件计算与连续性

1. 手动/自动推理构造基础运行时快照，新快照冻结显式 Chan 能力和市场会话政策版本。
2. 旧快照兼容解析；单笔复盘按开关计算或完全跳过。
3. 日复盘和单笔复盘使用 v6 目标窗口，保留原始结构和能力字段。
4. 收紧周末缺口分类并统一实时/复盘实现；保存时拒绝启用 Chan 的不支持周期。

验收门：开/关切换、四周期窗口、会话连续性和配置矩阵全部通过；关闭时计算器调用次数为零。

### 阶段 C：动态复盘合同与安全沉淀

1. 日/月复盘提示词和输出 Schema 按适用性生成。
2. 只要求 enabled outcome 的 Chan 诊断。
3. 分离 `review_input_status` 和 `chan_evidence_status`。
4. 结构化候选贯穿确认、衍生任务和合并前复核，阻止 disabled/unknown/partial/unsupported 来源写入 Chan 记忆。
5. 确认后先创建真实修订，再决定是否压缩；补齐严格 `memory_application_status` 和冲突计数去重。

验收门：禁用策略载荷没有 Chan；批准版本可从 pending、修订和当前库证明已经写入；压缩失败不丢经验。

### 阶段 D：完整记忆注入与语义安全压缩

1. 覆盖全部策略相关模型入口，统一冻结一份记忆版本，删除旧层级和适用条件载荷残留。
2. 压缩输出升级为覆盖映射，增加确定性锚点和独立语义验证。
3. 完善租约、重试、status unknown、stale 和 noop 终态；手动排队唤醒 worker。

验收门：注入矩阵全部通过；压缩不能改变数字、方向、否定、风险边界、反例或冲突；失败时原版本不变。

### 阶段 E：前端可观测性与人工操作保护

1. 新增 job 状态查询并让用户端、管理端轮询真实状态。
2. 加入排队、整理、校验、保存动画和 succeeded/noop/failed/stale 结果摘要。
3. 防止轮询覆盖人工草稿，活跃任务禁止冲突操作；补齐无障碍与减少动态效果。

验收门：真实浏览器从点击到终态自动更新，无假进度、无重复排队、无人工草稿丢失。

### 阶段 F：部署前复核

1. 全量测试和语法检查。
2. 在 LF 干净验证工作树确认迁移历史、静态资源 cache key 和最终 diff 范围。
3. 本地真实 MySQL、真实浏览器、冻结样本真实模型回放通过。
4. 只读检查待部署服务器基线、当前提交、迁移记录和自然信号证据，不人为触发交易或复盘。
5. 同一个发布批次部署 Chan 复盘与统一记忆优化，并确认两边使用同一 `chan_requirement` 合同。

## 11. 回滚与部署边界

- 无数据库迁移时可通过代码回滚恢复旧逻辑，但不得回滚已写入的新版本证据为旧 Schema 后继续混用。
- 若新增记忆状态迁移，代码回滚不得删除表或列；旧代码必须能够忽略新增字段。统一记忆库一旦成为权威，不回退旧短期/长期双写。
- 若动态输出 Schema 导致模型响应校验异常，回滚标准是：暂停新复盘生成，不回退实时交易链路，不自动重试已批准复盘。
- 若压缩语义验证误拒绝，暂停新压缩 worker，保留人工编辑和已确认记忆写入；不得放宽为“只校验字符数”。
- 若状态查询或动画异常，可以仅回滚前端轮询；后台任务和权威记忆版本继续按 durable 状态运行。
- 连续性规则收紧后可能使部分信号或复盘从 complete 变为 partial，这是预期的失败关闭，不应为了恢复数量放宽规则。
- 本方案不授权服务器拉取、重启、数据库查询/修复、历史复盘重跑、记忆库清理或真实订单操作。

## 12. 第一轮复审：需求一致性与最小正确边界

### 复审结论

- 用户要求的核心不是“所有复盘都增加 Chan”，而是严格继承策略当时的开关。
- 当前策略表是可变状态，不能作为历史信号复盘的唯一来源；冻结推理快照才是权威证据。
- 原始结构直传模型合同同样适用于复盘，后端不应重新增加跨周期方向仲裁。
- 复盘的额外历史只服务 Chan 计算，不应扩大普通图表和模型可见 K 线窗口。

### 第一轮调整

- 将最初设想的“读取当前策略开关”改为“解析冻结信号能力”，避免策略修改后污染历史复盘。
- 将“禁用时输出 `chan:null`”改为完全不输出 Chan 键，避免模型误判为计算失败。
- 增加混合策略版本的逐 outcome 适用性，而不是用一个日级布尔值覆盖所有交易。
- 明确复盘计算不得持久化实时 Chan 锚点。

### 第一轮剩余风险

- 很旧的快照可能既没有显式能力字段，也没有可识别的原始结构，只能标为 unknown。
- 混合版本日复盘的模型合同会比当前固定结构复杂，需要严格的动态 Schema 测试。

## 13. 第二轮复审：数据完整性、记忆库与部署风险

### 复审结论

- 仅扩大到 800–1200 根还不够；必须把政策目标原样传入计算器，否则仍可能把短历史标为完整。
- `evidence_capabilities` 不能在复盘瘦身时删除，否则模型无法区分数据缺失、结构未形成和锚点待确认。
- 复盘结论会进入统一策略记忆库，因此禁用/未知/不完整证据必须在内容验证和记忆合并两处失败关闭。
- 周末缺口误判会同时污染实时和复盘 Chan，必须与复盘修复一并解决。
- 已批准复盘和既有记忆属于历史数据，不应随代码部署自动改写。

### 第二轮调整

- 增加 `period_market.schema_version` 升级和未批准证据刷新门槛。
- 增加动态月复盘合同，避免日复盘修正后月汇总仍无条件要求 Chan。
- 增加策略保存时不支持周期校验，防止继续制造 `unsupported_policy` 快照。
- 将历史记忆修复明确拆成另一个需授权任务，不夹带进本次代码发布。

### 第二轮剩余风险与实施判定

- 收紧完整性后，短期内部分复盘会显示 partial 或 insufficient evidence；这是纠正错误置信度后的预期结果。
- 真实模型能否稳定遵守混合 outcome 的动态合同，需要用冻结快照回放和上线后自然复盘抽检验证，单元测试不能替代生产模型验证。
- 服务器当前运行提交和真实策略配置尚未在本方案阶段重新验证；部署前必须补做只读核对。

方案已覆盖用户确认的开关合同、审查中发现的两个高风险数据边界和相关兼容问题，并通过两轮复审。完成实施与验证前，不应将复盘生成的 Chan 结论视为已达到与实时策略相同的证据标准。

## 14. 第三轮复审：当前代码落点与可实施性

### 复审结论

- `strategy_runtime_json` 已是独立持久化列，但当前手动/自动链路传入的是可选策略编译运行时；
  显式 Chan 能力必须由两条推理入口构造，不能只靠快照序列化器扫描行情正文。
- 旧快照中“没有 Chan”不能证明策略关闭；只有显式冻结 `false` 可以判定 disabled。
- Chan partial 与普通复盘是否可生成必须分离，否则现有 worker 的 `evidence_status=complete`
  领取条件会让证据不足场景根本不进入动态模型合同。
- 当前记忆衍生链会把结构化 `memory_updates` 提前压成纯文本，导致合并前无法执行第二道
  `chan_structure` 来源校验；必须先调整服务接口和持久化元数据。
- 周末闭市不能只从 UTC 星期几判断；统一分类器必须基于带版本、品种和会话时间的覆盖政策。

### 第三轮调整

- 将显式 `strategy_runtime_json` 提升为第一权威来源，删除“缺少 Chan 即兼容 disabled”的推断。
- 补入 `strategy.js`、`scheduler.js` 和 `strategy-memory-library.js` 的实施范围与回归测试。
- 新增 `review_input_status` 与 `chan_evidence_status` 分离合同。
- 新增结构化记忆候选贯穿、双重来源校验和旧兼容字段降级规则。
- 明确已有草稿也不得后台静默刷新，并补充市场会话政策的可执行边界。

### 第三轮验证基线与剩余风险

- 基于本地 `dev_codex` 提交 `2fdc999e55c67db26c990d5bbfcf5179777089fc` 加当前未提交工作树静态核对；
  定向 8 个测试文件 428 项通过，全量 188 个测试文件 2817 项通过。
- 通过测试只证明当前旧行为稳定，不代表本方案已经实施；当前测试仍要求所有 outcome 固定返回
  `chan_diagnoses`，实施时必须用动态合同测试替换该旧断言。
- 真实经纪商的周末/夏令时会话窗口仍需部署前用自然行情只读抽样验证；不能仅靠 mocked K 线证明。

## 15. 统一记忆库专项复审：压缩语义、可观测性与当前代码差距

### 专项复审结论

- 当前统一记忆库已经具备单策略权威正文、版本修订、pending、冲突、压缩 job、注入日志和旧 API 410 的主体结构；
  手动/自动分析、模型对比、单笔复盘、日/月复盘主要链路也已开始注入完整库。
- 当前压缩提示词明确要求只整理已有内容、保留反例/冲突/不确定性并服从当前策略，这是正确方向；
  但服务端实际只强校验输出类型和字符数，尚不能证明数值、否定、风险边界、周期和反例没有丢失。
- 当前人工压缩接口只返回排队 job；用户端和管理端随后只刷新一次详情，没有按 job 查询终态。
  worker 默认 60 秒扫描，因此任务即使最终 `succeeded_noop`，页面也可能长期只显示排队或重新回到 idle。
- 当前库级 `compression_status` 是工作状态，不足以表达最近一次终态；终态必须来自具体 job，不能把
  `succeeded_noop` 压扁成 idle 后让用户猜测是否执行。
- 当前 181 迁移导入旧经验时会把适用条件和迁移来源写入正文；新压缩提示词禁止继续保留这些内容，
  但部署不能自动批量改写历史库，必须经只读扫描、预览和人工新版本处理。
- 当前 `memory-system.js` 仍保留大量旧短期/长期服务实现。路由已退休不代表没有内部调用；最终实施必须做入口、import、worker、启动注册和测试的引用审计，确认新链路不再使用后才能标为仅审计保留或后续删除候选。

### 已确认保留的正确行为

- 每个策略一份完整记忆库，不恢复按需检索和短期/长期分层。
- 人工保存创建版本；恢复历史版本也创建新版本，不覆盖审计历史。
- 月复盘确认内容先确定性进入权威正文；压缩只是后续整理，失败不能撤销已经沉淀的记忆。
- 压缩冻结源版本和哈希，并在应用时执行 CAS；期间被人工修改的旧结果不得覆盖新正文。
- 相同正文返回 `succeeded_noop`，不创建无意义重复版本。
- 容量目标为字符上限；模型物理输入、上下文和输出能力仍由模型配置决定，不重新引入业务 token 硬上限。

### 专项调整

- 将“压缩”正式定义为语义守恒的整理与知识整合，增加 source block 覆盖映射、确定性锚点和双向语义验证。
- 将压缩状态从库级粗粒度字段扩展为 job 级可查询状态，并加入用户端/管理端一致的实时轮询和动画。
- 将适用条件从正文与模型载荷移除，但保留来源、类别、证据状态和 Chan 验证合同作为服务端审计元数据。
- 将所有策略模型入口的完整记忆版本冻结和注入日志纳入同一验收矩阵，避免只修分析却遗漏复盘分块或模型对比。
- 将 Chan 候选双门槛、冲突阈值和压缩语义校验纳入同一阶段顺序，防止错误证据先进入库后再被压缩固化。

### 当前验证证据与限制

- 静态核对基于本地 `dev_codex`、基线提交 `2fdc999e55c67db26c990d5bbfcf5179777089fc` 和当前脏工作树；
  统一记忆相关实现仍包含未提交修改，最终实施必须逐文件复核，不能只按 HEAD 比较。
- 本地数据库已观察到人工 job 完成但返回 `succeeded_noop` 的真实案例，证明后台任务可运行，也证明当前前端无法及时表达终态；
  该个案不能替代完整的并发、失败、恢复和语义保持验收。
- 既有定向与全量测试基线证明旧合同稳定，不证明新增 Chan 动态合同、压缩双层验证和浏览器轮询已经实现。
- 尚未在本方案阶段完成真实浏览器全状态走查、真实模型高风险样本回放、生产数据库迁移核对和经纪商会话抽样；
  在这些门槛完成前，最终验收状态必须保持 partial。

## 16. 最终完成定义

只有同时满足以下条件，才能把本方案标记为完成：

1. 新信号冻结明确 Chan 开关与周期；旧信号按权威顺序解析，未知失败关闭。
2. 单笔、日、月复盘使用正确 v6 窗口、连续性政策和动态输出合同。
3. 普通复盘状态与 Chan 证据状态分离，证据不足不会被包装成确定结论。
4. 所有策略相关模型任务注入同一份冻结完整记忆库，旧短期/长期和适用条件不再参与运行时。
5. 确认沉淀具有真实修订证明，重复确认、重试、重启、并发压缩都不会丢失或重复写入。
6. 冲突必须由至少三个独立批准版本累计，只提醒人工，不自动修改策略。
7. 压缩通过语义守恒校验；失败、stale、unknown 和 noop 都保留原记忆并有明确终态。
8. 用户端和管理端能从排队自动更新到真实终态，动画不伪造进度且不覆盖人工草稿。
9. 新迁移幂等、已发布迁移正文未修改；历史内容没有未经授权的批量改写。
10. 语法、定向、全量、真实 MySQL、真实浏览器、真实模型冻结样本和部署前只读检查全部达到本方案验收门。

本文件是两项工作的唯一最终实施方案。后续实施、代码审查、测试记录和剩余风险都更新到本文件，
不再分别维护一个 Chan 方案和一个记忆库方案，避免合同或部署顺序再次分叉。

## 17. 最终合并方案第一轮复审：需求覆盖、复用与最小改动

### 复审结论

- 用户确认的两项核心要求均已成为硬合同：每策略只有一个完整记忆库；复盘 Chan 能力严格继承信号当时冻结配置。
- 方案复用了现有 v6 窗口政策、推理快照、复盘 durable job、模型任务追踪、记忆修订/pending/job/CAS 和前端轮询习惯，
  不需要重建第二套调度器、第二套记忆正文或新的前端管理页面。
- 原设想若把每次压缩都升级为强制双模型调用会造成不必要成本。最小正确实现应先用确定性语义清单和锚点校验；
  只有高风险块、确定性检查无法证明守恒或用户配置开启严格模式时才调用独立语义验证模型。
- “所有模型请求都传记忆库”需要限定为“所有有明确策略归属的业务模型请求”。连接测试、资料验证和无策略管理任务没有合法策略库，
  不应为了字面覆盖而伪造默认记忆。
- 前端不需要 WebSocket 新协议；有 durable job 状态接口和 visibility-aware 轮询即可达到及时、可恢复和多页面一致。

### 第一轮调整

- 将语义验证改为分层：确定性锚点必做，独立验证按风险和无法判定情况触发；任何层无法证明安全仍失败关闭。
- 明确非策略模型任务不注入记忆库，避免跨策略默认回退。
- 保持一个现有 AI 实验室记忆页面和统一管理后台入口，只增强状态与动画，不新增重复页面。
- 把适用条件限定为审计元数据，不设计新的运行时条件引擎。

### 第一轮剩余风险

- 纯 Markdown 的 source block 粒度可能受人工标题和列表格式影响，需要稳定规范化规则和黄金样本。
- 混合 enabled/disabled/unknown outcome 的动态 Schema 可能增加模型遵循难度，需真实模型回放而非只靠 mock。
- 完整记忆库接近模型输入上限时会触发物理输入限制；本方案不允许静默截断，必须先整理或提示人工处理。

## 18. 最终合并方案第二轮复审：兼容、迁移、并发、恢复与连带风险

### 复审发现与已纳入调整

1. **迁移兼容**：181/182 可能已部署，禁止修改正文；新增 job 阶段、语义清单或验证字段必须用后续幂等迁移，
   应用代码要容忍部署短窗口内新字段尚不存在，或明确采用“先迁移后切 worker”的停机部署顺序。
2. **确认与压缩并发**：压缩冻结后新确认的复盘不能由旧 job 拥有。能直接追加时创建新版本使旧 job stale；容量不足时新 pending
   由下一 job 冻结。任一路径都必须有事务测试和重启恢复测试。
3. **人工编辑与轮询并发**：终态刷新可能覆盖 textarea 草稿。前端必须维护 dirty/version token；dirty 时只更新状态，不替换正文。
4. **任务未知结果**：provider 已提交但无可确认响应时不能盲重试；job 保持 `status_unknown`，人工先刷新/核对模型任务，避免重复计费和不同压缩结果竞争。
5. **复盘时间语义**：日/月新 case 仍只在可信终端时间窗口创建；本方案只改变已有 case 的证据和后续沉淀，不得借 schema 升级在窗口外自动 backfill。
6. **Chan 会话时区**：周末与 DST 分类必须来自经纪商会话政策和可信时钟。未知时 partial/unknown 失败关闭，不能回退 UTC 星期或北京时间。
7. **授权与隔离**：job 查询必须同时校验策略访问和 job.strategy_id；平台/私有策略、观摩源和普通用户不能借 job ID 越权观察状态。
8. **旧记忆残留**：旧路由 410 不等于内部 worker/import 已消失。发布门增加 import、定时器、启动注册和运行时 SQL 引用审计；
   只要新请求仍访问旧 active/summaries，就不能声称已全面取消层级记忆。
9. **输入容量**：完整库加策略和行情超过模型物理 max_input/context 时必须在调用前返回稳定错误并引导整理；不得恢复任务 token 上限或截断正文。
10. **静态资源缓存**：前端状态与文案改动必须更新实际 HTML 入口 cache key，并在浏览器网络面板确认服务的是新资源。

### 第二轮实施判定

- 上述问题已经分别写入 5.5、5.7、5.8、5.9、8.7–8.10、9–11 以及最终完成定义。
- 阶段顺序确认可实施：先保护 durable 记忆合同，再修 Chan 冻结证据和沉淀门槛，随后做注入/语义压缩，最后开放前端实时状态。
- 任何一阶段未通过验收门都停止进入下一阶段；不得用前端“完成”状态掩盖后端修订、语义验证或 Chan 证据仍不成立。

### 第二轮剩余风险

- 真实模型对覆盖映射和混合 Chan 动态合同的稳定性仍未知，必须用真实冻结样本验收。
- 经纪商会话和 DST 政策需要真实自然行情抽样；单元测试不能证明生产时区正确。
- 当前工作树跨多个未提交批次且共享文件较多，实施提交必须按区块审查；若无法安全拆分，停止自动提交/推送并报告阻塞。

最终合并方案已连续完成两轮复审，第二轮发现均已纳入合同、阶段和验收门，现可按阶段 A 开始实施。

## 19. 2026-08-12 本地实施与验收记录

### 已完成

- 推理快照冻结 Chan 开关、周期和窗口政策；禁用、未知和不支持周期均失败关闭，单笔、日、月复盘不再读取当前可变策略猜测历史能力。
- 日/月复盘输出合同按冻结 Chan 能力动态生成；月度 `memory_candidates` 成为唯一的新候选，确认沉淀和冲突累计均在事务内重新校验当前批准 case/version、策略归属和权威来源。
- 统一记忆正文不再接受 `applicable_when`、`avoid_when` 或 `applicability`；旧条件元数据只保留在历史审计表，不进入新正文或模型提示词。
- 压缩使用稳定 Markdown 逻辑块和覆盖映射，校验数字、价格、周期、方向、风险、否定、例外、反例与冲突锚点；未通过校验、stale 或 provider 状态未知时保留当前权威正文。
- 压缩 job 增加授权终态查询；用户端和管理端使用 visibility-aware 轮询展示排队、运行、校验、应用、成功、noop、失败和未知状态，活跃时显示动画，人工草稿变脏时不覆盖正文。
- 旧短期/长期记忆与平台经验模块不再从 AI 路由导出或启动 worker；旧 HTTP 入口继续返回 410，历史文件和表仅用于审计兼容。
- 手动分析、自动分析、模型对比、单笔/周期复盘和记忆压缩均使用冻结完整记忆库；压缩请求也在调用模型前写入版本/哈希注入日志。

### 验证证据

- 所有改动 JavaScript 均通过 `node --check`，`git diff --check` 无空白错误（仅 Windows 换行提示）。
- `npx vitest run tests/ai`：97 个文件、1843 项全部通过。
- `npx vitest run`：189 个文件、2863 项全部通过。
- 本地服务已以最新工作树重启；`/health` 返回数据库和 Redis 均 connected。
- 真实本地 MySQL 只读核对：case 1201 为 approved，当前/批准版本均为 39，pending #1 已 merged 到 revision #4；修复脚本 dry-run 检测不到新的潜在损坏对象，因此未重复执行数据写入。
- 真实本地浏览器验证用户端“AI复盘师 → 策略记忆库”和管理端“AI运营 → 统一记忆”均可达，静态资源包含 `compressionobs2`，刷新后会恢复最近 job #4 并显示“当前内容已足够精炼，无需修改”，页面控制台无 error/warn。
- 本地压缩 job #4 为 `succeeded_noop`，源版本 v5，验证状态 noop；job #3 为 succeeded 并生成 revision #5，说明“无变化”和“实际生成新版本”两条终态均存在真实数据证据。

### 尚未完成的发布前门槛

- 未用新的真实模型样本重新触发一次 enabled/disabled/unknown 混合 Chan 复盘，也未在整理过程中人工制造脏草稿做端到端并发演练；当前证据由严格单元/集成测试和既有真实 job 共同构成。
- 未做生产数据库迁移只读核对、真实经纪商 DST/周末自然行情抽样、提交、推送或部署。
- 当前工作树混有多个并行批次，无法安全形成单一原子提交；在拆分审查完成前保持未提交状态。

因此，本方案本地实现状态为“完成”，生产发布状态继续保持 `partial`。
