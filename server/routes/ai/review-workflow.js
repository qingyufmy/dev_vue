import { beijingNow, queryAll, queryOne, queryRun, withTransaction } from '../../db.js'
import { parseSnapshotJson, sha256, resolveFrozenChanRequirement } from './inference-snapshots.js'
import { buildReviewMarketPath } from './review-market-path.js'
import { canManagePlatformAiContent, platformAiContentManagerSql } from './platform-content-access.js'
import { assessChanEvidenceDimensions } from './chan-evidence-assessment.js'

const REVIEW_DECISIONS = new Set(['good', 'mixed', 'poor', 'insufficient_evidence'])
const ISSUE_SEVERITIES = new Set(['low', 'medium', 'high', 'critical'])
const PROCESS_STATUSES = new Set(['unreviewed', 'issue', 'no_issue', 'uncertain'])
const REVIEW_CONTENT_STATUSES = new Set(['pending', 'accurate', 'needs_revision', 'deferred'])
const parse = (value, fallback = null) => { try { return value == null ? fallback : JSON.parse(value) } catch { return fallback } }
const json = value => JSON.stringify(value)
const safeError = error => String(error?.message || error || 'review_failed').replace(/Bearer\s+\S+/gi, 'Bearer [redacted]').slice(0, 128)

function isTruePrompt(value) {
  const text = String(value || '').trim()
  return Boolean(text) && !text.startsWith('[evidence omitted;')
}

export function assessReviewStrategyEligibility(row) {
  const strategyScope = String(row?.snapshot_strategy_scope || row?.strategy_scope || '').trim().toLowerCase()
  const platformManager = canManagePlatformAiContent(row)
  if (strategyScope === 'platform') {
    return platformManager
      ? { eligible: true, reason: null }
      : { eligible: false, reason: 'platform_strategy_user_review_disabled' }
  }
  if (strategyScope === 'private') {
    return !platformManager
      ? { eligible: true, reason: null }
      : { eligible: false, reason: 'platform_manager_private_strategy_review_disabled' }
  }
  return { eligible: false, reason: 'review_strategy_scope_missing' }
}

function reviewEligibilitySql(caseAlias = 'rc') {
  const platformManagerSql = platformAiContentManagerSql('eligibility_user')
  return `EXISTS (
    SELECT 1 FROM inference_snapshots eligibility_snap
    JOIN users eligibility_user ON eligibility_user.id = ${caseAlias}.user_id
    WHERE eligibility_snap.signal_id = ${caseAlias}.signal_id
      AND ((eligibility_snap.strategy_scope = 'private' AND NOT ${platformManagerSql})
        OR (eligibility_snap.strategy_scope = 'platform' AND ${platformManagerSql}))
  )`
}

export function validateReviewContent(input, evidenceRefs = null) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('invalid_review_content')
  const allowed = new Set(['summary', 'decision_quality', 'outcome_summary', 'trade_process_issues', 'strengths', 'lessons', 'evidence_refs', 'confidence'])
  if (Object.keys(input).some(key => !allowed.has(key))) throw new Error('unknown_review_field')
  for (const key of ['summary', 'outcome_summary']) if (!String(input[key] || '').trim()) throw new Error(`missing_${key}`)
  if (!REVIEW_DECISIONS.has(input.decision_quality)) throw new Error('invalid_decision_quality')
  if (!Array.isArray(input.trade_process_issues) || !Array.isArray(input.strengths) || !Array.isArray(input.lessons) || !Array.isArray(input.evidence_refs)) throw new Error('invalid_review_arrays')
  if (!Number.isFinite(Number(input.confidence)) || Number(input.confidence) < 0 || Number(input.confidence) > 1) throw new Error('invalid_review_confidence')
  const knownRefs = evidenceRefs ? new Set(Object.keys(evidenceRefs)) : null
  const validateRefs = refs => {
    if (!Array.isArray(refs) || refs.some(ref => typeof ref !== 'string' || (knownRefs && !knownRefs.has(ref)))) throw new Error('invalid_evidence_ref')
  }
  validateRefs(input.evidence_refs)
  for (const issue of input.trade_process_issues) {
    if (!issue || typeof issue !== 'object' || !String(issue.code || '').trim() || !String(issue.description || '').trim() || !ISSUE_SEVERITIES.has(issue.severity)) throw new Error('invalid_trade_process_issue')
    validateRefs(issue.evidence_refs)
  }
  return {
    summary: String(input.summary).trim(), decision_quality: input.decision_quality,
    outcome_summary: String(input.outcome_summary).trim(),
    trade_process_issues: input.trade_process_issues.map(item => ({ code: String(item.code), severity: item.severity, description: String(item.description), evidence_refs: item.evidence_refs })),
    strengths: input.strengths.map(String), lessons: input.lessons.map(String),
    evidence_refs: input.evidence_refs, confidence: Number(input.confidence),
  }
}

