import { buildFrozenStrategyPaths, validateFrozenStrategyPath } from './manual-trade-review-contract.js'

const PATH_REPAIR_CODES = new Set([
  'manual_trade_review_v3_strategy_rule_path_required',
  'manual_trade_review_v3_strategy_rule_path_invalid',
  'manual_trade_review_v3_strategy_rule_path_unknown',
])

const TIMEFRAME_REPAIR_CODES = new Set([
  'manual_trade_review_v3_strategy_signal_timeframe_invalid',
  'manual_trade_review_v3_strategy_signal_timeframe_undeclared',
  'manual_trade_review_v3_strategy_signal_timeframe_evidence_unavailable',
  'manual_trade_review_v3_strategy_signal_timeframe_evidence_timeframe_invalid',
  'manual_trade_review_v3_strategy_signal_timeframe_evidence_timeframe_missing',
])

function normalizedTimeframe(value) {
  const timeframe = String(value == null ? '' : value).normalize('NFKC').trim().toUpperCase()
  return /^[A-Z][A-Z0-9_]*$/.test(timeframe) ? timeframe : null
}

function evidenceReferenceTimeframe(value) {
  return normalizedTimeframe(String(value == null ? '' : value).split(':').at(-1))
}

function normalizedSet(values, normalizer = value => String(value)) {
  return new Set((Array.isArray(values) ? values : values instanceof Set ? [...values] : [])
    .map(normalizer).filter(Boolean))
}

function evidenceRefsByTimeframe(values) {
  const byTimeframe = new Map()
  for (const value of values instanceof Set ? values : Array.isArray(values) ? values : []) {
    const ref = String(value == null ? '' : value).normalize('NFKC').trim()
    const timeframe = evidenceReferenceTimeframe(ref)
    if (!ref || !timeframe) continue
    if (!byTimeframe.has(timeframe)) byTimeframe.set(timeframe, [])
    byTimeframe.get(timeframe).push(ref)
  }
  return Object.fromEntries([...byTimeframe.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([timeframe, refs]) => [timeframe, [...new Set(refs)].sort()]))
}

function signalHasTimeframeEvidenceIssue(signal, {
  declaredTimeframes, availableTimeframes, allowedEvidenceRefsByTimeframe,
} = {}) {
  const timeframe = normalizedTimeframe(signal?.timeframe)
  const refs = Array.isArray(signal?.evidence_refs)
    ? signal.evidence_refs.map(value => String(value == null ? '' : value).normalize('NFKC').trim()).filter(Boolean) : []
  if (!timeframe || refs.length === 0) return true
  if (declaredTimeframes.size && !declaredTimeframes.has(timeframe)) return true
  if (availableTimeframes.size && !availableTimeframes.has(timeframe)) return true
  const allowed = new Set(allowedEvidenceRefsByTimeframe[timeframe] || [])
  return !allowed.size || refs.some(ref => !allowed.has(ref) || evidenceReferenceTimeframe(ref) !== timeframe)
}

export function manualTradeReviewPointRepairTargets(initialObject, {
  strategySnapshot = {}, strategyDeclaredTimeframes = [], evidenceAvailableTimeframes = [],
  allowedEvidenceRefs = [], includePaths = true, includeTimeframes = true,
} = {}) {
  const allowedStrategyPaths = buildFrozenStrategyPaths(strategySnapshot)
  const declaredTimeframes = normalizedSet(strategyDeclaredTimeframes, normalizedTimeframe)
  const availableTimeframes = normalizedSet(evidenceAvailableTimeframes, normalizedTimeframe)
  const allowedEvidenceRefsByTimeframe = evidenceRefsByTimeframe(allowedEvidenceRefs)
  for (const timeframe of Object.keys(allowedEvidenceRefsByTimeframe)) {
    if ((declaredTimeframes.size && !declaredTimeframes.has(timeframe))
      || (availableTimeframes.size && !availableTimeframes.has(timeframe))) {
      delete allowedEvidenceRefsByTimeframe[timeframe]
    }
  }
  const targets = []
  const signals = Array.isArray(initialObject?.strategy_signals) ? initialObject.strategy_signals : []
  signals.forEach((signal, index) => {
    if (includePaths) {
      try {
        validateFrozenStrategyPath(signal?.strategy_rule_path, strategySnapshot)
      } catch {
        targets.push({ kind:'strategy_path', path:`strategy_signals[${index}].strategy_rule_path`,
          signal_index:index, current_value:typeof signal?.strategy_rule_path === 'string' ? signal.strategy_rule_path : null })
      }
    }
    if (includeTimeframes && signalHasTimeframeEvidenceIssue(signal, {
      declaredTimeframes, availableTimeframes, allowedEvidenceRefsByTimeframe,
    })) {
      targets.push({ kind:'timeframe_evidence', path:`strategy_signals[${index}].timeframe_evidence_refs`,
        signal_index:index, current_timeframe:signal?.timeframe ?? null,
        current_evidence_refs:Array.isArray(signal?.evidence_refs) ? signal.evidence_refs : [] })
    }
  })
  return { targets, allowedStrategyPaths, allowedEvidenceRefsByTimeframe }
}

