# 手动交易复盘 v3 业务优化实施方案

## 0. 文档信息

- 文档状态：可实施方案，尚未开始功能开发
- 编写日期：2026-08-17
- 适用项目：AURUM / AI 交易实验室
- 适用入口：AI复盘师 → 手动交易复盘
- 当前实现基线：`dev_codex` / `4e7095b31be269cd7a10f777b9b4e31aacda3107`
- 当前实现合同：`docs/manual-trade-review-v2-contract.md`
- 本方案目标：补齐单笔技术逻辑重建、历史时间邻域策略回放、止盈止损合理性判断，以及多条已完成复盘的综合策略优化分析
- 授权边界：本文只定义方案，不授权修改功能代码、数据库、公网数据或部署

### 0.1 与既有文档的关系

1. `manual-trade-review-v2-contract.md` 继续描述当前已实现行为，在 v3 发布前不得改写成目标状态。
2. `manual-profitable-trade-counterfactual-strategy-review-optimization-plan.md` 中“一次只选一笔原始交易”的原则继续保留；其中“多条聚合不实施”的旧结论被本方案替代。
3. 多条综合分析选择的是已经生成的复盘版本，不是在新建单笔复盘时一次选择多条原始交易。
4. `manual-trade-review-second-pass-corrective-remediation-plan.md` 中已落地的签名选择上下文、两阶段冻结、阶段账本、CAS 和恢复约束继续保留。

## 1. 最终需求

系统需要稳定回答三类问题。

### 1.1 单笔手动盈利交易的技术逻辑

- 这笔交易使用了什么可观察的市场逻辑。
- 为什么最终盈利，盈利来自方向、入场、持仓、退出还是偶然行情。
- 哪些技术分析证据可以在不预知结果时支持相同方向。
- 技术分析结论必须对应具体周期、观察、推理和冻结证据引用，不能只输出笼统故事。
- 模型可以发现策略正文之外的人工逻辑，但必须明确标记为“策略外解释”，不得冒充当前策略规则。

### 1.2 当前策略在历史时间邻域的回放

- 使用“创建复盘时的当前策略冻结版本”回放历史行情，而不是猜测当年使用过什么策略。
- 允许在实际开仓附近的合理时间范围检查信号，不要求精确命中成交毫秒。
- 每个候选时间只能使用当时已经闭合、当时可获得的证据。
- 判断当前策略是否会给出同方向入场、仅同方向观察、反方向或不交易。
- 若策略给出入场，必须同时给出入场方式、失效条件、止损和止盈计划，并进行机械合理性检查。

### 1.3 多条已完成复盘的综合策略优化

- 用户可以多选已经完成并拥有固定版本的手动复盘历史。
- 系统综合识别重复出现的人工逻辑、策略遗漏、反例和风险。
- 每项优化建议必须列出支持样本、反对样本、适用边界、潜在副作用和验证要求。
- 综合分析仍只产生待人工验证的策略假设，不自动修改策略、记忆、回测配置或交易行为。

## 2. 设计原则与明确边界

### 2.1 策略唯一分析权威

- 服务端只提供通用时间邻域、冻结行情、指标、证据引用、输出合同和机械校验能力。
- 不在服务端硬编码 EMA、MACD、缠论、多周期共振等具体交易方法。
- 技术方法来自当前冻结策略声明、策略所需数据，以及模型对人工交易的独立事后解释。
- 模型输出必须区分 `strategy_derived`、`manual_logic_inferred` 和 `unexplained`。

### 2.2 防止事后偏差

- “当前策略会不会下单”必须在看不到真实方向、利润、实际 SL/TP 和后续行情的隔离任务中判断。
- “为什么盈利”和“人工可能使用了什么策略外逻辑”只能在盲测结果冻结后生成。
- 时间邻域中的每个候选点独立构造截止证据，禁止把后一个候选点的行情提供给前一个候选点。
- 系统必须展示全部预先确定的候选点，禁止事后只保留最接近盈利结果的点。

### 2.3 结论层级

