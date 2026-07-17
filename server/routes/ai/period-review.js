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
    ON DUPLICATE KEY UPDATE evidence_status = VALUES(evidence_status), evidence_reason = VALUES(evidence_reason),
      evidence_json = VALUES(evidence_json), evidence_hash = VALUES(evidence_hash), source_count = VALUES(source_count),
      status = IF(status IN ('approved','edited','needs_revision','deferred'), status, VALUES(status)), updated_at = VALUES(updated_at)`, [
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
        AND (jobs.status = 'queued' OR (jobs.status = 'leased' AND jobs.lease_expires_at < ?))
        AND jobs.attempt_count < jobs.max_attempts AND cases.period_type = 'daily' AND cases.evidence_status = 'complete'
      ORDER BY jobs.updated_at, jobs.id LIMIT 1 FOR UPDATE`, [beijingNow()])
    if (!rows[0]) return null
    const token = crypto.randomUUID()
    await run(`UPDATE period_review_jobs SET status = 'leased', lease_token = ?, lease_expires_at = ?,
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
  await queryRun(`UPDATE period_review_jobs SET status = ?, last_error_code = ?, lease_token = NULL,
    lease_expires_at = NULL, updated_at = ? WHERE id = ? AND lease_token = ?`, [exhausted ? 'failed' : 'queued', safeError(error), beijingNow(), job.id, job.lease_token])
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
