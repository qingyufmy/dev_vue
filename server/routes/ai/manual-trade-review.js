import crypto from 'node:crypto'
import { beijingNow, queryAll, queryOne, queryRun, withTransaction } from '../../db.js'
import { canManagePlatformAiContent } from './platform-content-access.js'
import { requestJsonObject } from './llm.js'
import { estimateModelInputTokens, selectModelTaskBudget } from './model-task-budget.js'
import { getModelProviderCapabilities } from './model-provider-capabilities.js'
import { MODEL_PROVIDER_DEFAULTS, modelProviderProtocol } from './model-providers.js'
import { resolveAiTaskModel } from './model-profiles.js'
import { sha256 } from './inference-snapshots.js'
import { getCurrentManualReviewAccount, listEligibleManualTrades, readManualTradeEvidence, normalizedTradeHash, MANUAL_TRADE_SELECTION_MAX } from './manual-trade-evidence.js'

const REVIEW_OUTPUT_VERSION = 'manual-trade-review-v2'
const COUNTERFACTUAL_OUTPUT_VERSION = 'manual-trade-counterfactual-v1'
const MAX_TEXT = 6_000
const MAX_THESIS = 2_000
const MAX_CANDIDATES = 20
const TERMINAL_JOBS = new Set(['succeeded', 'failed', 'cancelled', 'deferred'])
const VALID_CASE_STATUSES = new Set(['evidence_pending', 'queued', 'generating', 'draft', 'edited', 'needs_revision', 'approved', 'failed', 'deferred', 'superseded'])
const VALID_REVIEW_ACTIONS = new Set(['approve', 'mark_problem', 'defer'])
const ALLOWED_ALIGNMENT = new Set(['aligned', 'partial', 'misaligned', 'conflict', 'unknown'])
const ALLOWED_DECISION = new Set(['good', 'mixed', 'poor', 'insufficient_evidence'])
const ALLOWED_EVIDENCE = new Set(['complete', 'partial', 'insufficient'])
const ALLOWED_COUNTERFACTUAL_DECISION = new Set(['buy', 'sell', 'hold', 'insufficient_evidence'])
const ALLOWED_COUNTERFACTUAL_MATCH = new Set(['same_direction', 'hold', 'opposite_direction', 'insufficient_evidence'])
const ALLOWED_HYPOTHESIS_STATE = new Set(['hypothesis', 'insufficient_evidence'])

let manualReviewTimer = null
let manualReviewWake = false
let manualReviewRunning = false

function parse(value, fallback = null) {
  if (value == null || value === '') return fallback
  if (typeof value === 'object') return value
  try { return JSON.parse(value) } catch { return fallback }
}

function text(value, max = MAX_TEXT) {
  return String(value == null ? '' : value).normalize('NFKC').replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, max)
}

function array(value, max = MAX_CANDIDATES) { return (Array.isArray(value) ? value : []).slice(0, max) }

function boundedObject(value, maxBytes = 4_000) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
  try {
    const copy = JSON.parse(JSON.stringify(value))
    if (Buffer.byteLength(JSON.stringify(copy), 'utf8') > maxBytes) throw new Error('too_large')
    return copy
  } catch (error) {
    if (error?.message === 'too_large') throw new Error('manual_trade_review_output_object_too_large')
    throw new Error('manual_trade_review_output_object_invalid')
  }
}

function id(value, code = 'invalid_id') {
  const number = Number(value)
  if (!Number.isSafeInteger(number) || number <= 0) throw new Error(code)
  return number
}

function jsonHash(value) { return sha256(JSON.stringify(value)) }

function dateAfter(seconds = 120) {
  const date = new Date(Date.now() + Math.max(1, Number(seconds) || 120) * 1000)
  return new Date(date.getTime() + 8 * 3600_000).toISOString().replace('T', ' ').slice(0, 19)
}

function modelEndpoint(model) {
  const provider = model.provider || model.api_provider
  const protocol = modelProviderProtocol(provider)
  const base = String(model.api_base_url || MODEL_PROVIDER_DEFAULTS[provider] || '').replace(/\/+$/, '')
  if (!base) throw new Error('manual_trade_review_model_provider_unavailable')
  return { protocol, url:`${base}/${protocol === 'responses' ? 'responses' : 'chat/completions'}` }
}

async function prepareManualTradeReviewBudget(resolved, messages) {
  let capabilities = {}
  try {
    capabilities = await getModelProviderCapabilities(resolved?.model_profile_id) || {}
  } catch (error) {
    console.warn('[ManualTradeReview] provider capability lookup unavailable:', error.message)
  }
  const budget = selectModelTaskBudget({
    taskKind:'manual_analysis',
    // Preserve the pre-capability migration behavior for legacy/unconfirmed
    // profiles.  Confirmed physical limits take the other branch and ignore
    // this value entirely.
    profileHardCap:Math.min(4_096, Math.max(1_200, Number(resolved?.model?.max_tokens) || 2_000)),
    providerOutputCap:capabilities.max_output_tokens,
    contextWindowTokens:capabilities.context_window_tokens,
    maxInputTokens:capabilities.max_input_tokens ?? capabilities.provider_max_input_tokens,
    contextLimitSemantics:capabilities.context_limit_semantics,
    capabilities,
    profile:resolved?.model,
    estimatedInputTokens:estimateModelInputTokens(messages),
    schemaNeedTokens:0,
    legacyExactProfileCap:true,
  })
  if (budget.reason === 'model_input_limit_exceeded' || budget.inputLimitExceeded) throw new Error('model_input_limit_exceeded')
  if (!budget.sufficient || budget.selectedMaxOutputTokens <= 0) throw new Error('output_budget_insufficient')
  return budget
}

function managerOrThrow(actor) {
  if (!canManagePlatformAiContent(actor)) throw new Error('manual_trade_review_forbidden')
  const actorId = Number(actor?.id)
  if (!Number.isSafeInteger(actorId) || actorId <= 0) throw new Error('manual_trade_review_forbidden')
  return actorId
}

function sanitizeThesis(value) { return text(value, MAX_THESIS) || null }

