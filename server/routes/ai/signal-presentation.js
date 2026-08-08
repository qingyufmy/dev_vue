import { auditValueLabel, formatRiskReason } from '../../audit-localization.js'
import { normalizeExperienceAttribution, normalizeExperienceRefs } from './experience-attribution.js'

const SIGNAL_SCHEMA_VERSION = 5

function cleanText(value, maxLength = 240) {
  return typeof value === 'string' ? value.trim().slice(0, maxLength) : ''
}

function cleanList(value, maxItems = 4, maxLength = 160) {
  if (!Array.isArray(value)) return []
  return value.map(item => cleanText(item, maxLength)).filter(Boolean).slice(0, maxItems)
}

function directionScores(signal) {
  const bullish = Number(signal.bullish_score)
  const bearish = Number(signal.bearish_score)
  if (!Number.isFinite(bullish) || !Number.isFinite(bearish) || bullish < 0 || bearish < 0 || bullish + bearish <= 0) {
    return { bullish_score: null, bearish_score: null }
  }
  const total = bullish + bearish
  const bullishScore = Math.round(bullish / total * 1000) / 10
  return { bullish_score: bullishScore, bearish_score: Math.round((100 - bullishScore) * 10) / 10 }
}

function candidateEntry(signal) {
  const candidate = signal?.candidate_entry && typeof signal.candidate_entry === 'object'
    ? signal.candidate_entry : null
  if (!candidate) return null
  const positiveNumber = value => {
    const number = Number(value)
    return Number.isFinite(number) && number > 0 ? number : null
  }
  const signalType = String(candidate.signal_type || '').toLowerCase()
  const entryMethod = String(candidate.entry_method || '').toLowerCase()
  if (!/^(?:buy|sell)(?:_(?:limit|stop|stop_limit))?$/.test(signalType)) return null
  if (!['market', 'limit', 'stop', 'stop_limit'].includes(entryMethod)) return null
  return {
    signal_type:signalType,
    direction:signalType.startsWith('buy') ? 'buy' : 'sell',
    entry_method:entryMethod,
    entry_price:positiveNumber(candidate.entry_price),
    stop_limit_price:positiveNumber(candidate.stop_limit_price),
    stop_loss_price:positiveNumber(candidate.stop_loss_price),
    take_profit_1_price:positiveNumber(candidate.take_profit_1_price),
    take_profit_2_price:positiveNumber(candidate.take_profit_2_price),
    take_profit_3_price:positiveNumber(candidate.take_profit_3_price),
  }
}

function experienceUsage(signal) {
  const usage = signal?.experience_usage && typeof signal.experience_usage === 'object' ? signal.experience_usage : {}
  const ids = value => [...new Set((Array.isArray(value) ? value : []).map(Number)
    .filter(id => Number.isInteger(id) && id > 0))].slice(0, 10)
  const consideredRefs = normalizeExperienceRefs(usage.considered_refs).slice(0, 10)
  const attribution = normalizeExperienceAttribution({
    availableIds:ids(usage.considered_ids),
    availableRefs:consideredRefs,
    usedIds:usage.used_ids,
    usedRefs:usage.used_refs,
    rejectedIds:usage.rejected_ids,
    rejectedRefs:usage.rejected_refs,
    influence:usage.influence,
  })
  const result = {
    source:usage.source === 'platform' || usage.source === 'personal' ? usage.source : null,
    considered_ids:attribution.considered_ids.slice(0, 10),
    used_ids:attribution.used_ids,
    rejected_ids:attribution.rejected_ids,
    influence:cleanText(usage.influence, 400),
  }
  if (attribution.considered_refs.length) {
    result.considered_refs = attribution.considered_refs
    result.used_refs = attribution.used_refs
    result.rejected_refs = attribution.rejected_refs
  }
  return result
}

function parseJson(value) {
  if (!value) return null
  if (typeof value === 'object') return value
  try { return JSON.parse(value) } catch { return null }
}