系统必须区分以下三层，不能统一写成“AI 会下同样的单”：

1. `model_signal`：当前策略模型在该候选时点给出的分析方向。
2. `strategy_eligibility`：品种、时段、入场方式和策略通用规则是否允许入场。
3. `execution_feasibility`：可恢复的历史风控、账户状态和合约约束是否允许执行。

只有三层证据均完整且通过时，才能显示“历史条件下具备执行条件”。缺少历史账户或合约证据时，只能显示模型信号和策略资格，不能推断真实订单一定会成交。

### 2.4 无自动副作用

单笔或综合复盘的创建、生成、编辑、确认和重试均不得：

- 写入或压缩策略记忆库；
- 创建平台经验候选；
- 修改、回测、发布或切换策略；
- 创建信号、订单意图或 Bridge 交易命令；
- 修改历史成交或行情；
- 自动重试旧失败 generation。

## 3. 目标用户流程

### 3.1 单笔复盘

1. 用户选择一笔符合 v2 准入条件的盈利、完全平仓、未绑定平台信号的交易。
2. 用户选择当前平台策略，系统冻结当前策略版本和完整可用运行时。
3. 系统按策略主周期生成固定时间邻域候选点。
4. 每个候选点执行独立的开仓前盲测。
5. 服务端机械计算方向关系、SL/TP 方向、风险收益比和可验证约束。
6. 所有盲测冻结后，模型执行事后盈利解释和技术逻辑重建。
7. 用户查看结论、人工编辑版本、确认或标记问题。

### 3.2 综合复盘

1. 用户进入“综合分析”，筛选同一策略的已完成复盘。
2. 用户选择 2–20 条复盘版本；系统固定具体版本 ID 和内容哈希。
3. 系统按策略版本、技术逻辑、方向匹配、时点偏移和保护计划进行统计与分组。
4. 模型基于冻结的结构化单笔结论生成跨样本分析。
5. 页面展示重复模式、反例、覆盖不足和待验证策略优化建议。
6. 用户只能打开策略编辑器自行处理，系统不自动套用建议。

## 4. 单笔复盘 v3 合同

### 4.1 当前策略冻结运行时

创建复盘时冻结并哈希：

- 当前 `auto_prompt_types` 策略版本与策略正文；
- `strategy_policy`、`market_data_plan`、`entry_methods`、symbols 和结构分析声明；
- 当前策略统一记忆库完整版本，明确标记为经验参考；
- 当前账户订阅时段、时段外行为、止盈模式和执行开关；
- 当前平台风险规则版本；
- 可证明的历史合约规格来源和版本；
- 是否要求历史账户/持仓上下文，以及该上下文是否可恢复。

“当前策略”固定定义为复盘创建时的策略版本。若产品以后需要比较“交易当时的历史策略版本”，应使用独立对比功能，不在本合同中混用。

### 4.2 时间邻域

时间邻域使用策略主周期的闭合 K 线边界，不使用固定分钟数。

默认候选点：

- `anchor_minus_1`：实际开仓前一根主周期 K 线闭合时点；
- `anchor`：实际开仓所在主周期在开仓前可获得的最后闭合时点；
- `anchor_plus_1`：实际开仓后一根主周期 K 线闭合时点。

可配置上限为前后各 2 根，总候选点不得超过 5 个。首版默认 3 个，只有策略明确需要更宽确认窗口时才使用 5 个。

每个候选点保存：

```json
{
  "candidate_key": "anchor_minus_1|anchor|anchor_plus_1",
  "decision_time_utc_msc": 0,
  "terminal_time": "",
  "primary_timeframe": "M15",
  "offset_bars": -1,
  "market_snapshot_hash": "",
  "input_hash": ""
}
```

所有候选点在模型调用前一次性确定并冻结。不得根据实际利润、方向或模型第一次输出动态扩大、缩小或移动窗口。

### 4.3 独立盲测任务

每个候选点使用独立模型任务，输入只包含该时点可见信息。不能把多个候选快照放入同一个模型请求，因为后一个快照会向前一个决策泄漏未来信息。