function enumValue(value, allowed, fallback, code) {
  if (value == null || value === '') return fallback
  if (!allowed.has(value)) throw new Error(code)
  return value
}

export function validateManualTradeSelection(selected = []) {
  if (!Array.isArray(selected) || !selected.length || selected.length > MANUAL_TRADE_SELECTION_MAX) {
    throw new Error('manual_trade_review_selection_invalid')
  }
  const identities = selected.map(item => String(item?.source_identity_hash || item?.trade_id || '').trim())
  const hashes = selected.map(item => String(item?.trade_source_hash || '').trim())
  if (identities.some(value => !value) || new Set(identities).size !== identities.length
    || hashes.some(value => !value) || new Set(hashes).size !== hashes.length) {
    throw new Error('manual_trade_review_selection_duplicate')
  }
  return selected
}

export function manualTradeReviewOutputContract(sampleCount = 1) {
  return {
    output_contract_version:REVIEW_OUTPUT_VERSION,
    counterfactual_analysis:{ output_contract_version:COUNTERFACTUAL_OUTPUT_VERSION,
      decision:'buy|sell|hold|insufficient_evidence' },
    evidence_quality:'complete|partial|insufficient',
    strategy_alignment:'aligned|partial|conflict|unknown',
    decision_quality:'good|mixed|poor|insufficient_evidence',
    counterfactual_match:'same_direction|hold|opposite_direction|insufficient_evidence',
    strategy_optimization_state:'hypothesis|insufficient_evidence',
  }
}

export function validateCounterfactualAnalysis(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('manual_trade_review_counterfactual_invalid')
  return {
    output_contract_version:COUNTERFACTUAL_OUTPUT_VERSION,
    decision:enumValue(input.decision, ALLOWED_COUNTERFACTUAL_DECISION, 'insufficient_evidence', 'manual_trade_review_output_enum_invalid'),
    reasoning:text(input.reasoning), strategy_signals:array(input.strategy_signals, 20).map(value => text(value)).filter(Boolean),
    blocking_rules:array(input.blocking_rules, 20).map(value => text(value)).filter(Boolean),
    evidence_refs:array(input.evidence_refs, 30).map(value => text(value, 128)).filter(Boolean),
    confidence:Math.max(0, Math.min(1, Number(input.confidence) || 0)),
  }
}

