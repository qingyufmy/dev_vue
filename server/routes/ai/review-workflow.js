import crypto from 'crypto'
import { beijingNow, queryAll, queryOne, queryRun, withTransaction } from '../../db.js'
import { resolveAiTaskModel } from './model-profiles.js'
import { requestJsonObject } from './llm.js'
import { sha256 } from './inference-snapshots.js'

const REVIEW_DECISIONS = new Set(['good', 'mixed', 'poor', 'insufficient_evidence'])
const ISSUE_SEVERITIES = new Set(['low', 'medium', 'high', 'critical'])
const PROCESS_STATUSES = new Set(['unreviewed', 'issue', 'no_issue', 'uncertain'])
const REVIEW_CONTENT_STATUSES = new Set(['pending', 'accurate', 'needs_revision', 'deferred'])
const PROVIDER_BASE_URLS = {
  deepseek: 'https://api.deepseek.com', gpt: 'https://api.openai.com/v1',
  kimi: 'https://api.moonshot.cn/v1', qwen: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
  zhipu: 'https://open.bigmodel.cn/api/paas/v4', doubao: 'https://ark.cn-beijing.volces.com/api/v3',
  volcengine_agent_plan: 'https://ark.cn-beijing.volces.com/api/plan/v3',
}

let workerTimer = null
const parse = (value, fallback = null) => { try { return value == null ? fallback : JSON.parse(value) } catch { return fallback } }
const json = value => JSON.stringify(value)
const safeError = error => String(error?.message || error || 'review_failed').replace(/Bearer\s+\S+/gi, 'Bearer [redacted]').slice(0, 128)

function afterSeconds(seconds) {
  const date = new Date(Date.now() + (8 * 3600 + seconds) * 1000)
  return date.toISOString().replace('T', ' ').slice(0, 19)
}