候选点输出合同：

```json
{
  "output_contract_version": "manual-trade-counterfactual-point-v3",
  "candidate_key": "anchor",
  "decision": "buy|sell|hold|insufficient_evidence",
  "entry_allowed": true,
  "entry_method": "market|limit|stop|stop_limit|observe|unknown",
  "entry_price_reference": null,
  "strategy_signals": [
    {
      "strategy_rule_path": "strategy_policy...",
      "timeframe": "M15",
      "observation": "",
      "inference": "",
      "evidence_refs": [""]
    }
  ],
  "blocking_rules": [],
  "protection_plan": {
    "invalidation_logic": "",
    "stop_loss_price": null,
    "take_profit_prices": [],
    "recommended_take_profit_tier": null,
    "position_size_tier": "none|probe|light|standard|unknown"
  },
  "confidence": 0.0
}
```

### 4.4 服务端确定性派生

以下字段不允许由阶段 B 模型自由声明：

- `direction_match`：根据盲测 `decision` 和真实方向确定；
- `first_same_direction_candidate`：按候选时间排序后确定；
- `same_direction_candidate_count`；
- `stop_loss_direction_valid`；
- `take_profit_direction_valid`；
- `risk_reward_ratios`；
- `stop_distance_atr`；
- `take_profit_distance_atr`；
- 可恢复合约条件下的最小距离和价格步进校验；
- `model_signal`、`strategy_eligibility`、`execution_feasibility` 三层状态。

`direction_match` 归一化为：

- `same_direction_entry`
- `same_direction_observe`
- `opposite_direction`
- `hold`
- `insufficient_evidence`

任何模型返回的同名派生字段都应忽略或拒绝，避免模型结论与冻结数据自相矛盾。

### 4.5 止盈止损合理性

合理性分为四个独立维度：

1. **方向合法性**：买入止损低于入场、止盈高于入场；卖出相反。
2. **策略一致性**：失效逻辑、目标层级和仓位档位符合冻结策略规则。
3. **市场结构合理性**：距离与冻结 ATR、结构位或策略声明的通用依据一致。
4. **执行可行性**：历史合约规格可恢复时，满足最小距离、价格精度和订单类型约束。

实际手动单的 SL/TP 与策略建议分别展示，不能把实际盈利倒推为保护设置合理。缺少历史合约规格时，执行可行性必须为 `unknown`，不得用当前合约规格冒充历史事实。

### 4.6 事后技术逻辑和盈利解释

所有候选盲测冻结后，阶段 B 才接收实际交易、持仓路径和用户说明。

v3 结果至少包含：

```json
{
  "output_contract_version": "manual-trade-review-v3",
  "review_summary": "",
  "why_profitable": {
    "direction_contribution": "",
    "entry_timing_contribution": "",
    "holding_contribution": "",
    "exit_contribution": "",
    "luck_or_uncontrolled_factors": ""
  },
  "technical_analysis_chain": [
    {
      "origin": "strategy_derived|manual_logic_inferred|unexplained",
      "method_label": "",
      "timeframes": [],
      "observations": [],
      "reasoning": "",
      "would_support_same_direction_without_outcome": true,
      "strategy_rule_paths": [],
      "evidence_refs": [],
      "limitations": ""
    }
  ],
  "counterfactual_summary": {
    "server_derived_direction_match": "same_direction_entry",
    "first_same_direction_candidate": "anchor_plus_1",
    "timing_difference_bars": 1,
    "protection_quality": "reasonable|partial|unreasonable|unknown"
  },
  "rule_comparisons": [],
  "strengths": [],
  "issues": [],
  "strategy_optimization_hypotheses": [],
  "confidence": 0.0,
  "limitations": []
}
```

技术逻辑必须引用真实冻结证据。模型不得宣称某种技术分析“保证得到同样结果”，只能说明该方法在当时是否支持相同方向以及证据强弱。

## 5. 综合复盘合同

### 5.1 可选来源

一条综合分析来源必须满足：

