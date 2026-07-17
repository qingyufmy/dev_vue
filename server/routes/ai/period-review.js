import crypto from 'crypto'
import { beijingNow, queryAll, queryOne, queryRun, withTransaction } from '../../db.js'
import { sha256 } from './inference-snapshots.js'
import { ensureReviewCaseForOutcome } from './review-workflow.js'
import { resolveAiTaskModel } from './model-profiles.js'
import { requestJsonObject } from './llm.js'
import { MODEL_PROVIDER_DEFAULTS, modelProviderProtocol } from './model-providers.js'

const DAY_MS = 86400000
const DEFAULT_MT5_OFFSET_MINUTES = 180
const DAILY_GRACE_MINUTES = 30
const MONTHLY_GRACE_MINUTES = 120
let periodReviewTimer = null
let periodReviewCycleRunning = false
const parse = (value, fallback = null) => { try { return value == null ? fallback : JSON.parse(value) } catch { return fallback } }
const safeError = error => String(error?.message || error || 'period_review_failed').replace(/Bearer\s+\S+/gi, 'Bearer [redacted]').slice(0, 128)

function afterSeconds(seconds) {
  const date = new Date(Date.now() + (8 * 3600 + seconds) * 1000)
  return date.toISOString().replace('T', ' ').slice(0, 19)
}

export function reviewPeriodBounds(periodType, periodKey, offsetMinutes = DEFAULT_MT5_OFFSET_MINUTES) {
  const offsetMs = Number(offsetMinutes) * 60000
  if (periodType === 'daily') {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(periodKey))) throw new Error('invalid_daily_period_key')
    const start = Date.parse(`${periodKey}T00:00:00Z`) - offsetMs
    if (!Number.isFinite(start)) throw new Error('invalid_daily_period_key')
    return { startUtcMs: start, endUtcMs: start + DAY_MS, offsetMinutes: Number(offsetMinutes) }
  }
  if (periodType === 'monthly') {
    if (!/^\d{4}-\d{2}$/.test(String(periodKey))) throw new Error('invalid_monthly_period_key')
    const [year, month] = String(periodKey).split('-').map(Number)
    const start = Date.UTC(year, month - 1, 1) - offsetMs
    const end = Date.UTC(year, month, 1) - offsetMs
    return { startUtcMs: start, endUtcMs: end, offsetMinutes: Number(offsetMinutes) }
  }
  throw new Error('invalid_review_period_type')
}

export function reviewPeriodKey(utcMs, periodType, offsetMinutes = DEFAULT_MT5_OFFSET_MINUTES) {
  const shifted = new Date(Number(utcMs) + Number(offsetMinutes) * 60000)
  if (!Number.isFinite(shifted.getTime())) throw new Error('invalid_review_period_time')
  const day = shifted.toISOString().slice(0, 10)
  if (periodType === 'daily') return day
  if (periodType === 'monthly') return day.slice(0, 7)
  throw new Error('invalid_review_period_type')
}

function fallbackBeijingUtcMs(value) {
  const parsed = Date.parse(String(value || '').replace(' ', 'T') + '+08:00')
  return Number.isFinite(parsed) ? parsed : null
}

export function outcomeCloseUtcMs(row, offsetMinutes = DEFAULT_MT5_OFFSET_MINUTES) {
  const raw = parse(row?.last_deal_raw_json, {})
  const direct = Number(raw?.time_utc_msc)
  if (Number.isFinite(direct) && direct > 0) return direct
  const broker = Number(raw?.time_msc)
  if (Number.isFinite(broker) && broker > 0) return broker - Number(offsetMinutes) * 60000
  return fallbackBeijingUtcMs(row?.fully_closed_at || row?.review_eligible_at)
}

export function periodReviewEligibility(row) {
  const scope = String(row?.strategy_scope || '').toLowerCase()
  const role = String(row?.user_role || '').toLowerCase()
  if (scope === 'private' && role !== 'admin') return { eligible: true }
  if (scope === 'platform' && role === 'admin') return { eligible: true }
  return { eligible: false, reason: scope === 'platform' ? 'platform_strategy_user_review_disabled' : role === 'admin' ? 'admin_private_strategy_review_disabled' : 'review_strategy_scope_missing' }
}

export function groupDailyReviewOutcomes(rows, { offsetMinutes = DEFAULT_MT5_OFFSET_MINUTES, asOfUtcMs = Date.now() } = {}) {
  const groups = new Map()
  for (const row of rows || []) {
    if (!periodReviewEligibility(row).eligible) continue
    const closeUtcMs = outcomeCloseUtcMs(row, offsetMinutes)
    if (!Number.isFinite(closeUtcMs)) continue
    const periodKey = reviewPeriodKey(closeUtcMs, 'daily', offsetMinutes)
    const bounds = reviewPeriodBounds('daily', periodKey, offsetMinutes)
    if (Number(asOfUtcMs) < bounds.endUtcMs + DAILY_GRACE_MINUTES * 60000) continue
    const key = [row.user_id, row.trading_account_id, row.strategy_id, Number(row.strategy_version || 1), periodKey].join(':')
    if (!groups.has(key)) groups.set(key, { periodType: 'daily', periodKey, ...bounds, userId: Number(row.user_id), tradingAccountId: Number(row.trading_account_id), strategyId: Number(row.strategy_id), strategyVersion: Number(row.strategy_version || 1), strategyScope: row.strategy_scope, outcomes: [] })
    groups.get(key).outcomes.push({ ...row, close_utc_msc: closeUtcMs })
  }
  return [...groups.values()].sort((a, b) => a.periodKey.localeCompare(b.periodKey) || a.strategyId - b.strategyId)
}

export function dailyReviewStatistics(outcomes) {
  const values = outcomes || []
  const netProfit = values.reduce((sum, row) => sum + Number(row.net_profit || 0), 0)
  const wins = values.filter(row => Number(row.net_profit || 0) > 0).length
  const losses = values.filter(row => Number(row.net_profit || 0) < 0).length
  const grossWin = values.reduce((sum, row) => sum + Math.max(0, Number(row.net_profit || 0)), 0)
  const grossLoss = Math.abs(values.reduce((sum, row) => sum + Math.min(0, Number(row.net_profit || 0)), 0))
  return {
    trade_count: values.length,
    wins,
    losses,
    breakeven: values.length - wins - losses,
    win_rate: values.length ? wins / values.length : 0,
    net_profit: netProfit,
    gross_profit: grossWin,
    gross_loss: grossLoss,
    profit_factor: grossLoss > 0 ? grossWin / grossLoss : null,
    external_intervention_count: values.filter(row => Boolean(row.external_intervention)).length,
  }
}