export function assessReviewEvidence(row, deals = []) {
  const reasons = []
  if (!row || row.status !== 'closed' || !row.review_eligible_at) reasons.push('outcome_not_review_eligible')
  if (row?.attribution_status !== 'attributed') reasons.push('outcome_attribution_not_exact')
  if (!row?.signal_id || !row?.signal_type) reasons.push('original_signal_missing')
  if (!row?.snapshot_id) reasons.push('inference_snapshot_missing')
  if (row?.snapshot_evidence_status !== 'complete') reasons.push('inference_snapshot_incomplete')
  if (!isTruePrompt(row?.system_prompt) || !isTruePrompt(row?.user_prompt)) reasons.push('historical_prompt_missing')
  if (!Array.isArray(deals) || !deals.length) reasons.push('execution_deals_missing')
  return { complete: reasons.length === 0, reasons }
}

export function assessChanEvidenceStatus(requirementOrStatus, timeframeValues = []) {
  const assessment = assessChanEvidenceDimensions(requirementOrStatus, timeframeValues)
  // Keep the period-review API shape stable while making the shared evaluator
  // available to manual review and future callers through its orthogonal
  // data_status/structure_status dimensions.
  return { status:assessment.status, reason:assessment.reason }
}

async function loadEvidence(outcomeId) {
  const row = await queryOne(`SELECT so.*, s.signal_type, s.confidence, s.recommended_volume, s.analysis,
      s.reasoning, s.stop_loss_price, s.take_profit_1_price, s.take_profit_2_price, s.take_profit_3_price,
      s.timeframe AS signal_timeframe, s.market_data_json AS signal_market_data_json, s.created_at AS signal_created_at,
      snap.id AS snapshot_id, snap.system_prompt, snap.user_prompt, snap.prompt_hash,
      snap.strategy_id AS snapshot_strategy_id,
      snap.strategy_version AS snapshot_strategy_version,
      snap.strategy_scope AS snapshot_strategy_scope,
      snap.model_profile_id AS inference_model_profile_id, snap.provider AS inference_provider,
      snap.model_name AS inference_model_name, snap.credential_source AS inference_credential_source,
       snap.klines_json, snap.market_snapshot_json, snap.evidence_status AS snapshot_evidence_status,
       snap.omitted_fields_json, snap.content_hash AS snapshot_content_hash, snap.strategy_runtime_json,
      oi.request_json, oi.original_order_json, oi.approved_order_json, oi.bridge_payload_json,
      oi.result_json, oi.status AS execution_status, oi.bridge_command_ref,
      rd.policy_version_ids_json, rd.rule_results_json, rd.decision_status AS risk_decision_status,
      rd.reject_code AS risk_reject_code, u.role AS review_user_role, u.plan_source AS review_user_plan_source
    FROM signal_outcomes so
    JOIN users u ON u.id = so.user_id
    LEFT JOIN ai_signals s ON s.id = so.signal_id
    LEFT JOIN inference_snapshots snap ON snap.signal_id = so.signal_id
    LEFT JOIN order_intents oi ON oi.id = so.order_intent_id
    LEFT JOIN risk_decisions rd ON rd.order_intent_id = so.order_intent_id
    WHERE so.id = ? ORDER BY snap.id DESC LIMIT 1`, [outcomeId])
  if (!row) throw new Error('outcome_not_found')
  const deals = await queryAll('SELECT * FROM signal_outcome_deals WHERE outcome_id = ? ORDER BY deal_time, id', [outcomeId])
  const coreAssessment = assessReviewEvidence(row, deals)
  const snapshot = row.snapshot_id ? { id: row.snapshot_id, strategy_id: row.snapshot_strategy_id,
    strategy_version: Number(row.snapshot_strategy_version || 1), strategy_scope: row.snapshot_strategy_scope,
    system_prompt: row.system_prompt, user_prompt: row.user_prompt, prompt_hash: row.prompt_hash,
    model_profile_id: row.inference_model_profile_id, provider: row.inference_provider,
     model_name: row.inference_model_name, credential_source: row.inference_credential_source,
     market_snapshot: parse(row.market_snapshot_json, {}), klines: parseSnapshotJson(row.klines_json, {}),
     strategy_runtime:parseSnapshotJson(row.strategy_runtime_json, null), content_hash: row.snapshot_content_hash } : null
  const signal = row.signal_id ? { id: row.signal_id, signal_type: row.signal_type, timeframe: row.signal_timeframe,
    confidence: row.confidence, recommended_volume: row.recommended_volume, analysis: row.analysis, reasoning: row.reasoning,
    stop_loss_price: row.stop_loss_price, take_profit_1_price: row.take_profit_1_price,
     take_profit_2_price: row.take_profit_2_price, take_profit_3_price: row.take_profit_3_price, created_at: row.signal_created_at } : null
  const chanRequirement = resolveFrozenChanRequirement(snapshot, {
    signal_market_data_json:row.signal_market_data_json,
    inference_time:{ snapshot },
  })
  let marketPath = { status: 'partial', reason: 'market_path_unavailable', timeframes: {}, metrics: null, hash: null }
  try { marketPath = await buildReviewMarketPath({ userId: row.user_id,
     tradingAccountId:row.trading_account_id, symbol: row.symbol,
     signal: signal || {}, snapshot: snapshot || {}, deals, chanRequirement }) }
  catch (error) { marketPath.reason = safeError(error) }
  const chanEvidence = assessChanEvidenceStatus(chanRequirement, Object.values(marketPath.timeframes || {}))
  const chanEvidenceStatus = chanEvidence.status
  const assessment = {
    complete:coreAssessment.complete && marketPath.status === 'complete',
    reasons:[...coreAssessment.reasons, ...(marketPath.status === 'complete' ? [] : ['holding_market_path_incomplete'])],
  }
  const refs = {
    original_signal: { type: 'ai_signal', id: row.signal_id },
    inference_snapshot: { type: 'inference_snapshot', id: row.snapshot_id, hash: row.snapshot_content_hash },
    risk_decision: { type: 'risk_decision', order_intent_id: row.order_intent_id },
    approved_order: { type: 'order_intent', id: row.order_intent_id },
    execution_deals: { type: 'signal_outcome_deals', outcome_id: row.id, count: deals.length },
    trade_outcome: { type: 'signal_outcome', id: row.id },
    holding_market_path: { type: 'review_market_path', hash: marketPath.hash, status: marketPath.status },
  }
  const bundle = {
    schema_version: 2,
    inference_time: {
      signal,
      snapshot,
      risk_decision: { status: row.risk_decision_status, reject_code: row.risk_reject_code, policy_version_ids: parse(row.policy_version_ids_json, []), rule_results: parse(row.rule_results_json, []) },
      original_order: parse(row.original_order_json, parse(row.request_json, {})),
      approved_order: parse(row.approved_order_json, null),
    },
    post_trade: {
      outcome: { id: row.id, symbol: row.symbol, status: row.status, attribution_status: row.attribution_status, expected_volume: row.expected_volume, entry_volume: row.entry_volume, closed_volume: row.closed_volume, gross_profit: row.gross_profit, commission: row.commission, swap: row.swap, fee: row.fee, net_profit: row.net_profit, external_intervention: Boolean(row.external_intervention), intervention: parse(row.intervention_json, []) },
      execution: { status: row.execution_status, result: parse(row.result_json, {}), bridge_command_ref: row.bridge_command_ref },
      deals: deals.map(deal => ({ deal_ticket: deal.deal_ticket, position_id: deal.position_id, order_ticket: deal.order_ticket, entry_type: deal.entry_type, magic: deal.magic, reason: deal.reason, volume: deal.volume, price: deal.price, profit: deal.profit, commission: deal.commission, swap: deal.swap, fee: deal.fee, deal_time: deal.deal_time })),
      path_metrics: marketPath.metrics,
      post_trade_klines: Object.fromEntries(Object.entries(marketPath.timeframes || {}).map(([timeframe, value]) => [timeframe, value.candles || []])),
       post_trade_structure: Object.fromEntries(Object.entries(marketPath.timeframes || {}).map(([timeframe, value]) => [timeframe, {
         indicators: value.indicators || null,
         ...(Object.prototype.hasOwnProperty.call(value, 'chan') ? { chan:value.chan } : {}),
       }])),
       path_evidence: { status: marketPath.status, reason: marketPath.reason, primary_timeframe: marketPath.primary_timeframe,
         chan_requirement_status:chanRequirement.status, chan_evidence_status:chanEvidenceStatus,
          chan_evidence_reason:chanEvidence.reason,
         chan_requirement:chanRequirement,
        coverage: Object.fromEntries(Object.entries(marketPath.timeframes || {}).map(([timeframe, value]) => [timeframe, {
          status: value.status, candle_count: value.candle_count, source_candle_count: value.source_candle_count,
           truncated_before_entry: value.truncated_before_entry, truncated_before_exit: value.truncated_before_exit,
            chan_status:value.chan ? (value.chan.status || 'partial') : null,
            chan_evidence_status:value.chan ? assessChanEvidenceStatus(chanRequirement, [value]).status : null,
         }])) },
    },
    evidence_refs: refs,
  }
  return { row, assessment, bundle, evidenceHash: sha256(json(bundle)) }
}