function normalizeHypothesis(item, refs) {
  if (!item || typeof item !== 'object' || Array.isArray(item)) throw new Error('manual_trade_review_output_invalid')
  const supporting = [...new Set(array(item.supporting_trade_refs, 1).map(value => text(value, 128)).filter(Boolean))]
  if (!supporting.length || supporting.some(value => !refs.has(value))) throw new Error('manual_trade_review_output_reference_invalid')
  const targetPath = item.target_path == null ? null : text(item.target_path, 255)
  if (targetPath && !/^(strategy_policy_json|market_data_plan_json|entry_methods_json|symbols_json|use_chan_analysis|use_ema34_filter)(\.|\[|$)/.test(targetPath)) {
    throw new Error('manual_trade_review_output_rule_path_invalid')
  }
  return { hypothesis_id:text(item.hypothesis_id || item.candidate_id, 128) || `hypothesis_${sha256(JSON.stringify(item)).slice(0, 16)}`,
    target_path:targetPath, current_rule_summary:text(item.current_rule_summary), observed_gap:text(item.observed_gap || item.observed_manual_logic),
    proposed_change:text(item.proposed_change), supporting_trade_refs:supporting,
    counter_evidence:array(item.counter_evidence, 20).map(value => text(value)).filter(Boolean),
    applicable_when:boundedObject(item.applicable_when), risk_if_applied:text(item.risk_if_applied),
    confidence:Math.max(0, Math.min(1, Number(item.confidence) || 0)),
    state:enumValue(item.state, ALLOWED_HYPOTHESIS_STATE, 'hypothesis', 'manual_trade_review_output_enum_invalid'),
    validation_needed:text(item.validation_needed),
  }
}

function sourceRefs(sourceRows = []) { return new Set(sourceRows.map(row => String(row.source_identity_hash || '')).filter(Boolean)) }

function normalizeRuleComparison(item, strategySnapshot) {
  if (!item || typeof item !== 'object' || Array.isArray(item)) throw new Error('manual_trade_review_output_invalid')
  const path = item.rule_path == null ? null : text(item.rule_path, 255)
  const allowedPath = !path || /^(strategy_policy_json|market_data_plan_json|entry_methods_json|symbols_json|use_chan_analysis|use_ema34_filter)(\.|\[|$)/.test(path)
  if (!allowedPath) throw new Error('manual_trade_review_output_rule_path_invalid')
  return { rule_path:path, rule_summary:text(item.rule_summary), observed_evidence:text(item.observed_evidence),
    status:enumValue(item.status, new Set(['aligned', 'partial', 'conflict', 'unknown', 'not_applicable']), 'unknown', 'manual_trade_review_output_enum_invalid'),
    evidence_refs:array(item.evidence_refs, 30).map(value => text(value, 128)).filter(Boolean),
    frozen_strategy_version:Number(strategySnapshot.version || 1) }
}

export function validateManualTradeReviewContent(input, sourceRows = [], strategySnapshot = {}, { evidenceStatus = 'complete' } = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('manual_trade_review_output_invalid')
  const refs = sourceRefs(sourceRows)
  const sampleCount = sourceRows.length
  if (sampleCount !== 1) throw new Error('manual_trade_review_selection_invalid')
  const evidenceQuality = enumValue(input.evidence_quality, ALLOWED_EVIDENCE,
    evidenceStatus === 'complete' ? 'complete' : 'insufficient', 'manual_trade_review_output_enum_invalid')
  if (evidenceStatus !== 'complete' && evidenceQuality === 'complete') {
    throw new Error('manual_trade_review_output_evidence_quality_invalid')
  }
  const evidenceComplete = evidenceStatus === 'complete' && evidenceQuality === 'complete'
  const strategyAlignment = enumValue(input.strategy_alignment, ALLOWED_ALIGNMENT, 'unknown', 'manual_trade_review_output_enum_invalid')
  const decisionQuality = enumValue(input.decision_quality, ALLOWED_DECISION, 'insufficient_evidence', 'manual_trade_review_output_enum_invalid')
  const counterfactual = validateCounterfactualAnalysis(input.counterfactual_analysis)
  const content = {
    output_contract_version:REVIEW_OUTPUT_VERSION,
    evidence_quality:evidenceQuality,
    review_summary:text(input.review_summary),
    strategy_alignment:strategyAlignment,
    decision_quality:decisionQuality,
    counterfactual_match:enumValue(input.counterfactual_match, ALLOWED_COUNTERFACTUAL_MATCH,
      'insufficient_evidence', 'manual_trade_review_output_enum_invalid'),
    counterfactual_analysis:counterfactual,
    why_profitable:text(input.why_profitable),
    profit_attribution:{ market_fit:text(input.profit_attribution?.market_fit), entry_quality:text(input.profit_attribution?.entry_quality),
      exit_quality:text(input.profit_attribution?.exit_quality), luck_or_uncontrolled_factors:text(input.profit_attribution?.luck_or_uncontrolled_factors) },
    outcome_independence_note:text(input.outcome_independence_note),
    rule_comparisons:array(input.rule_comparisons, 50).map(item => normalizeRuleComparison(item, strategySnapshot)),
    strengths:array(input.strengths, 20).map(value => text(value)).filter(Boolean),
    issues:array(input.issues, 20).map(value => text(value)).filter(Boolean),
    strategy_optimization_hypotheses:array(input.strategy_optimization_hypotheses || input.strategy_optimization_candidates, MAX_CANDIDATES)
      .map(item => normalizeHypothesis(item, refs)),
    confidence:Math.max(0, Math.min(1, Number(input.confidence) || 0)),
  }
  if (!evidenceComplete) {
    content.strategy_optimization_hypotheses = content.strategy_optimization_hypotheses
      .map(item => ({ ...item, state:'insufficient_evidence', validation_needed:item.validation_needed || '补齐冻结行情证据后再人工评估' }))
  }
  return content
}

async function getPlatformStrategySnapshot(actor, strategyId) {
  managerOrThrow(actor)
  const strategy = await queryOne(`SELECT * FROM auto_prompt_types
    WHERE id = ? AND scope = 'platform' AND deleted_at IS NULL
      AND is_active = 1 AND visibility_status = 'active' LIMIT 1`, [id(strategyId, 'strategy_not_found')])
  if (!strategy) throw new Error('platform_strategy_required')
  const snapshot = {
    id:Number(strategy.id), title:text(strategy.title, 100), description:text(strategy.description), version:Number(strategy.version || 1), scope:'platform', owner_user_id:0,
    system_prompt:text(strategy.system_prompt, 50_000), symbols:parse(strategy.symbols_json, []), market_data_plan:parse(strategy.market_data_plan_json, {}),
    strategy_policy:parse(strategy.strategy_policy_json, {}), entry_methods:parse(strategy.entry_methods_json, []), use_chan_analysis:Boolean(Number(strategy.use_chan_analysis)),
    use_ema34_filter:Boolean(Number(strategy.use_ema34_filter)), include_portfolio_context:Boolean(Number(strategy.include_portfolio_context)),
  }
  return { row:strategy, snapshot, hash:jsonHash(snapshot) }
}

async function getCaseForActor(caseId, actorId, { forUpdate = false } = {}) {
  const suffix = forUpdate ? ' FOR UPDATE' : ''
  return queryOne(`SELECT cases.*, jobs.id AS job_id, jobs.status AS job_status, jobs.progress_stage,
      jobs.attempt_count, jobs.max_attempts, jobs.last_error_code, jobs.next_attempt_at,
      jobs.lease_expires_at, jobs.completed_at, jobs.model_task_id
    FROM manual_trade_review_cases cases
    LEFT JOIN manual_trade_review_jobs jobs ON jobs.case_id = cases.id
    WHERE cases.id = ? AND cases.user_id = ?${suffix}`, [caseId, actorId])
}

function publicCase(row) {
  if (!row) return null
  return { id:Number(row.id), user_id:Number(row.user_id), trading_account_id:Number(row.trading_account_id), strategy_id:Number(row.strategy_id), strategy_version:Number(row.strategy_version), strategy_scope:row.strategy_scope,
    strategy_snapshot_hash:row.strategy_snapshot_hash, selection_hash:row.selection_hash, evidence_status:row.evidence_status, evidence_reason:row.evidence_reason, status:row.status,
    current_version_id:row.current_version_id == null ? null : Number(row.current_version_id), approved_version_id:row.approved_version_id == null ? null : Number(row.approved_version_id),
    created_at:row.created_at, updated_at:row.updated_at, job_status:row.job_status || null, progress_stage:row.progress_stage || null, attempt_count:Number(row.attempt_count || 0),
    last_error_code:row.last_error_code || null }
}

export async function listManualTradeReviewStrategies(actor) {
  managerOrThrow(actor)
  return queryAll(`SELECT id, title, description, symbols_json, market_data_plan_json, strategy_policy_json,
      entry_methods_json, use_chan_analysis, use_ema34_filter, include_portfolio_context, version, scope
    FROM auto_prompt_types WHERE scope = 'platform' AND deleted_at IS NULL AND visibility_status = 'active' AND is_active = 1
    ORDER BY sort_order, id`)
}

export async function listEligibleManualTradeReviews(actor, params = {}) {
  managerOrThrow(actor)
  return listEligibleManualTrades(actor, params)
}

export async function createManualTradeReview(actor, input = {}, options = {}) {
  const actorId = managerOrThrow(actor)
  const clientRequestId = text(input.client_request_id || input.clientRequestId, 191)
  if (!clientRequestId) throw new Error('manual_trade_review_client_request_id_required')
  const selected = validateManualTradeSelection(Array.isArray(input.trades) ? input.trades : [])
  const existing = await getCaseForActorByRequest(actorId, clientRequestId)
  if (existing) return { created:false, case:publicCase(existing) }
  const account = options.account || await getCurrentManualReviewAccount(actorId, input.trading_account_id)
  if (Number(input.trading_account_id || account.id) !== Number(account.id)) throw new Error('manual_trade_review_account_unavailable')
  const strategy = options.strategy || await getPlatformStrategySnapshot(actor, input.strategy_id)
  const evidence = options.evidence || await readManualTradeEvidence(actor, account, selected, { ...options, strategySnapshot:strategy.snapshot })
  if (!evidence || !Array.isArray(evidence.trades) || evidence.evidence_status === 'unavailable') {
    throw new Error('manual_trade_review_evidence_unavailable')
  }
  const thesis = sanitizeThesis(input.user_thesis_text || input.user_thesis)
  const selectionHash = jsonHash(selected.map(item => ({ source_identity_hash:item.source_identity_hash || item.trade_id, trade_source_hash:item.trade_source_hash })).sort((a, b) => a.source_identity_hash.localeCompare(b.source_identity_hash)))
  const evidenceHash = jsonHash(evidence)
  const tradeHashByIdentity = new Map((evidence.trade_source_hashes || []).map(item => [
    String(item.source_identity_hash || ''), String(item.trade_source_hash || ''),
  ]).filter(([identity, hash]) => identity && hash))
  const caseEvidenceStatus = evidence.evidence_status === 'complete' && evidence.market_data?.status === 'complete' ? 'complete' : 'partial'
  const caseEvidenceReason = caseEvidenceStatus === 'complete' ? null : 'market_evidence_unavailable'
  const now = beijingNow()
  const result = await withTransaction(async run => {
    const [duplicates] = await run('SELECT * FROM manual_trade_review_cases WHERE user_id = ? AND client_request_id = ? FOR UPDATE', [actorId, clientRequestId])
    if (duplicates?.[0]) return { created:false, id:Number(duplicates[0].id) }
    const [insert] = await run(`INSERT INTO manual_trade_review_cases
      (client_request_id, user_id, trading_account_id, strategy_id, strategy_version, strategy_scope,
       strategy_snapshot_json, strategy_snapshot_hash, user_thesis_text, user_thesis_hash, selection_hash,
       evidence_json, evidence_hash, evidence_status, evidence_reason, status, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, 'platform', ?, ?, ?, ?, ?, ?, ?, ?, ?, 'queued', ?, ?)`,
    [clientRequestId, actorId, account.id, strategy.snapshot.id, strategy.snapshot.version, JSON.stringify(strategy.snapshot), strategy.hash, thesis,
      thesis ? sha256(thesis) : null, selectionHash, JSON.stringify(evidence), evidenceHash, caseEvidenceStatus, caseEvidenceReason, now, now])
    for (const trade of evidence.trades) {
      await run(`INSERT INTO manual_trade_review_sources
        (case_id, source_identity_hash, trade_source_hash, trading_account_id, terminal_instance_id, broker_server, login_account,
         position_id, entry_order_ticket, entry_time_utc_msc, close_time_utc_msc, symbol, direction, normalized_trade_json,
         manual_classification_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [insert.insertId, trade.identity?.identity_hash || trade.source_identity_hash || trade.identity_hash || sha256(trade),
        tradeHashByIdentity.get(String(trade.identity?.identity_hash || trade.source_identity_hash || trade.identity_hash || '')) || normalizedTradeHash(trade), account.id, account.terminal_instance_id, account.broker_server, account.login_account,
        trade.identity?.position_id || trade.position_id || null, trade.identity?.entry_order_ticket || trade.entry_order_ticket || null, trade.entry_time_utc_msc, trade.close_time_utc_msc,
        trade.symbol, trade.direction, JSON.stringify(trade), JSON.stringify(trade.manual_classification || trade.normalized?.manual_classification || { source:'manual', evidence_status:'complete' }), now])
    }
    const jobKey = `manual:${insert.insertId}:${evidenceHash}:${strategy.hash}:${thesis ? sha256(thesis) : 'none'}:${REVIEW_OUTPUT_VERSION}`
    await run(`INSERT INTO manual_trade_review_jobs
      (case_id, idempotency_key, status, progress_stage, attempt_count, max_attempts, created_at, updated_at)
      VALUES (?, ?, 'queued', 'queued', 0, 3, ?, ?)`, [insert.insertId, jobKey, now, now])
    return { created:true, id:Number(insert.insertId) }
  })
  const saved = await getCaseForActor(result.id, actorId)
  return { created:result.created, case:publicCase(saved) }
}

async function getCaseForActorByRequest(actorId, clientRequestId) {
  return queryOne(`SELECT cases.*, jobs.status AS job_status, jobs.progress_stage, jobs.attempt_count, jobs.max_attempts,
      jobs.last_error_code, jobs.next_attempt_at FROM manual_trade_review_cases cases
      LEFT JOIN manual_trade_review_jobs jobs ON jobs.case_id = cases.id
      WHERE cases.user_id = ? AND cases.client_request_id = ? LIMIT 1`, [actorId, clientRequestId])
}

export async function listManualTradeReviews(actor, params = {}) {
  const actorId = managerOrThrow(actor)
  const limit = Math.min(100, Math.max(1, Number(params.limit) || 20))
  const offset = Math.max(0, Number(params.offset) || 0)
  const rows = await queryAll(`SELECT cases.*, jobs.status AS job_status, jobs.progress_stage, jobs.attempt_count,
      jobs.max_attempts, jobs.last_error_code, jobs.next_attempt_at
    FROM manual_trade_review_cases cases LEFT JOIN manual_trade_review_jobs jobs ON jobs.case_id = cases.id
    WHERE cases.user_id = ? ORDER BY cases.updated_at DESC, cases.id DESC LIMIT ? OFFSET ?`, [actorId, limit, offset])
  return { cases:rows.map(publicCase), pagination:{ limit, offset, next_offset:offset + rows.length, has_more:rows.length === limit } }
}

export async function getManualTradeReview(caseId, actor) {
  const actorId = managerOrThrow(actor)
  const row = await getCaseForActor(id(caseId, 'manual_trade_review_not_found'), actorId)
  if (!row) throw new Error('manual_trade_review_not_found')
  const [sources, versions] = await Promise.all([
    queryAll(`SELECT sources.id, sources.source_identity_hash, sources.trade_source_hash, sources.trading_account_id, sources.terminal_instance_id,
        position_id, entry_order_ticket, entry_time_utc_msc, close_time_utc_msc, symbol, direction,
        normalized_trade_json, manual_classification_json, sources.created_at FROM manual_trade_review_sources sources
      JOIN manual_trade_review_cases cases ON cases.id = sources.case_id
      WHERE sources.case_id = ? AND cases.user_id = ? ORDER BY sources.id`, [row.id, actorId]),
    queryAll(`SELECT versions.id, versions.version_no, versions.parent_version_id, versions.author_type, versions.author_user_id, versions.content_json, versions.content_hash,
        versions.change_note, versions.created_at FROM manual_trade_review_versions versions
      JOIN manual_trade_review_cases cases ON cases.id = versions.case_id
      WHERE versions.case_id = ? AND cases.user_id = ? ORDER BY versions.version_no`, [row.id, actorId]),
  ])
  const snapshot = parse(row.strategy_snapshot_json, {})
  const evidence = parse(row.evidence_json, {})
  return { ...publicCase(row), strategy_snapshot:snapshot, evidence:{ ...evidence, trades:undefined }, sources:sources.map(source => ({ ...source,
    normalized_trade:parse(source.normalized_trade_json, null), manual_classification:parse(source.manual_classification_json, null), normalized_trade_json:undefined, manual_classification_json:undefined })),
    versions:versions.map(version => ({ ...version, content:parse(version.content_json, {}), content_json:undefined })) }
}

export async function getManualTradeReviewJobStatus(caseId, actor) {
  const actorId = managerOrThrow(actor)
  const row = await getCaseForActor(id(caseId, 'manual_trade_review_not_found'), actorId)
  if (!row) throw new Error('manual_trade_review_not_found')
  return { id:Number(row.job_id || 0) || null, case_id:Number(row.id), status:row.job_status || null, progress_stage:row.progress_stage || null,
    attempt_count:Number(row.attempt_count || 0), max_attempts:Number(row.max_attempts || 3), last_error_code:row.last_error_code || null,
    next_attempt_at:row.next_attempt_at || null, completed_at:row.completed_at || null }
}

export async function editManualTradeReview({ caseId, actor, content, expectedVersionId = null, changeNote = null } = {}) {
  const actorId = managerOrThrow(actor)
  const idValue = id(caseId, 'manual_trade_review_not_found')
  const result = await withTransaction(async run => {
    const [rows] = await run(`SELECT * FROM manual_trade_review_cases WHERE id = ? AND user_id = ? FOR UPDATE`, [idValue, actorId])
    const row = rows?.[0]
    if (!row) throw new Error('manual_trade_review_not_found')
    if (!['draft', 'edited', 'needs_revision'].includes(String(row.status))) throw new Error('manual_trade_review_edit_not_allowed')
    if (expectedVersionId != null && Number(expectedVersionId) !== Number(row.current_version_id || 0)) throw new Error('manual_trade_review_version_conflict')
    if (row.current_version_id) {
      const [currentVersions] = await run(`SELECT content_json FROM manual_trade_review_versions
        WHERE id = ? AND case_id = ? FOR UPDATE`, [row.current_version_id, idValue])
      const frozenCounterfactual = parse(currentVersions?.[0]?.content_json, {})?.counterfactual_analysis
      const editedCounterfactual = content?.counterfactual_analysis
      if (frozenCounterfactual && jsonHash(frozenCounterfactual) !== jsonHash(editedCounterfactual)) {
        throw new Error('manual_trade_review_counterfactual_immutable')
      }
    }
    const [sources] = await run(`SELECT sources.source_identity_hash FROM manual_trade_review_sources sources
      JOIN manual_trade_review_cases cases ON cases.id = sources.case_id
      WHERE sources.case_id = ? AND cases.user_id = ?`, [idValue, actorId])
    const normalized = validateManualTradeReviewContent(content, sources, parse(row.strategy_snapshot_json, {}), { evidenceStatus:row.evidence_status })
    const [maxRows] = await run(`SELECT COALESCE(MAX(versions.version_no), 0) AS version_no FROM manual_trade_review_versions versions
      JOIN manual_trade_review_cases cases ON cases.id = versions.case_id
      WHERE versions.case_id = ? AND cases.user_id = ?`, [idValue, actorId])
    const versionNo = Number(maxRows?.[0]?.version_no || 0) + 1
    const now = beijingNow()
    const hash = jsonHash(normalized)
    const [insert] = await run(`INSERT INTO manual_trade_review_versions
      (case_id, version_no, parent_version_id, author_type, author_user_id, content_json, content_hash, change_note, created_at)
      VALUES (?, ?, ?, 'user', ?, ?, ?, ?, ?)`, [idValue, versionNo, row.current_version_id || null, actorId, JSON.stringify(normalized), hash, text(changeNote, 500) || null, now])
    await run(`UPDATE manual_trade_review_cases SET current_version_id = ?, status = 'edited', updated_at = ? WHERE id = ? AND user_id = ?`, [insert.insertId, now, idValue, actorId])
    return { id:Number(insert.insertId), version_no:versionNo, content:normalized, content_hash:hash }
  })
  return { version:result, review:await getManualTradeReview(idValue, actor) }
}

export async function confirmManualTradeReview({ caseId, actor, versionId = null, action = 'approve' } = {}) {
  const actorId = managerOrThrow(actor)
  const idValue = id(caseId, 'manual_trade_review_not_found')
  if (!VALID_REVIEW_ACTIONS.has(action)) throw new Error('manual_trade_review_action_invalid')
  return withTransaction(async run => {
    const [rows] = await run('SELECT * FROM manual_trade_review_cases WHERE id = ? AND user_id = ? FOR UPDATE', [idValue, actorId])
    const row = rows?.[0]
    if (!row) throw new Error('manual_trade_review_not_found')
    const selectedVersion = Number(versionId || row.current_version_id || 0)
    if (!selectedVersion) throw new Error('manual_trade_review_version_required')
    const [versions] = await run(`SELECT versions.id, versions.content_json FROM manual_trade_review_versions versions
      JOIN manual_trade_review_cases cases ON cases.id = versions.case_id
      WHERE versions.id = ? AND versions.case_id = ? AND cases.user_id = ?`, [selectedVersion, idValue, actorId])
    if (!versions?.[0]) throw new Error('manual_trade_review_version_not_found')
    const now = beijingNow()
    const state = action === 'approve' ? 'approved' : action === 'mark_problem' ? 'needs_revision' : 'deferred'
    await run(`UPDATE manual_trade_review_cases SET status = ?, current_version_id = ?, approved_version_id = ?, updated_at = ?
      WHERE id = ? AND user_id = ?`, [state, selectedVersion, action === 'approve' ? selectedVersion : null, now, idValue, actorId])
    return { case_id:idValue, status:state, version_id:selectedVersion }
  })
}

export async function retryManualTradeReview(caseId, actor) {
  const actorId = managerOrThrow(actor)
  const idValue = id(caseId, 'manual_trade_review_not_found')
  const now = beijingNow()
  const result = await queryRun(`UPDATE manual_trade_review_jobs jobs
    JOIN manual_trade_review_cases cases ON cases.id = jobs.case_id
    SET jobs.status = 'queued', jobs.progress_stage = 'queued', jobs.attempt_count = 0, jobs.lease_token = NULL,
      jobs.lease_expires_at = NULL, jobs.last_error_code = NULL, jobs.next_attempt_at = NULL, jobs.updated_at = ?,
      cases.status = 'queued', cases.updated_at = ?
    WHERE jobs.case_id = ? AND cases.user_id = ? AND jobs.status IN ('failed','deferred')`, [now, now, idValue, actorId])
  if (!Number(result.changes || 0)) throw new Error('manual_trade_review_retry_not_allowed')
  requestManualTradeReviewCycle()
  return { queued:true, case_id:idValue }
}

async function claimManualTradeReviewJob() {
  const now = beijingNow()
  const token = crypto.randomUUID()
  return withTransaction(async run => {
    const [rows] = await run(`SELECT jobs.*, cases.user_id, cases.strategy_id, cases.status AS case_status
      FROM manual_trade_review_jobs jobs JOIN manual_trade_review_cases cases ON cases.id = jobs.case_id
      WHERE (jobs.status = 'queued' OR (jobs.status = 'leased' AND jobs.lease_expires_at < ?))
        AND (jobs.next_attempt_at IS NULL OR jobs.next_attempt_at <= ?)
      ORDER BY jobs.created_at, jobs.id LIMIT 1 FOR UPDATE`, [now, now])
    const row = rows?.[0]
    if (!row) return null
    const [updated] = await run(`UPDATE manual_trade_review_jobs SET status = 'leased', progress_stage = 'preparing',
      attempt_count = attempt_count + 1, lease_token = ?, lease_expires_at = ?, stage_updated_at = ?, updated_at = ?
      WHERE id = ? AND (status = 'queued' OR (status = 'leased' AND lease_expires_at < ?))`, [token, dateAfter(600), now, now, row.id, now])
    if (!updated.affectedRows) return null
    return { ...row, lease_token:token, attempt_count:Number(row.attempt_count || 0) + 1 }
  })
}

function counterfactualPrompt(reviewCase, sources) {
  const snapshot = parse(reviewCase.strategy_snapshot_json, {})
  const evidence = parse(reviewCase.evidence_json, {})
  const source = sources[0]
  const trade = parse(source?.normalized_trade_json, {})
  const path = evidence.market_data?.trades?.[source?.source_identity_hash]?.pre_entry || { status:'unavailable' }
  const contract = { output_contract_version:COUNTERFACTUAL_OUTPUT_VERSION,
    decision:'buy|sell|hold|insufficient_evidence', reasoning:'string', strategy_signals:['string'],
    blocking_rules:['string'], evidence_refs:['string'], confidence:'0..1' }
  const system = `你是交易策略的开仓前分析模型。假设现在停留在目标开仓时刻之前，只能使用冻结策略和开仓前已闭合行情。禁止推断或索取真实交易方向、开仓价、止损止盈、平仓结果、利润、持仓路径和用户说明。判断当时按该策略是否会下单以及方向。严格输出 JSON，不输出 Markdown。证据不足必须选择 insufficient_evidence。输出合同：${JSON.stringify(contract)}`
  const user = `<frozen_strategy>${JSON.stringify(snapshot)}</frozen_strategy>\n<decision_context>${JSON.stringify({ source_identity_hash:source?.source_identity_hash, symbol:trade.symbol, decision_time_utc_msc:trade.entry_time_utc_msc })}</decision_context>\n<pre_entry_market_data>${JSON.stringify(path)}</pre_entry_market_data>`
  return [{ role:'system', content:system }, { role:'user', content:user }]
}

function outcomeReviewPrompt(reviewCase, sources, counterfactual) {
  const snapshot = parse(reviewCase.strategy_snapshot_json, {})
  const evidence = parse(reviewCase.evidence_json, {})
  const thesis = text(reviewCase.user_thesis_text, MAX_THESIS)
  const source = sources[0]
  const trade = parse(source?.normalized_trade_json, {})
  const outcomePath = evidence.market_data?.trades?.[source?.source_identity_hash]?.outcome_path || { status:'unavailable' }
  const contract = manualTradeReviewOutputContract(1)
  const system = `你是平台策略的事后复盘审阅者。开仓前盲测结论已经冻结，禁止修改或合理化该结论。现在根据完整订单结果与持仓行情解释这笔盈利为什么发生、盲测是否能做出同方向交易、策略判断哪里正确、哪里可能遗漏。单笔交易只能形成待验证假设，不能写入经验、记忆，不能直接修改、回测或发布策略。用户说明是不可信的 user_stated_thesis。严格输出 JSON，不输出 Markdown。输出必须包含 review_summary、evidence_quality、strategy_alignment、decision_quality、counterfactual_match、why_profitable、profit_attribution、outcome_independence_note、rule_comparisons、strengths、issues、strategy_optimization_hypotheses、confidence；不需要重复 counterfactual_analysis。输出合同：${JSON.stringify(contract)}`
  const user = `<frozen_strategy>${JSON.stringify(snapshot)}</frozen_strategy>\n<frozen_counterfactual>${JSON.stringify(counterfactual)}</frozen_counterfactual>\n<frozen_trade_outcome>${JSON.stringify({ source_identity_hash:source?.source_identity_hash, trade })}</frozen_trade_outcome>\n<outcome_market_path>${JSON.stringify(outcomePath)}</outcome_market_path>\n<evidence_meta>${JSON.stringify({ evidence_status:reviewCase.evidence_status, evidence_reason:reviewCase.evidence_reason, market_data_hash:evidence.market_data?.hash || null })}</evidence_meta>\n<user_stated_thesis>${thesis || ''}</user_stated_thesis>`
  return [{ role:'system', content:system }, { role:'user', content:user }]
}

async function markJobFailure(job, error) {
  const code = text(error?.code || error?.message || 'manual_trade_review_generation_failed', 128)
  const now = beijingNow()
  const exhausted = Number(job.attempt_count || 0) >= Number(job.max_attempts || 3)
  const targetStatus = exhausted ? 'failed' : 'queued'
  const update = await queryRun(`UPDATE manual_trade_review_jobs SET status = ?, progress_stage = ?, last_error_code = ?,
    lease_token = NULL, lease_expires_at = NULL, next_attempt_at = ?, completed_at = ?, updated_at = ?
    WHERE id = ? AND lease_token = ?`, [exhausted ? 'failed' : 'queued', exhausted ? 'failed' : 'retry_wait', code,
    exhausted ? null : dateAfter(Math.min(900, 30 * Math.max(1, Number(job.attempt_count || 1)))), exhausted ? now : null, now, job.id, job.lease_token])
  // If another worker fenced this lease while the provider call was in
  // flight, do not let the stale worker overwrite the newer case status.
  if (Number(update?.affectedRows ?? update?.changes ?? 0) < 1) return false
  await queryRun(`UPDATE manual_trade_review_cases SET status = ?, evidence_reason = COALESCE(evidence_reason, ?), updated_at = ?
    WHERE id = ? AND status <> 'approved'
      AND EXISTS (SELECT 1 FROM manual_trade_review_jobs jobs
        WHERE jobs.id = ? AND jobs.status = ? AND jobs.last_error_code = ?)`, [targetStatus, code, now, job.case_id, job.id, targetStatus, code])
  return true
}

export async function runManualTradeReviewWorkerOnce({ requestModel = requestJsonObject } = {}) {
  const job = await claimManualTradeReviewJob()
  if (!job) return { status:'idle' }
  try {
    const reviewCase = await queryOne('SELECT * FROM manual_trade_review_cases WHERE id = ? AND user_id = ?', [job.case_id, job.user_id])
    if (!reviewCase) throw new Error('manual_trade_review_not_found')
    const sources = await queryAll(`SELECT sources.* FROM manual_trade_review_sources sources
      JOIN manual_trade_review_cases cases ON cases.id = sources.case_id
      WHERE sources.case_id = ? AND cases.user_id = ? ORDER BY sources.id`, [job.case_id, job.user_id])
    const resolved = await resolveAiTaskModel({ userId:job.user_id, strategyId:job.strategy_id, usage:'review' })
    if (!resolved.model) throw new Error(resolved.error || 'manual_trade_review_model_unavailable')
    const endpoint = modelEndpoint(resolved.model)
    const counterfactualMessages = counterfactualPrompt(reviewCase, sources)
    const counterfactualBudget = await prepareManualTradeReviewBudget(resolved, counterfactualMessages)
    await queryRun(`UPDATE manual_trade_review_jobs SET progress_stage = 'counterfactual_analysis', stage_updated_at = ?, updated_at = ?
      WHERE id = ? AND lease_token = ?`, [beijingNow(), beijingNow(), job.id, job.lease_token])
    const counterfactualRaw = await requestModel({ url:endpoint.url, apiKey:resolved.model.api_key_encrypted, provider:resolved.model.provider,
      model:resolved.model.model_name, temperature:Math.min(Number(resolved.model.temperature ?? 0.2), 0.3), maxTokens:counterfactualBudget.selectedMaxOutputTokens,
      thinkingEnabled:resolved.model.thinking_enabled, reasoningEffort:resolved.model.reasoning_effort, protocol:endpoint.protocol,
      messages:counterfactualMessages, modelTaskBudget:counterfactualBudget,
      usageContext:{ userId:job.user_id, profileId:resolved.model_profile_id, credentialSource:resolved.credential_source, usage:'review', strategyId:job.strategy_id },
      allowFollowupRequests:false,
      validateObject:validateCounterfactualAnalysis })
    const counterfactual = validateCounterfactualAnalysis(counterfactualRaw)
    await queryRun(`UPDATE manual_trade_review_jobs SET progress_stage = 'outcome_review', stage_updated_at = ?, updated_at = ?
      WHERE id = ? AND lease_token = ?`, [beijingNow(), beijingNow(), job.id, job.lease_token])
    const outcomeMessages = outcomeReviewPrompt(reviewCase, sources, counterfactual)
    const outcomeBudget = await prepareManualTradeReviewBudget(resolved, outcomeMessages)
    const outcomeRaw = await requestModel({ url:endpoint.url, apiKey:resolved.model.api_key_encrypted, provider:resolved.model.provider,
      model:resolved.model.model_name, temperature:Math.min(Number(resolved.model.temperature ?? 0.2), 0.3), maxTokens:outcomeBudget.selectedMaxOutputTokens,
      thinkingEnabled:resolved.model.thinking_enabled, reasoningEffort:resolved.model.reasoning_effort, protocol:endpoint.protocol,
      messages:outcomeMessages, modelTaskBudget:outcomeBudget,
      usageContext:{ userId:job.user_id, profileId:resolved.model_profile_id, credentialSource:resolved.credential_source, usage:'review', strategyId:job.strategy_id },
      allowFollowupRequests:false,
      validateObject:value => validateManualTradeReviewContent({ ...value, counterfactual_analysis:counterfactual }, sources,
        parse(reviewCase.strategy_snapshot_json, {}), { evidenceStatus:reviewCase.evidence_status }) })
    const content = validateManualTradeReviewContent({ ...outcomeRaw, counterfactual_analysis:counterfactual }, sources,
      parse(reviewCase.strategy_snapshot_json, {}), { evidenceStatus:reviewCase.evidence_status })
    const contentHash = jsonHash(content)
    const now = beijingNow()
    await withTransaction(async run => {
      const [rows] = await run('SELECT status, lease_token, current_version_id FROM manual_trade_review_cases WHERE id = ? AND user_id = ? FOR UPDATE', [job.case_id, job.user_id])
      const current = rows?.[0]
      if (!current || String(current.status) === 'approved') throw new Error('manual_trade_review_lease_lost')
      const [lease] = await run('SELECT id FROM manual_trade_review_jobs WHERE id = ? AND lease_token = ? AND status = \'leased\' FOR UPDATE', [job.id, job.lease_token])
      if (!lease?.[0]) throw new Error('manual_trade_review_lease_lost')
      const [versions] = await run(`SELECT COALESCE(MAX(versions.version_no), 0) AS version_no FROM manual_trade_review_versions versions
        JOIN manual_trade_review_cases cases ON cases.id = versions.case_id
        WHERE versions.case_id = ? AND cases.user_id = ?`, [job.case_id, job.user_id])
      const versionNo = Number(versions?.[0]?.version_no || 0) + 1
      const [insert] = await run(`INSERT INTO manual_trade_review_versions
        (case_id, version_no, parent_version_id, author_type, author_user_id, content_json, content_hash, change_note, created_at)
        VALUES (?, ?, ?, 'model', NULL, ?, ?, NULL, ?)`, [job.case_id, versionNo, current.current_version_id || null, JSON.stringify(content), contentHash, now])
      await run(`UPDATE manual_trade_review_cases SET current_version_id = ?, status = 'draft', updated_at = ?
        WHERE id = ? AND user_id = ?`, [insert.insertId, now, job.case_id, job.user_id])
      await run(`UPDATE manual_trade_review_jobs SET status = 'succeeded', progress_stage = 'completed', lease_token = NULL,
        lease_expires_at = NULL, completed_at = ?, updated_at = ? WHERE id = ? AND lease_token = ?`, [now, now, job.id, job.lease_token])
    })
    return { status:'succeeded', case_id:Number(job.case_id) }
  } catch (error) {
    await markJobFailure(job, error)
    return { status:'failed', case_id:Number(job.case_id), error:String(error?.code || error?.message || 'manual_trade_review_generation_failed') }
  }
}

export async function recoverAbandonedManualTradeReviewJobs({ now = beijingNow(), limit = 100 } = {}) {
  const rows = await queryAll(`SELECT id, case_id, attempt_count, max_attempts, progress_stage FROM manual_trade_review_jobs
    WHERE status = 'leased' AND lease_expires_at < ? ORDER BY id LIMIT ?`, [now, Math.min(500, Math.max(1, Number(limit) || 100))])
  let requeued = 0; let failed = 0; let manualRetryRequired = 0
  for (const job of rows) {
    // A provider request may have completed after the process lost its lease.
    // Without a durable model-task id/result fence, never automatically send
    // an expired generating request again; require an explicit user retry.
    const generationExpired = ['generating', 'counterfactual_analysis', 'outcome_review'].includes(String(job.progress_stage || ''))
    const exhausted = generationExpired || Number(job.attempt_count || 0) >= Number(job.max_attempts || 3)
    if (generationExpired) manualRetryRequired++
    const errorCode = generationExpired
      ? 'manual_trade_review_generation_expired_manual_retry_required'
      : 'manual_trade_review_worker_recovered'
    const result = await queryRun(`UPDATE manual_trade_review_jobs SET status = ?, progress_stage = ?, lease_token = NULL,
      lease_expires_at = NULL, last_error_code = ?, next_attempt_at = ?, completed_at = ?, updated_at = ?
      WHERE id = ? AND status = 'leased' AND lease_expires_at < ?`, [exhausted ? 'failed' : 'queued', exhausted ? 'failed' : 'queued',
      errorCode, exhausted ? null : now, exhausted ? now : null, now, job.id, now])
    if (Number(result.changes || 0)) {
      if (exhausted) failed++; else requeued++
      await queryRun(`UPDATE manual_trade_review_cases cases
        JOIN manual_trade_review_jobs jobs ON jobs.id = ? AND jobs.case_id = cases.id
        SET cases.status = ?, cases.updated_at = ?
        WHERE cases.status NOT IN ('approved','superseded') AND jobs.status = ?`, [job.id, exhausted ? 'failed' : 'queued', now, exhausted ? 'failed' : 'queued'])
    }
  }
  return { scanned:rows.length, requeued, failed, manual_retry_required:manualRetryRequired }
}

export function requestManualTradeReviewCycle() {
  if (manualReviewWake) return
  manualReviewWake = true
  setImmediate(async () => {
    manualReviewWake = false
    if (manualReviewRunning) return
    manualReviewRunning = true
    try { await recoverAbandonedManualTradeReviewJobs(); await runManualTradeReviewWorkerOnce() }
    catch (error) { console.error('[ManualTradeReview] worker cycle failed:', error.message) }
    finally { manualReviewRunning = false }
  })
}

export function startManualTradeReviewWorker(intervalMs = 60_000) {
  if (manualReviewTimer) return false
  requestManualTradeReviewCycle()
  manualReviewTimer = setInterval(requestManualTradeReviewCycle, Math.max(10_000, Number(intervalMs) || 60_000))
  manualReviewTimer.unref?.()
  return true
}

export function stopManualTradeReviewWorker() {
  if (!manualReviewTimer) return false
  clearInterval(manualReviewTimer); manualReviewTimer = null; manualReviewWake = false
  return true
}

export const __manualTradeReviewTest = { parse, getPlatformStrategySnapshot, counterfactualPrompt, outcomeReviewPrompt }