export function groupMonthlyReviewCases(rows, { offsetMinutes = DEFAULT_MT5_OFFSET_MINUTES, asOfUtcMs = Date.now() } = {}) {
  const groups = new Map()
  for (const row of rows || []) {
    if (String(row?.period_type) !== 'daily' || !row?.current_version_id) continue
    const periodKey = String(row.period_key || '').slice(0, 7)
    if (!/^\d{4}-\d{2}$/.test(periodKey)) continue
    const bounds = reviewPeriodBounds('monthly', periodKey, offsetMinutes)
    if (Number(asOfUtcMs) < bounds.endUtcMs + MONTHLY_GRACE_MINUTES * 60000) continue
    const key = [row.user_id, row.strategy_id, Number(row.strategy_version || 1), periodKey].join(':')
    if (!groups.has(key)) groups.set(key, { periodType: 'monthly', periodKey, ...bounds,
      userId: Number(row.user_id), tradingAccountId: 0, strategyId: Number(row.strategy_id),
      strategyVersion: Number(row.strategy_version || 1), strategyScope: row.strategy_scope, dailyCases: [] })
    groups.get(key).dailyCases.push(row)
  }
  return [...groups.values()].map(group => ({ ...group,
    dailyCases: group.dailyCases.sort((a, b) => String(a.period_key).localeCompare(String(b.period_key)) || Number(a.id) - Number(b.id)) }))
    .sort((a, b) => a.periodKey.localeCompare(b.periodKey) || a.strategyId - b.strategyId)
}

export function monthlyReviewStatistics(dailyCases) {
  const statistics = (dailyCases || []).map(row => parse(row?.evidence_json, {})?.statistics || {})
  const sum = key => statistics.reduce((total, item) => total + Number(item[key] || 0), 0)
  const tradeCount = sum('trade_count')
  const grossLoss = sum('gross_loss')
  const netByDay = statistics.map(item => Number(item.net_profit || 0))
  return {
    trading_days: statistics.length,
    trade_count: tradeCount,
    wins: sum('wins'),
    losses: sum('losses'),
    breakeven: sum('breakeven'),
    win_rate: tradeCount ? sum('wins') / tradeCount : 0,
    net_profit: sum('net_profit'),
    gross_profit: sum('gross_profit'),
    gross_loss: grossLoss,
    profit_factor: grossLoss > 0 ? sum('gross_profit') / grossLoss : null,
    profitable_days: netByDay.filter(value => value > 0).length,
    losing_days: netByDay.filter(value => value < 0).length,
    external_intervention_count: sum('external_intervention_count'),
  }
}

const DAILY_DECISIONS = new Set(['good', 'mixed', 'poor', 'insufficient_evidence'])
const CHAN_SOURCES = new Set(['data', 'calculation', 'confirmation_lag', 'ai_interpretation', 'strategy_rule', 'none', 'unknown'])

export function validateDailyReviewContent(input, outcomeIds = []) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('invalid_daily_review_content')
  const allowed = new Set(['period_summary', 'decision_quality', 'trade_assessments', 'repeated_issues', 'strengths', 'daily_lessons', 'risk_observations', 'chan_diagnoses', 'confidence'])
  if (Object.keys(input).some(key => !allowed.has(key))) throw new Error('unknown_daily_review_field')
  if (!String(input.period_summary || '').trim()) throw new Error('daily_review_summary_missing')
  if (!DAILY_DECISIONS.has(input.decision_quality)) throw new Error('invalid_daily_review_decision')
  for (const key of ['trade_assessments', 'repeated_issues', 'strengths', 'daily_lessons', 'risk_observations', 'chan_diagnoses']) if (!Array.isArray(input[key])) throw new Error(`invalid_daily_review_${key}`)
  if (!Number.isFinite(Number(input.confidence)) || Number(input.confidence) < 0 || Number(input.confidence) > 1) throw new Error('invalid_daily_review_confidence')
  const known = new Set(outcomeIds.map(Number))
  const assessments = input.trade_assessments.map(item => {
    const outcomeId = Number(item?.outcome_id)
    if (!known.has(outcomeId) || !DAILY_DECISIONS.has(item?.decision_quality) || !String(item?.summary || '').trim()) throw new Error('invalid_daily_trade_assessment')
    return { outcome_id: outcomeId, decision_quality: item.decision_quality, summary: String(item.summary).trim(), issue_codes: Array.isArray(item.issue_codes) ? item.issue_codes.map(String) : [] }
  })
  if (new Set(assessments.map(item => item.outcome_id)).size !== known.size) throw new Error('daily_review_trade_coverage_incomplete')
  const chanDiagnoses = input.chan_diagnoses.map(item => {
    const outcomeId = Number(item?.outcome_id)
    if (!known.has(outcomeId) || !CHAN_SOURCES.has(item?.issue_source)) throw new Error('invalid_daily_chan_diagnosis')
    return { outcome_id: outcomeId, status: String(item.status || 'insufficient_evidence'), issue_source: item.issue_source,
      impact_on_decision: String(item.impact_on_decision || 'unknown'), explanation: String(item.explanation || '').trim(), confidence: Math.min(1, Math.max(0, Number(item.confidence || 0))) }
  })
  if (new Set(chanDiagnoses.map(item => item.outcome_id)).size !== known.size) throw new Error('daily_review_chan_coverage_incomplete')
  return {
    period_summary: String(input.period_summary).trim(), decision_quality: input.decision_quality, trade_assessments: assessments,
    repeated_issues: input.repeated_issues.map(String), strengths: input.strengths.map(String), daily_lessons: input.daily_lessons.map(String),
    risk_observations: input.risk_observations.map(String), chan_diagnoses: chanDiagnoses, confidence: Number(input.confidence),
  }
}