export function createManualTradeReviewPointRepairContext({
  strategySnapshot = {}, strategyDeclaredTimeframes = [], evidenceAvailableTimeframes = [],
  allowedEvidenceRefs = [], validateOutput,
} = {}) {
  if (typeof validateOutput !== 'function') throw new Error('manual_trade_review_v3_point_repair_validator_required')
  const targetOptions = { strategySnapshot, strategyDeclaredTimeframes, evidenceAvailableTimeframes, allowedEvidenceRefs }
  return {
    mode:'patch',
    patchOutputFormat:{ changes:[
      { path:'exact strategy_path repair target', value:'one exact allowed_strategy_rule_paths value' },
      { path:'exact timeframe_evidence repair target', timeframe:'one exact allowed timeframe',
        evidence_refs:['one or more exact refs listed for that timeframe'] },
    ] },
    requiredCoverage:'Return exactly one change for every repair target and no other changes.',
    repairMaxTokens:4_096,
    repairReasoningEffort:'low',
    patchRepairInstructions:'只能修复 repair_targets 报告的 strategy_rule_path 或 timeframe/evidence_refs。策略路径必须逐字复制 allowed_strategy_rule_paths。timeframe 与 evidence_refs 必须选择 allowed_evidence_refs_by_timeframe 中同一周期的一组，且至少一个引用。不得修改方向、入场方法、价格、观察、推断、保护计划、置信度或其他字段。',
    validationContext:({ validationError, initialObject }) => {
      const code = String(validationError?.code || validationError?.message || '')
      const pathFailure = PATH_REPAIR_CODES.has(code)
      const timeframeFailure = TIMEFRAME_REPAIR_CODES.has(code)
      if (!pathFailure && !timeframeFailure) throw validationError
      const context = manualTradeReviewPointRepairTargets(initialObject, {
        ...targetOptions, includePaths:pathFailure, includeTimeframes:timeframeFailure,
      })
      if (!context.targets.length
        || (pathFailure && !context.allowedStrategyPaths.length)
        || (timeframeFailure && !Object.keys(context.allowedEvidenceRefsByTimeframe).length)) throw validationError
      return { targets:context.targets, allowed_strategy_rule_paths:context.allowedStrategyPaths,
        allowed_evidence_refs_by_timeframe:context.allowedEvidenceRefsByTimeframe }
    },
    repairInput:({ initialObject, validationContext }) => ({
      repair_targets:(validationContext?.targets || []).map(target => ({
        ...target, strategy_signal:initialObject?.strategy_signals?.[target.signal_index] || null,
      })),
      allowed_strategy_rule_paths:validationContext?.allowed_strategy_rule_paths || [],
      allowed_evidence_refs_by_timeframe:validationContext?.allowed_evidence_refs_by_timeframe || {},
    }),
    applyRepairPatch:({ initialObject, repairPatch, validationContext }) => {
      const changes = Array.isArray(repairPatch?.changes) ? repairPatch.changes : []
      const targets = Array.isArray(validationContext?.targets) ? validationContext.targets : []
      if (changes.length !== targets.length) throw new Error('manual_trade_review_v3_point_repair_coverage_invalid')
      const targetByPath = new Map(targets.map(target => [target.path, target]))
      const allowedPaths = new Set(validationContext?.allowed_strategy_rule_paths || [])
      const allowedRefsByTimeframe = validationContext?.allowed_evidence_refs_by_timeframe || {}
      const seen = new Set()
      const repaired = JSON.parse(JSON.stringify(initialObject))
      for (const change of changes) {
        const path = String(change?.path || '')
        const target = targetByPath.get(path)
        const signal = repaired?.strategy_signals?.[target?.signal_index]
        if (!target || !signal || seen.has(path)) throw new Error('manual_trade_review_v3_point_repair_invalid')
        if (target.kind === 'strategy_path') {
          const value = String(change?.value || '').normalize('NFKC').trim()
          if (!allowedPaths.has(value)) throw new Error('manual_trade_review_v3_point_repair_invalid')
          signal.strategy_rule_path = value
        } else if (target.kind === 'timeframe_evidence') {
          const timeframe = normalizedTimeframe(change?.timeframe)
          const refs = Array.isArray(change?.evidence_refs)
            ? [...new Set(change.evidence_refs.map(value => String(value == null ? '' : value).normalize('NFKC').trim()).filter(Boolean))] : []
          const allowedRefs = new Set(timeframe ? allowedRefsByTimeframe[timeframe] || [] : [])
          if (!timeframe || !refs.length || refs.some(ref => !allowedRefs.has(ref)
            || evidenceReferenceTimeframe(ref) !== timeframe)) {
            throw new Error('manual_trade_review_v3_point_repair_invalid')
          }
          signal.timeframe = timeframe
          signal.evidence_refs = refs
        } else {
          throw new Error('manual_trade_review_v3_point_repair_invalid')
        }
        seen.add(path)
      }
      return validateOutput(repaired)
    },
  }
}