- 属于当前操作者和当前权威账户范围；
- 单笔复盘任务已经生成终态版本；
- 固定具体 `case_id + version_id + content_hash`；
- 复盘版本未被删除且来源交易仍可审计；
- 所有来源使用同一 `strategy_id`。

允许选择 `draft`、`edited`、`needs_revision` 和 `approved` 中已有固定版本的记录，但综合结果必须区分：

- `confirmed_sources`：已批准版本；
- `unconfirmed_sources`：模型草稿或人工尚未确认版本。

未确认来源可以用于观察，不得单独把建议提升为“可人工修改候选”。首版最少 2 条、最多 20 条。

### 5.2 策略版本处理

- 相同 `strategy_id`、相同版本：直接综合。
- 相同 `strategy_id`、不同版本：按版本分组，并单独输出跨版本变化。
- 不同 `strategy_id`：首版拒绝创建，避免把不同规则体系混成一个优化建议。

### 5.3 服务器统计层

模型调用前，服务端先计算可重复统计：

- 样本数、已确认数、证据完整数；
- 实际方向分布；
- 各时间偏移点同方向入场率；
- 首次同方向信号偏移分布；
- SL/TP 四维合理性分布；
- 技术逻辑来源分布；
- 相同策略路径问题的支持样本和反例；
- 每个策略版本的覆盖差异。

这些统计使用单笔 v3 的结构化字段确定性生成。v2 来源可以选入，但缺失字段必须计入 `coverage_missing`，不得让模型自行补造。

### 5.4 综合模型输出

```json
{
  "output_contract_version": "manual-trade-review-aggregate-v1",
  "source_summary": {
    "total": 0,
    "confirmed": 0,
    "evidence_complete": 0,
    "strategy_versions": []
  },
  "recurring_patterns": [
    {
      "pattern": "",
      "supporting_review_refs": [],
      "counterexample_review_refs": [],
      "support_count": 0,
      "confidence": 0.0
    }
  ],
  "strategy_gaps": [],
  "protection_findings": [],
  "version_comparisons": [],
  "strategy_optimization_hypotheses": [
    {
      "target_path": "strategy_policy...",
      "current_rule_summary": "",
      "observed_gap": "",
      "proposed_change": "",
      "supporting_review_refs": [],
      "counterexample_review_refs": [],
      "applicable_when": {},
      "risk_if_applied": "",
      "validation_needed": "",
      "recommendation_state": "observe|ready_for_human_review|insufficient_evidence",
      "confidence": 0.0
    }
  ],
  "limitations": []
}
```

只有至少 3 条不同且已确认复盘支持、存在明确反例检查、目标路径真实存在时，建议才可以是 `ready_for_human_review`。该状态仍不代表已经验证有效。

## 6. 后端架构

### 6.1 保留现有单笔边界

继续保留：

- `MANUAL_TRADE_SELECTION_MAX = 1`；
- 当前候选签名上下文；
- 当前 case/source/version/job 表；
- 当前人工编辑、确认和新 generation 重试；
- 两阶段结果隔离和最终应用 CAS。

不得为了综合分析把单笔创建接口重新放宽为一次选择多笔原始交易。

### 6.2 新增候选点执行层

迁移 192 的 `manual_trade_review_stage_runs` 继续保存 generation 级阶段账本，不修改既有迁移正文。

新增追加迁移，建立 `manual_trade_review_counterfactual_points`：

- `case_id`
- `job_id`
- `generation_no`
- `candidate_key`
- `decision_time_utc_msc`
- `offset_bars`
- `status`
- `model_task_id`
- `market_snapshot_hash`
- `input_hash`
- `normalized_output_json/hash`
- `last_error_code`
- 时间字段

唯一键：

- `(job_id, generation_no, candidate_key)`
- `model_task_id`

阶段 A 只有在所有候选点均进入可解释终态后才算完成。单点证据不足可以保存为规范结果；供应商状态未知仍按现有 fail-closed 机制等待对账。

### 6.3 综合分析存储

不复用周期复盘表，不修改单笔复盘来源语义。新增最小独立表：