export function validateMonthlyReviewContent(input, dailyCaseIds = [], approvedDailyCaseIds = dailyCaseIds) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('invalid_monthly_review_content')
  const allowed = new Set(['period_summary', 'decision_quality', 'daily_assessments', 'recurring_patterns', 'strengths',
    'risk_observations', 'chan_issue_summary', 'next_month_actions', 'memory_candidates', 'confidence'])
  if (Object.keys(input).some(key => !allowed.has(key))) throw new Error('unknown_monthly_review_field')
  if (!String(input.period_summary || '').trim()) throw new Error('monthly_review_summary_missing')
  if (!DAILY_DECISIONS.has(input.decision_quality)) throw new Error('invalid_monthly_review_decision')
  for (const key of ['daily_assessments', 'recurring_patterns', 'strengths', 'risk_observations', 'chan_issue_summary', 'next_month_actions', 'memory_candidates']) {
    if (!Array.isArray(input[key])) throw new Error(`invalid_monthly_review_${key}`)
  }
  if (!Number.isFinite(Number(input.confidence)) || Number(input.confidence) < 0 || Number(input.confidence) > 1) throw new Error('invalid_monthly_review_confidence')
  const known = new Set(dailyCaseIds.map(Number))
  const approved = new Set(approvedDailyCaseIds.map(Number))
  const assessments = input.daily_assessments.map(item => {
    const periodCaseId = Number(item?.period_case_id)
    if (!known.has(periodCaseId) || !DAILY_DECISIONS.has(item?.decision_quality) || !String(item?.summary || '').trim()) throw new Error('invalid_monthly_daily_assessment')
    return { period_case_id: periodCaseId, decision_quality: item.decision_quality, summary: String(item.summary).trim(), issue_codes: Array.isArray(item.issue_codes) ? item.issue_codes.map(String) : [] }
  })
  if (new Set(assessments.map(item => item.period_case_id)).size !== known.size) throw new Error('monthly_review_daily_coverage_incomplete')
  const memoryCandidates = input.memory_candidates.map(item => {
    const support = Array.isArray(item?.supporting_period_case_ids) ? [...new Set(item.supporting_period_case_ids.map(Number))] : []
    if (!String(item?.lesson || '').trim() || support.length < 2 || support.some(id => !known.has(id) || !approved.has(id))) throw new Error('invalid_monthly_memory_candidate')
    return { lesson: String(item.lesson).trim(), anti_pattern: String(item.anti_pattern || '').trim(),
      supporting_period_case_ids: support, confidence: Math.min(1, Math.max(0, Number(item.confidence || 0))) }
  })
  return {
    period_summary: String(input.period_summary).trim(), decision_quality: input.decision_quality, daily_assessments: assessments,
    recurring_patterns: input.recurring_patterns.map(String), strengths: input.strengths.map(String),
    risk_observations: input.risk_observations.map(String), chan_issue_summary: input.chan_issue_summary.map(String),
    next_month_actions: input.next_month_actions.map(String), memory_candidates: memoryCandidates, confidence: Number(input.confidence),
  }
}

async function latestMt5Clock() {
  const row = await queryOne(`SELECT mds.timezone_offset_minutes, mds.clock_status, mds.last_calibrated_at
    FROM market_data_sources mds JOIN users u ON u.id = mds.bridge_user_id
    WHERE u.role = 'admin' AND mds.timezone_offset_minutes IS NOT NULL
    ORDER BY (mds.clock_status = 'calibrated') DESC, mds.last_calibrated_at DESC, mds.id DESC LIMIT 1`)
  return row ? { offsetMinutes: Number(row.timezone_offset_minutes), status: row.clock_status, calibratedAt: row.last_calibrated_at } : { offsetMinutes: DEFAULT_MT5_OFFSET_MINUTES, status: 'fallback', calibratedAt: null }
}

async function eligibleOutcomeRows(limit) {
  return queryAll(`SELECT so.*, snap.strategy_id, snap.strategy_version, snap.strategy_scope,
      u.role AS user_role,
      (SELECT sod.raw_json FROM signal_outcome_deals sod WHERE sod.outcome_id = so.id ORDER BY sod.deal_time DESC, sod.id DESC LIMIT 1) AS last_deal_raw_json
    FROM signal_outcomes so
    JOIN users u ON u.id = so.user_id
    JOIN inference_snapshots snap ON snap.id = (SELECT MAX(s2.id) FROM inference_snapshots s2 WHERE s2.signal_id = so.signal_id)
    WHERE so.status = 'closed' AND so.review_eligible_at IS NOT NULL
      AND ((snap.strategy_scope = 'private' AND u.role <> 'admin') OR (snap.strategy_scope = 'platform' AND u.role = 'admin'))
    ORDER BY so.review_eligible_at DESC LIMIT ?`, [Math.min(2000, Math.max(1, Number(limit || 500)))])
}

async function prepareTradeEvidence(outcome) {
  const reviewCase = await ensureReviewCaseForOutcome(outcome.id, { queueGeneration:false })
  if (reviewCase?.skipped) return { status: 'ineligible', reason: reviewCase.reason, reviewCase: null, evidence: null }
  const loaded = await queryOne('SELECT * FROM trade_review_cases WHERE id = ?', [reviewCase.id])
  return { status: loaded?.evidence_status || 'incomplete', reason: loaded?.evidence_reason || null, reviewCase: loaded, evidence: parse(loaded?.evidence_json, null) }
}

async function upsertDailyGroup(group, clock) {
  const existingCase = await queryOne(`SELECT * FROM period_review_cases WHERE period_type = 'daily' AND period_key = ?
    AND user_id = ? AND trading_account_id = ? AND strategy_id = ? AND strategy_version = ?`,
  [group.periodKey, group.userId, group.tradingAccountId, group.strategyId, group.strategyVersion])
  if (existingCase) {
    const existingJob = await queryOne(`SELECT id, status FROM period_review_jobs
      WHERE period_case_id = ? AND job_type = 'daily_review' AND job_slot = 0 LIMIT 1`, [existingCase.id])
    if (existingCase.current_version_id || existingJob) return { id: Number(existingCase.id), periodKey: group.periodKey,
      complete: existingCase.evidence_status === 'complete', sourceCount: Number(existingCase.source_count || 0), evidenceHash: existingCase.evidence_hash }
  }
  const prepared = []
  for (const outcome of group.outcomes) prepared.push({ outcome, ...(await prepareTradeEvidence(outcome)) })
  const complete = prepared.every(item => item.status === 'complete' && item.evidence)
  const reasons = [...new Set(prepared.flatMap(item => String(item.reason || '').split(',')).filter(Boolean))]
  const sources = prepared.map(item => ({ outcome_id: Number(item.outcome.id), trade_review_case_id: Number(item.reviewCase?.id || 0) || null, evidence_hash: item.reviewCase?.evidence_hash || null, evidence: item.evidence }))
  const sourceIds = sources.map(item => item.outcome_id).sort((a, b) => a - b)
  const sourceHash = sha256(JSON.stringify(sources.map(item => [item.outcome_id, item.evidence_hash])))
  const evidence = {
    schema_version: 1,
    period: { type: 'daily', key: group.periodKey, timezone_offset_minutes: group.offsetMinutes, clock_status: clock.status, start_utc_msc: group.startUtcMs, end_utc_msc: group.endUtcMs },
    strategy: { id: group.strategyId, version: group.strategyVersion, scope: group.strategyScope },
    statistics: dailyReviewStatistics(group.outcomes),
    sources,
  }
  const evidenceHash = sha256(JSON.stringify(evidence))
  const now = beijingNow()
  await queryRun(`INSERT INTO period_review_cases
    (period_type, period_key, user_id, trading_account_id, strategy_id, strategy_version, strategy_scope,
     timezone_offset_minutes, period_start_utc_msc, period_end_utc_msc, status, evidence_status,
     evidence_reason, evidence_json, evidence_hash, source_count, created_at, updated_at)
    VALUES ('daily', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON DUPLICATE KEY UPDATE evidence_status = IF(current_version_id IS NOT NULL, evidence_status, VALUES(evidence_status)),
      evidence_reason = IF(current_version_id IS NOT NULL, evidence_reason, VALUES(evidence_reason)),
      evidence_json = IF(current_version_id IS NOT NULL, evidence_json, VALUES(evidence_json)),
      evidence_hash = IF(current_version_id IS NOT NULL, evidence_hash, VALUES(evidence_hash)),
      source_count = IF(current_version_id IS NOT NULL, source_count, VALUES(source_count)),
      status = IF(status IN ('generating','approved','edited','needs_revision','deferred'), status, VALUES(status)), updated_at = VALUES(updated_at)`, [
    group.periodKey, group.userId, group.tradingAccountId, group.strategyId, group.strategyVersion, group.strategyScope,
    group.offsetMinutes, group.startUtcMs, group.endUtcMs, complete ? 'ready' : 'incomplete', complete ? 'complete' : 'incomplete',
    reasons.join(',').slice(0, 255) || null, JSON.stringify(evidence), evidenceHash, sourceIds.length, now, now,
  ])
  const periodCase = await queryOne(`SELECT * FROM period_review_cases WHERE period_type = 'daily' AND period_key = ?
    AND user_id = ? AND trading_account_id = ? AND strategy_id = ? AND strategy_version = ?`, [group.periodKey, group.userId, group.tradingAccountId, group.strategyId, group.strategyVersion])
  for (const source of sources) await queryRun(`INSERT INTO period_review_sources
    (period_case_id, outcome_id, trade_review_case_id, source_hash, created_at) VALUES (?, ?, ?, ?, ?)
    ON DUPLICATE KEY UPDATE trade_review_case_id = VALUES(trade_review_case_id), source_hash = VALUES(source_hash)`, [periodCase.id, source.outcome_id, source.trade_review_case_id, source.evidence_hash, now])
  if (complete && !periodCase.current_version_id) await queryRun(`INSERT IGNORE INTO period_review_jobs
    (period_case_id, job_type, idempotency_key, status, attempt_count, max_attempts, created_at, updated_at)
    VALUES (?, 'daily_review', ?, 'queued', 0, 3, ?, ?)`, [periodCase.id, `daily:${periodCase.id}:${evidenceHash}`, now, now])
  return { id: Number(periodCase.id), periodKey: group.periodKey, complete, sourceCount: sourceIds.length, evidenceHash }
}