function stopLossDiagnostics(signal = {}) {
  const market = parseJson(signal.market_data) || parseJson(signal.market_data_json) || {}
  const entryMethod = String(signal.entry_method || 'market').toLowerCase()
  const entry = Number(entryMethod === 'market'
    ? market.latest_price
    : entryMethod === 'stop_limit'
      ? (signal.stop_limit_price || signal.limit_price)
      : signal.limit_price)
  const stopLoss = Number(signal.stop_loss_price)
  if (!(entry > 0) || !(stopLoss > 0)) return null
  const distance = Math.abs(entry - stopLoss)
  if (!(distance > 0)) return null
  const atr = Number(market.atr_anchor)
  return {
    entry_price:entry,
    stop_loss_price:stopLoss,
    distance,
    atr_anchor:atr > 0 ? atr : null,
    distance_atr:atr > 0 ? Math.round(distance / atr * 1000) / 1000 : null,
  }
}

function signalExperienceUsage(signal = {}) {
  const decision = parseJson(signal.decision) || {}
  const stored = parseJson(signal.decision_json) || {}
  const usage = signal.experience_usage || decision.experience_usage || stored.experience_usage
  return usage && typeof usage === 'object' ? usage : {}
}

function positionManagementDecision(signal = {}) {
  const value = signal?._position_management || signal?.position_management
  if (!value || Array.isArray(value) || typeof value !== 'object') return null
  const evaluations = key => (Array.isArray(value[key]) ? value[key] : []).map(item => ({
    management_group_id:cleanText(item?.management_group_id, 80),
    ...(key === 'pending_evaluations' ? {
      cancel_reason_code:item?.cancel_reason_code == null ? null : cleanText(item.cancel_reason_code, 40),
    } : {}),
    ...(key === 'position_evaluations' ? {
      thesis_id:cleanText(item?.thesis_id, 80),
      exit_reason_code:item?.exit_reason_code == null ? null : cleanText(item.exit_reason_code, 40),
      // Kept only so archived v1.2 signals remain readable. v1.3 never uses
      // the original condition identifier as an execution gate.
      matched_condition_id:item?.matched_condition_id == null ? null : cleanText(item.matched_condition_id, 80),
      reversal_candidate:Boolean(item?.reversal_candidate),
    } : {}),
    action:cleanText(item?.action, 16),
    reason:cleanText(item?.reason, 1000),
    evidence_refs:cleanList(item?.evidence_refs, 20, 160),
  })).filter(item => item.management_group_id && item.action)
  return {
    contract_version:cleanText(value.contract_version, 40),
    as_of:value.as_of && typeof value.as_of === 'object' ? {
      decision_timeframe:cleanText(value.as_of.decision_timeframe, 16),
      closed_bar_time_utc_ms:Number(value.as_of.closed_bar_time_utc_ms) || null,
      market_snapshot_hash:cleanText(value.as_of.market_snapshot_hash, 80),
    } : null,
    pending_evaluations:evaluations('pending_evaluations'),
    position_evaluations:evaluations('position_evaluations'),
    validation:value.validation && typeof value.validation === 'object' ? value.validation : null,
  }
}

export function restrictSignalExperienceUsage(signal = {}, { requesterUserId = null, requesterRole = 'user' } = {}) {
  const usage = signalExperienceUsage(signal)
  const source = String(usage.source || '').toLowerCase()
  const canViewPlatform = source === 'platform' && requesterRole === 'admin'
  const canViewPersonal = source === 'personal' && requesterRole !== 'admin'
    && Number(requesterUserId) > 0 && Number(signal.user_id) === Number(requesterUserId)
  const hasUsageDetails = ['considered_ids', 'used_ids', 'rejected_ids', 'considered_refs', 'used_refs', 'rejected_refs']
    .some(key => Array.isArray(usage[key]) && usage[key].length)
    || Boolean(String(usage.influence || '').trim())
  if (canViewPlatform || canViewPersonal || (!source && !hasUsageDetails)) return signal

  const sanitized = { ...signal }
  delete sanitized.experience_usage
  if (sanitized.decision && typeof sanitized.decision === 'object') {
    sanitized.decision = { ...sanitized.decision }
    delete sanitized.decision.experience_usage
  }
  const stored = parseJson(sanitized.decision_json)
  if (stored) {
    delete stored.experience_usage
    sanitized.decision_json = typeof sanitized.decision_json === 'string' ? JSON.stringify(stored) : stored
  }
  return sanitized
}