export async function ensureReviewCaseForOutcome(outcomeId, { queueGeneration: _queueGeneration = false } = {}) {
  const evidence = await loadEvidence(outcomeId)
  const eligibility = assessReviewStrategyEligibility(evidence.row)
  if (!eligibility.eligible) return { skipped: true, reason: eligibility.reason, outcome_id: Number(outcomeId) }
  const now = beijingNow()
  const status = evidence.assessment.complete ? 'ready' : 'incomplete'
  await queryRun(`INSERT INTO trade_review_cases
    (outcome_id, signal_id, user_id, trading_account_id, status, evidence_status, evidence_reason,
     evidence_json, evidence_hash, path_evidence_status, path_evidence_reason, path_evidence_hash, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON DUPLICATE KEY UPDATE signal_id = VALUES(signal_id),
      status = IF(status IN ('approved','draft','edited','needs_revision','deferred')
        OR (evidence_status = 'complete' AND VALUES(evidence_status) <> 'complete'), status, VALUES(status)),
      evidence_status = IF(evidence_status = 'complete' AND VALUES(evidence_status) <> 'complete',
        evidence_status, VALUES(evidence_status)),
      evidence_reason = IF(evidence_status = 'complete' AND VALUES(evidence_status) <> 'complete',
        evidence_reason, VALUES(evidence_reason)),
      evidence_json = IF(evidence_status = 'complete' AND VALUES(evidence_status) <> 'complete',
        evidence_json, VALUES(evidence_json)),
      evidence_hash = IF(evidence_status = 'complete' AND VALUES(evidence_status) <> 'complete',
        evidence_hash, VALUES(evidence_hash)),
      path_evidence_status = IF(evidence_status = 'complete' AND VALUES(evidence_status) <> 'complete',
        path_evidence_status, VALUES(path_evidence_status)),
      path_evidence_reason = IF(evidence_status = 'complete' AND VALUES(evidence_status) <> 'complete',
        path_evidence_reason, VALUES(path_evidence_reason)),
      path_evidence_hash = IF(evidence_status = 'complete' AND VALUES(evidence_status) <> 'complete',
        path_evidence_hash, VALUES(path_evidence_hash)),
      updated_at = IF(evidence_status = 'complete' AND VALUES(evidence_status) <> 'complete',
        updated_at, VALUES(updated_at))`, [
    evidence.row.id, evidence.row.signal_id || null, evidence.row.user_id, evidence.row.trading_account_id,
    status, evidence.assessment.complete ? 'complete' : 'incomplete', evidence.assessment.reasons.join(',') || null,
    json(evidence.bundle), evidence.evidenceHash, evidence.bundle.post_trade.path_evidence.status,
    evidence.bundle.post_trade.path_evidence.reason, evidence.bundle.evidence_refs.holding_market_path.hash, now, now,
  ])
  const reviewCase = await queryOne('SELECT * FROM trade_review_cases WHERE outcome_id = ?', [outcomeId])
  // Legacy per-trade model generation is retired. Period reviews still reuse
  // this immutable evidence case, but no caller may enqueue trade_review_jobs.
  return await queryOne('SELECT * FROM trade_review_cases WHERE id = ?', [reviewCase.id])
}