function isTruePrompt(value) {
  const text = String(value || '').trim()
  return Boolean(text) && !text.startsWith('[evidence omitted;')
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

async function loadEvidence(outcomeId) {
  const row = await queryOne(`SELECT so.*, s.signal_type, s.confidence, s.recommended_volume, s.analysis,
      s.reasoning, s.stop_loss_price, s.take_profit_1_price, s.take_profit_2_price, s.take_profit_3_price,
      s.market_data_json AS signal_market_data_json, s.created_at AS signal_created_at,
      snap.id AS snapshot_id, snap.system_prompt, snap.user_prompt, snap.prompt_hash,
      snap.model_profile_id AS inference_model_profile_id, snap.provider AS inference_provider,
      snap.model_name AS inference_model_name, snap.credential_source AS inference_credential_source,
      snap.klines_json, snap.market_snapshot_json, snap.evidence_status AS snapshot_evidence_status,
      snap.omitted_fields_json, snap.content_hash AS snapshot_content_hash,
      oi.request_json, oi.original_order_json, oi.approved_order_json, oi.bridge_payload_json,
      oi.result_json, oi.status AS execution_status, oi.bridge_command_ref,
      rd.policy_version_ids_json, rd.rule_results_json, rd.decision_status AS risk_decision_status,
      rd.reject_code AS risk_reject_code
    FROM signal_outcomes so
    LEFT JOIN ai_signals s ON s.id = so.signal_id
    LEFT JOIN inference_snapshots snap ON snap.signal_id = so.signal_id
    LEFT JOIN order_intents oi ON oi.id = so.order_intent_id
    LEFT JOIN risk_decisions rd ON rd.order_intent_id = so.order_intent_id
    WHERE so.id = ? ORDER BY snap.id DESC LIMIT 1`, [outcomeId])
  if (!row) throw new Error('outcome_not_found')
  const deals = await queryAll('SELECT * FROM signal_outcome_deals WHERE outcome_id = ? ORDER BY deal_time, id', [outcomeId])
  const assessment = assessReviewEvidence(row, deals)
  const refs = {
    original_signal: { type: 'ai_signal', id: row.signal_id },
    inference_snapshot: { type: 'inference_snapshot', id: row.snapshot_id, hash: row.snapshot_content_hash },
    risk_decision: { type: 'risk_decision', order_intent_id: row.order_intent_id },
    approved_order: { type: 'order_intent', id: row.order_intent_id },
    execution_deals: { type: 'signal_outcome_deals', outcome_id: row.id, count: deals.length },
    trade_outcome: { type: 'signal_outcome', id: row.id },
  }
  const bundle = {
    schema_version: 1,
    inference_time: {
      signal: row.signal_id ? { id: row.signal_id, signal_type: row.signal_type, confidence: row.confidence, recommended_volume: row.recommended_volume, analysis: row.analysis, reasoning: row.reasoning, stop_loss_price: row.stop_loss_price, take_profit_1_price: row.take_profit_1_price, take_profit_2_price: row.take_profit_2_price, take_profit_3_price: row.take_profit_3_price, created_at: row.signal_created_at } : null,
      snapshot: row.snapshot_id ? { id: row.snapshot_id, system_prompt: row.system_prompt, user_prompt: row.user_prompt, prompt_hash: row.prompt_hash, model_profile_id: row.inference_model_profile_id, provider: row.inference_provider, model_name: row.inference_model_name, credential_source: row.inference_credential_source, market_snapshot: parse(row.market_snapshot_json, {}), klines: parse(row.klines_json, {}), content_hash: row.snapshot_content_hash } : null,
      risk_decision: { status: row.risk_decision_status, reject_code: row.risk_reject_code, policy_version_ids: parse(row.policy_version_ids_json, []), rule_results: parse(row.rule_results_json, []) },
      original_order: parse(row.original_order_json, parse(row.request_json, {})),
      approved_order: parse(row.approved_order_json, null),
    },
    post_trade: {
      outcome: { id: row.id, status: row.status, attribution_status: row.attribution_status, expected_volume: row.expected_volume, entry_volume: row.entry_volume, closed_volume: row.closed_volume, gross_profit: row.gross_profit, commission: row.commission, swap: row.swap, fee: row.fee, net_profit: row.net_profit, external_intervention: Boolean(row.external_intervention), intervention: parse(row.intervention_json, []) },
      execution: { status: row.execution_status, result: parse(row.result_json, {}), bridge_command_ref: row.bridge_command_ref },
      deals: deals.map(deal => ({ deal_ticket: deal.deal_ticket, position_id: deal.position_id, order_ticket: deal.order_ticket, entry_type: deal.entry_type, magic: deal.magic, reason: deal.reason, volume: deal.volume, price: deal.price, profit: deal.profit, commission: deal.commission, swap: deal.swap, fee: deal.fee, deal_time: deal.deal_time })),
      post_trade_klines: null,
    },
    evidence_refs: refs,
  }
  return { row, assessment, bundle, evidenceHash: sha256(json(bundle)) }
}

export async function ensureReviewCaseForOutcome(outcomeId) {
  const evidence = await loadEvidence(outcomeId)
  const now = beijingNow()
  const status = evidence.assessment.complete ? 'ready' : 'incomplete'
  await queryRun(`INSERT INTO trade_review_cases
    (outcome_id, signal_id, user_id, trading_account_id, status, evidence_status, evidence_reason,
     evidence_json, evidence_hash, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON DUPLICATE KEY UPDATE signal_id = VALUES(signal_id), status = IF(status IN ('approved','draft','edited','needs_revision','deferred'), status, VALUES(status)),
      evidence_status = VALUES(evidence_status), evidence_reason = VALUES(evidence_reason), evidence_json = VALUES(evidence_json),
      evidence_hash = VALUES(evidence_hash), updated_at = VALUES(updated_at)`, [
    evidence.row.id, evidence.row.signal_id || null, evidence.row.user_id, evidence.row.trading_account_id,
    status, evidence.assessment.complete ? 'complete' : 'incomplete', evidence.assessment.reasons.join(',') || null,
    json(evidence.bundle), evidence.evidenceHash, now, now,
  ])
  const reviewCase = await queryOne('SELECT * FROM trade_review_cases WHERE outcome_id = ?', [outcomeId])
  if (evidence.assessment.complete && !reviewCase.current_version_id && !['approved', 'deferred'].includes(reviewCase.status)) {
    await queryRun(`INSERT IGNORE INTO trade_review_jobs
      (case_id, idempotency_key, status, attempt_count, max_attempts, created_at, updated_at)
      VALUES (?, ?, 'queued', 0, 3, ?, ?)`, [reviewCase.id, `review:${reviewCase.id}:${evidence.evidenceHash}`, now, now])
  }
  return await queryOne('SELECT * FROM trade_review_cases WHERE id = ?', [reviewCase.id])
}

export async function enqueueEligibleReviewCases(limit = 50) {
  const outcomes = await queryAll(`SELECT so.id FROM signal_outcomes so
    LEFT JOIN trade_review_cases rc ON rc.outcome_id = so.id
    WHERE so.status = 'closed' AND so.review_eligible_at IS NOT NULL
      AND (rc.id IS NULL OR rc.evidence_status <> 'complete') ORDER BY so.review_eligible_at LIMIT ?`, [Number(limit)])
  const result = { scanned: outcomes.length, ready: 0, incomplete: 0 }
  for (const outcome of outcomes) {
    try {
      const reviewCase = await ensureReviewCaseForOutcome(outcome.id)
      result[reviewCase.evidence_status === 'complete' ? 'ready' : 'incomplete']++
    } catch (error) { console.error('[TradeReview] Evidence preparation failed:', safeError(error)) }
  }
  return result
}

async function claimReviewJob() {
  return withTransaction(async run => {
    const [rows] = await run(`SELECT * FROM trade_review_jobs
      WHERE (status = 'queued' OR (status = 'leased' AND lease_expires_at < ?)) AND attempt_count < max_attempts
      ORDER BY updated_at, id LIMIT 1 FOR UPDATE`, [beijingNow()])
    const job = rows[0]
    if (!job) return null
    const token = crypto.randomUUID()
    await run(`UPDATE trade_review_jobs SET status = 'leased', lease_token = ?, lease_expires_at = ?,
      attempt_count = attempt_count + 1, updated_at = ? WHERE id = ?`, [token, afterSeconds(180), beijingNow(), job.id])
    await run(`UPDATE trade_review_cases SET status = 'generating', updated_at = ?
      WHERE id = ? AND current_version_id IS NULL`, [beijingNow(), job.case_id])
    return { ...job, lease_token: token, attempt_count: Number(job.attempt_count) + 1 }
  })
}

function modelEndpoint(model) {
  const provider = model.provider || model.api_provider
  const protocol = provider === 'volcengine_agent_plan' ? 'responses' : 'chat_completions'
  const base = String(model.api_base_url || PROVIDER_BASE_URLS[provider] || '').replace(/\/+$/, '')
  if (!base) throw new Error('unsupported_review_model_provider')
  return { protocol, url: `${base}/${protocol === 'responses' ? 'responses' : 'chat/completions'}` }
}

async function generateReview(reviewCase, requestModel = requestJsonObject) {
  if (reviewCase.evidence_status !== 'complete') throw new Error('review_evidence_incomplete')
  const evidence = parse(reviewCase.evidence_json, null)
  if (!evidence) throw new Error('review_evidence_invalid')
  const resolved = await resolveAiTaskModel({ userId: reviewCase.user_id, strategyId: null, usage: 'review' })
  if (!resolved.model) throw new Error(resolved.error || 'review_model_unavailable')
  const endpoint = modelEndpoint(resolved.model)
  const system = `你是严格的交易复盘分析器。只依据提供的证据判断，不得把亏损直接等同于决策错误，也不得把盈利直接等同于决策正确。区分推理时证据与交易后结果；无法判断时使用 insufficient_evidence。只返回 JSON。`
  const shape = { summary: 'string', decision_quality: 'good|mixed|poor|insufficient_evidence', outcome_summary: 'string', trade_process_issues: [{ code: 'string', severity: 'low|medium|high|critical', description: 'string', evidence_refs: ['ref key'] }], strengths: ['string'], lessons: ['string'], evidence_refs: ['ref key'], confidence: 0.5 }
  const content = await requestModel({ url: endpoint.url, apiKey: resolved.model.api_key_encrypted, model: resolved.model.model_name,
    temperature: Math.min(Number(resolved.model.temperature ?? 0.2), 0.3), maxTokens: resolved.model.max_tokens || 3000,
    thinkingEnabled: resolved.model.thinking_enabled, reasoningEffort: resolved.model.reasoning_effort, protocol: endpoint.protocol,
    messages: [{ role: 'system', content: system }, { role: 'user', content: `输出结构：${json(shape)}\n\n证据包：${json(evidence)}` }],
    usageContext: { userId: reviewCase.user_id, profileId: resolved.model_profile_id, credentialSource: resolved.credential_source, usage: 'review', strategyId: null },
  })
  return { content: validateReviewContent(content, evidence.evidence_refs), resolved }
}

async function finishJobSuccess(job, content, resolved) {
  await withTransaction(async run => {
    const [jobs] = await run('SELECT * FROM trade_review_jobs WHERE id = ? FOR UPDATE', [job.id])
    if (!jobs[0] || jobs[0].status !== 'leased' || jobs[0].lease_token !== job.lease_token) throw new Error('review_job_lease_lost')
    const [cases] = await run('SELECT * FROM trade_review_cases WHERE id = ? FOR UPDATE', [job.case_id])
    const reviewCase = cases[0]
    if (!reviewCase || reviewCase.current_version_id) {
      await run(`UPDATE trade_review_jobs SET status = 'succeeded', completed_at = ?, lease_token = NULL, lease_expires_at = NULL, updated_at = ? WHERE id = ?`, [beijingNow(), beijingNow(), job.id])
      return
    }
    const [versions] = await run('SELECT COALESCE(MAX(version_no), 0) AS max_version FROM trade_review_versions WHERE case_id = ? FOR UPDATE', [job.case_id])
    const now = beijingNow()
    const [insert] = await run(`INSERT INTO trade_review_versions
      (case_id, version_no, parent_version_id, author_type, author_user_id, content_json, content_hash, change_note, created_at)
      VALUES (?, ?, NULL, 'ai', NULL, ?, ?, 'AI initial draft', ?)`, [job.case_id, Number(versions[0].max_version) + 1, json(content), sha256(json(content)), now])
    await run(`UPDATE trade_review_cases SET status = 'draft', current_version_id = ?, review_content_status = 'pending', updated_at = ? WHERE id = ?`, [insert.insertId, now, job.case_id])
    await run(`UPDATE trade_review_jobs SET status = 'succeeded', model_profile_id = ?, credential_source = ?,
      completed_at = ?, lease_token = NULL, lease_expires_at = NULL, updated_at = ? WHERE id = ?`, [resolved.model_profile_id, resolved.credential_source, now, now, job.id])
  })
}

async function finishJobFailure(job, error) {
  const exhausted = job.attempt_count >= Number(job.max_attempts)
  await withTransaction(async run => {
    await run(`UPDATE trade_review_jobs SET status = ?, last_error_code = ?, lease_token = NULL,
      lease_expires_at = NULL, updated_at = ? WHERE id = ? AND lease_token = ?`, [exhausted ? 'failed' : 'queued', safeError(error), beijingNow(), job.id, job.lease_token])
    await run(`UPDATE trade_review_cases SET status = ?, updated_at = ? WHERE id = ? AND current_version_id IS NULL`, [exhausted ? 'failed' : 'ready', beijingNow(), job.case_id])
  })
}

export async function runReviewWorkerOnce({ requestModel = requestJsonObject } = {}) {
  const job = await claimReviewJob()
  if (!job) return { claimed: false }
  try {
    const reviewCase = await queryOne('SELECT * FROM trade_review_cases WHERE id = ?', [job.case_id])
    const generated = await generateReview(reviewCase, requestModel)
    await finishJobSuccess(job, generated.content, generated.resolved)
    return { claimed: true, caseId: job.case_id, status: 'succeeded' }
  } catch (error) {
    await finishJobFailure(job, error)
    return { claimed: true, caseId: job.case_id, status: 'failed', error: safeError(error) }
  }
}

export function startReviewWorker(intervalMs = 30_000) {
  if (workerTimer) return false
  const tick = async () => {
    try { await enqueueEligibleReviewCases(); await runReviewWorkerOnce() }
    catch (error) { console.error('[TradeReview] Worker cycle failed:', safeError(error)) }
  }
  workerTimer = setInterval(tick, Math.max(5_000, Number(intervalMs)))
  workerTimer.unref?.()
  void tick()
  return true
}

export function stopReviewWorker() {
  if (!workerTimer) return false
  clearInterval(workerTimer); workerTimer = null; return true
}

export async function listReviewCases(userId, { limit = 50, offset = 0, status = null } = {}) {
  const params = [userId]
  let where = 'WHERE user_id = ?'
  if (status) { where += ' AND status = ?'; params.push(status) }
  params.push(Math.min(100, Math.max(1, Number(limit))), Math.max(0, Number(offset)))
  return queryAll(`SELECT id, outcome_id, signal_id, trading_account_id, status, evidence_status, evidence_reason,
    trade_process_issue_status, review_content_status, current_version_id, approved_version_id,
    deferred_at, created_at, updated_at FROM trade_review_cases ${where} ORDER BY updated_at DESC LIMIT ? OFFSET ?`, params)
}

export async function getReviewCase(caseId, userId) {
  const reviewCase = await queryOne('SELECT * FROM trade_review_cases WHERE id = ? AND user_id = ?', [caseId, userId])
  if (!reviewCase) throw new Error('review_case_not_found')
  const versions = await queryAll(`SELECT id, version_no, parent_version_id, author_type, author_user_id,
    content_json, content_hash, change_note, created_at FROM trade_review_versions WHERE case_id = ? ORDER BY version_no`, [caseId])
  return { ...reviewCase, evidence: parse(reviewCase.evidence_json, null), evidence_json: undefined, versions: versions.map(row => ({ ...row, content: parse(row.content_json, {}), content_json: undefined })) }
}

export async function editReviewCase({ caseId, userId, content, expectedVersionId, changeNote = null }) {
  return withTransaction(async run => {
    const [rows] = await run('SELECT * FROM trade_review_cases WHERE id = ? AND user_id = ? FOR UPDATE', [caseId, userId])
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
    const [rows] = await run('SELECT * FROM trade_review_cases WHERE id = ? AND user_id = ? FOR UPDATE', [caseId, userId])
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
  return withTransaction(async run => {
    const [cases] = await run('SELECT * FROM trade_review_cases WHERE id = ? AND user_id = ? FOR UPDATE', [caseId, userId])
    const reviewCase = cases[0]
    if (!reviewCase) throw new Error('review_case_not_found')
    if (reviewCase.evidence_status !== 'complete') throw new Error('review_evidence_incomplete')
    if (reviewCase.current_version_id) throw new Error('review_already_generated')
    const [jobs] = await run('SELECT * FROM trade_review_jobs WHERE case_id = ? ORDER BY id DESC LIMIT 1 FOR UPDATE', [caseId])
    const now = beijingNow()
    if (jobs[0]) await run(`UPDATE trade_review_jobs SET status = 'queued', attempt_count = 0, last_error_code = NULL,
      lease_token = NULL, lease_expires_at = NULL, completed_at = NULL, updated_at = ? WHERE id = ?`, [now, jobs[0].id])
    else await run(`INSERT INTO trade_review_jobs (case_id, idempotency_key, status, attempt_count, max_attempts, created_at, updated_at)
      VALUES (?, ?, 'queued', 0, 3, ?, ?)`, [caseId, `review:${caseId}:${reviewCase.evidence_hash}:retry:${crypto.randomUUID()}`, now, now])
    await run(`UPDATE trade_review_cases SET status = 'ready', updated_at = ? WHERE id = ?`, [now, caseId])
    return { queued: true }
  })
}

export async function getReviewAdminHealth() {
  const rows = await queryAll(`SELECT status, evidence_status, COUNT(*) AS case_count,
    MIN(updated_at) AS oldest_updated_at, MAX(updated_at) AS newest_updated_at
    FROM trade_review_cases GROUP BY status, evidence_status`)
  const jobs = await queryAll(`SELECT status, COUNT(*) AS job_count, SUM(attempt_count) AS total_attempts
    FROM trade_review_jobs GROUP BY status`)
  return { cases: rows, jobs, content_redacted: true }
}