export async function prepareEligibleDailyReviews({ limit = 500, asOfUtcMs = Date.now() } = {}) {
  const [clock, rows] = await Promise.all([latestMt5Clock(), eligibleOutcomeRows(limit)])
  const groups = groupDailyReviewOutcomes(rows, { offsetMinutes: clock.offsetMinutes, asOfUtcMs })
  const result = { scanned: rows.length, groups: groups.length, ready: 0, incomplete: 0, clock }
  for (const group of groups) {
    const prepared = await upsertDailyGroup(group, clock)
    result[prepared.complete ? 'ready' : 'incomplete'] += 1
  }
  return result
}

async function eligibleDailyReviewRows(limit) {
  return queryAll(`SELECT cases.*, versions.content_json AS current_content_json,
      versions.content_hash AS current_content_hash
    FROM period_review_cases cases
    JOIN period_review_versions versions ON versions.id = cases.current_version_id
    WHERE cases.period_type = 'daily' AND cases.evidence_status = 'complete'
      AND cases.status IN ('draft','edited','approved','needs_revision','deferred')
    ORDER BY cases.period_key DESC, cases.id DESC LIMIT ?`, [Math.min(3000, Math.max(1, Number(limit || 1000)))])
}

async function upsertMonthlyGroup(group, clock) {
  const existingCase = await queryOne(`SELECT * FROM period_review_cases WHERE period_type = 'monthly' AND period_key = ?
    AND user_id = ? AND trading_account_id = 0 AND strategy_id = ? AND strategy_version = ?`,
  [group.periodKey, group.userId, group.strategyId, group.strategyVersion])
  if (existingCase) {
    const existingJob = await queryOne(`SELECT id, status FROM period_review_jobs
      WHERE period_case_id = ? AND job_type = 'monthly_review' AND job_slot = 0 LIMIT 1`, [existingCase.id])
    if (existingCase.current_version_id || existingJob) return { id: Number(existingCase.id), periodKey: group.periodKey,
      sourceCount: Number(existingCase.source_count || 0), evidenceHash: existingCase.evidence_hash }
  }
  const sources = group.dailyCases.map(row => ({ period_case_id: Number(row.id), period_key: row.period_key,
    trading_account_id: Number(row.trading_account_id || 0), review_status: row.status,
    evidence_hash: row.evidence_hash, content_hash: row.current_content_hash,
    statistics: parse(row.evidence_json, {})?.statistics || {}, review: parse(row.current_content_json, {}) }))
  const evidence = {
    schema_version: 1,
    period: { type: 'monthly', key: group.periodKey, timezone_offset_minutes: group.offsetMinutes,
      clock_status: clock.status, start_utc_msc: group.startUtcMs, end_utc_msc: group.endUtcMs },
    strategy: { id: group.strategyId, version: group.strategyVersion, scope: group.strategyScope },
    statistics: monthlyReviewStatistics(group.dailyCases),
    source_quality: { approved_days: sources.filter(item => item.review_status === 'approved').length,
      unconfirmed_days: sources.filter(item => item.review_status !== 'approved').length },
    sources,
  }
  const evidenceHash = sha256(JSON.stringify(evidence))
  const now = beijingNow()
  await queryRun(`INSERT INTO period_review_cases
    (period_type, period_key, user_id, trading_account_id, strategy_id, strategy_version, strategy_scope,
     timezone_offset_minutes, period_start_utc_msc, period_end_utc_msc, status, evidence_status,
     evidence_reason, evidence_json, evidence_hash, source_count, created_at, updated_at)
    VALUES ('monthly', ?, ?, 0, ?, ?, ?, ?, ?, ?, 'ready', 'complete', NULL, ?, ?, ?, ?, ?)
    ON DUPLICATE KEY UPDATE evidence_status = VALUES(evidence_status), evidence_reason = VALUES(evidence_reason),
      evidence_json = VALUES(evidence_json), evidence_hash = VALUES(evidence_hash), source_count = VALUES(source_count),
      status = IF(status IN ('approved','edited','needs_revision','deferred'), status, VALUES(status)), updated_at = VALUES(updated_at)`, [
    group.periodKey, group.userId, group.strategyId, group.strategyVersion, group.strategyScope,
    group.offsetMinutes, group.startUtcMs, group.endUtcMs, JSON.stringify(evidence), evidenceHash, sources.length, now, now,
  ])
  const periodCase = await queryOne(`SELECT * FROM period_review_cases WHERE period_type = 'monthly' AND period_key = ?
    AND user_id = ? AND trading_account_id = 0 AND strategy_id = ? AND strategy_version = ?`,
  [group.periodKey, group.userId, group.strategyId, group.strategyVersion])
  if (!periodCase.current_version_id) {
    for (const source of sources) await queryRun(`INSERT INTO period_review_sources
      (period_case_id, outcome_id, trade_review_case_id, source_period_case_id, source_hash, created_at)
      VALUES (?, NULL, NULL, ?, ?, ?) ON DUPLICATE KEY UPDATE source_hash = VALUES(source_hash)`,
    [periodCase.id, source.period_case_id, sha256(`${source.evidence_hash || ''}:${source.content_hash || ''}`), now])
    await queryRun(`INSERT IGNORE INTO period_review_jobs
      (period_case_id, job_type, idempotency_key, status, attempt_count, max_attempts, created_at, updated_at)
      VALUES (?, 'monthly_review', ?, 'queued', 0, 3, ?, ?)`, [periodCase.id, `monthly:${periodCase.id}:${evidenceHash}`, now, now])
  }
  return { id: Number(periodCase.id), periodKey: group.periodKey, sourceCount: sources.length, evidenceHash }
}