export async function enqueueEligibleReviewCases(limit = 50) {
  void limit
  return { retired:true, scanned:0, ready:0, incomplete:0, skipped:0 }
}

export async function runReviewWorkerOnce() {
  return { claimed:false, retired:true }
}

export function startReviewWorker() {
  return false
}

export function stopReviewWorker() {
  return false
}

export async function listReviewCases(userId, { limit = 50, offset = 0, status = null } = {}) {
  const params = [userId]
  let where = `WHERE rc.user_id = ? AND ${reviewEligibilitySql('rc')}`
  if (status) { where += ' AND rc.status = ?'; params.push(status) }
  params.push(Math.min(100, Math.max(1, Number(limit))), Math.max(0, Number(offset)))
  return queryAll(`SELECT rc.id, rc.outcome_id, rc.signal_id, rc.trading_account_id, rc.status, rc.evidence_status, rc.evidence_reason,
    rc.trade_process_issue_status, rc.review_content_status, rc.current_version_id, rc.approved_version_id,
    rc.deferred_at, rc.created_at, rc.updated_at FROM trade_review_cases rc ${where} ORDER BY rc.updated_at DESC LIMIT ? OFFSET ?`, params)
}

export async function getReviewCase(caseId, userId) {
  const reviewCase = await queryOne(`SELECT rc.* FROM trade_review_cases rc WHERE rc.id = ? AND rc.user_id = ? AND ${reviewEligibilitySql('rc')}`, [caseId, userId])
  if (!reviewCase) throw new Error('review_case_not_found')
  const versions = await queryAll(`SELECT id, version_no, parent_version_id, author_type, author_user_id,
    content_json, content_hash, change_note, created_at FROM trade_review_versions WHERE case_id = ? ORDER BY version_no`, [caseId])
  return { ...reviewCase, evidence: parse(reviewCase.evidence_json, null), evidence_json: undefined, versions: versions.map(row => ({ ...row, content: parse(row.content_json, {}), content_json: undefined })) }
}

