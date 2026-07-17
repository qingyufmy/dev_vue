import { auditValueLabel } from '../../audit-localization.js'

const SIGNAL_SCHEMA_VERSION = 2

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

function experienceUsage(signal) {
  const usage = signal?.experience_usage && typeof signal.experience_usage === 'object' ? signal.experience_usage : {}
  const ids = value => [...new Set((Array.isArray(value) ? value : []).map(Number)
    .filter(id => Number.isInteger(id) && id > 0))].slice(0, 10)
  const considered = ids(usage.considered_ids)
  const allowed = new Set(considered)
  const used = ids(usage.used_ids).filter(id => allowed.has(id))
  return {
    source:usage.source === 'platform' || usage.source === 'personal' ? usage.source : null,
    considered_ids:considered,
    used_ids:used,
    rejected_ids:ids(usage.rejected_ids).filter(id => allowed.has(id) && !used.includes(id)),
    influence:cleanText(usage.influence, 400),
  }
}

function parseJson(value) {
  if (!value) return null
  if (typeof value === 'object') return value
  try { return JSON.parse(value) } catch { return null }
}

function executionDescription(execution, fallback) {
  const rejectedRule = Array.isArray(execution?.details?.rules)
    ? execution.details.rules.find(rule => rule?.outcome === 'reject')
    : null
  const raw = cleanText(rejectedRule?.code || execution?.message || execution?.reason || execution?.error, 240)
  if (!raw) return fallback
  const localized = auditValueLabel(raw)
  if (localized !== raw) return localized
  if (/^(?:R\d|PX\.)[A-Z0-9._-]+$/i.test(raw)) return '风控条件未满足'
  return raw
}

export function normalizeDecisionFields(signal = {}) {
  const direction = String(signal.signal_type || 'hold').toLowerCase()
  const isHold = direction === 'hold' || String(signal.entry_method || '') === 'observe'
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
    experience_usage:experienceUsage(signal),
    ...directionScores(signal),
  }
}

export function buildExecutionAdvice(signal = {}, executionResult = null) {
  const direction = String(signal.signal_type || 'hold').toLowerCase()
  const entryMethod = String(signal.entry_method || (direction === 'hold' ? 'observe' : 'market')).toLowerCase()
  const execution = parseJson(executionResult ?? signal.execution_result)
  const executed = Number(signal.is_executed) === 1 || signal.is_executed === true || execution?.status === 'success'
  const pending = Boolean(signal.pending_ticket) || signal.pending_state === 'pending'
  const stale = Boolean(signal.is_stale)

  if (executed || pending) return {
    state: pending ? 'pending' : 'executed',
    title: pending ? '挂单已提交' : '订单已执行',
    description: executionDescription(execution, pending ? '等待市场触发，系统会继续跟踪状态。' : '执行结果已记录，可前往交易或审计页面查看。'),
    executable: false,
  }
  if (execution && execution.status && execution.status !== 'success') return {
    state: execution.status === 'rejected' ? 'rejected' : 'failed',
    title: execution.status === 'rejected' ? '风控未放行' : '执行未完成',
    description: executionDescription(execution, '请查看风控中心中的具体决策原因。'),
    executable: false,
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
  const decision = normalizeDecisionFields({ ...signal, ...stored })
  return { ...signal, ...decision, decision, execution_advice: buildExecutionAdvice(signal) }
}

export { SIGNAL_SCHEMA_VERSION }