function executionDescription(execution, fallback) {
  const ruleSets = [execution?.details?.rules, execution?.risk?.rule_results, execution?.rule_results]
  const rejectedRule = ruleSets.find(Array.isArray)?.find(rule => rule?.outcome === 'reject') || null
  const raw = cleanText(rejectedRule?.code || execution?.reject_code || execution?.message || execution?.reason || execution?.error, 240)
  if (!raw) return fallback
  if (rejectedRule || /^(?:R\d|PX\.)[A-Z0-9._-]+$/i.test(raw)) {
    return formatRiskReason(raw, rejectedRule?.details || execution?.details || {})
  }
  const localized = auditValueLabel(raw)
  if (localized !== raw) return formatRiskReason(raw, execution?.details || {})
  if (/^(?:R\d|PX\.)[A-Z0-9._-]+$/i.test(raw)) return '风控条件未满足'
  if (/[A-Za-z]/.test(raw) && !/[\u4e00-\u9fff]/.test(raw)) return '系统执行条件未满足，详细信息已记录'
  return raw
}

export function normalizeDecisionFields(signal = {}) {
  const direction = String(signal.signal_type || 'hold').toLowerCase()
  const isHold = direction === 'hold' || String(signal.entry_method || '') === 'observe'
  const executionValidUntilUtcMsc = Number(signal.execution_valid_until_utc_msc)
  const summaryFallback = isHold
    ? '当前条件不足，建议继续观望。'
    : `${direction.startsWith('buy') ? '偏多' : '偏空'}机会成立，等待风控复核后执行。`
  return {
    schema_version: SIGNAL_SCHEMA_VERSION,
    decision_summary: cleanText(signal.decision_summary, 200) || summaryFallback,
    trigger_condition: cleanText(signal.trigger_condition, 240),
    invalidation_condition: cleanText(signal.invalidation_condition, 240),
    key_reasons: cleanList(signal.key_reasons),
    risk_factors: cleanList(signal.risk_factors),
    position_size_tier:String(signal.position_size_tier || (isHold ? 'observe' : '')).toLowerCase(),
    position_size_factor:Number(signal.position_size_factor || 0),
    position_size_reason:cleanText(signal.position_size_reason, 240),
    position_action:String(signal.position_action || (isHold ? 'observe' : '')).toLowerCase(),
    pending_action:String(signal.pending_action || 'none').toLowerCase(),
    pending_action_reason:cleanText(signal.pending_action_reason, 320),
    management_direction:String(signal.management_direction || 'none').toLowerCase(),
    execution_valid_until_utc_msc:Number.isFinite(executionValidUntilUtcMsc) && executionValidUntilUtcMsc > 0
      ? Math.trunc(executionValidUntilUtcMsc) : null,
    candidate_entry:candidateEntry(signal),
    stop_loss_diagnostics:stopLossDiagnostics(signal),
    position_management:positionManagementDecision(signal),
    experience_usage:experienceUsage(signal),
    ...directionScores(signal),
  }
}

