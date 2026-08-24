import crypto from 'node:crypto'
import { beijingNow, queryAll, queryOne, queryRun, withTransaction } from '../../db.js'
import { canManagePlatformAiContent } from './platform-content-access.js'
import { requestJsonObject } from './llm.js'
import { createModelTaskTracker } from './model-task-tracker.js'
import { markModelTaskSucceededFromResult, reconcileModelTaskResultInTransaction } from './model-task-runtime.js'
import { estimateModelInputTokens, modelTaskDeadlines, selectModelTaskBudget } from './model-task-budget.js'
import { getModelProviderCapabilities } from './model-provider-capabilities.js'
import { MODEL_PROVIDER_DEFAULTS, modelProviderProtocol } from './model-providers.js'
import { resolveAiTaskModel } from './model-profiles.js'
import { sha256 } from './inference-snapshots.js'
import { getCurrentManualReviewAccount, listEligibleManualTrades, readManualTradeEvidence, normalizedTradeHash, MANUAL_TRADE_SELECTION_MAX } from './manual-trade-evidence.js'
import { verifyManualTradeSelectionContext } from './manual-trade-selection-context.js'
import { buildManualReviewEvidenceCatalog, requiredManualReviewArray, requiredManualReviewConfidence,
  requiredManualReviewEnum, requiredManualReviewObject, requiredManualReviewText, validateFrozenStrategyPath,
  validateManualReviewEvidenceRefs } from './manual-trade-review-contract.js'
import { createStrategyMemoryInjectionLog, getStrategyMemoryLibraryForRuntime } from './strategy-memory-library.js'
import { createManualTradeReviewPrompts } from './manual-trade-review-prompts.js'
import {
  ensureManualTradeReviewCounterfactualPoints,
  readManualTradeReviewCounterfactualPoints,
  linkManualTradeReviewCounterfactualPointModelTask,
  saveManualTradeReviewCounterfactualPointOutput,
  markManualTradeReviewCounterfactualPointUnknown,
  markManualTradeReviewCounterfactualPointFailed,
} from './manual-trade-review-counterfactual-points.js'
import {
  MANUAL_TRADE_REVIEW_COUNTERFACTUAL_POINT_V3_VERSION,
  MANUAL_TRADE_REVIEW_V3_VERSION,
  deriveManualTradeReviewDeclaredTimeframes,
  deriveManualTradeReviewEvidenceTimeframes,
  deriveManualTradeReviewDirectionSummary,
  evaluateManualTradeReviewProtectionPlan,
  normalizeManualTradeReviewCounterfactualPoint,
  normalizeManualTradeReviewV3Content,
} from './manual-trade-review-v3-contract.js'
import { buildFrozenRuntime, buildManualTradeReviewStageInputHash, ensureManualTradeReviewStageRuns,
  linkManualTradeReviewStageModelTask, normalizeManualTradeReviewStageOutput,
  readManualTradeReviewStageRuns, saveManualTradeReviewStageOutput, validateManualTradeReviewStageRuns } from './manual-trade-review-stage-runs.js'

const REVIEW_OUTPUT_VERSION = 'manual-trade-review-v2'
const COUNTERFACTUAL_OUTPUT_VERSION = 'manual-trade-counterfactual-v1'
const REVIEW_V3_OUTPUT_VERSION = MANUAL_TRADE_REVIEW_V3_VERSION
const COUNTERFACTUAL_POINT_V3_OUTPUT_VERSION = MANUAL_TRADE_REVIEW_COUNTERFACTUAL_POINT_V3_VERSION
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
const MANUAL_TRADE_HASH_PATTERN = /^[0-9a-f]{64}$/i
const MANUAL_TRADE_REFERENCE_PATTERN = /^(?!0+$)\d{1,32}$/
const MANUAL_TRADE_REVIEW_TASK_DEADLINE_MS = 30 * 60_000
const MANUAL_TRADE_REVIEW_V3_POINT_DEADLINE_MS = 15 * 60_000
const MANUAL_TRADE_REVIEW_MAX_DEADLINE_MS = 120 * 60_000
const MODEL_TASK_TERMINAL_STATES = new Set(['cancelled', 'failed_terminal', 'succeeded', 'completed_stale', 'completed_rejected'])
const MODEL_TASK_ACTIVE_STATES = new Set(['leased', 'preparing', 'submitted', 'provider_running', 'provider_quiet',
  'status_unknown', 'reconciling', 'response_received', 'validating', 'repairing', 'result_ready', 'applying'])

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

const {
  counterfactualPrompt, outcomeReviewPrompt, counterfactualPointPrompt, outcomeReviewV3Prompt,
} = createManualTradeReviewPrompts({
  parse, text, buildManualReviewEvidenceCatalog, manualTradeReviewOutputContract,
  counterfactualOutputVersion:COUNTERFACTUAL_OUTPUT_VERSION, maxThesis:MAX_THESIS,
  counterfactualPointOutputVersion:COUNTERFACTUAL_POINT_V3_OUTPUT_VERSION,
  manualTradeReviewV3OutputVersion:REVIEW_V3_OUTPUT_VERSION,
})

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

function dateAtUtcMs(utcMs) {
  const timestamp = Number(utcMs)
  if (!Number.isFinite(timestamp) || timestamp <= 0) return null
  const date = new Date(timestamp + 8 * 3600_000)
  return Number.isFinite(date.getTime()) ? date.toISOString().replace('T', ' ').slice(0, 19) : null
}

function parseBeijingDateTime(value) {
  if (!value) return null
  const date = new Date(`${String(value).replace(' ', 'T')}+08:00`)
  return Number.isFinite(date.getTime()) ? date.getTime() : null
}

function manualTradeReviewFrozenCandidateCount(evidence = {}) {
  const paths = Object.values(evidence?.market_data?.trades || {})
  let count = 0
  for (const path of paths) {
    const supplied = path?.counterfactual_points ?? path?.candidate_points
    const values = Array.isArray(supplied) ? supplied
      : supplied && typeof supplied === 'object' ? Object.values(supplied) : []
    count += values.length
  }
  return Math.min(5, Math.max(0, count))
}

function manualTradeReviewDeadlineMs(evidence = {}) {
  const explicitV3 = evidence?.review_contract_version === MANUAL_TRADE_REVIEW_V3_VERSION
  const hasV3Shape = Object.values(evidence?.market_data?.trades || {}).some(path => path && (
    Object.prototype.hasOwnProperty.call(path, 'counterfactual_points')
    || Object.prototype.hasOwnProperty.call(path, 'candidate_points')))
  if (!explicitV3 && !hasV3Shape) return MANUAL_TRADE_REVIEW_TASK_DEADLINE_MS
  return Math.min(MANUAL_TRADE_REVIEW_MAX_DEADLINE_MS,
    MANUAL_TRADE_REVIEW_TASK_DEADLINE_MS
      + manualTradeReviewFrozenCandidateCount(evidence) * MANUAL_TRADE_REVIEW_V3_POINT_DEADLINE_MS)
}

function newManualTradeReviewDeadline(evidence = {}) {
  return dateAfter(manualTradeReviewDeadlineMs(evidence) / 1000)
}

function assertManualTradeReviewRequestTime(job) {
  const deadlineAtMs = parseBeijingDateTime(job?.task_deadline_at)
  if (!deadlineAtMs) throw new Error('manual_trade_review_deadline_missing')
  if (deadlineAtMs <= Date.now()) {
    const error = new Error('manual_trade_review_generation_deadline_exceeded')
    error.code = error.message
    throw error
  }
  return deadlineAtMs
}

function manualTradeReviewModelIdempotencyKey(job) {
  return `manual_trade_review:${Number(job.id)}:${Number(job.generation_no || 1)}`
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
    providerOutputCap:capabilities.max_output_tokens,
    contextWindowTokens:capabilities.context_window_tokens,
    maxInputTokens:capabilities.max_input_tokens ?? capabilities.provider_max_input_tokens,
    contextLimitSemantics:capabilities.context_limit_semantics,
    capabilities,
    profile:resolved?.model,
    estimatedInputTokens:estimateModelInputTokens(messages),
    schemaNeedTokens:0,
  })
  if (budget.reason === 'model_token_limits_unconfirmed' || budget.reason === 'model_token_limits_stale') {
    const error = new Error(budget.reason)
    error.code = error.message
    throw error
  }
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

function manualTradeHash(value) {
  if (typeof value !== 'string') throw new Error('manual_trade_review_selection_invalid')
  const normalized = value.trim()
  if (!MANUAL_TRADE_HASH_PATTERN.test(normalized)) throw new Error('manual_trade_review_selection_invalid')
  return normalized.toLowerCase()
}

function manualTradeReference(value) {
  if (value == null) return null
  if (typeof value !== 'string') throw new Error('manual_trade_review_selection_reference_invalid')
  const normalized = value.trim()
  if (!MANUAL_TRADE_REFERENCE_PATTERN.test(normalized)) {
    throw new Error('manual_trade_review_selection_reference_invalid')
  }
  return normalized
}

export function validateManualTradeSelection(selected = []) {
  if (!Array.isArray(selected) || !selected.length || selected.length > MANUAL_TRADE_SELECTION_MAX) {
    throw new Error('manual_trade_review_selection_invalid')
  }
  const normalized = selected.map(item => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      throw new Error('manual_trade_review_selection_invalid')
    }
    // `trade_id` remains a compatibility alias only when the canonical
    // source identity hash is absent. The server always emits both canonical
    // hash fields so downstream evidence reads cannot depend on the alias.
    const sourceIdentityValue = item.source_identity_hash == null || String(item.source_identity_hash).trim() === ''
      ? item.trade_id : item.source_identity_hash
    const sourceIdentityHash = manualTradeHash(sourceIdentityValue)
    const tradeSourceHash = manualTradeHash(item.trade_source_hash)
    const positionId = manualTradeReference(item.position_id)
    const entryOrderTicket = manualTradeReference(item.entry_order_ticket)
    if (!positionId && !entryOrderTicket) {
      throw new Error('manual_trade_review_selection_reference_invalid')
    }
    return {
      trade_id:sourceIdentityHash,
      source_identity_hash:sourceIdentityHash,
      trade_source_hash:tradeSourceHash,
      position_id:positionId,
      entry_order_ticket:entryOrderTicket,
    }
  })
  const identities = normalized.map(item => item.source_identity_hash)
  const hashes = normalized.map(item => item.trade_source_hash)
  if (identities.some(value => !value) || new Set(identities).size !== identities.length
    || hashes.some(value => !value) || new Set(hashes).size !== hashes.length) {
    throw new Error('manual_trade_review_selection_duplicate')
  }
  return normalized
}

export function manualTradeReviewOutputContract(sampleCount = 1) {
  return {
    output_contract_version:REVIEW_OUTPUT_VERSION,
    counterfactual_analysis:{ output_contract_version:COUNTERFACTUAL_OUTPUT_VERSION,
      decision:'buy|sell|hold|insufficient_evidence', reasoning:'non-empty string', strategy_signals:['string'],
      blocking_rules:['string'], evidence_refs:['allowed pre-entry evidence ref'], confidence:'number 0..1' },
    evidence_quality:'complete|insufficient; must match frozen evidence status',
    strategy_alignment:'aligned|partial|misaligned|conflict|unknown',
    decision_quality:'good|mixed|poor|insufficient_evidence',
    counterfactual_match:'same_direction|hold|opposite_direction|insufficient_evidence',
    review_summary:'non-empty string', why_profitable:'non-empty string',
    profit_attribution:{ market_fit:'non-empty string', entry_quality:'non-empty string',
      exit_quality:'non-empty string', luck_or_uncontrolled_factors:'non-empty string' },
    outcome_independence_note:'non-empty string',
    rule_comparisons:[{ rule_path:'existing frozen strategy path or null only when status is unknown/not_applicable',
      rule_summary:'non-empty string', observed_evidence:'non-empty string',
      status:'aligned|partial|conflict|unknown|not_applicable', evidence_refs:['allowed outcome evidence ref'] }],
    strengths:['string'], issues:['string'],
    strategy_optimization_hypotheses:[{ target_path:'existing frozen strategy path', supporting_trade_refs:['source identity hash'],
      current_rule_summary:'non-empty string', observed_gap:'non-empty string', proposed_change:'non-empty string',
      counter_evidence:['string'], applicable_when:{}, risk_if_applied:'non-empty string',
      validation_needed:'non-empty string', confidence:'number 0..1',
      state:'hypothesis|insufficient_evidence' }],
    confidence:'number 0..1',
    allowed_strategy_roots:['strategy_policy', 'market_data_plan', 'entry_methods', 'symbols', 'use_chan_analysis'],
    strategy_optimization_state:'hypothesis|insufficient_evidence',
  }
}

export function validateCounterfactualAnalysis(input, { allowedEvidenceRefs = null } = {}) {
  requiredManualReviewObject(input, 'counterfactual_analysis')
  return {
    output_contract_version:COUNTERFACTUAL_OUTPUT_VERSION,
    decision:requiredManualReviewEnum(input.decision, ALLOWED_COUNTERFACTUAL_DECISION),
    reasoning:requiredManualReviewText(input.reasoning, 'counterfactual_reasoning'),
    strategy_signals:requiredManualReviewArray(input.strategy_signals, 'strategy_signals', 20)
      .map(value => requiredManualReviewText(value, 'strategy_signal')),
    blocking_rules:requiredManualReviewArray(input.blocking_rules, 'blocking_rules', 20)
      .map(value => requiredManualReviewText(value, 'blocking_rule')),
    evidence_refs:allowedEvidenceRefs == null
      ? validateManualReviewEvidenceRefs(requiredManualReviewArray(input.evidence_refs, 'evidence_refs', 30), input.evidence_refs, { required:true })
      : validateManualReviewEvidenceRefs(requiredManualReviewArray(input.evidence_refs, 'evidence_refs', 30), allowedEvidenceRefs, { required:true }),
    confidence:requiredManualReviewConfidence(input.confidence),
  }
}