1. `manual_trade_review_aggregate_cases`
   - 用户、账户、策略、selection hash、generation、状态、当前版本、任务 ID、deadline 和错误码。
2. `manual_trade_review_aggregate_sources`
   - aggregate case、单笔 case、固定 version、content hash、确认状态和策略版本。
3. `manual_trade_review_aggregate_versions`
   - generation、内容 JSON/hash、模型或人工来源、创建时间。

综合分析只需要一个模型阶段，复用通用 `ai_model_tasks` 的租约、幂等、容量和状态未知对账，不复制单笔两阶段账本。

### 6.4 模块拆分

为避免继续扩大 `manual-trade-review.js`，实施前先按职责拆分，不改变行为：

- `manual-trade-review-contracts.js`：v2/v3 输出合同和校验；
- `manual-trade-review-prompts.js`：候选点盲测和事后复盘提示；
- `manual-trade-review-counterfactual.js`：时间邻域和候选点任务；
- `manual-trade-review-aggregate.js`：综合分析 API、统计和任务；
- `manual-trade-review-worker.js`：单笔 generation 编排；
- 原文件保留对外业务函数和兼容导出。

拆分提交必须是纯重构并先通过现有测试，不能与 v3 行为变化混在同一个提交。

## 7. API 设计

### 7.1 单笔接口兼容升级

保留现有路径：

- `POST /api/ai/manual-trade-reviews`
- `GET /api/ai/manual-trade-reviews/:id`
- `GET /api/ai/manual-trade-reviews/:id/job-status`
- 编辑、确认和重试路径

新建任务默认生成 v3；旧 v2 详情继续只读兼容。详情增加：

- `counterfactual_points`
- `server_derived_comparison`
- `protection_assessment`
- `runtime_coverage`

### 7.2 综合分析接口

- `GET /api/ai/manual-trade-review-aggregates/eligible-reviews`
- `POST /api/ai/manual-trade-review-aggregates`
- `GET /api/ai/manual-trade-review-aggregates`
- `GET /api/ai/manual-trade-review-aggregates/:id`
- `GET /api/ai/manual-trade-review-aggregates/:id/job-status`
- `POST /api/ai/manual-trade-review-aggregates/:id/retry`

创建请求只提交固定版本引用和服务器签发的选择上下文。服务器在事务内重新验证用户、账户、策略、版本哈希、状态和数量。

同一个 `client_request_id` 必须幂等；相同选择集合使用排序后的版本引用生成 `selection_hash`。不同请求可以故意对相同集合重新分析，但必须有不同 generation/request 身份并保留审计链。

## 8. 前端方案

### 8.1 单笔结果页

结果按以下顺序展示：

1. 结论摘要和明确限制；
2. 历史时间邻域时间轴；
3. 每个候选点的方向、入场方式和阻断条件；
4. 当前策略建议 SL/TP 与实际手动单对照；
5. 盈利归因；
6. 技术分析链；
7. 策略规则对照和单笔优化假设。

“同方向”必须显示具体偏移，例如“开仓后 1 根 M15 闭合 K 线首次出现同方向入场”，不能只显示一个布尔标签。

### 8.2 综合分析页

- 历史列表增加多选模式，仅在用户点击“综合分析”后启用；普通查看仍为单选详情。
- 显示已选数量、策略版本分组、已确认/未确认数量和字段覆盖情况。
- 不同策略时禁用创建并解释原因。
- 结果优先展示支持样本和反例，不用单一置信度掩盖样本不足。
- 优化建议提供“打开策略编辑器”，不提供“一键应用”。

### 8.3 状态与可访问性

- 区分“正在生成候选点盲测”“正在进行事后归因”“正在综合分析”。
- 单个候选点等待对账时显示具体候选时间，不回退成泛化的“AI 分析中”。
- 键盘可选择历史记录，状态不只依赖颜色。
- 所有英文内部错误码映射为中文，但详情保留可复制的审计编号。

## 9. 过度设计清理策略

### 9.1 本轮保留

