export function strategyMemoryPayload(memory) {
  return { version_no:Number(memory?.version_no || 0), content_hash:memory?.content_hash || null,
    content_text:String(memory?.content_text || '') }
}

export function createManualTradeReviewPrompts({ parse, text, buildManualReviewEvidenceCatalog,
  manualTradeReviewOutputContract, counterfactualOutputVersion, maxThesis }) {
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

  return { counterfactualPrompt, outcomeReviewPrompt }
}