export function buildExecutionAdvice(signal = {}, executionResult = null) {
  const direction = String(signal.signal_type || 'hold').toLowerCase()
  const entryMethod = String(signal.entry_method || (direction === 'hold' ? 'observe' : 'market')).toLowerCase()
  const parsedExecution = parseJson(executionResult ?? signal.execution_result)
  const persistedStatus = String(signal.execution_status || '').toLowerCase()
  const terminalStatus = ['rejected', 'failed', 'skipped', 'uncertain'].includes(persistedStatus) ? persistedStatus : ''
  const execution = parsedExecution ? { ...parsedExecution, status: parsedExecution.status || terminalStatus } : (terminalStatus ? { status:terminalStatus } : null)
  const executed = Number(signal.is_executed) === 1 || signal.is_executed === true || execution?.status === 'success'
  const pending = Boolean(signal.pending_ticket) || signal.pending_state === 'pending'
  const stale = Boolean(signal.is_stale)
  const storedDecision = parseJson(signal.decision_json) || {}
  const pendingActionReason = cleanText(
    execution?.details?.pending_action_reason || signal.pending_action_reason || storedDecision.pending_action_reason,
    320
  )

  if (execution?.status === 'success' && execution?.reason === 'pending_cancelled') return {
    state:'cancelled', title:'旧挂单已取消',
    description:pendingActionReason
      ? `撤单依据：${pendingActionReason}`
      : '策略判断原挂单逻辑已经失效，系统已取消当前策略对应的挂单。',
    executable:false,
  }

  if (execution?.reason === 'market_snapshot_expired') return {
    state:'expired', title:'行情快照已过期',
    description:'本次推理结果已保留，但生成时使用的行情快照已经过期，因此不会发送任何交易指令。',
    executable:false,
  }

  if (executed || pending) return {
    state: pending ? 'pending' : 'executed',
    title: pending ? '挂单已提交' : '订单已执行',
    description: executionDescription(execution, pending ? '等待市场触发，系统会继续跟踪状态。' : '执行结果已记录，可前往交易或审计页面查看。'),
    executable: false,
  }
  const positionAction = String(signal.position_action || storedDecision.position_action || '').toLowerCase()
  if (positionAction === 'hold_no_add') return {
    state:'observe', title:'继续持有，暂不加仓',
    description:'当前已有同向持仓，候选入场价仅供观察，不会进入下单流程。',
    executable:false,
  }
  if (execution && execution.status && execution.status !== 'success') return {
    state: execution.status === 'rejected' ? 'rejected' : execution.status === 'skipped' ? 'skipped' : 'failed',
    title: execution.classification === 'broker_rejection'
      ? 'MT5 拒绝订单'
      : execution.status === 'rejected' ? '风控未放行' : execution.status === 'skipped' ? '本次未执行' : '执行未完成',
    description: executionDescription(execution, '请查看风控中心中的具体决策原因。'),
    executable: false,
  }
  if (direction !== 'hold' && entryMethod !== 'observe' && !positionAction) return {
    state:'unavailable', title:'执行信息不完整',
    description:'该记录缺少当前版本要求的仓位处理结论，仅保留用于历史查看，不能执行。',
    executable:false,
  }
  if (stale) return { state: 'expired', title: '信号已过期', description: '请重新推理，过期信号不会发送到交易端。', executable: false }
  if (direction === 'hold' || entryMethod === 'observe') return { state: 'observe', title: '暂不执行', description: '当前建议为观望，等待触发条件或市场结构改善。', executable: false }
  return {
    state: 'review',
    title: entryMethod === 'market' ? '建议复核后执行' : '建议复核后挂单',
    description: '点击复核后，系统会获取最新报价与账户快照，并由风控计算最终手数。',
    executable: true,
  }
}

export function attachSignalPresentation(signal = {}) {
  const stored = parseJson(signal.decision_json) || {}
  const positionAction = String(signal.position_action || stored.position_action || '').toLowerCase()
  const signalType = String(signal.signal_type || '').toLowerCase()
  const noAddTrade = positionAction === 'hold_no_add' && (signalType.startsWith('buy') || signalType.startsWith('sell'))
  const legacyCandidate = noAddTrade ? candidateEntry({ candidate_entry:{
    signal_type:signalType,
    entry_method:String(signal.entry_method || '').toLowerCase(),
    entry_price:signal.entry_method === 'market' ? signal.market_data?.latest_price : signal.limit_price,
    stop_limit_price:signal.stop_limit_price,
    stop_loss_price:signal.stop_loss_price,
    take_profit_1_price:signal.take_profit_1_price,
    take_profit_2_price:signal.take_profit_2_price,
    take_profit_3_price:signal.take_profit_3_price,
  } }) : null
  const presentationSignal = noAddTrade ? {
    ...signal,
    signal_type:'hold', entry_method:'observe', recommended_volume:0,
    position_size_tier:'observe', position_size_factor:0,
    decision_summary:'当前已有同向持仓，策略建议继续持有，暂不加仓。',
    candidate_entry:stored.candidate_entry || signal.candidate_entry || legacyCandidate,
    limit_price:null, stop_limit_price:null, stop_loss_price:null,
    take_profit_1_price:null, take_profit_2_price:null, take_profit_3_price:null,
    recommended_take_profit_tier:null, pending_valid_until:null,
  } : signal
  const decision = normalizeDecisionFields({ ...presentationSignal, ...stored,
    ...(noAddTrade ? {
      decision_summary:'当前已有同向持仓，策略建议继续持有，暂不加仓。',
      candidate_entry:presentationSignal.candidate_entry,
    } : {}) })
  return { ...presentationSignal, ...decision, decision, execution_advice: buildExecutionAdvice(presentationSignal) }
}

export { SIGNAL_SCHEMA_VERSION }