- 两阶段模型隔离；
- generation、租约、deadline、幂等和 CAS；
- 签名选择上下文；
- 冻结策略、记忆、行情和模型配置；
- 状态未知 fail-closed；
- 旧版本只读兼容。

这些机制直接保护模型成本、证据完整性和重试安全，不属于可删功能。

### 9.2 功能稳定后单独清理

- 删除已经证明只被测试引用且不再承担兼容作用的旧辅助函数；
- 评估废弃 job 行上的 `model_task_id` 镜像，以 stage/point/task 为权威来源；
- 将 generation 级冻结运行时从两个 stage row 的重复正文改为单一快照引用；
- 收敛旧 v1 前端兼容模板，但保留历史记录可读；
- 修正过期注释和合同命名。

清理必须在 v3 业务能力之后单独提交，不与新功能混合，且不得删除迁移 192 或历史审计数据。

## 10. 并发、幂等与恢复

### 10.1 单笔候选点

- 每个候选点使用 `job + generation + candidate_key` 稳定幂等键。
- 已保存规范输出的点不得再次调用模型。
- 任一点供应商状态未知时，只对账该点；不得重跑其他已成功点。
- 人工重试创建新 generation 和全新候选点记录，旧记录只读。
- 事后阶段必须绑定全部候选输出哈希的有序集合。

### 10.2 综合分析

- 创建时事务性锁定并固定所有来源版本。
- 来源版本之后被人工编辑不影响已创建综合分析。
- Worker 最终应用必须检查 aggregate generation、任务 ID、输入哈希和来源集合哈希。
- 失败重试创建新 generation，不覆盖旧版本。
- 同一用户不能通过并发请求绕过最多 20 条限制或混入其他账户版本。

### 10.3 时间语义

- 内部一律使用 UTC 毫秒；展示使用来源终端验证时差。
- 每个候选点记录 UTC、终端时间、时差、时钟状态和证据来源。
- 时钟不可信时整个时间邻域为 `insufficient_evidence`，不得回退到固定时区。
- 休市、周末和跨交易日偏移按真实闭合 K 线序列计算，不按自然分钟相加。

## 11. 测试方案

### 11.1 时间邻域与防泄漏

- M5、M15、H1 等不同主周期候选点正确。
- 周末、休市、缺口和夏令时不产生虚假 K 线偏移。
- 每个候选输入只含截止该候选时点的闭合行情。
- 后一候选行情不会出现在前一候选输入。
- 候选集合不因实际方向、利润或第一次模型结果变化。

### 11.2 确定性方向关系

- 阶段 A `buy` + 实际 `sell` 必须由服务端派生为 `opposite_direction`。
- 阶段 B 即使返回错误 match，也不能覆盖服务器派生值。
- hold、证据不足和同方向观察分别正确归一化。

### 11.3 SL/TP

- 买卖方向的 SL/TP 方向机械校验。
- 多档 TP 顺序、RR、ATR 距离和策略路径校验。
- 历史合约规格缺失时执行可行性为 unknown。
- 实际盈利但实际 SL/TP 不合理时仍能指出问题。
- 没有实际 SL/TP 时不得猜造其设置。

### 11.4 技术分析链

- 每条逻辑必须有 evidence refs。
- `strategy_derived` 必须引用真实策略路径。
- 策略外解释不能进入策略一致性结论。
- 证据不足时不能输出强技术结论或优化假设。

### 11.5 综合分析

- 2 条和 20 条边界成功，1 条和 21 条失败。
- 跨用户、跨账户、跨策略、版本哈希变化全部 fail-closed。
- 同策略不同版本正确分组。
- v2 缺失字段计入 coverage，不由模型补造。
- 未确认来源不能单独产生 `ready_for_human_review`。
- 支持数不足、没有反例检查或路径不存在时建议降级。

### 11.6 恢复和真实环境

- 在每个候选点模型请求前后、规范输出写入前后模拟进程中断。
- 真实 MySQL 验证唯一键、CAS、并发创建和任务恢复。
- 前端 DOM、键盘、分页、多选、刷新和返回单笔详情测试。
- 聚焦测试后运行全量 `npm test` 和 `git diff --check`。
- 公网部署后只读验证 commit、迁移、进程、静态缓存和日志。
- 经单独授权后创建一条新 v3 单笔复盘和一个综合分析，观察到真实模型终态。