export async function editReviewCase({ caseId, userId, content, expectedVersionId, changeNote = null }) {
  return withTransaction(async run => {
    const [rows] = await run(`SELECT rc.* FROM trade_review_cases rc WHERE rc.id = ? AND rc.user_id = ? AND ${reviewEligibilitySql('rc')} FOR UPDATE`, [caseId, userId])
    const reviewCase = rows[0]
    if (!reviewCase) throw new Error('review_case_not_found')
    if (!reviewCase.current_version_id || Number(reviewCase.current_version_id) !== Number(expectedVersionId)) throw new Error('review_version_conflict')
    const evidence = parse(reviewCase.evidence_json, {})
    const normalized = validateReviewContent(content, evidence.evidence_refs || {})
    const [versions] = await run('SELECT COALESCE(MAX(version_no), 0) AS max_version FROM trade_review_versions WHERE case_id = ? FOR UPDATE', [caseId])
    const now = beijingNow()
    const [insert] = await run(`INSERT INTO trade_review_versions
      (case_id, version_no, parent_version_id, author_type, author_user_id, content_json, content_hash, change_note, created_at)
      VALUES (?, ?, ?, 'user', ?, ?, ?, ?, ?)`, [caseId, Number(versions[0].max_version) + 1, reviewCase.current_version_id, userId, json(normalized), sha256(json(normalized)), String(changeNote || '').slice(0, 500) || null, now])
    await run(`UPDATE trade_review_cases SET status = 'edited', current_version_id = ?, approved_version_id = NULL,
      review_content_status = 'pending', updated_at = ? WHERE id = ?`, [insert.insertId, now, caseId])
    return { versionId: insert.insertId, versionNo: Number(versions[0].max_version) + 1 }
  })
}