function normalizeHypothesis(item, refs, strategySnapshot) {
  if (!item || typeof item !== 'object' || Array.isArray(item)) throw new Error('manual_trade_review_output_invalid')
  const supporting = [...new Set(requiredManualReviewArray(item.supporting_trade_refs, 'supporting_trade_refs', 1)
    .map(value => requiredManualReviewText(value, 'supporting_trade_ref', 128)))]
  if (!supporting.length || supporting.some(value => !refs.has(value))) throw new Error('manual_trade_review_output_reference_invalid')
  const state = requiredManualReviewEnum(item.state, ALLOWED_HYPOTHESIS_STATE)
  const targetPath = validateFrozenStrategyPath(item.target_path, strategySnapshot, { allowEmpty:state === 'insufficient_evidence' })
  return { hypothesis_id:text(item.hypothesis_id || item.candidate_id, 128) || `hypothesis_${sha256(JSON.stringify(item)).slice(0, 16)}`,
    target_path:targetPath,
    current_rule_summary:requiredManualReviewText(item.current_rule_summary, 'current_rule_summary'),
    observed_gap:requiredManualReviewText(item.observed_gap || item.observed_manual_logic, 'observed_gap'),
    proposed_change:requiredManualReviewText(item.proposed_change, 'proposed_change'), supporting_trade_refs:supporting,
    counter_evidence:requiredManualReviewArray(item.counter_evidence, 'counter_evidence', 20)
      .map(value => requiredManualReviewText(value, 'counter_evidence_item')),
    applicable_when:requiredManualReviewObject(item.applicable_when, 'applicable_when'),
    risk_if_applied:requiredManualReviewText(item.risk_if_applied, 'risk_if_applied'),
    confidence:requiredManualReviewConfidence(item.confidence), state,
    validation_needed:requiredManualReviewText(item.validation_needed, 'validation_needed'),
  }
}

function sourceRefs(sourceRows = []) { return new Set(sourceRows.map(row => String(row.source_identity_hash || '')).filter(Boolean)) }

function manualTradeReviewEvidenceReason(evidence) {
  const preciseReasons = new Set([
    'chan_data_incomplete', 'chan_structure_insufficient', 'terminal_clock_untrusted', 'market_candle_gap',
    'market_candle_boundary_insufficient', 'chan_timeframe_unsupported', 'market_data_plan_invalid',
    'market_data_unavailable', 'history_snapshot_changed',
    'chan_evidence_incomplete', 'holding_path_bar_boundary_insufficient', 'market_path_candle_coverage_incomplete',
  ])
  const issues = [...(Array.isArray(evidence?.evidence_issues) ? evidence.evidence_issues : []),
    ...(Array.isArray(evidence?.market_data?.evidence_issues) ? evidence.market_data.evidence_issues : [])]
  issues.sort((left, right) => Number(left?.category === 'chan_structure') - Number(right?.category === 'chan_structure'))
  const candidates = [evidence?.reason, evidence?.evidence_reason, evidence?.market_data?.reason,
    ...issues.flatMap(item => [item?.code, item?.reason])]
  const exact = candidates.map(value => String(value || '').trim()).find(value => preciseReasons.has(value))
  if (exact) return exact
  const reason = String(evidence?.market_data?.reason || evidence?.reason || '')
  if (reason.includes('chan_evidence_incomplete')) return 'chan_evidence_incomplete'
  if (reason.includes('holding_path_bar_boundary_insufficient')) return 'holding_path_bar_boundary_insufficient'
  if (reason.includes('truncated') || reason.includes('coverage')) return 'market_path_candle_coverage_incomplete'
  return 'market_evidence_unavailable'
}

function normalizeRuleComparison(item, strategySnapshot, allowedEvidenceRefs) {
  if (!item || typeof item !== 'object' || Array.isArray(item)) throw new Error('manual_trade_review_output_invalid')
  const status = requiredManualReviewEnum(item.status, new Set(['aligned', 'partial', 'conflict', 'unknown', 'not_applicable']))
  const path = validateFrozenStrategyPath(item.rule_path, strategySnapshot, { allowEmpty:['unknown', 'not_applicable'].includes(status) })
  return { rule_path:path, rule_summary:requiredManualReviewText(item.rule_summary, 'rule_summary'),
    observed_evidence:requiredManualReviewText(item.observed_evidence, 'observed_evidence'), status,
    evidence_refs:validateManualReviewEvidenceRefs(requiredManualReviewArray(item.evidence_refs, 'evidence_refs', 30),
      allowedEvidenceRefs, { required:true }),
    frozen_strategy_version:Number(strategySnapshot.version || 1) }
}

export function validateManualTradeReviewContent(input, sourceRows = [], strategySnapshot = {}, { evidenceStatus = 'complete', evidence = {} } = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('manual_trade_review_output_invalid')
  const refs = sourceRefs(sourceRows)
  const catalog = buildManualReviewEvidenceCatalog(sourceRows, evidence)
  const sampleCount = sourceRows.length
  if (sampleCount !== 1) throw new Error('manual_trade_review_selection_invalid')
  const evidenceQuality = requiredManualReviewEnum(input.evidence_quality, ALLOWED_EVIDENCE)
  const expectedEvidenceQuality = evidenceStatus === 'complete' ? 'complete' : 'insufficient'
  if (evidenceQuality !== expectedEvidenceQuality) {
    throw new Error('manual_trade_review_output_evidence_quality_invalid')
  }
  const evidenceComplete = evidenceStatus === 'complete' && evidenceQuality === 'complete'
  const strategyAlignment = requiredManualReviewEnum(input.strategy_alignment, ALLOWED_ALIGNMENT)
  const decisionQuality = requiredManualReviewEnum(input.decision_quality, ALLOWED_DECISION)
  const counterfactual = validateCounterfactualAnalysis(input.counterfactual_analysis, { allowedEvidenceRefs:catalog.pre_entry_refs })
  const attribution = requiredManualReviewObject(input.profit_attribution, 'profit_attribution')
  const content = {
    output_contract_version:REVIEW_OUTPUT_VERSION,
    evidence_quality:evidenceQuality,
    review_summary:requiredManualReviewText(input.review_summary, 'review_summary'),
    strategy_alignment:strategyAlignment,
    decision_quality:decisionQuality,
    counterfactual_match:requiredManualReviewEnum(input.counterfactual_match, ALLOWED_COUNTERFACTUAL_MATCH),
    counterfactual_analysis:counterfactual,
    why_profitable:requiredManualReviewText(input.why_profitable, 'why_profitable'),
    profit_attribution:{ market_fit:requiredManualReviewText(attribution.market_fit, 'profit_market_fit'),
      entry_quality:requiredManualReviewText(attribution.entry_quality, 'profit_entry_quality'),
      exit_quality:requiredManualReviewText(attribution.exit_quality, 'profit_exit_quality'),
      luck_or_uncontrolled_factors:requiredManualReviewText(attribution.luck_or_uncontrolled_factors, 'profit_luck_factors') },
    outcome_independence_note:requiredManualReviewText(input.outcome_independence_note, 'outcome_independence_note'),
    rule_comparisons:requiredManualReviewArray(input.rule_comparisons, 'rule_comparisons', 50)
      .map(item => normalizeRuleComparison(item, strategySnapshot, catalog.outcome_refs)),
    strengths:requiredManualReviewArray(input.strengths, 'strengths', 20)
      .map(value => requiredManualReviewText(value, 'strength')),
    issues:requiredManualReviewArray(input.issues, 'issues', 20)
      .map(value => requiredManualReviewText(value, 'issue')),
    strategy_optimization_hypotheses:requiredManualReviewArray(
      input.strategy_optimization_hypotheses ?? input.strategy_optimization_candidates,
      'strategy_optimization_hypotheses', MAX_CANDIDATES)
      .map(item => normalizeHypothesis(item, refs, strategySnapshot)),
    confidence:requiredManualReviewConfidence(input.confidence),
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
    include_portfolio_context:Boolean(Number(strategy.include_portfolio_context)),
  }
  return { row:strategy, snapshot, hash:jsonHash(snapshot) }
}