export async function prepareEligibleMonthlyReviews({ limit = 1000, asOfUtcMs = Date.now() } = {}) {
  const [clock, rows] = await Promise.all([latestMt5Clock(), eligibleDailyReviewRows(limit)])
  const groups = groupMonthlyReviewCases(rows, { offsetMinutes: clock.offsetMinutes, asOfUtcMs })
  const result = { scanned: rows.length, groups: groups.length, ready: 0, clock }
  for (const group of groups) {
    await upsertMonthlyGroup(group, clock)
    result.ready += 1
  }
  return result
}

function modelEndpoint(model) {
  const provider = model.provider || model.api_provider
  const protocol = modelProviderProtocol(provider)
  const base = String(model.api_base_url || MODEL_PROVIDER_DEFAULTS[provider] || '').replace(/\/+$/, '')
  if (!base) throw new Error('unsupported_daily_review_model_provider')
  return { protocol, url: `${base}/${protocol === 'responses' ? 'responses' : 'chat/completions'}` }
}

async function claimDailyReviewJob() {
  return withTransaction(async run => {
    const [rows] = await run(`SELECT jobs.*, cases.user_id, cases.strategy_id, cases.evidence_json, cases.evidence_hash
      FROM period_review_jobs jobs JOIN period_review_cases cases ON cases.id = jobs.period_case_id
      WHERE jobs.job_type = 'daily_review'
        AND jobs.job_slot = 0
        AND ((jobs.status = 'queued' AND (jobs.next_attempt_at IS NULL OR jobs.next_attempt_at <= ?))
          OR (jobs.status = 'leased' AND jobs.lease_expires_at < ?))
        AND jobs.attempt_count < jobs.max_attempts AND cases.period_type = 'daily' AND cases.evidence_status = 'complete'
      ORDER BY jobs.updated_at, jobs.id LIMIT 1 FOR UPDATE`, [beijingNow(), beijingNow()])
    if (!rows[0]) return null
    const token = crypto.randomUUID()
    await run(`UPDATE period_review_jobs SET status = 'leased', lease_token = ?, lease_expires_at = ?, next_attempt_at = NULL,
      attempt_count = attempt_count + 1, updated_at = ? WHERE id = ?`, [token, afterSeconds(300), beijingNow(), rows[0].id])
    await run(`UPDATE period_review_cases SET status = 'generating', updated_at = ?
      WHERE id = ? AND current_version_id IS NULL`, [beijingNow(), rows[0].period_case_id])
    return { ...rows[0], lease_token: token, attempt_count: Number(rows[0].attempt_count) + 1 }
  })
}

async function generateDailyReview(job, requestModel) {
  const evidence = parse(job.evidence_json, null)
  if (!evidence || !Array.isArray(evidence.sources) || !evidence.sources.length) throw new Error('daily_review_evidence_invalid')
  const resolved = await resolveAiTaskModel({ userId: job.user_id, strategyId: job.strategy_id, usage: 'review' })
  if (!resolved.model) throw new Error(resolved.error || 'daily_review_model_unavailable')
  const endpoint = modelEndpoint(resolved.model)
  const outcomeIds = evidence.sources.map(item => Number(item.outcome_id))
  const shape = { period_summary: 'string', decision_quality: 'good|mixed|poor|insufficient_evidence',
    trade_assessments: outcomeIds.map(outcomeId => ({ outcome_id: outcomeId, decision_quality: 'good|mixed|poor|insufficient_evidence', summary: 'string', issue_codes: ['string'] })),
    repeated_issues: ['string'], strengths: ['string'], daily_lessons: ['string'], risk_observations: ['string'],
    chan_diagnoses: outcomeIds.map(outcomeId => ({ outcome_id: outcomeId, status: 'normal|suspected_issue|confirmed_issue|insufficient_evidence', issue_source: 'data|calculation|confirmation_lag|ai_interpretation|strategy_rule|none|unknown', impact_on_decision: 'none|minor|material|unknown', explanation: 'string', confidence: 0.5 })), confidence: 0.5 }
  const output = await requestModel({ url: endpoint.url, apiKey: resolved.model.api_key_encrypted, provider: resolved.model.provider,
    model: resolved.model.model_name, temperature: Math.min(Number(resolved.model.temperature ?? 0.2), 0.3),
    maxTokens: Number(resolved.model.max_tokens || 3000), thinkingEnabled: resolved.model.thinking_enabled,
    reasoningEffort: resolved.model.reasoning_effort, protocol: endpoint.protocol,
    messages: [
      { role: 'system', content: '你是严格的交易日复盘分析器。所有基础统计以系统提供的数据为准，不得自行重算。必须区分推理时结构、同时间点回放结构和事后最终结构；未来数据只能用于事后解释，不能反过来判定当时决策错误。不得把盈利等同于决策正确，也不得把亏损等同于决策错误。只返回 JSON。' },
      { role: 'user', content: JSON.stringify({ output: shape, evidence }) },
    ],
    usageContext: { userId: job.user_id, profileId: resolved.model_profile_id, credentialSource: resolved.credential_source, usage: 'review', strategyId: job.strategy_id },
  })
  return { content: validateDailyReviewContent(output, outcomeIds), resolved }
}