## 12. 分阶段实施与提交边界

### 阶段 0：锁定合同和基线

- 固化本文的 v3 JSON schema、候选点默认范围和综合来源规则。
- 为当前 v2 行为补齐契约回归，确保后续兼容。
- 记录当前聚焦测试、全量测试和 migration 对比基线。

验收：合同测试可表达全部字段和非法组合，但生产行为仍保持 v2。

### 阶段 1：纯重构拆分

- 拆分当前单文件职责，不改变 API、模型输入、状态或数据库。
- 删除不得与本阶段混合。

验收：现有手动复盘聚焦测试和全量测试与基线一致。

### 阶段 2：时间邻域和候选点账本

- 新增追加迁移和候选点存储。
- 构建独立截止行情和独立盲测任务。
- 保留现有事后阶段，暂不开放综合分析。

验收：3 个默认候选点无未来泄漏，进程中断后不重复模型调用。

### 阶段 3：v3 技术逻辑与 SL/TP 合同

- 引入 v3 结果、服务器派生关系和保护计划校验。
- 完成单笔 v3 前端展示。

验收：需求 1 和需求 2 的单笔链路在真实 MySQL 集成测试中通过。

### 阶段 4：综合分析

- 新增 aggregate 表、API、统计层、模型合同和前端多选。
- 支持 v2/v3 来源覆盖差异。

验收：2–20 条同策略来源可生成可追溯结果，跨权限和跨策略全部拒绝。

### 阶段 5：复杂度清理

- 在运行稳定后清理旧辅助函数、镜像字段调用点和重复运行时正文。
- 不删除历史表、迁移或审计记录。

验收：有明确调用点证据、兼容期结束条件和可回滚提交。

### 阶段 6：发布

- 每阶段独立 Conventional Commit，先推送 `dev_codex`。
- 合并 main 和公网部署必须由用户另行明确授权。
- 新迁移与依赖它的代码同批发布。

## 13. 迁移与回滚

- 所有数据库变化使用 192 之后的新迁移 ID，禁止修改 178、191、192 正文。
- 新表只追加，不重写旧 v2 case、version、job 或 stage 数据。
- 应用回滚时保留新表和生成记录；旧代码忽略新表。
- 如果候选点 Worker 出现异常，停止领取新 v3 job，允许 v2 历史只读，不删除状态未知模型任务。
- 如果综合分析异常，仅关闭综合入口，不影响单笔复盘。
- 不提供 destructive down migration。

## 14. 第一轮方案复审：需求覆盖、最小改动与过度设计

### 14.1 发现

1. 直接把单笔原始交易选择上限从 1 改回 10，会混淆单笔因果解释和综合策略分析，也会破坏已确认的 v2 边界。
2. 使用“开仓前后固定 30 分钟”会在不同主周期产生完全不同含义，并在休市时制造不存在的候选时间。
3. 把多个时间快照放进一个模型请求虽然便宜，但会让晚时点行情污染早时点决策。
4. 服务端预设固定技术方法会违反策略唯一分析权威，并把某一策略经验硬编码进通用复盘。
5. 仅比较方向仍无法回答止盈止损和真实执行条件。
6. 立即清理阶段账本会把近期为恢复可靠性增加的必要机制误删。

### 14.2 调整

- 保留单笔原始交易选择上限 1，新增独立的已完成复盘综合分析。
- 时间容差改为基于策略主周期闭合 K 线的固定候选集合。
- 每个候选点使用独立模型任务和独立截止证据。
- 技术分析采用通用结构合同，不硬编码方法、指标和权重。
- 将模型信号、策略资格、执行可行性和保护计划拆开。
- 可靠性机制先保留，复杂度清理放在功能稳定后的独立阶段。

### 14.3 第一轮结论

