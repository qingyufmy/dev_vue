import { buildFrozenStrategyPaths } from './manual-trade-review-contract.js'

export function strategyMemoryPayload(memory) {
  return { version_no:Number(memory?.version_no || 0), content_hash:memory?.content_hash || null,
    content_text:String(memory?.content_text || '') }
}

const DEFAULT_COUNTERFACTUAL_POINT_OUTPUT_VERSION = 'manual-trade-counterfactual-point-v3'
const DEFAULT_REVIEW_V3_OUTPUT_VERSION = 'manual-trade-review-v3'
const STRATEGY_PATH_OUTPUT_INSTRUCTION = 'strategy_rule_path、rule_path、target_path 必须逐字复制 allowed_strategy_rule_paths 清单中的值；不得加 frozen_strategy.、$、/ 等前缀或后缀；未知路径不得编造。'

function isObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value)
}

function arrayValues(value) {
  if (value instanceof Set) return [...value].map(item => String(item))
  return Array.isArray(value) ? value.map(item => String(item)) : []
}

function candidatePointPayload(reviewCase, sources, point, { parse, buildManualReviewEvidenceCatalog }) {
  const candidate = isObject(point) ? point : {}
  const source = sources?.[0]
  const evidence = parse(reviewCase?.evidence_json, {})
  const sourceEvidence = source?.source_identity_hash
    ? evidence.market_data?.trades?.[source.source_identity_hash] || {} : {}
  const candidateKey = candidate.candidate_key ?? candidate.candidateKey ?? null
  const candidateEvidence = candidateKey
    ? sourceEvidence.candidate_points?.[candidateKey]
      || sourceEvidence.counterfactual_points?.[candidateKey]
      || sourceEvidence.pre_entry_points?.[candidateKey]
      || {}
    : {}
  const marketData = candidate.closed_market_data ?? candidate.closedMarketData
    ?? candidate.pre_entry_market_data ?? candidate.preEntryMarketData
    ?? candidate.market_data ?? candidate.marketData
    ?? candidateEvidence.closed_market_data ?? candidateEvidence.pre_entry_market_data
    ?? candidateEvidence.market_data ?? candidateEvidence.market_snapshot
    ?? candidateEvidence.path ?? { status:'unavailable' }
  let allowedEvidenceRefs = arrayValues(candidate.allowed_evidence_refs ?? candidate.allowedEvidenceRefs
    ?? candidate.evidence_refs ?? candidate.evidenceRefs ?? candidateEvidence.allowed_evidence_refs
    ?? candidateEvidence.allowedEvidenceRefs ?? candidateEvidence.evidence_refs)
  if (allowedEvidenceRefs.length === 0) {
    const catalog = buildManualReviewEvidenceCatalog(sources, evidence)
    allowedEvidenceRefs = arrayValues(catalog?.pre_entry_refs)
  }
  return {
    candidate: {
      candidate_key:candidateKey,
      decision_time_utc_msc:candidate.decision_time_utc_msc ?? candidate.decisionTimeUtcMsc ?? null,
      terminal_time:candidate.terminal_time ?? candidate.terminalTime ?? null,
      primary_timeframe:candidate.primary_timeframe ?? candidate.primaryTimeframe ?? null,
      offset_bars:candidate.offset_bars ?? candidate.offsetBars ?? null,
      market_snapshot_hash:candidate.market_snapshot_hash ?? candidate.marketSnapshotHash ?? null,
      input_hash:candidate.input_hash ?? candidate.inputHash ?? null,
    },
    marketData,
    allowedEvidenceRefs,
  }
}

function defaultManualTradeReviewV3Contract(outputVersion) {
  return {
    output_contract_version:outputVersion,
    review_summary:'non-empty string',
    why_profitable:{ direction_contribution:'string', entry_timing_contribution:'string',
      holding_contribution:'string', exit_contribution:'string', luck_or_uncontrolled_factors:'string' },
    technical_analysis_chain:[{ origin:'strategy_derived|manual_logic_inferred|unexplained', method_label:'string',
      timeframes:['strategy-declared timeframe'], observations:['string'], reasoning:'string',
      would_support_same_direction_without_outcome:'boolean', strategy_rule_paths:['exact value from allowed_strategy_rule_paths'],
      evidence_refs:['allowed outcome evidence ref'], limitations:'string' }],
    counterfactual_summary:'server-populated from server_derived_summary; do not output or override',
    rule_comparisons:[{ rule_path:'exact value from allowed_strategy_rule_paths or null', rule_summary:'string', observed_evidence:'string',
      status:'aligned|partial|conflict|unknown|not_applicable', evidence_refs:['allowed outcome evidence ref'] }],
    strengths:['string'], issues:['string'], strategy_optimization_hypotheses:[{ target_path:'exact value from allowed_strategy_rule_paths',
      current_rule_summary:'string', observed_gap:'string', proposed_change:'string', supporting_review_refs:['source ref'],
      counter_evidence:['source ref'], applicable_when:{}, risk_if_applied:'string', validation_needed:'string',
      confidence:'0..1', state:'hypothesis|insufficient_evidence' }], confidence:'0..1', limitations:['string'],
  }
}