export async function confirmReviewCase({ caseId, userId, versionId, action, tradeProcessIssueStatus = null }) {
  if (!['approve', 'needs_revision', 'defer'].includes(action)) throw new Error('invalid_review_action')
  if (tradeProcessIssueStatus != null && !PROCESS_STATUSES.has(tradeProcessIssueStatus)) throw new Error('invalid_trade_process_issue_status')
  return withTransaction(async run => {
    const [rows] = await run(`SELECT rc.* FROM trade_review_cases rc WHERE rc.id = ? AND rc.user_id = ? AND ${reviewEligibilitySql('rc')} FOR UPDATE`, [caseId, userId])
    const reviewCase = rows[0]
    if (!reviewCase) throw new Error('review_case_not_found')
    if (!reviewCase.current_version_id || Number(reviewCase.current_version_id) !== Number(versionId)) throw new Error('review_version_conflict')
    const [versions] = await run('SELECT id FROM trade_review_versions WHERE id = ? AND case_id = ?', [versionId, caseId])
    if (!versions[0]) throw new Error('review_version_not_found')
    const now = beijingNow()
    const status = action === 'approve' ? 'approved' : action === 'defer' ? 'deferred' : 'needs_revision'
    const contentStatus = action === 'approve' ? 'accurate' : action === 'defer' ? 'deferred' : 'needs_revision'
    if (!REVIEW_CONTENT_STATUSES.has(contentStatus)) throw new Error('invalid_review_content_status')
    await run(`UPDATE trade_review_cases SET status = ?, review_content_status = ?,
      trade_process_issue_status = COALESCE(?, trade_process_issue_status),
      approved_version_id = ?, deferred_at = ?, updated_at = ? WHERE id = ?`, [status, contentStatus, tradeProcessIssueStatus, action === 'approve' ? versionId : null, action === 'defer' ? now : null, now, caseId])
    return { status, approvedVersionId: action === 'approve' ? Number(versionId) : null }
  })
}

export async function retryReviewCase(caseId, userId) {
  void caseId
  void userId
  throw new Error('legacy_trade_review_disabled')
}

export async function getReviewAdminHealth() {
  const rows = await queryAll(`SELECT status, evidence_status, COUNT(*) AS case_count,
    MIN(updated_at) AS oldest_updated_at, MAX(updated_at) AS newest_updated_at
    FROM trade_review_cases GROUP BY status, evidence_status`)
  const jobs = await queryAll(`SELECT status, COUNT(*) AS job_count, SUM(attempt_count) AS total_attempts
    FROM trade_review_jobs GROUP BY status`)
  return { cases: rows, jobs, content_redacted: true }
}