async function getCaseForActor(caseId, actorId, { forUpdate = false } = {}) {
  const suffix = forUpdate ? ' FOR UPDATE' : ''
  return queryOne(`SELECT cases.*, jobs.id AS job_id, jobs.status AS job_status, jobs.progress_stage,
      jobs.generation_no, jobs.task_deadline_at, jobs.attempt_count, jobs.max_attempts, jobs.last_error_code, jobs.next_attempt_at,
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
    created_at:row.created_at, updated_at:row.updated_at, job_status:row.job_status || null, progress_stage:row.progress_stage || null,
    generation_no:Number(row.generation_no || 1), task_deadline_at:row.task_deadline_at || null, attempt_count:Number(row.attempt_count || 0),
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
  // Preserve idempotent replay even when the client only has an old request
  // outcome and its selection context has since expired.  Existing cases are
  // already scoped to this actor and do not require another Bridge read.
  const existing = await getCaseForActorByRequest(actorId, clientRequestId)
  if (existing) return { created:false, case:publicCase(existing) }
  const account = options.account || await getCurrentManualReviewAccount(actorId, input.trading_account_id)
  if (Number(input.trading_account_id || account.id) !== Number(account.id)) throw new Error('manual_trade_review_account_unavailable')
  const selectionContextToken = input.selection_context_token || input.selectionContextToken
  const selectionContext = verifyManualTradeSelectionContext(selectionContextToken, {
    userId:actorId, tradingAccountId:account.id, platform:account.platform, nowUtcMsc:options.nowUtcMsc,
  })
  const strategy = options.strategy || await getPlatformStrategySnapshot(actor, input.strategy_id)
  const rawEvidence = options.evidence || await readManualTradeEvidence(actor, account, selected, {
    ...options, strategySnapshot:strategy.snapshot, selection_context_token:selectionContextToken,
  })
  // New cases always freeze the v3 contract marker inside evidence_json.  It
  // participates in evidence_hash/job idempotency and prevents an incomplete
  // candidate batch from being mistaken for a legacy v2 record on recovery.
  const evidence = rawEvidence && typeof rawEvidence === 'object'
    ? { ...rawEvidence, review_contract_version:MANUAL_TRADE_REVIEW_V3_VERSION }
    : rawEvidence
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
  const caseEvidenceReason = caseEvidenceStatus === 'complete' ? null : manualTradeReviewEvidenceReason(evidence)
  const hasExplicitV3Contract = evidence?.review_contract_version === MANUAL_TRADE_REVIEW_V3_VERSION
  const hasCounterfactualPointShape = hasExplicitV3Contract || Object.values(evidence.market_data?.trades || {}).some(path =>
    path && typeof path === 'object' && Object.prototype.hasOwnProperty.call(path, 'counterfactual_points'))
  const now = beijingNow()
  let result
  try {
    result = await withTransaction(async run => {
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
      const jobKey = `manual:${insert.insertId}:${evidenceHash}:${strategy.hash}:${thesis ? sha256(thesis) : 'none'}:${hasCounterfactualPointShape ? REVIEW_V3_OUTPUT_VERSION : REVIEW_OUTPUT_VERSION}`
      await run(`INSERT INTO manual_trade_review_jobs
      (case_id, idempotency_key, generation_no, status, progress_stage, attempt_count, max_attempts,
       task_deadline_at, created_at, updated_at)
      VALUES (?, ?, 1, 'queued', 'queued', 0, 3, ?, ?, ?)`, [insert.insertId, jobKey, newManualTradeReviewDeadline(evidence), now, now])
      return { created:true, id:Number(insert.insertId) }
    })
  } catch (error) {
    if (String(error?.code || '') !== 'ER_DUP_ENTRY') throw error
    const replay = await getCaseForActorByRequest(actorId, clientRequestId)
    if (!replay) throw error
    return { created:false, case:publicCase(replay) }
  }
  if (result.created) requestManualTradeReviewCycle()
  const saved = await getCaseForActor(result.id, actorId)
  return { created:result.created, case:publicCase(saved) }
}

async function getCaseForActorByRequest(actorId, clientRequestId) {
  return queryOne(`SELECT cases.*, jobs.status AS job_status, jobs.progress_stage, jobs.generation_no, jobs.task_deadline_at,
      jobs.attempt_count, jobs.max_attempts,
      jobs.last_error_code, jobs.next_attempt_at FROM manual_trade_review_cases cases
      LEFT JOIN manual_trade_review_jobs jobs ON jobs.case_id = cases.id
      WHERE cases.user_id = ? AND cases.client_request_id = ? LIMIT 1`, [actorId, clientRequestId])
}

export async function listManualTradeReviews(actor, params = {}) {
  const actorId = managerOrThrow(actor)
  const limit = Math.min(100, Math.max(1, Number(params.limit) || 20))
  const offset = Math.max(0, Number(params.offset) || 0)
  const rows = await queryAll(`SELECT cases.*, jobs.status AS job_status, jobs.progress_stage, jobs.generation_no, jobs.task_deadline_at, jobs.attempt_count,
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
  const evidenceIssues = Array.isArray(evidence.evidence_issues) ? evidence.evidence_issues
    : Array.isArray(evidence.market_data?.evidence_issues) ? evidence.market_data.evidence_issues : []
  // The detail endpoint is already scoped by getCaseForActor to the current
  // actor.  Return the user's own thesis here so the deterministic evidence
  // recovery action can preserve it when creating a new case; keep it out of
  // publicCase/list responses because those are list/card payloads.
  return { ...publicCase(row), user_thesis_text:row.user_thesis_text || null,
    strategy_snapshot:snapshot, evidence_issues:evidenceIssues,
    evidence:{ ...evidence, trades:undefined }, sources:sources.map(source => ({ ...source,
    normalized_trade:parse(source.normalized_trade_json, null), manual_classification:parse(source.manual_classification_json, null), normalized_trade_json:undefined, manual_classification_json:undefined })),
    versions:versions.map(version => ({ ...version, content:parse(version.content_json, {}), content_json:undefined })) }
}

export async function getManualTradeReviewJobStatus(caseId, actor) {
  const actorId = managerOrThrow(actor)
  const row = await getCaseForActor(id(caseId, 'manual_trade_review_not_found'), actorId)
  if (!row) throw new Error('manual_trade_review_not_found')
  return { id:Number(row.job_id || 0) || null, case_id:Number(row.id), generation_no:Number(row.generation_no || 1),
    task_deadline_at:row.task_deadline_at || null, status:row.job_status || null, progress_stage:row.progress_stage || null,
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
    if (['queued', 'generating'].includes(String(row.status))) throw new Error('manual_trade_review_action_not_allowed_in_generation')
    if (!['draft', 'edited', 'needs_revision'].includes(String(row.status))) throw new Error('manual_trade_review_edit_not_allowed')
    if (expectedVersionId != null && Number(expectedVersionId) !== Number(row.current_version_id || 0)) throw new Error('manual_trade_review_version_conflict')
    let currentContent = null
    let currentIsV3 = false
    if (row.current_version_id) {
      const [currentVersions] = await run(`SELECT content_json FROM manual_trade_review_versions
        WHERE id = ? AND case_id = ? FOR UPDATE`, [row.current_version_id, idValue])
      currentContent = parse(currentVersions?.[0]?.content_json, {})
      currentIsV3 = currentContent?.output_contract_version === REVIEW_V3_OUTPUT_VERSION
      if (currentIsV3) {
        const frozenPoints = currentContent?.counterfactual_points
        const frozenSummary = currentContent?.counterfactual_summary
        if (jsonHash(frozenPoints) !== jsonHash(content?.counterfactual_points)
          || jsonHash(frozenSummary) !== jsonHash(content?.counterfactual_summary)) {
          throw new Error('manual_trade_review_counterfactual_immutable')
        }
      } else {
        const frozenCounterfactual = currentContent?.counterfactual_analysis
        const editedCounterfactual = content?.counterfactual_analysis
        if (frozenCounterfactual && jsonHash(frozenCounterfactual) !== jsonHash(editedCounterfactual)) {
          throw new Error('manual_trade_review_counterfactual_immutable')
        }
      }
    }
    const [sources] = await run(`SELECT sources.source_identity_hash FROM manual_trade_review_sources sources
      JOIN manual_trade_review_cases cases ON cases.id = sources.case_id
      WHERE sources.case_id = ? AND cases.user_id = ?`, [idValue, actorId])
    const strategySnapshot = parse(row.strategy_snapshot_json, {})
    const evidence = parse(row.evidence_json, {})
    const evidenceCatalog = buildManualReviewEvidenceCatalog(sources, evidence)
    const normalized = currentIsV3
      ? { ...normalizeManualTradeReviewV3Content(content, {
        strategySnapshot,
        strategyDeclaredTimeframes:deriveManualTradeReviewDeclaredTimeframes(strategySnapshot),
        evidenceAvailableTimeframes:deriveManualTradeReviewEvidenceTimeframes(evidenceCatalog.outcome_refs),
        allowedEvidenceRefs:evidenceCatalog.outcome_refs,
        sourceRefs:evidenceCatalog.trade_refs,
        sourceRefSet:new Set(evidenceCatalog.trade_refs),
        serverDerivedSummary:currentContent.counterfactual_summary,
        serverProtectionAssessment:{ protection_quality:currentContent.counterfactual_summary?.protection_quality },
      }), counterfactual_points:currentContent.counterfactual_points,
        counterfactual_summary:currentContent.counterfactual_summary }
      : validateManualTradeReviewContent(content, sources, strategySnapshot, {
        evidenceStatus:row.evidence_status, evidence,
      })
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
    if (String(row.status) === 'approved') {
      if (action === 'approve' && selectedVersion === Number(row.approved_version_id || 0)) {
        return { case_id:idValue, status:'approved', version_id:selectedVersion }
      }
      throw new Error('manual_trade_review_approved_locked')
    }
    if (!['draft', 'edited', 'needs_revision'].includes(String(row.status))) {
      throw new Error('manual_trade_review_action_not_allowed_in_generation')
    }
    if (selectedVersion !== Number(row.current_version_id || 0)) throw new Error('manual_trade_review_version_conflict')
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
  const result = await withTransaction(async run => {
    const [rows] = await run(`SELECT cases.id AS case_id, cases.status AS case_status, cases.evidence_json,
        jobs.id AS job_id,
        jobs.generation_no, jobs.status AS job_status
      FROM manual_trade_review_cases cases
      JOIN manual_trade_review_jobs jobs ON jobs.case_id = cases.id
      WHERE cases.id = ? AND cases.user_id = ? AND jobs.status IN ('failed','deferred')
      FOR UPDATE`, [idValue, actorId])
    const row = rows?.[0]
    if (!row) throw new Error('manual_trade_review_retry_not_allowed')
    const now = beijingNow()
    const generationNo = Math.max(1, Number(row.generation_no || 1)) + 1
    const deadline = newManualTradeReviewDeadline(parse(row.evidence_json, {}))
    const [updated] = await run(`UPDATE manual_trade_review_jobs
      SET status = 'queued', progress_stage = 'queued', generation_no = ?, model_task_id = NULL,
        task_deadline_at = ?, attempt_count = 0, lease_token = NULL, lease_expires_at = NULL,
        last_error_code = NULL, next_attempt_at = NULL, completed_at = NULL, stage_updated_at = NULL,
        updated_at = ?
      WHERE id = ? AND case_id = ? AND status IN ('failed','deferred')`,
    [generationNo, deadline, now, row.job_id, idValue])
    if (Number(updated?.affectedRows ?? updated?.changes ?? 0) !== 1) throw new Error('manual_trade_review_retry_not_allowed')
    const [caseUpdate] = await run(`UPDATE manual_trade_review_cases
      SET status = 'queued', updated_at = ?
      WHERE id = ? AND user_id = ?`, [now, idValue, actorId])
    if (Number(caseUpdate?.affectedRows ?? caseUpdate?.changes ?? 0) !== 1) throw new Error('manual_trade_review_retry_not_allowed')
    return { generation_no:generationNo, task_deadline_at:deadline }
  })
  requestManualTradeReviewCycle()
  return { queued:true, case_id:idValue, generation_no:result.generation_no, task_deadline_at:result.task_deadline_at }
}

async function claimManualTradeReviewJob() {
  const now = beijingNow()
  const token = crypto.randomUUID()
  return withTransaction(async run => {
    const [rows] = await run(`SELECT jobs.*, cases.user_id, cases.strategy_id, cases.evidence_json,
        cases.status AS case_status
      FROM manual_trade_review_jobs jobs JOIN manual_trade_review_cases cases ON cases.id = jobs.case_id
      WHERE (jobs.status = 'queued' OR (jobs.status = 'leased' AND jobs.lease_expires_at < ?))
        AND cases.status IN ('queued','generating')
        AND (jobs.next_attempt_at IS NULL OR jobs.next_attempt_at <= ?)
      ORDER BY jobs.created_at, jobs.id LIMIT 1 FOR UPDATE`, [now, now])
    const row = rows?.[0]
    if (!row) return null
    const firstClaimDeadline = newManualTradeReviewDeadline(parse(row.evidence_json, {}))
    const [updated] = await run(`UPDATE manual_trade_review_jobs SET status = 'leased', progress_stage = 'preparing',
      attempt_count = attempt_count + 1, task_deadline_at = COALESCE(task_deadline_at, ?),
      lease_token = ?, lease_expires_at = ?, stage_updated_at = ?, updated_at = ?
      WHERE id = ? AND (status = 'queued' OR (status = 'leased' AND lease_expires_at < ?))`,
    [firstClaimDeadline, token, dateAfter(600), now, now, row.id, now])
    if (!updated.affectedRows) return null
    const [caseUpdated] = await run(`UPDATE manual_trade_review_cases
      SET status = 'generating', updated_at = ?
      WHERE id = ? AND status IN ('queued','generating')`, [now, row.case_id])
    if (!caseUpdated?.affectedRows) throw new Error('manual_trade_review_case_state_fence_lost')
    return { ...row, task_deadline_at:row.task_deadline_at || firstClaimDeadline,
      case_status:'generating', lease_token:token, attempt_count:Number(row.attempt_count || 0) + 1 }
  })
}

// The business lease is independent from the generic model-task lease. Keep
// renewing it while either of the two manual-analysis provider requests is in
// flight so a slow response cannot be mistaken for an abandoned job.
function startManualTradeReviewLeaseHeartbeat(job) {
  const controller = new AbortController()
  let stopped = false
  let pending = null
  const renew = async () => {
    if (stopped || pending) return
    pending = queryRun(`UPDATE manual_trade_review_jobs SET lease_expires_at = ?, updated_at = ?
      WHERE id = ? AND status = 'leased' AND lease_token = ?`,
    [dateAfter(120), beijingNow(), job.id, job.lease_token]).then(result => {
      if (Number(result?.affectedRows ?? result?.changes ?? 0) !== 1 && !controller.signal.aborted) {
        controller.abort(new Error('manual_trade_review_lease_lost'))
      }
    }).catch(error => {
      if (!controller.signal.aborted) controller.abort(error)
    }).finally(() => { pending = null })
    await pending
  }
  const timer = setInterval(renew, 30_000)
  timer.unref?.()
  return {
    signal:controller.signal,
    assertOwned:() => controller.signal.throwIfAborted(),
    async stop() {
      stopped = true
      clearInterval(timer)
      if (pending) await pending
    },
  }
}

function manualTradeReviewModelTaskWaitError(task, nowUtcMs = Date.now()) {
  if (!task) return null
  const status = String(task.status || '')
  const leaseExpiresAt = Number(task.lease_expires_at_utc_msc || 0)
  const scheduledAt = Number(task.scheduled_at_utc_msc || 0)
  const hasValidLease = leaseExpiresAt > nowUtcMs
  const scheduledInFuture = scheduledAt > nowUtcMs
  const canBeHeldByAnotherWorker = ['queued', 'retry_wait'].includes(status) || MODEL_TASK_ACTIVE_STATES.has(status)
  if (!(canBeHeldByAnotherWorker && (hasValidLease || scheduledInFuture))) return null
  const waitUntilUtcMs = Math.max(nowUtcMs + 5_000, hasValidLease ? leaseExpiresAt : 0, scheduledInFuture ? scheduledAt : 0)
  const error = new Error('manual_trade_review_model_task_lease_wait')
  error.code = 'manual_trade_review_model_task_lease_wait'
  error.manualTradeReviewDeferUntilUtcMs = waitUntilUtcMs
  return error
}

function manualTradeReviewModelTaskTerminalError(task) {
  if (!MODEL_TASK_TERMINAL_STATES.has(String(task?.status || ''))) return null
  const error = new Error('manual_trade_review_model_task_terminal_requires_retry')
  error.code = 'manual_trade_review_model_task_terminal_requires_retry'
  error.manualTradeReviewTerminalTask = true
  return error
}

function manualTradeReviewCanRecoverCompletedTask(task, reviewCase) {
  return String(task?.status || '') === 'succeeded'
    && Number(reviewCase?.current_version_id || 0) > 0
    && ['draft', 'edited', 'needs_revision', 'approved'].includes(String(reviewCase?.status || ''))
}

async function deferManualTradeReviewForModelTaskLease(job, error) {
  const now = Date.now()
  const deadlineAtUtcMs = parseBeijingDateTime(job.task_deadline_at)
  const requestedWaitUntil = Number(error?.manualTradeReviewDeferUntilUtcMs) || now + 30_000
  const deadlineExpired = Number.isFinite(deadlineAtUtcMs) && deadlineAtUtcMs > 0 && deadlineAtUtcMs <= requestedWaitUntil
  const status = deadlineExpired ? 'failed' : 'queued'
  const progressStage = deadlineExpired ? 'failed' : error?.manualTradeReviewHold ? 'status_unknown' : 'retry_wait'
  const errorCode = deadlineExpired ? 'manual_trade_review_generation_deadline_exceeded'
    : error?.manualTradeReviewHold ? text(error?.code || 'manual_trade_review_stage_task_status_unknown', 128)
      : 'manual_trade_review_model_task_lease_wait'
  const nextAttemptAt = deadlineExpired ? null : dateAtUtcMs(requestedWaitUntil)
  const completedAt = deadlineExpired ? beijingNow() : null
  const update = await queryRun(`UPDATE manual_trade_review_jobs SET status = ?, progress_stage = ?,
    attempt_count = GREATEST(0, attempt_count - 1), last_error_code = ?, lease_token = NULL,
    lease_expires_at = NULL, next_attempt_at = ?, completed_at = ?, updated_at = ?
    WHERE id = ? AND lease_token = ? AND generation_no = ?`, [status, progressStage, errorCode, nextAttemptAt, completedAt,
    beijingNow(), job.id, job.lease_token, Number(job.generation_no || 1)])
  if (Number(update?.affectedRows ?? update?.changes ?? 0) < 1) return false
  await queryRun(`UPDATE manual_trade_review_cases SET status = ?, updated_at = ?
     WHERE id = ? AND status IN ('queued','generating')`, [status, beijingNow(), job.case_id])
  return { status, error_code:errorCode, next_attempt_at:nextAttemptAt }
}

async function markJobFailure(job, error) {
  const code = text(error?.code || error?.message || 'manual_trade_review_generation_failed', 128)
  const now = beijingNow()
  const deadlineAtUtcMs = parseBeijingDateTime(job.task_deadline_at)
  const deadlineExpired = Number.isFinite(deadlineAtUtcMs) && deadlineAtUtcMs > 0 && deadlineAtUtcMs <= Date.now()
  const heldForTaskReconciliation = Boolean(error?.manualTradeReviewHold)
  const deterministicEvidenceFailure = manualTradeReviewDeterministicEvidenceFailure(code)
  const exhausted = !heldForTaskReconciliation && (deterministicEvidenceFailure
    || Boolean(error?.manualTradeReviewTerminalTask)
    || deadlineExpired
    || Number(job.attempt_count || 0) >= Number(job.max_attempts || 3))
  const targetStatus = exhausted ? 'failed' : 'queued'
  const update = await queryRun(`UPDATE manual_trade_review_jobs SET status = ?, progress_stage = ?, last_error_code = ?,
    lease_token = NULL, lease_expires_at = NULL, next_attempt_at = ?, completed_at = ?, updated_at = ?
    WHERE id = ? AND lease_token = ? AND generation_no = ?`, [exhausted ? 'failed' : 'queued', exhausted ? 'failed' : 'retry_wait', code,
    exhausted ? null : dateAfter(Math.min(900, 30 * Math.max(1, Number(job.attempt_count || 1)))), exhausted ? now : null, now, job.id, job.lease_token,
    Number(job.generation_no || 1)])
  // If another worker fenced this lease while the provider call was in
  // flight, do not let the stale worker overwrite the newer case status.
  if (Number(update?.affectedRows ?? update?.changes ?? 0) < 1) return false
  await queryRun(`UPDATE manual_trade_review_cases SET status = ?, evidence_reason = COALESCE(evidence_reason, ?), updated_at = ?
     WHERE id = ? AND status IN ('queued','generating')
      AND EXISTS (SELECT 1 FROM manual_trade_review_jobs jobs
        WHERE jobs.id = ? AND jobs.status = ? AND jobs.last_error_code = ?)`, [targetStatus, code, now, job.case_id, job.id, targetStatus, code])
  return true
}

function manualTradeReviewDeterministicEvidenceFailure(errorOrCode) {
  const code = typeof errorOrCode === 'string'
    ? errorOrCode : text(errorOrCode?.code || errorOrCode?.message || '', 128)
  return code === 'manual_trade_review_counterfactual_points_unavailable'
}

function manualTradeReviewModelConfigFingerprint(resolved, endpoint) {
  const model = resolved?.model || {}
  return sha256(JSON.stringify({
    profile_id:Number(resolved?.model_profile_id || 0) || null,
    provider:String(model.provider || model.api_provider || ''),
    model:String(model.model_name || model.model || ''),
    protocol:String(endpoint?.protocol || ''),
    endpoint:String(endpoint?.url || ''),
    temperature:Number(model.temperature ?? 0.2),
    max_tokens:Number(model.max_tokens ?? 0) || null,
    thinking_enabled:Boolean(model.thinking_enabled),
    reasoning_effort:model.reasoning_effort == null ? null : String(model.reasoning_effort),
    credential_source:String(resolved?.credential_source || ''),
  }))
}

function manualTradeReviewOutputContractHash() {
  return jsonHash(manualTradeReviewOutputContract(1))
}

function manualTradeReviewV3OutputContractHash() {
  return jsonHash({
    output_contract_version:REVIEW_V3_OUTPUT_VERSION,
    technical_analysis_chain:'structured evidence-backed array',
    counterfactual_summary:'server-derived',
    protection_plan:'server-evaluated',
  })
}

function manualTradeReviewV3PointContractHash() {
  return jsonHash({
    output_contract_version:COUNTERFACTUAL_POINT_V3_OUTPUT_VERSION,
    candidate_key:'anchor_minus_2|anchor_minus_1|anchor|anchor_plus_1|anchor_plus_2', decision:'buy|sell|hold|insufficient_evidence',
    entry_allowed:'boolean', entry_method:'market|limit|stop|stop_limit|observe|unknown',
    strategy_signals:'structured evidence-backed array', protection_plan:'mechanically assessed', confidence:'0..1',
  })
}

function manualTradeReviewCounterfactualContractHash() {
  return jsonHash({ output_contract_version:COUNTERFACTUAL_OUTPUT_VERSION,
    decision:'buy|sell|hold|insufficient_evidence', reasoning:'string', strategy_signals:['string'],
    blocking_rules:['string'], evidence_refs:['string'], confidence:'0..1' })
}

function frozenMemoryPayload(runtime) {
  const memory = runtime?.memory || {}
  const content = String(memory.content || '')
  if (memory.content_hash && sha256(content) !== String(memory.content_hash).toLowerCase()) {
    throw Object.assign(new Error('manual_trade_review_frozen_memory_hash_mismatch'), {
      code:'manual_trade_review_frozen_memory_hash_mismatch', manualTradeReviewTerminalTask:true,
    })
  }
  const charCount = Array.from(content).length
  const estimatedTokenCount = Math.ceil(Buffer.byteLength(content, 'utf8') / 4)
  if ((memory.char_count != null && Number(memory.char_count) !== charCount)
    || (memory.estimated_token_count != null && Number(memory.estimated_token_count) !== estimatedTokenCount)) {
    throw Object.assign(new Error('manual_trade_review_frozen_memory_metadata_mismatch'), {
      code:'manual_trade_review_frozen_memory_metadata_mismatch', manualTradeReviewTerminalTask:true,
    })
  }
  return { version_no:Number(memory.version_no || 0), content_hash:memory.content_hash || null,
    content_text:content, revision_id:Number(memory.revision_id || 0) || null,
    char_count:charCount, estimated_token_count:estimatedTokenCount }
}

function assertFrozenRuntimeForJob(runtime, job, reviewCase, resolved, endpoint, modelFingerprint, outputContractHash = null) {
  if (!runtime || Number(runtime.case_id) !== Number(job.case_id)
    || Number(runtime.job_id) !== Number(job.id)
    || Number(runtime.generation_no) !== Number(job.generation_no || 1)) {
    throw Object.assign(new Error('manual_trade_review_frozen_runtime_identity_mismatch'), {
      code:'manual_trade_review_frozen_runtime_identity_mismatch', manualTradeReviewTerminalTask:true,
    })
  }
  if (String(runtime.task_deadline_at || '') !== String(job.task_deadline_at || '')
    || String(runtime.strategy_snapshot_hash || '').toLowerCase() !== String(reviewCase.strategy_snapshot_hash || '').toLowerCase()
    || String(runtime.evidence_hash || '').toLowerCase() !== String(reviewCase.evidence_hash || '').toLowerCase()
    || Number(runtime.parent_version_id || 0) !== Number(reviewCase.current_version_id || 0)) {
    throw Object.assign(new Error('manual_trade_review_frozen_runtime_changed'), {
      code:'manual_trade_review_frozen_runtime_changed', manualTradeReviewTerminalTask:true,
    })
  }
  if (outputContractHash && String(runtime.output_contract_hash || '').toLowerCase() !== String(outputContractHash).toLowerCase()) {
    throw Object.assign(new Error('manual_trade_review_frozen_output_contract_changed'), {
      code:'manual_trade_review_frozen_output_contract_changed', manualTradeReviewTerminalTask:true,
    })
  }
  const model = runtime.model || {}
  const current = resolved?.model || {}
  const pairs = [
    [model.profile_id, Number(resolved?.model_profile_id || 0) || null],
    [model.provider, current.provider || current.api_provider],
    [model.model, current.model_name || current.model],
    [model.protocol, endpoint?.protocol],
    [model.credential_source, resolved?.credential_source],
    [model.config_fingerprint, modelFingerprint],
  ]
  if (pairs.some(([frozen, actual]) => frozen == null || actual == null || String(frozen) !== String(actual))) {
    throw Object.assign(new Error('manual_trade_review_frozen_model_changed'), {
      code:'manual_trade_review_frozen_model_changed', manualTradeReviewTerminalTask:true,
    })
  }
  return frozenMemoryPayload(runtime)
}

function manualTradeReviewStageTaskError(stage, code, { terminal = true, hold = false } = {}) {
  const error = new Error(`manual_trade_review_${stage}_${code}`)
  error.code = error.message
  if (terminal) error.manualTradeReviewTerminalTask = true
  if (hold) {
    error.manualTradeReviewHold = true
    error.manualTradeReviewDeferUntilUtcMs = Date.now() + 30_000
  }
  return error
}

async function mirrorManualTradeReviewStageTask(job, taskId) {
  const result = await queryRun(`UPDATE manual_trade_review_jobs SET model_task_id = ?,
      updated_at = ?
    WHERE id = ? AND generation_no = ? AND lease_token = ? AND status = 'leased'`,
  [taskId, beijingNow(), job.id, Number(job.generation_no || 1), job.lease_token])
  if (Number(result?.affectedRows ?? result?.changes ?? 0) < 1) {
    const linked = await queryOne('SELECT model_task_id, generation_no, lease_token FROM manual_trade_review_jobs WHERE id = ? LIMIT 1', [job.id])
    if (String(linked?.model_task_id || '') !== String(taskId)
      || Number(linked?.generation_no || 0) !== Number(job.generation_no || 1)
      || String(linked?.lease_token || '') !== String(job.lease_token || '')) {
      throw new Error('manual_trade_review_lease_lost')
    }
  }
}

async function loadManualTradeReviewGenerationRuntime(job, reviewCase, resolved, endpoint, memorySnapshot = null,
  outputContractHash = manualTradeReviewOutputContractHash()) {
  const persisted = await readManualTradeReviewStageRuns({ caseId:job.case_id, jobId:job.id, generationNo:Number(job.generation_no || 1) })
  if (persisted.length) {
    const shared = validateManualTradeReviewStageRuns(persisted, {
      caseId:job.case_id, jobId:job.id, generationNo:Number(job.generation_no || 1),
    })
    const modelFingerprint = manualTradeReviewModelConfigFingerprint(resolved, endpoint)
    const memory = assertFrozenRuntimeForJob(shared.runtime, job, reviewCase, resolved, endpoint, modelFingerprint, outputContractHash)
    return { stageRows:shared.stageRuns, runtime:shared.runtime, runtimeHash:shared.frozenRuntimeHash, memory }
  }
  const memory = memorySnapshot || (await getStrategyMemoryLibraryForRuntime({ strategyId:job.strategy_id,
    userId:job.user_id, role:'admin' })).library
  const modelFingerprint = manualTradeReviewModelConfigFingerprint(resolved, endpoint)
  const built = buildFrozenRuntime({
    caseId:job.case_id, jobId:job.id, generationNo:Number(job.generation_no || 1),
    taskDeadlineAt:job.task_deadline_at, parentVersionId:reviewCase.current_version_id,
    strategySnapshotHash:reviewCase.strategy_snapshot_hash, evidenceHash:reviewCase.evidence_hash,
    outputContractHash, selectionContractVersion:'manual-trade-selection-v1',
    memory:{ libraryId:memory?.strategy_id, versionNo:memory?.version_no, revisionId:memory?.revision_id,
      contentHash:memory?.content_hash, content:memory?.content_text },
    model:{ profileId:resolved.model_profile_id, provider:resolved.model.provider || resolved.model.api_provider,
      model:resolved.model.model_name || resolved.model.model, protocol:endpoint.protocol,
      credentialSource:resolved.credential_source, configFingerprint:modelFingerprint },
  })
  const ensured = await ensureManualTradeReviewStageRuns({
    caseId:job.case_id, jobId:job.id, generationNo:Number(job.generation_no || 1),
    frozenRuntime:built.frozenRuntime, frozenRuntimeHash:built.frozenRuntimeHash,
  })
  return { stageRows:ensured.stageRuns, runtime:built.frozenRuntime, runtimeHash:built.frozenRuntimeHash,
    memory:frozenMemoryPayload(built.frozenRuntime) }
}

async function reconcileManualTradeReviewStageTask(stageRow, outputHash) {
  if (!stageRow?.model_task_id) return
  // A v3 counterfactual stage is a compatibility checkpoint for the frozen
  // point bundle.  Its task id is borrowed from a completed point task only
  // because the legacy stage table requires one; never reconcile that task
  // with the aggregate bundle hash or its point result lineage is corrupted.
  if (stageRow.stage === 'counterfactual'
    && stageRow.normalizedOutput?.output_contract_version === COUNTERFACTUAL_POINT_V3_OUTPUT_VERSION) return
  const task = await queryOne(`SELECT task_id, status, lease_expires_at_utc_msc, scheduled_at_utc_msc
    FROM ai_model_tasks WHERE task_id = ? LIMIT 1`, [stageRow.model_task_id])
  if (stageRow.stage === 'outcome_review') {
    const waitError = manualTradeReviewModelTaskWaitError(task)
    if (waitError) throw waitError
    // Final task success is committed only together with the business
    // version.  The atomic apply path below reconciles an expired applying
    // task or accepts an already-succeeded task with the exact same hash.
    return
  }
  if (task && String(task.status) !== 'succeeded') {
    await markModelTaskSucceededFromResult(stageRow.model_task_id, {
      resultRef:`manual_trade_review_stage:${stageRow.job_id}:${stageRow.generation_no}:${stageRow.stage}`,
      resultHash:outputHash,
    })
  }
}

async function runManualTradeReviewStage({ stage, job, runtime, runtimeHash, memorySnapshot,
  stageRows, endpoint, resolved, budget, messages, parentOutputHash = null, requestModel, validateOutput,
  finalApply = false, lease, outputContractHash:requestedOutputContractHash = null } = {}) {
  const row = stageRows.find(item => item.stage === stage)
  if (!row) throw manualTradeReviewStageTaskError(stage, 'row_missing')
  if (row.status === 'succeeded' && row.normalizedOutput) {
    await reconcileManualTradeReviewStageTask(row, row.normalizedOutputHash)
    return { output:validateOutput(row.normalizedOutput), outputHash:row.normalizedOutputHash, skipped:true, tracker:null }
  }
  if (row.status === 'status_unknown') {
    throw manualTradeReviewStageTaskError(stage, 'status_unknown', { terminal:false, hold:true })
  }
  if (row.status === 'failed' || row.status === 'stale' || row.status === 'conflict') {
    throw manualTradeReviewStageTaskError(stage, 'terminal_requires_retry')
  }
  const outputContractHash = requestedOutputContractHash || (stage === 'counterfactual'
    ? manualTradeReviewCounterfactualContractHash() : manualTradeReviewOutputContractHash())
  const frozenRuntimeHash = runtimeHash || runtime.runtimeHash || runtime.frozenRuntimeHash
  const inputHash = buildManualTradeReviewStageInputHash({ stage, frozenRuntimeHash,
    messages, outputContractHash, parentOutputHash })
  let priorTask = null
  if (row.model_task_id) {
    priorTask = await queryOne('SELECT * FROM ai_model_tasks WHERE task_id = ? LIMIT 1', [row.model_task_id])
    if (!priorTask) throw manualTradeReviewStageTaskError(stage, 'task_missing')
    const waitError = manualTradeReviewModelTaskWaitError(priorTask)
    if (waitError) throw waitError
    if (String(priorTask.status) === 'status_unknown') throw manualTradeReviewStageTaskError(stage, 'task_status_unknown', { terminal:false, hold:true })
    if (MODEL_TASK_ACTIVE_STATES.has(String(priorTask.status))) throw manualTradeReviewStageTaskError(stage, 'task_active', { terminal:false, hold:true })
    if (MODEL_TASK_TERMINAL_STATES.has(String(priorTask.status))) throw manualTradeReviewStageTaskError(stage, 'task_terminal')
  }
  let tracker = null
  let handoff = false
  try {
    const idempotencyKey = `manual_trade_review:${Number(job.id)}:${Number(job.generation_no || 1)}:${stage}`
    tracker = await createModelTaskTracker({
      taskKind:'manual_analysis', queueClass:'background', ownerUserId:job.user_id,
      strategyId:job.strategy_id, domainType:'manual_trade_review_job', domainId:job.id,
      idempotencyKey, inputHash, snapshotHash:frozenRuntimeHash,
      promptHash:sha256(JSON.stringify(messages)), outputContractHash,
      provider:resolved.model.provider || resolved.model.api_provider, model:resolved.model.model_name || resolved.model.model,
      modelProfileId:resolved.model_profile_id, protocol:endpoint.protocol, credentialSource:resolved.credential_source,
      frozenContext:{ manual_review_runtime_hash:frozenRuntimeHash, stage,
        parent_output_hash:parentOutputHash, generation_no:Number(job.generation_no || 1) },
      maxAttempts:Number(job.max_attempts) || 3, taskDeadlineAtUtcMs:parseBeijingDateTime(job.task_deadline_at),
    }, { workerId:`manual-trade-review:${process.pid}`, linkTask:async taskId => {
      await linkManualTradeReviewStageModelTask({ caseId:job.case_id, jobId:job.id,
        generationNo:Number(job.generation_no || 1), stage, modelTaskId:taskId, inputHash, leaseToken:job.lease_token })
      await mirrorManualTradeReviewStageTask(job, taskId)
      return true
    } })
    await createStrategyMemoryInjectionLog({ strategyId:job.strategy_id,
      actor:{ userId:job.user_id, role:'admin' }, library:memorySnapshot,
      injectionKind:`manual_trade_review_${stage}`, modelTaskId:tracker.taskId })
    await tracker.persistBudget(budget)
    const requestSignal = () => {
      const signals = [lease.signal, tracker.signal].filter(Boolean)
      return signals.length > 1 ? AbortSignal.any(signals) : signals[0] || null
    }
    const callbacks = {
      onProviderRequest:event => tracker.onProviderRequest(event),
      onProviderUsage:event => tracker.onProviderUsage(event),
      onProviderActivity:event => tracker.onProviderActivity(event),
      onProviderQuiet:event => tracker.onProviderQuiet(event),
    }
    lease.assertOwned(); tracker.assertOwned()
    const businessDeadlineUtcMs = assertManualTradeReviewRequestTime(job)
    const deadlines = modelTaskDeadlines('manual_analysis', {
      nowUtcMs:Date.now(), businessDeadlineUtcMs,
    })
    const raw = await requestModel({ url:endpoint.url, apiKey:resolved.model.api_key_encrypted,
      provider:resolved.model.provider || resolved.model.api_provider, model:resolved.model.model_name || resolved.model.model,
      temperature:Math.min(Number(resolved.model.temperature ?? 0.2), 0.3), maxTokens:budget.selectedMaxOutputTokens,
      thinkingEnabled:resolved.model.thinking_enabled, reasoningEffort:resolved.model.reasoning_effort, protocol:endpoint.protocol,
      messages, modelTaskBudget:budget,
      usageContext:{ userId:job.user_id, profileId:resolved.model_profile_id, credentialSource:resolved.credential_source,
        usage:'review', strategyId:job.strategy_id },
      timeout:Math.max(1, Math.min(deadlines.attemptSafetyDeadlineUtcMs, deadlines.taskDeadlineUtcMs) - Date.now()),
      deadlineAtMs:deadlines.attemptSafetyDeadlineUtcMs, followupValidUntilMs:deadlines.taskDeadlineUtcMs,
      signal:requestSignal(), ...callbacks, allowFollowupRequests:false,
      validateObject:validateOutput,
    })
    lease.assertOwned(); tracker.assertOwned()
    const output = validateOutput(raw)
    const normalized = normalizeManualTradeReviewStageOutput(output)
    await saveManualTradeReviewStageOutput({ caseId:job.case_id, jobId:job.id,
      generationNo:Number(job.generation_no || 1), stage, leaseToken:job.lease_token,
      normalizedOutput:normalized.output })
    await tracker.resultReady({ resultHash:normalized.normalizedOutputHash })
    if (finalApply) {
      await tracker.applying()
      handoff = true
      return { output:normalized.output, outputHash:normalized.normalizedOutputHash, skipped:false, tracker }
    }
    await tracker.succeeded({ resultRef:`manual_trade_review_stage:${job.id}:${job.generation_no}:${stage}`,
      resultHash:normalized.normalizedOutputHash })
    return { output:normalized.output, outputHash:normalized.normalizedOutputHash, skipped:false, tracker:null }
  } finally {
    if (tracker && !handoff) {
      try { await tracker.stop() } catch (error) { console.error('[ManualTradeReview] stage task stop failed:', error.message) }
    }
  }
}

function manualTradeReviewV3PointOffset(candidateKey) {
  const value = String(candidateKey || '').trim()
  if (value === 'anchor') return 0
  const match = /^anchor_(minus|plus)_(\d+)$/.exec(value)
  if (!match) return null
  const offset = Number(match[2]) * (match[1] === 'minus' ? -1 : 1)
  return Number.isSafeInteger(offset) && Math.abs(offset) <= 2 ? offset : null
}

function manualTradeReviewV3PointHash(value) {
  const normalized = String(value || '').trim().toLowerCase()
  return /^[a-f0-9]{64}$/.test(normalized) ? normalized : null
}

function manualTradeReviewV3PointEvidence(reviewCase, sources, evidence) {
  const source = sources?.[0]
  const identity = String(source?.source_identity_hash || '')
  const path = evidence?.market_data?.trades?.[identity]
  const hasCounterfactualPoints = Boolean(path && (
    Object.prototype.hasOwnProperty.call(path, 'counterfactual_points')
    || Object.prototype.hasOwnProperty.call(path, 'candidate_points')
  ))
  if (!path || !hasCounterfactualPoints) return null
  const suppliedValue = Object.prototype.hasOwnProperty.call(path, 'counterfactual_points')
    ? path.counterfactual_points : path.candidate_points
  const supplied = Array.isArray(suppliedValue) ? suppliedValue
    : suppliedValue && typeof suppliedValue === 'object' && !Array.isArray(suppliedValue)
      ? Object.values(suppliedValue) : suppliedValue
  if (!Array.isArray(supplied) || supplied.length > 5) {
    throw new Error('manual_trade_review_counterfactual_points_invalid')
  }
  if (supplied.length === 0) throw new Error('manual_trade_review_counterfactual_points_invalid')
  const catalog = buildManualReviewEvidenceCatalog(sources, evidence)
  const keys = new Set(); const offsets = new Set(); const times = new Set()
  return supplied.map((candidate, index) => {
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) {
      throw new Error(`manual_trade_review_counterfactual_point_${index}_invalid`)
    }
    if ((candidate.status != null && String(candidate.status) !== 'complete')
      || (candidate.market_data?.status != null && String(candidate.market_data.status) !== 'complete')) {
      throw new Error(`manual_trade_review_counterfactual_point_${index}_incomplete`)
    }
    const candidateKey = String(candidate.candidate_key || candidate.candidateKey || '').trim()
    const offsetBars = Number(candidate.offset_bars ?? candidate.offsetBars)
    const decisionTime = Number(candidate.decision_time_utc_msc ?? candidate.decisionTimeUtcMsc)
    const expectedOffset = manualTradeReviewV3PointOffset(candidateKey)
    if (expectedOffset == null || !Number.isSafeInteger(offsetBars) || offsetBars !== expectedOffset
      || !Number.isSafeInteger(decisionTime) || decisionTime <= 0
      || keys.has(candidateKey) || offsets.has(offsetBars) || times.has(decisionTime)) {
      throw new Error(`manual_trade_review_counterfactual_point_${index}_identity_invalid`)
    }
    const marketData = candidate.market_data ?? candidate.closed_market_data ?? candidate.closedMarketData
      ?? candidate.market_snapshot ?? candidate.marketSnapshot
    if (!marketData || typeof marketData !== 'object' || Array.isArray(marketData)) {
      throw new Error(`manual_trade_review_counterfactual_point_${index}_market_data_invalid`)
    }
    if (marketData.status != null && String(marketData.status) !== 'complete') {
      throw new Error(`manual_trade_review_counterfactual_point_${index}_incomplete`)
    }
    const strategySnapshot = parse(reviewCase?.strategy_snapshot_json ?? reviewCase?.strategy_snapshot, {})
    const declaredTimeframes = new Set(deriveManualTradeReviewDeclaredTimeframes(strategySnapshot))
    const availableTimeframes = new Set(deriveManualTradeReviewEvidenceTimeframes(marketData))
    const inferredTimeframe = availableTimeframes.size === 1 ? [...availableTimeframes][0] : ''
    const primaryTimeframe = String(candidate.primary_timeframe || candidate.primaryTimeframe || marketData.primary_timeframe || inferredTimeframe).trim().toUpperCase()
    if (!primaryTimeframe || (declaredTimeframes.size && !declaredTimeframes.has(primaryTimeframe))
      || !availableTimeframes.has(primaryTimeframe)) {
      throw new Error(`manual_trade_review_counterfactual_point_${index}_timeframe_invalid`)
    }
    const allowed = candidate.allowed_evidence_refs ?? candidate.allowedEvidenceRefs
    let allowedEvidenceRefs
    const pointCatalogRefs = catalog.counterfactual_refs_by_trade?.[identity]?.[candidateKey] || []
    try {
      allowedEvidenceRefs = validateManualReviewEvidenceRefs(allowed, pointCatalogRefs, { required:true })
    } catch {
      throw new Error(`manual_trade_review_counterfactual_point_${index}_evidence_refs_invalid`)
    }
    const marketSnapshotHash = manualTradeReviewV3PointHash(candidate.market_snapshot_hash ?? candidate.marketSnapshotHash)
    if (!marketSnapshotHash) throw new Error(`manual_trade_review_counterfactual_point_${index}_snapshot_hash_invalid`)
    const inputHash = manualTradeReviewV3PointHash(candidate.input_hash ?? candidate.inputHash)
      || jsonHash({ candidate_key:candidateKey, decision_time_utc_msc:decisionTime, offset_bars:offsetBars,
        market_snapshot_hash:marketSnapshotHash, allowed_evidence_refs:allowedEvidenceRefs, market_data:marketData })
    const historicalContractSpec = candidate.historical_contract_spec ?? candidate.historicalContractSpec
      ?? candidate.contract_spec ?? candidate.contractSpec
    keys.add(candidateKey); offsets.add(offsetBars); times.add(decisionTime)
    return { candidate_key:candidateKey, decision_time_utc_msc:decisionTime, offset_bars:offsetBars,
      primary_timeframe:primaryTimeframe,
      status:'complete', market_data:marketData, closed_market_data:marketData,
      ...(historicalContractSpec && typeof historicalContractSpec === 'object' && !Array.isArray(historicalContractSpec)
        ? { historical_contract_spec:historicalContractSpec } : {}),
      market_snapshot_hash:marketSnapshotHash, input_hash:inputHash, allowed_evidence_refs:allowedEvidenceRefs }
  }).sort((left, right) => left.offset_bars - right.offset_bars)
}

function manualTradeReviewV3OutputDirection(value) {
  const normalized = String(value == null ? '' : value).trim().toLowerCase()
  if (['buy', 'long', '0'].includes(normalized)) return 'buy'
  if (['sell', 'short', '1'].includes(normalized)) return 'sell'
  return null
}

function atrDeclarationValues(value) {
  if (Array.isArray(value)) return value.map(item => item && typeof item === 'object' ? item : null).filter(Boolean)
  if (!value || typeof value !== 'object') return []
  return Object.entries(value).map(([id, item]) => item && typeof item === 'object' && !Array.isArray(item)
    ? { id, ...item } : null).filter(Boolean)
}

function atrDeclarationPeriod(declaration = {}) {
  const direct = Number(declaration.params?.period ?? declaration.period ?? declaration.length)
  if (Number.isSafeInteger(direct) && direct > 0) return direct
  const match = /(?:^|[_-])atr(?:[_-]?(\d+))(?:$|[_-])/i.exec(String(declaration.id || declaration.name || ''))
  const inferred = Number(match?.[1])
  return Number.isSafeInteger(inferred) && inferred > 0 ? inferred : null
}

function atrDeclarationTimeframe(declaration = {}) {
  return String(declaration.source?.timeframe || declaration.timeframe || declaration.source_timeframe || '')
    .trim().toUpperCase()
}

function manualTradeReviewV3AtrDeclarations(strategySnapshot = {}) {
  const policy = strategySnapshot?.strategy_policy || strategySnapshot?.strategyPolicy || {}
  const candidates = [
    ...atrDeclarationValues(policy.indicators),
    ...atrDeclarationValues(strategySnapshot?.indicator_declarations || strategySnapshot?.indicatorDeclarations),
    ...atrDeclarationValues(strategySnapshot?.market_data_plan?.indicators),
  ]
  return candidates.filter(declaration => /(?:^|[_-])atr(?:$|[_-])|average_true_range/i.test(
    `${declaration.id || ''} ${declaration.kind || ''} ${declaration.type || ''} ${declaration.name || ''}`,
  )).map(declaration => ({
    id:String(declaration.id || declaration.name || '').trim().toLowerCase(),
    timeframe:atrDeclarationTimeframe(declaration), period:atrDeclarationPeriod(declaration),
  })).filter(item => item.id && item.timeframe && item.period)
}

function indicatorAtrValue(value, period) {
  if (typeof value === 'number') return Number.isFinite(value) && value > 0 ? value : null
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const declaredPeriod = Number(value.period ?? value.params?.period)
  if (Number.isFinite(declaredPeriod) && declaredPeriod > 0 && declaredPeriod !== period) return null
  for (const key of ['value', 'atr', 'atr_value', 'average_true_range']) {
    const number = Number(value[key])
    if (Number.isFinite(number) && number > 0) return number
  }
  return null
}

function atrIndicatorKeyMatches(key, declaration) {
  const normalizedKey = String(key || '').trim().toLowerCase()
  if (normalizedKey === declaration.id) return true
  if (!normalizedKey.includes('atr') && !normalizedKey.includes('average_true_range')) return false
  const periodMatch = /(?:^|[_-])atr(?:[_-]?(\d+))(?:$|[_-])/i.exec(normalizedKey)
  return Number(periodMatch?.[1]) === declaration.period
}

function manualTradeReviewV3FindAtrEvidence(point, strategySnapshot = {}) {
  const marketData = point?.market_data || point?.closed_market_data || {}
  const primaryTimeframe = String(point?.primary_timeframe || marketData?.primary_timeframe || '').trim().toUpperCase()
  if (!primaryTimeframe) return { atr_timeframe:null, atr_period:null, atr_value:null, atr_evidence_ref:null }
  const declarations = manualTradeReviewV3AtrDeclarations(strategySnapshot)
    .filter(item => item.timeframe === primaryTimeframe)
  // No declaration, or more than one possible declaration, means the server
  // cannot safely choose an ATR identity/period.
  if (declarations.length !== 1) return { atr_timeframe:primaryTimeframe, atr_period:null, atr_value:null, atr_evidence_ref:null }
  const declaration = declarations[0]
  const frame = marketData?.timeframes?.[primaryTimeframe]
  const indicators = frame?.indicators
  if (!indicators || typeof indicators !== 'object' || Array.isArray(indicators)) {
    return { atr_timeframe:primaryTimeframe, atr_period:declaration.period, atr_value:null, atr_evidence_ref:null }
  }
  const matches = Object.entries(indicators)
    .filter(([key]) => atrIndicatorKeyMatches(key, declaration))
    .map(([key, value]) => ({ key, value:indicatorAtrValue(value, declaration.period) }))
    .filter(item => item.value != null)
  if (matches.length !== 1) {
    return { atr_timeframe:primaryTimeframe, atr_period:declaration.period, atr_value:null, atr_evidence_ref:null }
  }
  const refs = Array.isArray(point?.allowed_evidence_refs)
    ? point.allowed_evidence_refs.filter(ref => String(ref).startsWith('market:')
      && String(ref).split(':').at(-1)?.toUpperCase() === primaryTimeframe)
    : []
  return { atr_timeframe:primaryTimeframe, atr_period:declaration.period, atr_value:matches[0].value,
    atr_evidence_ref:refs.length === 1 ? refs[0] : null }
}

function manualTradeReviewV3FindAtr(point, strategySnapshot = {}) {
  return manualTradeReviewV3FindAtrEvidence(point, strategySnapshot).atr_value
}

function manualTradeReviewV3ProtectionAssessment(candidate, point, strategySnapshot = {}) {
  const marketData = point?.market_data || point?.closed_market_data || {}
  const atrEvidence = manualTradeReviewV3FindAtrEvidence(point, strategySnapshot)
  const assessment = evaluateManualTradeReviewProtectionPlan(candidate.protection_plan, {
    direction:candidate.decision,
    entryPrice:candidate.entry_price_reference,
    atr:atrEvidence.atr_value,
    contractSpec:point?.historical_contract_spec || point?.contract_spec || point?.contractSpec
      || marketData?.historical_contract_spec || marketData?.contract_spec || marketData?.contractSpec,
    strategyConsistency:'unknown',
  })
  return { ...assessment, ...atrEvidence }
}

function manualTradeReviewV3ServerSummary(points, candidates, actualDirection, strategySnapshot = {}) {
  const normalizedCandidates = candidates.map(candidate => candidate.normalizedOutput || candidate.normalized_output || candidate)
  const protections = new Map(points.map((point, index) => {
    const output = normalizedCandidates[index]
    return [output.candidate_key, manualTradeReviewV3ProtectionAssessment(output, point, strategySnapshot)]
  }))
  const direction = deriveManualTradeReviewDirectionSummary(normalizedCandidates, actualDirection, {
    protectionByCandidate:protections,
  })
  const resultCandidates = direction.candidates.map(item => ({ ...item,
    protection_assessment:protections.get(item.candidate_key) || null,
  }))
  const first = resultCandidates.find(item => item.direction_match === 'same_direction_entry'
    || item.direction_match === 'same_direction_observe')
  const protection = first?.protection_assessment || resultCandidates[0]?.protection_assessment || null
  return { ...direction, candidates:resultCandidates,
    protection_assessment:protection || { protection_quality:'unknown', execution_feasibility:'unknown' },
  }
}

function manualTradeReviewV3PointBundle(points, normalizedCandidates, serverSummary) {
  return {
    output_contract_version:COUNTERFACTUAL_POINT_V3_OUTPUT_VERSION,
    points:points.map((point, index) => ({
      candidate_key:point.candidate_key, decision_time_utc_msc:point.decision_time_utc_msc,
      offset_bars:point.offset_bars, market_snapshot_hash:point.market_snapshot_hash,
      input_hash:point.input_hash, normalized_output:normalizedCandidates[index],
    })),
    server_derived_summary:serverSummary,
  }
}

function manualTradeReviewV3ValidatePersistedBundle(bundle, points, strategySnapshot) {
  if (!bundle || typeof bundle !== 'object' || bundle.output_contract_version !== COUNTERFACTUAL_POINT_V3_OUTPUT_VERSION
    || !bundle.server_derived_summary || typeof bundle.server_derived_summary !== 'object'
    || !Array.isArray(bundle.points)
    || bundle.points.length !== points.length) throw new Error('manual_trade_review_counterfactual_bundle_invalid')
  const byKey = new Map(bundle.points.map(point => [String(point?.candidate_key || ''), point]))
  return points.map(point => {
    const persisted = byKey.get(point.candidate_key)
    if (!persisted || String(persisted.market_snapshot_hash || '') !== point.market_snapshot_hash
      || String(persisted.input_hash || '') !== point.input_hash) {
      throw new Error('manual_trade_review_counterfactual_bundle_conflict')
    }
    const normalized = normalizeManualTradeReviewCounterfactualPoint(persisted.normalized_output, {
      strategySnapshot, strategyDeclaredTimeframes:deriveManualTradeReviewDeclaredTimeframes(strategySnapshot),
      evidenceAvailableTimeframes:deriveManualTradeReviewEvidenceTimeframes(point.market_data),
      allowedEvidenceRefs:point.allowed_evidence_refs,
    })
    if (normalized.candidate_key !== point.candidate_key) {
      throw new Error('manual_trade_review_counterfactual_bundle_candidate_conflict')
    }
    return normalized
  })
}

async function reconcileManualTradeReviewV3PointTask(pointRow, job, point) {
  if (!pointRow?.modelTaskId || !pointRow.normalizedOutputHash) return
  const task = await queryOne('SELECT task_id, status FROM ai_model_tasks WHERE task_id = ? LIMIT 1', [pointRow.modelTaskId])
  if (task && String(task.status) !== 'succeeded') {
    await markModelTaskSucceededFromResult(pointRow.modelTaskId, {
      resultRef:`manual_trade_review_counterfactual:${job.id}:${Number(job.generation_no || 1)}:${point.candidate_key}`,
      resultHash:pointRow.normalizedOutputHash,
    })
  }
}

async function runManualTradeReviewV3Point({ point, pointRow, reviewCase, sources, job, runtime, runtimeHash,
  memorySnapshot, endpoint, resolved, requestModel, lease, strategySnapshot } = {}) {
  const generationNo = Number(job.generation_no || 1)
  if (pointRow?.status === 'succeeded' && pointRow.normalizedOutput) {
    await reconcileManualTradeReviewV3PointTask(pointRow, job, point)
    return { output:normalizeManualTradeReviewCounterfactualPoint(pointRow.normalizedOutput, {
      strategySnapshot, strategyDeclaredTimeframes:deriveManualTradeReviewDeclaredTimeframes(strategySnapshot),
      evidenceAvailableTimeframes:deriveManualTradeReviewEvidenceTimeframes(point.market_data),
      allowedEvidenceRefs:point.allowed_evidence_refs,
    }), outputHash:pointRow.normalizedOutputHash, skipped:true }
  }
  if (pointRow?.status === 'status_unknown') {
    throw manualTradeReviewStageTaskError(`counterfactual_point_${point.candidate_key}`, 'status_unknown', { terminal:false, hold:true })
  }
  if (['failed', 'stale', 'conflict'].includes(String(pointRow?.status || ''))) {
    throw manualTradeReviewStageTaskError(`counterfactual_point_${point.candidate_key}`, 'terminal_requires_retry')
  }
  if (pointRow?.modelTaskId) {
    const priorTask = await queryOne('SELECT * FROM ai_model_tasks WHERE task_id = ? LIMIT 1', [pointRow.modelTaskId])
    if (!priorTask) throw manualTradeReviewStageTaskError(`counterfactual_point_${point.candidate_key}`, 'task_missing')
    const waitError = manualTradeReviewModelTaskWaitError(priorTask)
    if (waitError) throw waitError
    if (String(priorTask.status) === 'status_unknown') {
      throw manualTradeReviewStageTaskError(`counterfactual_point_${point.candidate_key}`, 'task_status_unknown', { terminal:false, hold:true })
    }
    if (MODEL_TASK_ACTIVE_STATES.has(String(priorTask.status))) {
      throw manualTradeReviewStageTaskError(`counterfactual_point_${point.candidate_key}`, 'task_active', { terminal:false, hold:true })
    }
    if (MODEL_TASK_TERMINAL_STATES.has(String(priorTask.status))) {
      throw manualTradeReviewStageTaskError(`counterfactual_point_${point.candidate_key}`, 'task_terminal')
    }
  }
  const messages = counterfactualPointPrompt(reviewCase, sources, point, memorySnapshot)
  const budget = await prepareManualTradeReviewBudget(resolved, messages)
  const pointOutputContractHash = manualTradeReviewV3PointContractHash()
  const inputHash = buildManualTradeReviewStageInputHash({ stage:'counterfactual', frozenRuntimeHash:runtimeHash,
    messages, outputContractHash:pointOutputContractHash, parentOutputHash:null })
  const validateOutput = value => normalizeManualTradeReviewCounterfactualPoint(value, {
    strategySnapshot, strategyDeclaredTimeframes:deriveManualTradeReviewDeclaredTimeframes(strategySnapshot),
    evidenceAvailableTimeframes:deriveManualTradeReviewEvidenceTimeframes(point.market_data),
    allowedEvidenceRefs:point.allowed_evidence_refs,
  })
  let tracker = null
  try {
    const idempotencyKey = `manual_trade_review:${Number(job.id)}:${generationNo}:counterfactual:${point.candidate_key}`
    tracker = await createModelTaskTracker({
      taskKind:'manual_analysis', queueClass:'background', ownerUserId:job.user_id,
      strategyId:job.strategy_id, domainType:'manual_trade_review_counterfactual_point', domainId:job.id,
      idempotencyKey, inputHash, snapshotHash:runtimeHash,
      promptHash:sha256(JSON.stringify(messages)), outputContractHash:pointOutputContractHash,
      provider:resolved.model.provider || resolved.model.api_provider, model:resolved.model.model_name || resolved.model.model,
      modelProfileId:resolved.model_profile_id, protocol:endpoint.protocol, credentialSource:resolved.credential_source,
      frozenContext:{ manual_review_runtime_hash:runtimeHash, stage:'counterfactual_point', candidate_key:point.candidate_key,
        decision_time_utc_msc:point.decision_time_utc_msc, offset_bars:point.offset_bars,
        market_snapshot_hash:point.market_snapshot_hash, input_hash:point.input_hash,
        allowed_evidence_refs:point.allowed_evidence_refs, parent_output_hash:null, generation_no:generationNo },
      maxAttempts:Number(job.max_attempts) || 3, taskDeadlineAtUtcMs:parseBeijingDateTime(job.task_deadline_at),
    }, { workerId:`manual-trade-review:${process.pid}:counterfactual:${point.candidate_key}`, linkTask:async taskId =>
      linkManualTradeReviewCounterfactualPointModelTask({ caseId:job.case_id, jobId:job.id, generationNo,
        candidateKey:point.candidate_key, modelTaskId:taskId, inputHash, leaseToken:job.lease_token }) })
    await createStrategyMemoryInjectionLog({ strategyId:job.strategy_id,
      actor:{ userId:job.user_id, role:'admin' }, library:memorySnapshot,
      injectionKind:`manual_trade_review_counterfactual_point_${point.candidate_key}`, modelTaskId:tracker.taskId })
    await tracker.persistBudget(budget)
    const requestSignal = () => {
      const signals = [lease.signal, tracker.signal].filter(Boolean)
      return signals.length > 1 ? AbortSignal.any(signals) : signals[0] || null
    }
    const callbacks = {
      onProviderRequest:event => tracker.onProviderRequest(event), onProviderUsage:event => tracker.onProviderUsage(event),
      onProviderActivity:event => tracker.onProviderActivity(event), onProviderQuiet:event => tracker.onProviderQuiet(event),
    }
    lease.assertOwned(); tracker.assertOwned()
    const businessDeadlineUtcMs = assertManualTradeReviewRequestTime(job)
    const deadlines = modelTaskDeadlines('manual_analysis', { nowUtcMs:Date.now(), businessDeadlineUtcMs })
    const raw = await requestModel({ url:endpoint.url, apiKey:resolved.model.api_key_encrypted,
      provider:resolved.model.provider || resolved.model.api_provider, model:resolved.model.model_name || resolved.model.model,
      temperature:Math.min(Number(resolved.model.temperature ?? 0.2), 0.3), maxTokens:budget.selectedMaxOutputTokens,
      thinkingEnabled:resolved.model.thinking_enabled, reasoningEffort:resolved.model.reasoning_effort, protocol:endpoint.protocol,
      messages, modelTaskBudget:budget, usageContext:{ userId:job.user_id, profileId:resolved.model_profile_id,
        credentialSource:resolved.credential_source, usage:'review', strategyId:job.strategy_id },
      timeout:Math.max(1, Math.min(deadlines.attemptSafetyDeadlineUtcMs, deadlines.taskDeadlineUtcMs) - Date.now()),
      deadlineAtMs:deadlines.attemptSafetyDeadlineUtcMs, followupValidUntilMs:deadlines.taskDeadlineUtcMs,
      signal:requestSignal(), ...callbacks, allowFollowupRequests:false, validateObject:validateOutput })
    lease.assertOwned(); tracker.assertOwned()
    const output = validateOutput(raw)
    const saved = await saveManualTradeReviewCounterfactualPointOutput({ caseId:job.case_id, jobId:job.id,
      generationNo, candidateKey:point.candidate_key, modelTaskId:tracker.taskId, leaseToken:job.lease_token,
      normalizedOutput:output })
    await tracker.resultReady({ resultHash:saved.normalizedOutputHash })
    await tracker.succeeded({ resultRef:`manual_trade_review_counterfactual:${job.id}:${generationNo}:${point.candidate_key}`,
      resultHash:saved.normalizedOutputHash })
    return { output, outputHash:saved.normalizedOutputHash, skipped:false, modelTaskId:tracker.taskId }
  } catch (error) {
    const hold = Boolean(error?.manualTradeReviewHold || error?.manualTradeReviewDeferUntilUtcMs)
    try {
      if (hold) await markManualTradeReviewCounterfactualPointUnknown({ caseId:job.case_id, jobId:job.id, generationNo,
        candidateKey:point.candidate_key, modelTaskId:tracker?.taskId || pointRow?.modelTaskId || null,
        leaseToken:job.lease_token, errorCode:error?.code || 'manual_trade_review_counterfactual_status_unknown' })
      else if (error?.manualTradeReviewTerminalTask) await markManualTradeReviewCounterfactualPointFailed({
        caseId:job.case_id, jobId:job.id, generationNo, candidateKey:point.candidate_key,
        modelTaskId:tracker?.taskId || pointRow?.modelTaskId || null, leaseToken:job.lease_token,
        errorCode:error?.code || 'manual_trade_review_counterfactual_failed' })
      // Keep a running point mutable for provider/validation failures.  The
      // durable model task tracker owns retry scheduling; marking it failed
      // here would make the next worker reject a retryable task permanently.
    } catch (statusError) {
      console.error('[ManualTradeReview] counterfactual point status update failed:', statusError.message)
    }
    try { await tracker?.failed(error, Number(job.attempt_count || 0) >= Number(job.max_attempts || 3)) } catch (trackerError) {
      console.error('[ManualTradeReview] counterfactual point task failure update failed:', trackerError.message)
    }
    throw error
  } finally {
    try { await tracker?.stop() } catch (error) { console.error('[ManualTradeReview] counterfactual point task stop failed:', error.message) }
  }
}

async function runManualTradeReviewV3Counterfactual({ points, reviewCase, sources, frozenEvidence, job, runtime,
  runtimeHash, memorySnapshot, endpoint, resolved, requestModel, lease, stageRows } = {}) {
  const strategySnapshot = parse(reviewCase.strategy_snapshot_json, {})
  const stage = stageRows.find(item => item.stage === 'counterfactual')
  if (!stage) throw manualTradeReviewStageTaskError('counterfactual', 'row_missing')
  const ledgerRows = await ensureManualTradeReviewCounterfactualPoints({ caseId:job.case_id, jobId:job.id,
    generationNo:Number(job.generation_no || 1), leaseToken:job.lease_token,
    candidates:points.map(point => ({ candidateKey:point.candidate_key, decisionTimeUtcMsc:point.decision_time_utc_msc,
      offsetBars:point.offset_bars, marketSnapshotHash:point.market_snapshot_hash, inputHash:point.input_hash })) })
  if (stage.status === 'status_unknown') throw manualTradeReviewStageTaskError('counterfactual', 'status_unknown', { terminal:false, hold:true })
  if (['failed', 'stale', 'conflict'].includes(String(stage.status || ''))) throw manualTradeReviewStageTaskError('counterfactual', 'terminal_requires_retry')
  let normalizedCandidates
  let outputHash = stage.normalizedOutputHash
  if (stage.status === 'succeeded' && stage.normalizedOutput) {
    const ledgerByKey = new Map(ledgerRows.map(row => [row.candidate_key, row]))
    for (const point of points) {
      const row = ledgerByKey.get(point.candidate_key)
      if (!row || row.status !== 'succeeded' || !row.normalizedOutput) {
        throw new Error('manual_trade_review_counterfactual_point_ledger_incomplete')
      }
      await reconcileManualTradeReviewV3PointTask(row, job, point)
    }
    normalizedCandidates = manualTradeReviewV3ValidatePersistedBundle(stage.normalizedOutput, points, strategySnapshot)
    for (const [index, point] of points.entries()) {
      const row = ledgerByKey.get(point.candidate_key)
      if (jsonHash(row.normalizedOutput) !== jsonHash(normalizedCandidates[index])) {
        throw new Error('manual_trade_review_counterfactual_point_output_conflict')
      }
    }
  } else {
    normalizedCandidates = []
    for (const point of points) {
      const row = ledgerRows.find(item => item.candidate_key === point.candidate_key)
      if (!row) throw new Error('manual_trade_review_counterfactual_point_missing')
      const result = await runManualTradeReviewV3Point({ point, pointRow:row, reviewCase, sources, job, runtime,
        runtimeHash, memorySnapshot, endpoint, resolved, requestModel, lease, strategySnapshot })
      normalizedCandidates.push(result.output)
    }
    const actualDirection = manualTradeReviewV3OutputDirection(parse(sources[0]?.normalized_trade_json, {})?.direction || sources[0]?.direction)
    const serverSummary = manualTradeReviewV3ServerSummary(points, normalizedCandidates, actualDirection, strategySnapshot)
    const bundle = manualTradeReviewV3PointBundle(points, normalizedCandidates, serverSummary)
    const bundleInputHash = buildManualTradeReviewStageInputHash({ stage:'counterfactual', frozenRuntimeHash:runtimeHash,
      messages:{ candidate_keys:points.map(point => point.candidate_key), input_hashes:points.map(point => point.input_hash) },
      outputContractHash:manualTradeReviewV3OutputContractHash(), parentOutputHash:null })
    const bundleTaskId = ledgerRows.find(row => row.model_task_id || row.modelTaskId)?.modelTaskId
    if (!bundleTaskId) throw new Error('manual_trade_review_counterfactual_point_task_missing')
    await linkManualTradeReviewStageModelTask({ caseId:job.case_id, jobId:job.id,
      generationNo:Number(job.generation_no || 1), stage:'counterfactual', modelTaskId:stage.model_task_id || bundleTaskId,
      inputHash:bundleInputHash, leaseToken:job.lease_token })
    const saved = await saveManualTradeReviewStageOutput({ caseId:job.case_id, jobId:job.id,
      generationNo:Number(job.generation_no || 1), stage:'counterfactual', leaseToken:job.lease_token,
      normalizedOutput:bundle })
    outputHash = saved.normalizedOutputHash
  }
  const actualDirection = manualTradeReviewV3OutputDirection(parse(sources[0]?.normalized_trade_json, {})?.direction || sources[0]?.direction)
  const serverSummary = manualTradeReviewV3ServerSummary(points, normalizedCandidates, actualDirection, strategySnapshot)
  return { normalizedCandidates, serverSummary, outputHash }
}

async function applyManualTradeReviewOutcome({ job, reviewCase, runtime, outputHash, sources = [], v3 = false,
  outcomeTracker = null } = {}) {
  const applied = await withTransaction(async run => {
    const [jobRows] = await run(`SELECT * FROM manual_trade_review_jobs
      WHERE id = ? AND generation_no = ? AND lease_token = ? AND status = 'leased' FOR UPDATE`,
    [job.id, Number(job.generation_no || 1), job.lease_token])
    const currentJob = jobRows?.[0]
    if (!currentJob) throw new Error('manual_trade_review_lease_lost')
    const [caseRows] = await run(`SELECT * FROM manual_trade_review_cases
      WHERE id = ? AND user_id = ? FOR UPDATE`, [job.case_id, job.user_id])
    const currentCase = caseRows?.[0]
    if (!currentCase || !['queued', 'generating'].includes(String(currentCase.status))) {
      throw new Error('manual_trade_review_action_not_allowed_in_generation')
    }
    if (Number(currentCase.current_version_id || 0) !== Number(runtime.parent_version_id || 0)) {
      throw new Error('manual_trade_review_parent_version_conflict')
    }
    const [stageRows] = await run(`SELECT * FROM manual_trade_review_stage_runs
      WHERE job_id = ? AND generation_no = ? ORDER BY FIELD(stage, 'counterfactual', 'outcome_review'), id FOR UPDATE`,
    [job.id, Number(job.generation_no || 1)])
    const shared = validateManualTradeReviewStageRuns(stageRows, {
      caseId:job.case_id, jobId:job.id, generationNo:Number(job.generation_no || 1),
    })
    const outcome = shared.stageRuns.find(stage => stage.stage === 'outcome_review')
    if (!outcome || outcome.status !== 'succeeded' || outcome.normalizedOutputHash !== outputHash) {
      throw new Error('manual_trade_review_outcome_stage_fence_lost')
    }
    const strategySnapshot = parse(currentCase.strategy_snapshot_json, {})
    const evidenceCatalog = buildManualReviewEvidenceCatalog(sources, parse(currentCase.evidence_json, {}))
    const content = v3
      ? normalizeManualTradeReviewV3Content(outcome.normalizedOutput, {
        strategySnapshot,
        strategyDeclaredTimeframes:deriveManualTradeReviewDeclaredTimeframes(strategySnapshot),
        evidenceAvailableTimeframes:deriveManualTradeReviewEvidenceTimeframes(evidenceCatalog.outcome_refs),
        allowedEvidenceRefs:evidenceCatalog.outcome_refs,
        sourceRefs:evidenceCatalog.trade_refs,
        sourceRefSet:new Set(evidenceCatalog.trade_refs),
        serverDerivedSummary:outcome.normalizedOutput.counterfactual_summary,
        serverProtectionAssessment:outcome.normalizedOutput.counterfactual_summary,
      })
      : validateManualTradeReviewContent(outcome.normalizedOutput, sources, strategySnapshot, {
        evidenceStatus:currentCase.evidence_status, evidence:parse(currentCase.evidence_json, {}) })
    const persistedContent = v3
      ? { ...content, counterfactual_points:outcome.normalizedOutput.counterfactual_points || [],
        counterfactual_summary:outcome.normalizedOutput.counterfactual_summary }
      : content
    const normalized = normalizeManualTradeReviewStageOutput(persistedContent)
    if (normalized.normalizedOutputHash !== outputHash) throw new Error('manual_trade_review_outcome_hash_mismatch')
    const now = beijingNow()
    const [existing] = await run(`SELECT id, version_no FROM manual_trade_review_versions
      WHERE case_id = ? AND content_hash = ? LIMIT 1 FOR UPDATE`, [job.case_id, outputHash])
    let versionId = Number(existing?.[0]?.id || 0) || null
    if (!versionId) {
      const [maxRows] = await run(`SELECT COALESCE(MAX(versions.version_no), 0) AS version_no FROM manual_trade_review_versions versions
        WHERE versions.case_id = ? FOR UPDATE`, [job.case_id])
      const versionNo = Number(maxRows?.[0]?.version_no || 0) + 1
      const [insert] = await run(`INSERT INTO manual_trade_review_versions
        (case_id, version_no, parent_version_id, author_type, author_user_id, content_json, content_hash, change_note, created_at)
        VALUES (?, ?, ?, 'model', NULL, ?, ?, NULL, ?)`, [job.case_id, versionNo, runtime.parent_version_id || null,
        normalized.normalizedOutputJson, outputHash, now])
      versionId = Number(insert.insertId)
    }
    const [caseUpdate] = await run(`UPDATE manual_trade_review_cases SET current_version_id = ?, status = 'draft', updated_at = ?
      WHERE id = ? AND user_id = ? AND status IN ('queued','generating') AND
        COALESCE(current_version_id, 0) = ?`, [versionId, now, job.case_id, job.user_id, Number(runtime.parent_version_id || 0)])
    if (Number(caseUpdate?.affectedRows ?? caseUpdate?.changes ?? 0) !== 1) {
      throw new Error('manual_trade_review_parent_version_conflict')
    }
    const [jobUpdate] = await run(`UPDATE manual_trade_review_jobs SET status = 'succeeded', progress_stage = 'completed',
      lease_token = NULL, lease_expires_at = NULL, completed_at = ?, updated_at = ?
      WHERE id = ? AND generation_no = ? AND lease_token = ? AND status = 'leased'`,
    [now, now, job.id, Number(job.generation_no || 1), job.lease_token])
    if (Number(jobUpdate?.affectedRows ?? jobUpdate?.changes ?? 0) !== 1) {
      throw new Error('manual_trade_review_lease_lost')
    }
    const resultRef = `manual_trade_review_case:${job.case_id}`
    if (outcomeTracker) {
      if (String(outcomeTracker.taskId || '') !== String(outcome.model_task_id || '')) {
        throw new Error('manual_trade_review_outcome_stage_task_conflict')
      }
      await outcomeTracker.succeedInTransaction(run, { resultRef, resultHash:outputHash })
    } else {
      if (!outcome.model_task_id) throw new Error('manual_trade_review_outcome_stage_task_missing')
      await reconcileModelTaskResultInTransaction(run, outcome.model_task_id, {
        resultRef, resultHash:outputHash,
      })
    }
    return { versionId, contentHash:outputHash }
  })
  if (outcomeTracker) await outcomeTracker.commitTransactionSucceeded()
  return applied
}

export async function runManualTradeReviewWorkerOnce({ requestModel = requestJsonObject } = {}) {
  const job = await claimManualTradeReviewJob()
  if (!job) return { status:'idle' }
  const lease = startManualTradeReviewLeaseHeartbeat(job)
  job._taskDeadlineAtMs = parseBeijingDateTime(job.task_deadline_at)
  let outcomeTracker = null
  try {
    lease.assertOwned()
    if (!job._taskDeadlineAtMs) throw new Error('manual_trade_review_deadline_missing')
    if (job._taskDeadlineAtMs <= Date.now()) throw Object.assign(new Error('manual_trade_review_generation_deadline_exceeded'), {
      code:'manual_trade_review_generation_deadline_exceeded',
    })
    const reviewCase = await queryOne('SELECT * FROM manual_trade_review_cases WHERE id = ? AND user_id = ?', [job.case_id, job.user_id])
    if (!reviewCase) throw new Error('manual_trade_review_not_found')
    const sources = await queryAll(`SELECT sources.* FROM manual_trade_review_sources sources
      JOIN manual_trade_review_cases cases ON cases.id = sources.case_id
      WHERE sources.case_id = ? AND cases.user_id = ? ORDER BY sources.id`, [job.case_id, job.user_id])
    if (sources.length !== 1) throw new Error('manual_trade_review_selection_invalid')
    const frozenEvidence = parse(reviewCase.evidence_json, {})
    const evidenceCatalog = buildManualReviewEvidenceCatalog(sources, frozenEvidence)
    const hasExplicitV3Contract = frozenEvidence?.review_contract_version === MANUAL_TRADE_REVIEW_V3_VERSION
    const sourcePath = frozenEvidence?.market_data?.trades?.[String(sources[0]?.source_identity_hash || '')]
    const hasCounterfactualPointField = Boolean(sourcePath && (
      Object.prototype.hasOwnProperty.call(sourcePath, 'counterfactual_points')
      || Object.prototype.hasOwnProperty.call(sourcePath, 'candidate_points')
    ))
    let v3Points = null
    try {
      v3Points = manualTradeReviewV3PointEvidence(reviewCase, sources, frozenEvidence)
    } catch (error) {
      // A v3 record (including an old unmarked record with the v3 evidence
      // shape) must never fall back to the v2 prompt.  Normalize all frozen
      // candidate evidence failures to one stable domain error for the job
      // and UI, while retaining the granular cause in logs/cause chains.
      if (hasExplicitV3Contract || hasCounterfactualPointField) {
        const unavailable = new Error('manual_trade_review_counterfactual_points_unavailable', { cause:error })
        unavailable.code = 'manual_trade_review_counterfactual_points_unavailable'
        throw unavailable
      }
      throw error
    }
    const isV3 = hasExplicitV3Contract || (Array.isArray(v3Points) && v3Points.length > 0)
    if (isV3 && (!Array.isArray(v3Points) || v3Points.length === 0)) {
      throw new Error('manual_trade_review_counterfactual_points_unavailable')
    }
    const resolved = await resolveAiTaskModel({ userId:job.user_id, strategyId:job.strategy_id, usage:'review',
      modelPurpose:'manual_trade_review' })
    if (!resolved.model) throw new Error(resolved.error || 'manual_trade_review_model_unavailable')
    const endpoint = modelEndpoint(resolved.model)
    const runtimeContext = await loadManualTradeReviewGenerationRuntime(job, reviewCase, resolved, endpoint, null,
      isV3 ? manualTradeReviewV3OutputContractHash() : manualTradeReviewOutputContractHash())
    const memorySnapshot = runtimeContext.memory
    const runtime = runtimeContext.runtime
    let stageRows = runtimeContext.stageRows
    let counterfactualResult
    let outcomeMessages
    let outcomeValidator
    if (isV3) {
      await queryRun(`UPDATE manual_trade_review_jobs SET progress_stage = 'counterfactual_points', stage_updated_at = ?, updated_at = ?
        WHERE id = ? AND generation_no = ? AND lease_token = ? AND status = 'leased'`,
      [beijingNow(), beijingNow(), job.id, Number(job.generation_no || 1), job.lease_token])
      const v3Counterfactual = await runManualTradeReviewV3Counterfactual({ points:v3Points, reviewCase, sources,
        frozenEvidence, job, runtime, runtimeHash:runtimeContext.runtimeHash, memorySnapshot, endpoint, resolved,
        requestModel, lease, stageRows })
      const serverCandidateByKey = new Map((v3Counterfactual.serverSummary.candidates || [])
        .map(item => [item.candidate_key, item]))
      const frozenPointBundle = v3Points.map((point, index) => {
        const normalized = v3Counterfactual.normalizedCandidates[index]
        const derived = serverCandidateByKey.get(point.candidate_key) || {}
        return { ...normalized, candidate_key:point.candidate_key, decision_time_utc_msc:point.decision_time_utc_msc,
          offset_bars:point.offset_bars, primary_timeframe:point.primary_timeframe || null, status:point.status || 'complete',
          market_snapshot_hash:point.market_snapshot_hash, input_hash:point.input_hash,
          allowed_evidence_refs:point.allowed_evidence_refs,
          ...(point.historical_contract_spec ? { historical_contract_spec:point.historical_contract_spec } : {}),
          normalized_output:normalized, direction_match:derived.direction_match || 'insufficient_evidence',
          strategy_eligibility:derived.strategy_eligibility || 'unknown',
          execution_feasibility:derived.execution_feasibility || 'unknown',
          protection_assessment:derived.protection_assessment || null }
      })
      const serverDerivedSummary = v3Counterfactual.serverSummary
      counterfactualResult = { output:v3Counterfactual.normalizedCandidates, outputHash:v3Counterfactual.outputHash,
        serverDerivedSummary, frozenPointBundle }
      stageRows = await readManualTradeReviewStageRuns({ caseId:job.case_id, jobId:job.id, generationNo:Number(job.generation_no || 1) })
      await queryRun(`UPDATE manual_trade_review_jobs SET progress_stage = 'outcome_review', stage_updated_at = ?, updated_at = ?
        WHERE id = ? AND generation_no = ? AND lease_token = ? AND status = 'leased'`,
      [beijingNow(), beijingNow(), job.id, Number(job.generation_no || 1), job.lease_token])
      outcomeMessages = outcomeReviewV3Prompt(reviewCase, sources, frozenPointBundle, serverDerivedSummary, memorySnapshot)
      outcomeValidator = value => {
        const normalized = normalizeManualTradeReviewV3Content(value, {
          strategySnapshot:parse(reviewCase.strategy_snapshot_json, {}),
          strategyDeclaredTimeframes:deriveManualTradeReviewDeclaredTimeframes(parse(reviewCase.strategy_snapshot_json, {})),
          evidenceAvailableTimeframes:deriveManualTradeReviewEvidenceTimeframes(evidenceCatalog.outcome_refs),
          allowedEvidenceRefs:evidenceCatalog.outcome_refs,
          sourceRefs:evidenceCatalog.trade_refs,
          sourceRefSet:new Set(evidenceCatalog.trade_refs),
          serverDerivedSummary,
          serverProtectionAssessment:serverDerivedSummary.protection_assessment,
        })
        return { ...normalized, counterfactual_points:frozenPointBundle,
          counterfactual_summary:normalized.counterfactual_summary }
      }
    } else {
      const counterfactualMessages = counterfactualPrompt(reviewCase, sources, memorySnapshot)
      const counterfactualBudget = await prepareManualTradeReviewBudget(resolved, counterfactualMessages)
      await queryRun(`UPDATE manual_trade_review_jobs SET progress_stage = 'counterfactual_analysis', stage_updated_at = ?, updated_at = ?
        WHERE id = ? AND generation_no = ? AND lease_token = ? AND status = 'leased'`,
      [beijingNow(), beijingNow(), job.id, Number(job.generation_no || 1), job.lease_token])
      counterfactualResult = await runManualTradeReviewStage({ stage:'counterfactual', job,
        runtime, runtimeHash:runtimeContext.runtimeHash, memorySnapshot, stageRows, endpoint, resolved, budget:counterfactualBudget,
        messages:counterfactualMessages, requestModel, lease,
        validateOutput:value => validateCounterfactualAnalysis(value, { allowedEvidenceRefs:evidenceCatalog.pre_entry_refs }) })
      const counterfactual = counterfactualResult.output
      stageRows = await readManualTradeReviewStageRuns({ caseId:job.case_id, jobId:job.id, generationNo:Number(job.generation_no || 1) })
      await queryRun(`UPDATE manual_trade_review_jobs SET progress_stage = 'outcome_review', stage_updated_at = ?, updated_at = ?
        WHERE id = ? AND generation_no = ? AND lease_token = ? AND status = 'leased'`,
      [beijingNow(), beijingNow(), job.id, Number(job.generation_no || 1), job.lease_token])
      outcomeMessages = outcomeReviewPrompt(reviewCase, sources, counterfactual, memorySnapshot)
      outcomeValidator = value => validateManualTradeReviewContent({ ...value, counterfactual_analysis:counterfactual }, sources,
        parse(reviewCase.strategy_snapshot_json, {}), { evidenceStatus:reviewCase.evidence_status, evidence:frozenEvidence })
    }
    const outcomeBudget = await prepareManualTradeReviewBudget(resolved, outcomeMessages)
    const outcomeResult = await runManualTradeReviewStage({ stage:'outcome_review', job,
      runtime, runtimeHash:runtimeContext.runtimeHash, memorySnapshot, stageRows, endpoint, resolved, budget:outcomeBudget,
      messages:outcomeMessages, parentOutputHash:counterfactualResult.outputHash, requestModel, lease,
      finalApply:true, outputContractHash:isV3 ? manualTradeReviewV3OutputContractHash() : null,
      validateOutput:outcomeValidator })
    outcomeTracker = outcomeResult.tracker
    lease.assertOwned(); outcomeTracker?.assertOwned()
    const applied = await applyManualTradeReviewOutcome({ job, reviewCase, runtime, outputHash:outcomeResult.outputHash,
      sources, v3:isV3, outcomeTracker })
    return { status:'succeeded', case_id:Number(job.case_id), version_id:applied.versionId }
  } catch (error) {
    let failure = error
    if (error?.manualTradeReviewHold && !Number(error.manualTradeReviewDeferUntilUtcMs)) {
      error.manualTradeReviewDeferUntilUtcMs = Date.now() + 30_000
    }
    if (Number(error?.manualTradeReviewDeferUntilUtcMs) > 0 && !outcomeTracker) {
      try {
        const deferred = await deferManualTradeReviewForModelTaskLease(job, error)
        if (deferred) return { status:deferred.status, case_id:Number(job.case_id), error:deferred.error_code }
      } catch (deferError) { failure = deferError }
    }
    try { await outcomeTracker?.failed(failure, Number(job.attempt_count || 0) >= Number(job.max_attempts || 3)) }
    catch (trackerError) { failure = trackerError }
    await markJobFailure(job, failure)
    return { status:'failed', case_id:Number(job.case_id), error:String(failure?.code || failure?.message || 'manual_trade_review_generation_failed') }
  } finally {
    try { await outcomeTracker?.stop() } catch (error) { console.error('[ManualTradeReview] model task stop failed:', error.message) }
    await lease.stop()
  }
}

export async function recoverAbandonedManualTradeReviewJobs({ now = beijingNow(), limit = 100 } = {}) {
  const rows = await queryAll(`SELECT id, case_id, generation_no, task_deadline_at, attempt_count, max_attempts, progress_stage FROM manual_trade_review_jobs
    WHERE status = 'leased' AND lease_expires_at < ? ORDER BY id LIMIT ?`, [now, Math.min(500, Math.max(1, Number(limit) || 100))])
  let requeued = 0; let failed = 0; let manualRetryRequired = 0
  for (const job of rows) {
    const stageRows = await readManualTradeReviewStageRuns({ caseId:job.case_id, jobId:job.id, generationNo:Number(job.generation_no || 1) })
    let pointRows = []
    try {
      pointRows = await readManualTradeReviewCounterfactualPoints({ caseId:job.case_id, jobId:job.id,
        generationNo:Number(job.generation_no || 1) })
    } catch {
      // The point ledger is an additive v3 capability.  A deployment that has
      // not applied its migration must retain the complete v2 recovery path.
      pointRows = []
    }
    const deadlineAt = parseBeijingDateTime(job.task_deadline_at)
    const deadlineExpired = Number.isFinite(deadlineAt) && deadlineAt > 0 && deadlineAt <= Date.now()
    const taskRows = []
    for (const stage of stageRows) {
      if (!stage.model_task_id) continue
      const task = await queryOne('SELECT status, lease_expires_at_utc_msc, scheduled_at_utc_msc FROM ai_model_tasks WHERE task_id = ? LIMIT 1', [stage.model_task_id])
      if (task) taskRows.push({ stage, task })
    }
    for (const point of pointRows) {
      if (!point.model_task_id) continue
      const task = await queryOne('SELECT status, lease_expires_at_utc_msc, scheduled_at_utc_msc FROM ai_model_tasks WHERE task_id = ? LIMIT 1', [point.model_task_id])
      if (task) taskRows.push({ stage:point, task })
    }
    const hasUnknownOrActiveTask = taskRows.some(({ stage, task }) =>
      stage.status === 'status_unknown' || String(task.status) === 'status_unknown' || MODEL_TASK_ACTIVE_STATES.has(String(task.status)))
    const hasTerminalStage = stageRows.some(stage => ['failed', 'stale', 'conflict'].includes(String(stage.status)))
      || pointRows.some(point => ['failed', 'stale', 'conflict'].includes(String(point.status)))
    const unsafeLegacyGeneration = stageRows.length === 0
      && ['generating', 'counterfactual_analysis', 'outcome_review'].includes(String(job.progress_stage || ''))
    const incompleteStageLedger = stageRows.length > 0 && stageRows.length !== 2
    const outcomeSucceeded = stageRows.some(stage => stage.stage === 'outcome_review' && stage.status === 'succeeded')
    const counterfactualSucceeded = stageRows.some(stage => stage.stage === 'counterfactual' && stage.status === 'succeeded')
    const progressStage = outcomeSucceeded ? 'outcome_review' : counterfactualSucceeded ? 'outcome_review' : 'counterfactual_analysis'
    const holdForReconciliation = !deadlineExpired && hasUnknownOrActiveTask
    const exhausted = !holdForReconciliation && (deadlineExpired || hasTerminalStage || unsafeLegacyGeneration || incompleteStageLedger
      || Number(job.attempt_count || 0) >= Number(job.max_attempts || 3))
    if (unsafeLegacyGeneration || incompleteStageLedger || hasTerminalStage || deadlineExpired) manualRetryRequired++
    const errorCode = holdForReconciliation
      ? 'manual_trade_review_stage_task_reconciliation_required'
      : deadlineExpired
        ? 'manual_trade_review_generation_deadline_exceeded'
        : unsafeLegacyGeneration
          ? 'manual_trade_review_generation_expired_manual_retry_required'
          : incompleteStageLedger
            ? 'manual_trade_review_stage_runs_incomplete'
        : hasTerminalStage
          ? 'manual_trade_review_stage_terminal_requires_retry'
          : 'manual_trade_review_worker_recovered'
    const targetStage = exhausted ? 'failed' : progressStage
    const result = await queryRun(`UPDATE manual_trade_review_jobs SET status = ?, progress_stage = ?, lease_token = NULL,
      lease_expires_at = NULL, last_error_code = ?, next_attempt_at = ?, completed_at = ?, updated_at = ?
      WHERE id = ? AND status = 'leased' AND lease_expires_at < ?`, [exhausted ? 'failed' : 'queued', targetStage,
      errorCode, exhausted ? null : now, exhausted ? now : null, now, job.id, now])
    if (Number(result?.changes ?? result?.affectedRows ?? 0)) {
      if (exhausted) failed++; else requeued++
      await queryRun(`UPDATE manual_trade_review_cases cases
        JOIN manual_trade_review_jobs jobs ON jobs.id = ? AND jobs.case_id = cases.id
        SET cases.status = ?, cases.updated_at = ?
        WHERE cases.status IN ('queued','generating') AND jobs.status = ?`, [job.id, exhausted ? 'failed' : 'queued', now, exhausted ? 'failed' : 'queued'])
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

export const __manualTradeReviewTest = {
  manualTradeReviewFrozenCandidateCount, manualTradeReviewDeadlineMs, newManualTradeReviewDeadline,
  assertManualTradeReviewRequestTime,
  parse, getPlatformStrategySnapshot, counterfactualPrompt, outcomeReviewPrompt,
  manualTradeReviewModelIdempotencyKey, manualTradeReviewModelTaskWaitError,
  manualTradeReviewModelTaskTerminalError, manualTradeReviewCanRecoverCompletedTask, claimManualTradeReviewJob,
  manualTradeReviewEvidenceReason, frozenMemoryPayload, loadManualTradeReviewGenerationRuntime,
  manualTradeReviewStageTaskError, deferManualTradeReviewForModelTaskLease,
  runManualTradeReviewStage, runManualTradeReviewV3Point, runManualTradeReviewV3Counterfactual,
  manualTradeReviewV3PointEvidence, manualTradeReviewV3ServerSummary, manualTradeReviewV3PointBundle,
  manualTradeReviewV3FindAtr, manualTradeReviewV3FindAtrEvidence,
  manualTradeReviewV3ValidatePersistedBundle, manualTradeReviewV3OutputContractHash, manualTradeReviewV3PointContractHash,
  applyManualTradeReviewOutcome, recoverAbandonedManualTradeReviewJobs, markJobFailure,
  manualTradeReviewDeterministicEvidenceFailure,
}