async function finishDailyReviewSuccess(job, generated) {
  await withTransaction(async run => {
    const [jobs] = await run('SELECT * FROM period_review_jobs WHERE id = ? FOR UPDATE', [job.id])
    if (!jobs[0] || jobs[0].status !== 'leased' || jobs[0].lease_token !== job.lease_token) throw new Error('daily_review_job_lease_lost')
    const [cases] = await run('SELECT * FROM period_review_cases WHERE id = ? FOR UPDATE', [job.period_case_id])
    if (!cases[0]) throw new Error('daily_review_case_missing')
    const now = beijingNow()
    if (!cases[0].current_version_id) {
      const [versions] = await run('SELECT COALESCE(MAX(version_no), 0) AS max_version FROM period_review_versions WHERE period_case_id = ? FOR UPDATE', [job.period_case_id])
      const body = JSON.stringify(generated.content)
      const [insert] = await run(`INSERT INTO period_review_versions
        (period_case_id, version_no, parent_version_id, author_type, author_user_id, content_json, content_hash, change_note, created_at)
        VALUES (?, ?, NULL, 'ai', NULL, ?, ?, 'AI daily review draft', ?)`, [job.period_case_id, Number(versions[0].max_version) + 1, body, sha256(body), now])
      await run(`UPDATE period_review_cases SET status = 'draft', current_version_id = ?, updated_at = ? WHERE id = ?`, [insert.insertId, now, job.period_case_id])
    }
    await run(`UPDATE period_review_jobs SET status = 'succeeded', model_profile_id = ?, credential_source = ?, completed_at = ?,
      lease_token = NULL, lease_expires_at = NULL, updated_at = ? WHERE id = ?`, [generated.resolved.model_profile_id, generated.resolved.credential_source, now, now, job.id])
  })
}

async function finishDailyReviewFailure(job, error) {
  const exhausted = job.attempt_count >= Number(job.max_attempts)
  const retryAt = exhausted ? null : afterSeconds(Math.min(900, 60 * (2 ** Math.max(0, Number(job.attempt_count) - 1))))
  await queryRun(`UPDATE period_review_jobs SET status = ?, last_error_code = ?, lease_token = NULL,
    lease_expires_at = NULL, next_attempt_at = ?, updated_at = ? WHERE id = ? AND lease_token = ?`,
  [exhausted ? 'failed' : 'queued', safeError(error), retryAt, beijingNow(), job.id, job.lease_token])
  await queryRun(`UPDATE period_review_cases SET status = ?, updated_at = ? WHERE id = ? AND current_version_id IS NULL`, [exhausted ? 'failed' : 'ready', beijingNow(), job.period_case_id])
}

export async function runDailyReviewWorkerOnce({ requestModel = requestJsonObject } = {}) {
  const job = await claimDailyReviewJob()
  if (!job) return { claimed: false }
  try {
    const generated = await generateDailyReview(job, requestModel)
    await finishDailyReviewSuccess(job, generated)
    return { claimed: true, status: 'succeeded', periodCaseId: Number(job.period_case_id) }
  } catch (error) {
    await finishDailyReviewFailure(job, error)
    return { claimed: true, status: 'failed', periodCaseId: Number(job.period_case_id), error: safeError(error) }
  }
}

async function claimMonthlyReviewJob() {
  return withTransaction(async run => {
    const [rows] = await run(`SELECT jobs.*, cases.user_id, cases.strategy_id, cases.evidence_json, cases.evidence_hash
      FROM period_review_jobs jobs JOIN period_review_cases cases ON cases.id = jobs.period_case_id
      WHERE jobs.job_type = 'monthly_review'
        AND jobs.job_slot = 0
        AND ((jobs.status = 'queued' AND (jobs.next_attempt_at IS NULL OR jobs.next_attempt_at <= ?))
          OR (jobs.status = 'leased' AND jobs.lease_expires_at < ?))
        AND jobs.attempt_count < jobs.max_attempts AND cases.period_type = 'monthly' AND cases.evidence_status = 'complete'
      ORDER BY jobs.updated_at, jobs.id LIMIT 1 FOR UPDATE`, [beijingNow(), beijingNow()])
    if (!rows[0]) return null
    const token = crypto.randomUUID()
    await run(`UPDATE period_review_jobs SET status = 'leased', lease_token = ?, lease_expires_at = ?, next_attempt_at = NULL,
      attempt_count = attempt_count + 1, updated_at = ? WHERE id = ?`, [token, afterSeconds(420), beijingNow(), rows[0].id])
    await run(`UPDATE period_review_cases SET status = 'generating', updated_at = ?
      WHERE id = ? AND current_version_id IS NULL`, [beijingNow(), rows[0].period_case_id])
    return { ...rows[0], lease_token: token, attempt_count: Number(rows[0].attempt_count) + 1 }
  })
}

async function generateMonthlyReview(job, requestModel) {
  const evidence = parse(job.evidence_json, null)
  if (!evidence || !Array.isArray(evidence.sources) || !evidence.sources.length) throw new Error('monthly_review_evidence_invalid')
  const resolved = await resolveAiTaskModel({ userId: job.user_id, strategyId: job.strategy_id, usage: 'review' })
  if (!resolved.model) throw new Error(resolved.error || 'monthly_review_model_unavailable')
  const endpoint = modelEndpoint(resolved.model)
  const dailyCaseIds = evidence.sources.map(item => Number(item.period_case_id))
  const approvedDailyCaseIds = evidence.sources.filter(item => item.review_status === 'approved').map(item => Number(item.period_case_id))
  const shape = { period_summary: 'string', decision_quality: 'good|mixed|poor|insufficient_evidence',
    daily_assessments: dailyCaseIds.map(id => ({ period_case_id: id, decision_quality: 'good|mixed|poor|insufficient_evidence', summary: 'string', issue_codes: ['string'] })),
    recurring_patterns: ['string'], strengths: ['string'], risk_observations: ['string'], chan_issue_summary: ['string'],
    next_month_actions: ['string'], memory_candidates: approvedDailyCaseIds.length >= 2
      ? [{ lesson: 'string', anti_pattern: 'string', supporting_period_case_ids: approvedDailyCaseIds.slice(0, 2), confidence: 0.5 }] : [], confidence: 0.5 }
  const output = await requestModel({ url: endpoint.url, apiKey: resolved.model.api_key_encrypted, provider: resolved.model.provider,
    model: resolved.model.model_name, temperature: Math.min(Number(resolved.model.temperature ?? 0.2), 0.3),
    maxTokens: Number(resolved.model.max_tokens || 4000), thinkingEnabled: resolved.model.thinking_enabled,
    reasoningEffort: resolved.model.reasoning_effort, protocol: endpoint.protocol,
    messages: [
      { role: 'system', content: '你是严格的交易月度复盘分析器。基础统计以系统数据为准，不得自行重算。只能从日复盘证据中识别跨日重复模式；未确认的日复盘只能作为待核实证据。必须区分缠论数据、结构计算、确认延迟、AI解读和策略规则问题。记忆候选必须至少由两个不同交易日支持，不得创造新规则或提高风险。只返回 JSON。' },
      { role: 'user', content: JSON.stringify({ output: shape, evidence }) },
    ],
    usageContext: { userId: job.user_id, profileId: resolved.model_profile_id, credentialSource: resolved.credential_source, usage: 'review', strategyId: job.strategy_id },
  })
  return { content: validateMonthlyReviewContent(output, dailyCaseIds, approvedDailyCaseIds), resolved }
}