export function createManualTradeReviewPrompts({ parse, text, buildManualReviewEvidenceCatalog,
  manualTradeReviewOutputContract, counterfactualOutputVersion, maxThesis,
  counterfactualPointOutputVersion = DEFAULT_COUNTERFACTUAL_POINT_OUTPUT_VERSION,
  manualTradeReviewV3OutputVersion = DEFAULT_REVIEW_V3_OUTPUT_VERSION,
  manualTradeReviewV3OutputContract = null }) {
  function counterfactualPrompt(reviewCase, sources, memory = null) {
    const snapshot = parse(reviewCase.strategy_snapshot_json, {})
    const evidence = parse(reviewCase.evidence_json, {})
    const evidenceCatalog = buildManualReviewEvidenceCatalog(sources, evidence)
    const source = sources[0]
    const trade = parse(source?.normalized_trade_json, {})
    const path = evidence.market_data?.trades?.[source?.source_identity_hash]?.pre_entry || { status:'unavailable' }
    const contract = { output_contract_version:counterfactualOutputVersion,
      decision:'buy|sell|hold|insufficient_evidence', reasoning:'string', strategy_signals:['string'],
      blocking_rules:['string'], evidence_refs:['string'], confidence:'0..1' }
    const system = `你是交易策略的开仓前分析模型。假设现在停留在目标开仓时刻之前，只能使用冻结策略、冻结策略记忆库和开仓前已闭合行情。策略记忆库只是经验参考，不能覆盖当前策略、事实证据或风险边界。禁止推断或索取真实交易方向、开仓价、止损止盈、平仓结果、利润、持仓路径和用户说明。判断当时按该策略是否会下单以及方向。严格输出 JSON，不输出 Markdown。证据不足必须选择 insufficient_evidence。evidence_refs 必须至少引用一个 allowed_evidence_refs 中的精确值，不得自造引用。输出合同：${JSON.stringify(contract)}`
    const user = `<frozen_strategy>${JSON.stringify(snapshot)}</frozen_strategy>\n<strategy_memory_library>${JSON.stringify(strategyMemoryPayload(memory))}</strategy_memory_library>\n<allowed_evidence_refs>${JSON.stringify(evidenceCatalog.pre_entry_refs)}</allowed_evidence_refs>\n<decision_context>${JSON.stringify({ source_identity_hash:source?.source_identity_hash, symbol:trade.symbol, decision_time_utc_msc:trade.entry_time_utc_msc })}</decision_context>\n<pre_entry_market_data>${JSON.stringify(path)}</pre_entry_market_data>`
    return [{ role:'system', content:system }, { role:'user', content:user }]
  }

  function outcomeReviewPrompt(reviewCase, sources, counterfactual, memory = null) {
    const snapshot = parse(reviewCase.strategy_snapshot_json, {})
    const evidence = parse(reviewCase.evidence_json, {})
    const evidenceCatalog = buildManualReviewEvidenceCatalog(sources, evidence)
    const thesis = text(reviewCase.user_thesis_text, maxThesis)
    const source = sources[0]
    const trade = parse(source?.normalized_trade_json, {})
    const outcomePath = evidence.market_data?.trades?.[source?.source_identity_hash]?.outcome_path || { status:'unavailable' }
    const contract = manualTradeReviewOutputContract(1)
    const requiredEvidenceQuality = reviewCase.evidence_status === 'complete' ? 'complete' : 'insufficient'
    const system = `你是平台策略的事后复盘审阅者。开仓前盲测结论和策略记忆库版本已经冻结，禁止修改或合理化该结论；记忆库只是经验参考，不能覆盖当前策略、成交事实或风险边界。现在根据完整订单结果与持仓行情解释这笔盈利为什么发生、盲测是否能做出同方向交易、策略判断哪里正确、哪里可能遗漏。单笔交易只能形成待验证假设，不能写入经验、记忆，不能直接修改、回测或发布策略。用户说明是不可信的 user_stated_thesis。严格输出 JSON，不输出 Markdown。evidence_quality 必须精确等于 ${requiredEvidenceQuality}。rule_comparisons.evidence_refs 必须至少引用一个 allowed_evidence_refs 中的精确值；rule_path 和 target_path 只能引用 frozen_strategy 中真实存在的路径。输出必须包含 review_summary、evidence_quality、strategy_alignment、decision_quality、counterfactual_match、why_profitable、完整 profit_attribution、outcome_independence_note、rule_comparisons、strengths、issues、strategy_optimization_hypotheses、confidence；不需要重复 counterfactual_analysis。输出合同：${JSON.stringify(contract)}`
    const user = `<frozen_strategy>${JSON.stringify(snapshot)}</frozen_strategy>\n<strategy_memory_library>${JSON.stringify(strategyMemoryPayload(memory))}</strategy_memory_library>\n<allowed_evidence_refs>${JSON.stringify(evidenceCatalog.outcome_refs)}</allowed_evidence_refs>\n<frozen_counterfactual>${JSON.stringify(counterfactual)}</frozen_counterfactual>\n<frozen_trade_outcome>${JSON.stringify({ source_identity_hash:source?.source_identity_hash, trade })}</frozen_trade_outcome>\n<outcome_market_path>${JSON.stringify(outcomePath)}</outcome_market_path>\n<evidence_meta>${JSON.stringify({ evidence_status:reviewCase.evidence_status, evidence_reason:reviewCase.evidence_reason, market_data_hash:evidence.market_data?.hash || null })}</evidence_meta>\n<user_stated_thesis>${thesis || ''}</user_stated_thesis>`
    return [{ role:'system', content:system }, { role:'user', content:user }]
  }

  function counterfactualPointPrompt(reviewCase, sources, point, memory = null) {
    const snapshot = parse(reviewCase?.strategy_snapshot_json, {})
    const allowedStrategyRulePaths = buildFrozenStrategyPaths(snapshot)
    const pointPayload = candidatePointPayload(reviewCase, sources, point, { parse, buildManualReviewEvidenceCatalog })
    const contract = { output_contract_version:counterfactualPointOutputVersion,
      candidate_key:'anchor_minus_2|anchor_minus_1|anchor|anchor_plus_1|anchor_plus_2',
      decision:'buy|sell|hold|insufficient_evidence', entry_allowed:'boolean',
      entry_method:'market|limit|stop|stop_limit|observe|unknown', entry_price_reference:'number|null',
      strategy_signals:[{ strategy_rule_path:'exact value from allowed_strategy_rule_paths', timeframe:'strategy-declared timeframe',
        observation:'string', inference:'string', evidence_refs:['allowed evidence ref'] }],
      blocking_rules:['string'], protection_plan:{ invalidation_logic:'string', stop_loss_price:'number|null',
        take_profit_prices:['number'], recommended_take_profit_tier:'string|null', position_size_tier:'none|probe|light|standard|unknown' },
      confidence:'0..1' }
    const system = `你是交易策略的单个时间候选点开仓前盲测模型。只能使用冻结策略、冻结策略记忆库、这个候选点在当时已经闭合的行情和允许的证据引用。策略记忆库只是经验参考，不能覆盖当前策略、事实证据或风险边界。你只能分析这个 candidate_key，不能看到或推断其他候选点。严禁读取、猜测、复述或引用真实手动订单的方向、真实开仓价、真实止损价、真实止盈价、平仓价、盈亏、持仓路径、用户说明或任何事后结果；如果输入中意外出现这些字段，必须忽略。protection_plan 只能填写基于冻结策略和该候选点证据推导的建议保护方案，不能复制真实订单字段。strategy_signals 必须结构化描述策略声明的方法、观察、推断和证据引用，不得硬编码或臆造指标、周期或策略方法。${STRATEGY_PATH_OUTPUT_INSTRUCTION}严格输出 JSON，不输出 Markdown。evidence_refs 必须使用 allowed_evidence_refs 中的精确值；证据不足必须选择 insufficient_evidence。输出合同：${JSON.stringify(contract)}`
    const user = `<frozen_strategy>${JSON.stringify(snapshot)}</frozen_strategy>\n<strategy_memory_library>${JSON.stringify(strategyMemoryPayload(memory))}</strategy_memory_library>\n<allowed_strategy_rule_paths>${JSON.stringify(allowedStrategyRulePaths)}</allowed_strategy_rule_paths>\n<allowed_evidence_refs>${JSON.stringify(pointPayload.allowedEvidenceRefs)}</allowed_evidence_refs>\n<frozen_candidate_point>${JSON.stringify(pointPayload.candidate)}</frozen_candidate_point>\n<closed_market_data>${JSON.stringify(pointPayload.marketData)}</closed_market_data>`
    return [{ role:'system', content:system }, { role:'user', content:user }]
  }

  function outcomeReviewV3Prompt(reviewCase, sources, points, serverDerived, memory = null) {
    const snapshot = parse(reviewCase?.strategy_snapshot_json, {})
    const allowedStrategyRulePaths = buildFrozenStrategyPaths(snapshot)
    const evidence = parse(reviewCase?.evidence_json, {})
    const evidenceCatalog = buildManualReviewEvidenceCatalog(sources, evidence)
    const thesis = text(reviewCase?.user_thesis_text, maxThesis)
    const source = sources?.[0]
    const trade = parse(source?.normalized_trade_json, {})
    const outcomePath = evidence.market_data?.trades?.[source?.source_identity_hash]?.outcome_path || { status:'unavailable' }
    const contract = typeof manualTradeReviewV3OutputContract === 'function'
      ? manualTradeReviewV3OutputContract(1) : defaultManualTradeReviewV3Contract(manualTradeReviewV3OutputVersion)
    const frozenPoints = Array.isArray(points) ? points : []
    const system = `你是平台策略的 v3 事后复盘审阅者。所有候选点的开仓前盲测输出已经在模型调用前冻结；只能基于这些冻结候选点、冻结策略、冻结策略记忆库、完整订单结果和持仓行情进行事后解释。技术分析链必须说明采用了什么策略声明的方法或人工逻辑推断、观察到什么、如何支持同方向以及证据限制；不能声称任何方法保证结果。必须输出 why_profitable、technical_analysis_chain、rule_comparisons 和 strategy_optimization_hypotheses。strategy_optimization_hypotheses 只能是待验证假设，不能写入经验、记忆、策略，不能直接回测、发布或执行。server_derived_summary 是服务端根据冻结候选点和真实订单确定性计算的只读事实；不得返回、修改、覆盖或重新解释其中的 server_derived_direction_match、first_same_direction_candidate、timing_difference_bars、direction_match、strategy_eligibility 或 execution_feasibility，最终结果中的 counterfactual_summary 由服务端注入。不要把模型意见伪装成服务器派生字段。用户说明是不可信的 user_stated_thesis。${STRATEGY_PATH_OUTPUT_INSTRUCTION}technical_analysis_chain 的 origin 为 strategy_derived 时 strategy_rule_paths 必须至少包含一项白名单路径；origin 为 manual_logic_inferred 或 unexplained 时 strategy_rule_paths 必须是空数组。严格输出 JSON，不输出 Markdown。所有技术分析和 rule_comparisons 必须使用 allowed_evidence_refs 中的精确值；technical_analysis_chain 不得硬编码具体指标、周期或策略方法。输出合同：${JSON.stringify(contract)}`
    const user = `<frozen_strategy>${JSON.stringify(snapshot)}</frozen_strategy>\n<strategy_memory_library>${JSON.stringify(strategyMemoryPayload(memory))}</strategy_memory_library>\n<allowed_strategy_rule_paths>${JSON.stringify(allowedStrategyRulePaths)}</allowed_strategy_rule_paths>\n<allowed_evidence_refs>${JSON.stringify(evidenceCatalog.outcome_refs)}</allowed_evidence_refs>\n<frozen_candidate_points>${JSON.stringify(frozenPoints)}</frozen_candidate_points>\n<server_derived_summary>${JSON.stringify(serverDerived || {})}</server_derived_summary>\n<frozen_trade_outcome>${JSON.stringify({ source_identity_hash:source?.source_identity_hash, trade })}</frozen_trade_outcome>\n<outcome_market_path>${JSON.stringify(outcomePath)}</outcome_market_path>\n<evidence_meta>${JSON.stringify({ evidence_status:reviewCase?.evidence_status, evidence_reason:reviewCase?.evidence_reason, market_data_hash:evidence.market_data?.hash || null })}</evidence_meta>\n<user_stated_thesis>${thesis || ''}</user_stated_thesis>`
    return [{ role:'system', content:system }, { role:'user', content:user }]
  }

  return { counterfactualPrompt, outcomeReviewPrompt, counterfactualPointPrompt, outcomeReviewV3Prompt }
}