调整后方案覆盖三项业务需求，同时没有把综合分析塞回单笔任务，也没有引入新的自动策略或交易副作用。独立候选任务会增加模型成本，但这是保证历史时点隔离的必要成本；通过默认 3 点、最大 5 点和管理员手动触发控制预算。

## 15. 第二轮方案复审：兼容、数据、恢复、安全与连带风险

### 15.1 发现

1. 现有 migration 192 和代码假设每个 generation 固定两个 stage，直接复用 stage 名称存 3–5 个候选点会破坏完整性检查和旧任务恢复。
2. 综合分析若只保存 case ID 而不固定 version ID，人工编辑后会产生不可复现结果。
3. 使用当前经纪商合约规格校验历史订单会把当前状态冒充历史证据。
4. 允许不同策略混合分析会产生无法定位 target path 的建议。
5. 只允许 approved 来源会与“已完成历史”的需求不完全一致；完全信任 draft 又会放大未确认模型错误。
6. 综合分析复用周期复盘表会混淆周期、来源和记忆派生语义。
7. 候选点增加模型调用后，旧的单任务 deadline 和成本上限可能不足。

### 15.2 调整

- 不修改 migration 192 语义，使用新追加表存候选点。
- 综合来源固定 `case + version + hash`，生成后不跟随人工编辑漂移。
- 历史合约证据缺失时执行可行性标为 unknown，不回退到当前规格。
- 首版只允许同一 strategy ID；不同版本分组比较。
- 允许有固定版本的终态复盘参与，但统计和建议严格区分 confirmed/unconfirmed。
- 综合分析使用独立最小表，不接入周期复盘和记忆派生。
- 在实施阶段重新测算总 deadline、每用户并发、模型容量和最大 token；候选点任务共享业务预算但保留独立任务身份。
- 所有来源重新校验用户、账户、策略和版本哈希，防止跨账号拼接。

### 15.3 第二轮结论

调整后的方案兼容 v2 历史和 migration 192，不依赖改写已发布迁移，不把当前合约状态伪装为历史事实，并保持模型任务可恢复、来源可复现和权限 fail-closed。第二轮未发现仍需改变总体架构的实质问题，方案可以进入阶段 0 实施。

## 16. 剩余风险

1. 默认 3 个候选点可能仍覆盖不了部分长周期策略；扩大到 5 点会显著增加模型成本和完成时间。
2. 历史账户风险、持仓和合约规格可能无法完整恢复，因此“实际会执行”在部分记录中只能保持 unknown。
3. v2 旧复盘缺少结构化技术链和保护计划，综合分析的字段覆盖率会低于 v3。
4. 模型可能为盈利结果编造看似合理的技术故事；必须依赖证据引用、策略来源分类和反例展示约束，而不能完全消除。
5. 同策略跨版本综合可能把策略变化与行情差异混合，结果必须按版本分组，不能只给总平均。
6. 供应商状态查询能力不足时，候选点任务仍可能长期等待人工处理，不能以自动重发换取表面完成率。
7. 候选点和综合版本会增加数据库增长，需要监控，但首版不设计自动删除或归档以免破坏审计。

## 17. 完成定义

只有同时满足以下条件，才能宣称本轮业务优化完成：

- 单笔 v3 明确输出技术分析链、盈利原因、时间邻域和 SL/TP 合理性。
- `counterfactual_match` 等确定性字段由服务器计算，模型不能覆盖。
- 每个候选点无未来数据泄漏，默认 3 点全部可追溯和恢复。
- 模型信号、策略资格和执行可行性在 UI 中明确分层。
- 用户可以选择 2–20 条同策略已完成复盘生成综合分析。
- 综合建议包含支持样本、反例、适用条件、风险和验证要求。
- 单笔与综合流程均无策略、记忆、回测、发布或交易副作用。
- 新迁移追加且通过真实 MySQL 唯一键、事务和并发验证。
- 聚焦测试、全量测试、浏览器流程和公网只读发布检查通过。
- 经用户单独授权，真实新单笔 v3 和综合任务均观察到模型终态；未执行真实交易或自动策略修改。