async function finishMonthlyReviewSuccess(job, generated) {
  await withTransaction(async run => {
    const [jobs] = await run('SELECT * FROM period_review_jobs WHERE id = ? FOR UPDATE', [job.id])
    if (!jobs[0] || jobs[0].status !== 'leased' || jobs[0].lease_token !== job.lease_token) throw new Error('monthly_review_job_lease_lost')
    const [cases] = await run('SELECT * FROM period_review_cases WHERE id = ? FOR UPDATE', [job.period_case_id])
    if (!cases[0]) throw new Error('monthly_review_case_missing')
    const now = beijingNow()
    if (!cases[0].current_version_id) {
      const [versions] = await run('SELECT COALESCE(MAX(version_no), 0) AS max_version FROM period_review_versions WHERE period_case_id = ? FOR UPDATE', [job.period_case_id])
      const body = JSON.stringify(generated.content)
      const [insert] = await run(`INSERT INTO period_review_versions
        (period_case_id, version_no, parent_version_id, author_type, author_user_id, content_json, content_hash, change_note, created_at)
        VALUES (?, ?, NULL, 'ai', NULL, ?, ?, 'AI monthly review draft', ?)`,
      [job.period_case_id, Number(versions[0].max_version) + 1, body, sha256(body), now])
      await run(`UPDATE period_review_cases SET status = 'draft', current_version_id = ?, updated_at = ? WHERE id = ?`, [insert.insertId, now, job.period_case_id])
    }
    await run(`UPDATE period_review_jobs SET status = 'succeeded', model_profile_id = ?, credential_source = ?, completed_at = ?,
      lease_token = NULL, lease_expires_at = NULL, updated_at = ? WHERE id = ?`,
    [generated.resolved.model_profile_id, generated.resolved.credential_source, now, now, job.id])
  })
}

async function finishMonthlyReviewFailure(job, error) {
  const exhausted = job.attempt_count >= Number(job.max_attempts)
  const retryAt = exhausted ? null : afterSeconds(Math.min(900, 60 * (2 ** Math.max(0, Number(job.attempt_count) - 1))))
  await queryRun(`UPDATE period_review_jobs SET status = ?, last_error_code = ?, lease_token = NULL,
    lease_expires_at = NULL, next_attempt_at = ?, updated_at = ? WHERE id = ? AND lease_token = ?`,
  [exhausted ? 'failed' : 'queued', safeError(error), retryAt, beijingNow(), job.id, job.lease_token])
  await queryRun(`UPDATE period_review_cases SET status = ?, updated_at = ? WHERE id = ? AND current_version_id IS NULL`,
  [exhausted ? 'failed' : 'ready', beijingNow(), job.period_case_id])
}

export async function runMonthlyReviewWorkerOnce({ requestModel = requestJsonObject } = {}) {
  const job = await claimMonthlyReviewJob()
  if (!job) return { claimed: false }
  try {
    const generated = await generateMonthlyReview(job, requestModel)
    await finishMonthlyReviewSuccess(job, generated)
    return { claimed: true, status: 'succeeded', periodCaseId: Number(job.period_case_id) }
  } catch (error) {
    await finishMonthlyReviewFailure(job, error)
    return { claimed: true, status: 'failed', periodCaseId: Number(job.period_case_id), error: safeError(error) }
  }
}

function periodReviewContentForCase(reviewCase, content) {
  const evidence = parse(reviewCase.evidence_json, {})
  if (reviewCase.period_type === 'daily') {
    const outcomeIds = (evidence.sources || []).map(item => Number(item.outcome_id))
    return validateDailyReviewContent(content, outcomeIds)
  }
  if (reviewCase.period_type === 'monthly') {
    const dailyCaseIds = (evidence.sources || []).map(item => Number(item.period_case_id))
    const approvedDailyCaseIds = (evidence.sources || []).filter(item => item.review_status === 'approved').map(item => Number(item.period_case_id))
    return validateMonthlyReviewContent(content, dailyCaseIds, approvedDailyCaseIds)
  }
  throw new Error('invalid_review_period_type')
}

export async function listPeriodReviewCases(userId, { periodType = null, status = null, limit = 50, offset = 0 } = {}) {
  const params = [userId]
  let where = 'WHERE cases.user_id = ?'
  if (periodType) {
    if (!['daily', 'monthly'].includes(periodType)) throw new Error('invalid_review_period_type')
    where += ' AND cases.period_type = ?'; params.push(periodType)
  }
  if (status) { where += ' AND cases.status = ?'; params.push(status) }
  const safeLimit = Math.min(100, Math.max(1, Number(limit || 50)))
  const safeOffset = Math.max(0, Number(offset || 0))
  params.push(safeLimit, safeOffset)
  const rows = await queryAll(`SELECT cases.id, cases.period_type, cases.period_key, cases.trading_account_id,
      cases.strategy_id, cases.strategy_version, cases.strategy_scope, cases.timezone_offset_minutes,
      cases.status, cases.evidence_status, cases.evidence_reason, cases.source_count,
      cases.current_version_id, cases.approved_version_id, cases.evidence_json, cases.created_at, cases.updated_at,
      COALESCE(strategies.title, CONCAT('策略 #', cases.strategy_id)) AS strategy_title,
      (SELECT jobs.last_error_code FROM period_review_jobs jobs WHERE jobs.period_case_id = cases.id AND jobs.job_slot = 0 LIMIT 1) AS last_error_code,
      (SELECT jobs.next_attempt_at FROM period_review_jobs jobs WHERE jobs.period_case_id = cases.id AND jobs.job_slot = 0 LIMIT 1) AS next_attempt_at
    FROM period_review_cases cases
    LEFT JOIN auto_prompt_types strategies ON strategies.id = cases.strategy_id ${where}
    ORDER BY cases.period_start_utc_msc DESC, cases.period_type, cases.id DESC LIMIT ? OFFSET ?`, params)
  return rows.map(row => {
    const evidence = parse(row.evidence_json, {})
    return { ...row, evidence_json: undefined, statistics: evidence.statistics || {}, source_quality: evidence.source_quality || null }
  })
}

export async function getPeriodReviewCase(periodCaseId, userId) {
  const reviewCase = await queryOne(`SELECT cases.*,
      COALESCE(strategies.title, CONCAT('策略 #', cases.strategy_id)) AS strategy_title,
      (SELECT jobs.last_error_code FROM period_review_jobs jobs WHERE jobs.period_case_id = cases.id AND jobs.job_slot = 0 LIMIT 1) AS last_error_code,
      (SELECT jobs.next_attempt_at FROM period_review_jobs jobs WHERE jobs.period_case_id = cases.id AND jobs.job_slot = 0 LIMIT 1) AS next_attempt_at
    FROM period_review_cases cases
    LEFT JOIN auto_prompt_types strategies ON strategies.id = cases.strategy_id
    WHERE cases.id = ? AND cases.user_id = ?`, [periodCaseId, userId])
  if (!reviewCase) throw new Error('period_review_not_found')
  const [versions, sources] = await Promise.all([
    queryAll(`SELECT id, version_no, parent_version_id, author_type, author_user_id, content_json,
      content_hash, change_note, created_at FROM period_review_versions WHERE period_case_id = ? ORDER BY version_no`, [periodCaseId]),
    queryAll(`SELECT id, outcome_id, trade_review_case_id, source_period_case_id, source_hash, created_at
      FROM period_review_sources WHERE period_case_id = ? ORDER BY id`, [periodCaseId]),
  ])
  return { ...reviewCase, evidence: parse(reviewCase.evidence_json, null), evidence_json: undefined, sources,
    versions: versions.map(row => ({ ...row, content: parse(row.content_json, {}), content_json: undefined })) }
}

export async function editPeriodReviewCase({ periodCaseId, userId, content, expectedVersionId, changeNote = null }) {
  return withTransaction(async run => {
    const [rows] = await run('SELECT * FROM period_review_cases WHERE id = ? AND user_id = ? FOR UPDATE', [periodCaseId, userId])
    const reviewCase = rows[0]
    if (!reviewCase) throw new Error('period_review_not_found')
    if (!reviewCase.current_version_id || Number(reviewCase.current_version_id) !== Number(expectedVersionId)) throw new Error('period_review_version_conflict')
    const normalized = periodReviewContentForCase(reviewCase, content)
    const [versions] = await run('SELECT COALESCE(MAX(version_no), 0) AS max_version FROM period_review_versions WHERE period_case_id = ? FOR UPDATE', [periodCaseId])
    const now = beijingNow()
    const body = JSON.stringify(normalized)
    const [insert] = await run(`INSERT INTO period_review_versions
      (period_case_id, version_no, parent_version_id, author_type, author_user_id, content_json, content_hash, change_note, created_at)
      VALUES (?, ?, ?, 'user', ?, ?, ?, ?, ?)`, [periodCaseId, Number(versions[0].max_version) + 1,
      reviewCase.current_version_id, userId, body, sha256(body), String(changeNote || '').slice(0, 500) || null, now])
    await run(`UPDATE period_review_cases SET status = 'edited', current_version_id = ?, approved_version_id = NULL,
      updated_at = ? WHERE id = ?`, [insert.insertId, now, periodCaseId])
    return { versionId: Number(insert.insertId), versionNo: Number(versions[0].max_version) + 1 }
  })
}

export async function confirmPeriodReviewCase({ periodCaseId, userId, versionId, action }) {
  if (!['approve', 'needs_revision', 'defer'].includes(action)) throw new Error('invalid_review_action')
  return withTransaction(async run => {
    const [rows] = await run('SELECT * FROM period_review_cases WHERE id = ? AND user_id = ? FOR UPDATE', [periodCaseId, userId])
    const reviewCase = rows[0]
    if (!reviewCase) throw new Error('period_review_not_found')
    if (!reviewCase.current_version_id || Number(reviewCase.current_version_id) !== Number(versionId)) throw new Error('period_review_version_conflict')
    const [versions] = await run('SELECT id FROM period_review_versions WHERE id = ? AND period_case_id = ?', [versionId, periodCaseId])
    if (!versions[0]) throw new Error('period_review_version_not_found')
    const status = action === 'approve' ? 'approved' : action === 'defer' ? 'deferred' : 'needs_revision'
    const now = beijingNow()
    await run(`UPDATE period_review_cases SET status = ?, approved_version_id = ?, updated_at = ? WHERE id = ?`,
    [status, action === 'approve' ? versionId : null, now, periodCaseId])
    return { status, periodType: reviewCase.period_type, strategyScope: reviewCase.strategy_scope,
      approvedVersionId: action === 'approve' ? Number(versionId) : null }
  })
}

export async function retryPeriodReviewCase(periodCaseId, userId) {
  return withTransaction(async run => {
    const [rows] = await run('SELECT * FROM period_review_cases WHERE id = ? AND user_id = ? FOR UPDATE', [periodCaseId, userId])
    const reviewCase = rows[0]
    if (!reviewCase) throw new Error('period_review_not_found')
    if (reviewCase.evidence_status !== 'complete') throw new Error('period_review_evidence_incomplete')
    if (reviewCase.current_version_id) throw new Error('period_review_already_generated')
    const jobType = reviewCase.period_type === 'daily' ? 'daily_review' : reviewCase.period_type === 'monthly' ? 'monthly_review' : null
    if (!jobType) throw new Error('invalid_review_period_type')
    const [jobs] = await run('SELECT * FROM period_review_jobs WHERE period_case_id = ? AND job_type = ? AND job_slot = 0 LIMIT 1 FOR UPDATE', [periodCaseId, jobType])
    const now = beijingNow()
    if (jobs[0]) await run(`UPDATE period_review_jobs SET status = 'queued', attempt_count = 0, last_error_code = NULL,
      lease_token = NULL, lease_expires_at = NULL, next_attempt_at = NULL, completed_at = NULL, updated_at = ? WHERE id = ?`, [now, jobs[0].id])
    else await run(`INSERT INTO period_review_jobs
      (period_case_id, job_type, idempotency_key, status, attempt_count, max_attempts, created_at, updated_at)
      VALUES (?, ?, ?, 'queued', 0, 3, ?, ?)`, [periodCaseId, jobType, `retry:${jobType}:${periodCaseId}:${crypto.randomUUID()}`, now, now])
    await run(`UPDATE period_review_cases SET status = 'ready', updated_at = ? WHERE id = ?`, [now, periodCaseId])
    return { queued: true }
  })
}

export async function runPeriodReviewCycle() {
  const dailyPreparation = await prepareEligibleDailyReviews()
  const dailyWorker = await runDailyReviewWorkerOnce()
  const monthlyPreparation = await prepareEligibleMonthlyReviews()
  const monthlyWorker = await runMonthlyReviewWorkerOnce()
  return { dailyPreparation, dailyWorker, monthlyPreparation, monthlyWorker }
}

export function startPeriodReviewWorker(intervalMs = 60_000) {
  if (periodReviewTimer) return false
  const run = () => {
    if (periodReviewCycleRunning) return
    periodReviewCycleRunning = true
    void runPeriodReviewCycle()
      .catch(error => console.error('[PeriodReview] cycle failed:', safeError(error)))
      .finally(() => { periodReviewCycleRunning = false })
  }
  run()
  periodReviewTimer = setInterval(run, Math.max(10_000, Number(intervalMs || 60_000)))
  periodReviewTimer.unref?.()
  return true
}

export function stopPeriodReviewWorker() {
  if (!periodReviewTimer) return false
  clearInterval(periodReviewTimer)
  periodReviewTimer = null
  return true
}
