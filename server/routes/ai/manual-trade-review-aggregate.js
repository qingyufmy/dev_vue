import crypto from 'node:crypto'
import { beijingNow, queryAll, queryOne, queryRun, withTransaction } from '../../db.js'
import { requestJsonObject } from './llm.js'
import { createModelTaskTracker } from './model-task-tracker.js'
import { estimateModelInputTokens, modelTaskDeadlines, selectModelTaskBudget } from './model-task-budget.js'
import { getModelProviderCapabilities } from './model-provider-capabilities.js'
import { MODEL_PROVIDER_DEFAULTS, modelProviderProtocol } from './model-providers.js'
import { resolveAiTaskModel } from './model-profiles.js'
import { sha256 } from './inference-snapshots.js'
import {
  MANUAL_TRADE_REVIEW_AGGREGATE_V1_VERSION,
  buildManualTradeReviewAggregateSourceSummary,
  normalizeManualTradeReviewAggregateOutput,
} from './manual-trade-review-v3-contract.js'

export const MANUAL_TRADE_REVIEW_AGGREGATE_MIN_SOURCES = 2
export const MANUAL_TRADE_REVIEW_AGGREGATE_MAX_SOURCES = 20
export const MANUAL_TRADE_REVIEW_AGGREGATE_DEFAULT_MAX_ATTEMPTS = 3
export const MANUAL_TRADE_REVIEW_AGGREGATE_LEASE_MS = 120_000
export const MANUAL_TRADE_REVIEW_AGGREGATE_DEADLINE_MS = 30 * 60_000

export const MANUAL_TRADE_REVIEW_AGGREGATE_SOURCE_STATUSES = new Set([
  'draft', 'edited', 'needs_revision', 'approved',
])
export const MANUAL_TRADE_REVIEW_AGGREGATE_RETRY_STATUSES = new Set(['failed', 'deferred', 'status_unknown'])

const HASH_PATTERN = /^[0-9a-f]{64}$/i
const CASE_STATUS_COMPLETED = MANUAL_TRADE_REVIEW_AGGREGATE_SOURCE_STATUSES
const DIRECTION_MATCH_KEYS = new Set([
  'same_direction_entry', 'same_direction_observe', 'opposite_direction', 'hold', 'insufficient_evidence',
])
const PROTECTION_QUALITY_KEYS = new Set(['reasonable', 'partial', 'unreasonable', 'unknown'])
const TECHNICAL_ORIGINS = new Set(['strategy_derived', 'manual_logic_inferred', 'unexplained'])
const MODEL_TASK_TERMINAL_STATES = new Set(['cancelled', 'failed_terminal', 'succeeded', 'completed_stale', 'completed_rejected'])
const MODEL_TASK_ACTIVE_STATES = new Set(['leased', 'preparing', 'submitted', 'provider_running', 'provider_quiet',
  'status_unknown', 'reconciling', 'response_received', 'validating', 'repairing', 'result_ready', 'applying'])

function aggregateError(code) {
  return new Error(`manual_trade_review_aggregate_${code}`)
}

function positiveId(value, field = 'id') {
  const number = Number(value)
  if (!Number.isSafeInteger(number) || number <= 0) throw aggregateError(`${field}_invalid`)
  return number
}

function normalizedHash(value, field = 'content_hash') {
  const hash = String(value == null ? '' : value).trim().toLowerCase()
  if (!HASH_PATTERN.test(hash)) throw aggregateError(`${field}_invalid`)
  return hash
}

function clientRequestId(value) {
  const normalized = String(value == null ? '' : value).normalize('NFKC').trim()
  if (!normalized || normalized.length > 191) throw aggregateError('client_request_id_invalid')
  return normalized
}

function parseJson(value, fallback = null) {
  if (value == null || value === '') return fallback
  if (typeof value === 'object') return value
  try { return JSON.parse(value) } catch { return fallback }
}

function sourceReference(source) {
  return `case:${source.case_id}:version:${source.version_id}:hash:${source.content_hash}`
}

function sourceSort(left, right) {
  return left.case_id - right.case_id || left.version_id - right.version_id
    || left.content_hash.localeCompare(right.content_hash)
}

/** Normalize client supplied immutable case/version/hash references. */
export function normalizeManualTradeReviewAggregateSources(sources) {
  if (!Array.isArray(sources)
    || sources.length < MANUAL_TRADE_REVIEW_AGGREGATE_MIN_SOURCES
    || sources.length > MANUAL_TRADE_REVIEW_AGGREGATE_MAX_SOURCES) {
    throw aggregateError('source_count_invalid')
  }
  const normalized = sources.map(source => {
    if (!source || typeof source !== 'object' || Array.isArray(source)) throw aggregateError('source_invalid')
    const caseId = positiveId(source.case_id ?? source.caseId, 'case_id')
    const versionId = positiveId(source.version_id ?? source.versionId, 'version_id')
    const contentHash = normalizedHash(source.content_hash ?? source.contentHash)
    return { case_id:caseId, version_id:versionId, content_hash:contentHash }
  }).sort(sourceSort)
  const refs = new Set()
  const versions = new Set()
  for (const source of normalized) {
    const ref = sourceReference(source)
    const versionRef = `${source.case_id}:${source.version_id}`
    if (refs.has(ref)) throw aggregateError('source_duplicate')
    if (versions.has(versionRef)) throw aggregateError('source_version_duplicate')
    refs.add(ref); versions.add(versionRef)
  }
  return normalized.map(source => ({ ...source, ref:sourceReference(source) }))
}

export function manualTradeReviewAggregateSelectionHash(sources) {
  const normalized = normalizeManualTradeReviewAggregateSources(sources)
  return sha256(JSON.stringify(normalized.map(({ case_id, version_id, content_hash }) => ({
    case_id, version_id, content_hash,
  }))))
}

export function manualTradeReviewAggregateModelIdempotencyKey({ aggregateId, generationNo } = {}) {
  return `manual_trade_review_aggregate:${positiveId(aggregateId, 'aggregate_case_id')}:${positiveId(generationNo, 'generation_no')}`
}

function actorId(actor) {
  return Number(actor?.id ?? actor?.user_id ?? actor?.userId ?? 0)
}

function assertOwner(actor, userId) {
  const id = positiveId(userId, 'user_id')
  if (actorId(actor) !== id) throw aggregateError('forbidden')
  return id
}

function runRows(result) {
  if (Array.isArray(result) && Array.isArray(result[0])) return result[0]
  if (Array.isArray(result)) return result
  if (Array.isArray(result?.rows)) return result.rows
  return []
}

function runResult(result) {
  if (Array.isArray(result)) return result[0] || {}
  return result || {}
}

function nonEmptyLeaseToken(value) {
  const token = String(value == null ? '' : value).trim()
  if (!token) throw aggregateError('lease_required')
  if (token.length > 191) throw aggregateError('lease_invalid')
  return token
}

function nonEmptyTaskId(value) {
  const taskId = String(value == null ? '' : value).trim()
  if (!taskId || taskId.length > 191) throw aggregateError('model_task_id_required')
  return taskId
}

function affectedRows(result) {
  return Number(runResult(result).affectedRows ?? runResult(result).changes ?? 0)
}

function dbApi(db = {}) {
  return {
    queryAll:db.queryAll || queryAll,
    queryOne:db.queryOne || queryOne,
    queryRun:db.queryRun || queryRun,
    withTransaction:db.withTransaction || withTransaction,
  }
}

async function txRows(run, sql, params = []) {
  return runRows(await run(sql, params))
}

async function txOne(run, sql, params = []) {
  return (await txRows(run, sql, params))[0] || null
}

async function txRun(run, sql, params = []) {
  return runResult(await run(sql, params))
}

function dateAfter(milliseconds) {
  return new Date(Date.now() + Number(milliseconds || 0) + 8 * 3600_000)
    .toISOString().replace('T', ' ').slice(0, 19)
}

function parseBeijingDateTime(value) {
  if (!value) return null
  const date = new Date(`${String(value).replace(' ', 'T')}+08:00`)
  return Number.isFinite(date.getTime()) ? date.getTime() : null
}

function modelEndpoint(model) {
  const provider = model?.provider || model?.api_provider
  const protocol = modelProviderProtocol(provider)
  const base = String(model?.api_base_url || MODEL_PROVIDER_DEFAULTS[provider] || '').replace(/\/+$/, '')
  if (!base) throw aggregateError('model_provider_unavailable')
  return { protocol, url:`${base}/${protocol === 'responses' ? 'responses' : 'chat/completions'}` }
}

function publicCase(row) {
  if (!row) return null
  return {
    id:Number(row.id),
    client_request_id:row.client_request_id,
    user_id:Number(row.user_id),
    trading_account_id:Number(row.trading_account_id),
    strategy_id:Number(row.strategy_id),
    strategy_versions:parseJson(row.strategy_versions_json, []),
    selection_hash:row.selection_hash,
    frozen_source_set_hash:row.frozen_source_set_hash || null,
    strategy_snapshot_hash:row.strategy_snapshot_hash || null,
    input_hash:row.input_hash || null,
    prompt_hash:row.prompt_hash || null,
    output_contract_hash:row.output_contract_hash || null,
    status:row.status,
    task_deadline_at:row.task_deadline_at || null,
    generation_no:Number(row.generation_no || 1),
    attempt_count:Number(row.attempt_count || 0),
    max_attempts:Number(row.max_attempts || MANUAL_TRADE_REVIEW_AGGREGATE_DEFAULT_MAX_ATTEMPTS),
    progress_stage:row.progress_stage,
    stage_updated_at:row.stage_updated_at,
    current_version_id:row.current_version_id == null ? null : Number(row.current_version_id),
    approved_version_id:row.approved_version_id == null ? null : Number(row.approved_version_id),
    model_profile_id:row.model_profile_id == null ? null : Number(row.model_profile_id),
    model_task_id:row.model_task_id || null,
    last_error_code:row.last_error_code || null,
    last_failure_generation_no:row.last_failure_generation_no == null ? null : Number(row.last_failure_generation_no),
    last_failure_at:row.last_failure_at || null,
    next_attempt_at:row.next_attempt_at || null,
    completed_at:row.completed_at || null,
    created_at:row.created_at,
    updated_at:row.updated_at,
  }
}

function publicSource(row) {
  return {
    id:Number(row.id),
    aggregate_case_id:Number(row.aggregate_case_id),
    case_id:Number(row.source_case_id),
    version_id:Number(row.source_version_id),
    content_hash:row.source_content_hash,
    user_id:Number(row.source_user_id),
    trading_account_id:Number(row.source_trading_account_id),
    strategy_id:Number(row.source_strategy_id),
    strategy_version:Number(row.source_strategy_version),
    confirmation_status:row.confirmation_status,
    confirmed:row.confirmation_status === 'confirmed',
    ref:`case:${row.source_case_id}:version:${row.source_version_id}:hash:${row.source_content_hash}`,
    created_at:row.created_at,
  }
}

function publicVersion(row) {
  if (!row) return null
  return {
    id:Number(row.id), aggregate_case_id:Number(row.aggregate_case_id),
    generation_no:Number(row.generation_no), version_no:Number(row.version_no),
    parent_version_id:row.parent_version_id == null ? null : Number(row.parent_version_id),
    author_type:row.author_type, author_user_id:row.author_user_id == null ? null : Number(row.author_user_id),
    model_profile_id:row.model_profile_id == null ? null : Number(row.model_profile_id),
    source_set_hash:row.source_set_hash, content_hash:row.content_hash,
    content:parseJson(row.content_json, null), created_at:row.created_at,
  }
}

async function loadPinnedSource(run, selection, { userId, tradingAccountId, strategyId }) {
  const row = await txOne(run, `SELECT cases.id AS source_case_id, cases.user_id AS source_user_id,
      cases.trading_account_id AS source_trading_account_id, cases.strategy_id AS source_strategy_id,
      cases.strategy_version AS source_strategy_version, cases.status AS source_case_status,
      cases.approved_version_id, cases.strategy_snapshot_json, cases.strategy_snapshot_hash,
      versions.id AS source_version_id, versions.content_json,
      versions.content_hash AS source_content_hash
    FROM manual_trade_review_cases cases
    JOIN manual_trade_review_versions versions ON versions.case_id = cases.id
    WHERE cases.id = ? AND versions.id = ? AND cases.user_id = ?
    FOR UPDATE`, [selection.case_id, selection.version_id, userId])
  if (!row) throw aggregateError('source_not_found')
  if (Number(row.source_trading_account_id) !== Number(tradingAccountId)) throw aggregateError('source_account_mismatch')
  if (Number(row.source_strategy_id) !== Number(strategyId)) throw aggregateError('source_strategy_mismatch')
  if (!CASE_STATUS_COMPLETED.has(String(row.source_case_status))) throw aggregateError('source_not_completed')
  const storedHash = normalizedHash(row.source_content_hash, 'stored_content_hash')
  if (storedHash !== selection.content_hash) throw aggregateError('source_hash_mismatch')
  const calculatedHash = sha256(row.content_json)
  if (calculatedHash !== storedHash) throw aggregateError('source_content_hash_invalid')
  const confirmed = String(row.source_case_status) === 'approved'
    && Number(row.approved_version_id) === Number(row.source_version_id)
  return {
    case_id:Number(row.source_case_id), version_id:Number(row.source_version_id), content_hash:storedHash,
    ref:sourceReference({ case_id:Number(row.source_case_id), version_id:Number(row.source_version_id), content_hash:storedHash }),
    user_id:Number(row.source_user_id), trading_account_id:Number(row.source_trading_account_id),
    strategy_id:Number(row.source_strategy_id), strategy_version:Number(row.source_strategy_version),
    confirmation_status:confirmed ? 'confirmed' : 'unconfirmed', confirmed,
    strategy_snapshot_json:row.strategy_snapshot_json,
    strategy_snapshot_hash:row.strategy_snapshot_hash,
    content_json:row.content_json,
  }
}

async function loadPinnedSources(run, selections, context) {
  const rows = []
  for (const selection of selections) rows.push(await loadPinnedSource(run, selection, context))
  const strategyVersions = [...new Set(rows.map(row => Number(row.strategy_version)))].sort((a, b) => a - b)
  return { rows, strategyVersions }
}

function canonicalSnapshotJson(value) {
  if (value == null || value === '') return null
  const parsed = parseJson(value, null)
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw aggregateError('strategy_snapshot_invalid')
  return JSON.stringify(parsed)
}

function frozenSourceRecord(row) {
  return {
    case_id:Number(row.case_id ?? row.source_case_id),
    version_id:Number(row.version_id ?? row.source_version_id),
    content_hash:String(row.content_hash ?? row.source_content_hash).toLowerCase(),
    user_id:Number(row.user_id ?? row.source_user_id),
    trading_account_id:Number(row.trading_account_id ?? row.source_trading_account_id),
    strategy_id:Number(row.strategy_id ?? row.source_strategy_id),
    strategy_version:Number(row.strategy_version ?? row.source_strategy_version),
    confirmation_status:String(row.confirmation_status || 'unconfirmed'),
    ref:row.ref || sourceReference({
      case_id:Number(row.case_id ?? row.source_case_id),
      version_id:Number(row.version_id ?? row.source_version_id),
      content_hash:String(row.content_hash ?? row.source_content_hash).toLowerCase(),
    }),
  }
}

export function manualTradeReviewAggregateFrozenSourceSetHash(rows = []) {
  return sha256(JSON.stringify((Array.isArray(rows) ? rows : []).map(frozenSourceRecord).sort(sourceSort)))
}

function snapshotRecord(row) {
  const snapshotJson = canonicalSnapshotJson(row.strategy_snapshot_json)
  if (!snapshotJson) throw aggregateError('strategy_snapshot_missing')
  const suppliedHash = normalizedHash(row.strategy_snapshot_hash, 'strategy_snapshot_hash')
  if (sha256(snapshotJson) !== suppliedHash) throw aggregateError('strategy_snapshot_changed')
  return {
    strategy_version:Number(row.strategy_version ?? row.source_strategy_version),
    strategy_snapshot_hash:suppliedHash,
    strategy_snapshot_json:snapshotJson,
    strategy_snapshot:JSON.parse(snapshotJson),
  }
}

function mergeStrategySnapshotObjects(target, source) {
  if (!source || typeof source !== 'object' || Array.isArray(source)) return target
  for (const [key, value] of Object.entries(source)) {
    if (target[key] == null) {
      target[key] = JSON.parse(JSON.stringify(value))
    } else if (target[key] && typeof target[key] === 'object' && !Array.isArray(target[key])
      && value && typeof value === 'object' && !Array.isArray(value)) {
      mergeStrategySnapshotObjects(target[key], value)
    }
  }
  return target
}

function combinedStrategySnapshot(snapshots = []) {
  const combined = {}
  for (const snapshot of snapshots) mergeStrategySnapshotObjects(combined, snapshot.strategy_snapshot)
  return combined
}

function freezeAggregateSnapshots(rows) {
  const snapshots = []
  const seen = new Set()
  for (const row of rows) {
    const snapshot = snapshotRecord(row)
    const key = `${snapshot.strategy_version}:${snapshot.strategy_snapshot_hash}`
    if (seen.has(key)) continue
    seen.add(key)
    snapshots.push(snapshot)
  }
  snapshots.sort((left, right) => left.strategy_version - right.strategy_version
    || left.strategy_snapshot_hash.localeCompare(right.strategy_snapshot_hash))
  const json = JSON.stringify(snapshots.map(item => ({
    strategy_version:item.strategy_version,
    strategy_snapshot_hash:item.strategy_snapshot_hash,
    strategy_snapshot:JSON.parse(item.strategy_snapshot_json),
  })))
  return { snapshots, json, hash:sha256(json), primary:snapshots[0]?.strategy_snapshot || null,
    combined:combinedStrategySnapshot(snapshots) }
}

/**
 * Re-read every pinned source under the aggregate row lock.  Claiming is the
 * point at which the source set and all strategy snapshots become immutable;
 * subsequent provider work may only use this returned envelope.
 */
async function loadAndFreezeAggregateEnvelope(run, aggregateRow) {
  const rows = await txRows(run, `SELECT sources.*, cases.user_id AS source_user_id,
      cases.trading_account_id AS source_trading_account_id, cases.strategy_id AS source_strategy_id,
      cases.strategy_version AS source_strategy_version, cases.status AS source_case_status,
      cases.approved_version_id, cases.strategy_snapshot_json, cases.strategy_snapshot_hash,
      versions.content_json, versions.content_hash AS version_content_hash
    FROM manual_trade_review_aggregate_sources sources
    JOIN manual_trade_review_cases cases ON cases.id = sources.source_case_id
    JOIN manual_trade_review_versions versions ON versions.case_id = sources.source_case_id
      AND versions.id = sources.source_version_id
    WHERE sources.aggregate_case_id = ?
    ORDER BY sources.id FOR UPDATE`, [aggregateRow.id])
  if (rows.length < MANUAL_TRADE_REVIEW_AGGREGATE_MIN_SOURCES
    || rows.length > MANUAL_TRADE_REVIEW_AGGREGATE_MAX_SOURCES) throw aggregateError('source_count_invalid')
  const normalized = rows.map(row => {
    if (Number(row.source_user_id) !== Number(aggregateRow.user_id)) throw aggregateError('source_owner_mismatch')
    if (Number(row.source_trading_account_id) !== Number(aggregateRow.trading_account_id)) throw aggregateError('source_account_mismatch')
    if (Number(row.source_strategy_id) !== Number(aggregateRow.strategy_id)) throw aggregateError('source_strategy_mismatch')
    if (!CASE_STATUS_COMPLETED.has(String(row.source_case_status))) throw aggregateError('source_not_completed')
    const storedHash = normalizedHash(row.source_content_hash, 'stored_content_hash')
    const versionHash = normalizedHash(row.version_content_hash, 'version_content_hash')
    if (storedHash !== versionHash || sha256(row.content_json) !== storedHash) throw aggregateError('source_changed')
    return {
      ...frozenSourceRecord(row),
      content_json:row.content_json,
      confirmed:String(row.confirmation_status) === 'confirmed',
      strategy_snapshot_json:row.strategy_snapshot_json,
      strategy_snapshot_hash:row.strategy_snapshot_hash,
    }
  }).sort(sourceSort)
  const selection = normalized.map(row => ({ case_id:row.case_id, version_id:row.version_id, content_hash:row.content_hash }))
  const selectionHash = manualTradeReviewAggregateSelectionHash(selection)
  if (String(aggregateRow.selection_hash || '').toLowerCase() !== selectionHash) throw aggregateError('source_set_changed')
  const frozenJson = JSON.stringify(normalized.map(frozenSourceRecord))
  const frozenHash = manualTradeReviewAggregateFrozenSourceSetHash(normalized)
  const snapshots = freezeAggregateSnapshots(normalized)
  if (aggregateRow.frozen_source_set_hash && String(aggregateRow.frozen_source_set_hash).toLowerCase() !== frozenHash) {
    throw aggregateError('frozen_source_set_changed')
  }
  if (aggregateRow.frozen_source_set_json && sha256(String(aggregateRow.frozen_source_set_json)) !== frozenHash) {
    throw aggregateError('frozen_source_set_changed')
  }
  if (aggregateRow.strategy_snapshot_hash && String(aggregateRow.strategy_snapshot_hash).toLowerCase() !== snapshots.hash) {
    throw aggregateError('strategy_snapshot_changed')
  }
  if (aggregateRow.strategy_snapshot_json && sha256(String(aggregateRow.strategy_snapshot_json)) !== snapshots.hash) {
    throw aggregateError('strategy_snapshot_changed')
  }
  return {
    rows:normalized,
    frozen_source_set_json:frozenJson,
    frozen_source_set_hash:frozenHash,
    strategy_snapshot_json:snapshots.json,
    strategy_snapshot_hash:snapshots.hash,
    strategy_snapshots:snapshots.snapshots,
    strategy_snapshot:snapshots.primary,
    strategy_snapshot_for_contract:snapshots.combined,
    strategy_versions:[...new Set(normalized.map(row => Number(row.strategy_version)))].sort((a, b) => a - b),
  }
}

function normalizeSourceRowsForContract(rows) {
  return rows.map(row => ({
    case_id:Number(row.case_id ?? row.source_case_id),
    version_id:Number(row.version_id ?? row.source_version_id),
    content_hash:String(row.content_hash ?? row.source_content_hash).toLowerCase(),
    confirmed:Boolean(row.confirmed ?? row.confirmation_status === 'confirmed'),
    ref:row.ref || `case:${row.case_id ?? row.source_case_id}:version:${row.version_id ?? row.source_version_id}:hash:${String(row.content_hash ?? row.source_content_hash).toLowerCase()}`,
  }))
}

function contentOf(row) {
  return parseJson(row.content_json ?? row.contentJson ?? row.content, {}) || {}
}

function increment(map, key) {
  if (key == null || key === '') return
  map[key] = Number(map[key] || 0) + 1
}

/** Build repeatable aggregate metrics before any model call. */
export function buildManualTradeReviewAggregateStatistics(sourceRows = [], { strategyVersions = [] } = {}) {
  const rows = Array.isArray(sourceRows) ? sourceRows : []
  const directionMatches = {}
  const candidateOffsets = {}
  const candidateOffsetStats = {}
  const protectionQualities = {}
  const technicalOrigins = {}
  const actualDirections = {}
  const ruleStatuses = {}
  const strategyPaths = {}
  const coverageMissing = { direction_match:0, protection_quality:0, technical_analysis_chain:0 }
  let evidenceComplete = 0
  for (const row of rows) {
    const content = contentOf(row)
    const summary = content.counterfactual_summary || content.server_derived_comparison || {}
    const directionMatch = summary.server_derived_direction_match || summary.direction_match
    if (DIRECTION_MATCH_KEYS.has(directionMatch)) increment(directionMatches, directionMatch)
    else coverageMissing.direction_match += 1
    const protectionQuality = summary.protection_quality || content.protection_assessment?.protection_quality
    if (PROTECTION_QUALITY_KEYS.has(protectionQuality)) increment(protectionQualities, protectionQuality)
    else coverageMissing.protection_quality += 1
    const actualDirection = content.actual_direction || content.trade_direction || row.actual_direction || row.direction
    if (actualDirection) increment(actualDirections, String(actualDirection).toLowerCase())
    const points = Array.isArray(content.counterfactual_points) ? content.counterfactual_points : []
    const first = summary.first_same_direction_candidate
    const timing = summary.timing_difference_bars
    if (first != null) increment(candidateOffsets, String(first))
    else if (timing != null) increment(candidateOffsets, `offset:${timing}`)
    const chain = Array.isArray(content.technical_analysis_chain) ? content.technical_analysis_chain : []
    if (chain.length === 0) coverageMissing.technical_analysis_chain += 1
    for (const item of chain) {
      if (TECHNICAL_ORIGINS.has(item?.origin)) increment(technicalOrigins, item.origin)
      for (const path of Array.isArray(item?.strategy_rule_paths) ? item.strategy_rule_paths : []) increment(strategyPaths, path)
    }
    for (const item of Array.isArray(content.rule_comparisons) ? content.rule_comparisons : []) increment(ruleStatuses, item?.status)
    const v3CoreComplete = content.counterfactual_summary && typeof content.counterfactual_summary === 'object'
      && !Array.isArray(content.counterfactual_summary)
      && Object.keys(content.counterfactual_summary).length > 0 && chain.length > 0
    const v2EvidenceComplete = String(content.evidence_quality || '').toLowerCase() === 'complete'
    if (v3CoreComplete || v2EvidenceComplete) evidenceComplete += 1
    for (const point of points) {
      if (point?.candidate_key != null && point?.offset_bars != null) {
        const key = `${point.candidate_key}:${point.offset_bars}`
        increment(candidateOffsets, key)
        const item = candidateOffsetStats[key] || {
          candidate_key:point.candidate_key, offset_bars:Number(point.offset_bars), total:0,
          same_direction_entry:0, same_direction_observe:0, opposite_direction:0,
          hold:0, insufficient_evidence:0,
        }
        item.total += 1
        const pointMatch = point.direction_match || point.server_derived_direction_match
        if (DIRECTION_MATCH_KEYS.has(pointMatch)) item[pointMatch] += 1
        candidateOffsetStats[key] = item
      }
    }
  }
  const normalizedSources = normalizeSourceRowsForContract(rows)
  const sourceSummary = buildManualTradeReviewAggregateSourceSummary(normalizedSources, {
    evidenceComplete, strategyVersions,
  })
  return {
    source_summary:sourceSummary,
    actual_direction_counts:actualDirections,
    direction_match_counts:directionMatches,
    candidate_offset_counts:candidateOffsets,
    candidate_offset_stats:candidateOffsetStats,
    protection_quality_counts:protectionQualities,
    technical_origin_counts:technicalOrigins,
    rule_status_counts:ruleStatuses,
    strategy_rule_path_counts:strategyPaths,
    coverage_missing:coverageMissing,
  }
}

export function buildManualTradeReviewAggregateModelInput({ aggregateCase, sources = [], statistics = null,
  strategySnapshots = null, strategySnapshotHash = null } = {}) {
  const rows = Array.isArray(sources) ? sources : []
  const derivedStatistics = statistics || buildManualTradeReviewAggregateStatistics(rows, {
    strategyVersions:[...new Set(rows.map(row => Number(row.strategy_version ?? row.source_strategy_version)).filter(Number.isFinite))],
  })
  return {
    output_contract_version:MANUAL_TRADE_REVIEW_AGGREGATE_V1_VERSION,
    aggregate_case_id:aggregateCase?.id == null ? null : Number(aggregateCase.id),
    selection_hash:aggregateCase?.selection_hash || null,
    source_set_hash:aggregateCase?.frozen_source_set_hash || aggregateCase?.source_set_hash || null,
    strategy_snapshot_hash:strategySnapshotHash || aggregateCase?.strategy_snapshot_hash || null,
    frozen_strategy_snapshots:Array.isArray(strategySnapshots)
      ? strategySnapshots.map(item => ({
        strategy_version:Number(item.strategy_version),
        strategy_snapshot_hash:item.strategy_snapshot_hash,
        strategy_snapshot:item.strategy_snapshot || parseJson(item.strategy_snapshot_json, {}),
      })) : [],
    source_summary:derivedStatistics.source_summary,
    deterministic_statistics:derivedStatistics,
    sources:rows.map(row => ({
      ref:row.ref || sourceReference({ case_id:Number(row.case_id ?? row.source_case_id), version_id:Number(row.version_id ?? row.source_version_id), content_hash:String(row.content_hash ?? row.source_content_hash).toLowerCase() }),
      confirmed:Boolean(row.confirmed ?? row.confirmation_status === 'confirmed'),
      content:contentOf(row),
    })),
  }
}

export function normalizeManualTradeReviewAggregateModelOutput(output, { sources = [], strategySnapshot, evidenceComplete, strategyVersions } = {}) {
  const sourceRows = normalizeSourceRowsForContract(sources)
  return normalizeManualTradeReviewAggregateOutput(output, {
    sources:sourceRows,
    strategySnapshot,
    evidenceComplete,
    strategyVersions,
  })
}

export function manualTradeReviewAggregateOutputContract() {
  return {
    output_contract_version:MANUAL_TRADE_REVIEW_AGGREGATE_V1_VERSION,
    recurring_patterns:[{ pattern:'string', supporting_review_refs:['frozen source ref'],
      counterexample_review_refs:['frozen source ref'], confidence:'number 0..1' }],
    strategy_gaps:['string'], protection_findings:['string'], version_comparisons:['string'],
    strategy_optimization_hypotheses:[{ recommendation_state:'observe|ready_for_human_review|insufficient_evidence',
      target_path:'frozen strategy path or null', current_rule_summary:'string', observed_gap:'string',
      proposed_change:'string', supporting_review_refs:['frozen source ref'], counterexample_review_refs:['frozen source ref'],
      applicable_when:{}, risk_if_applied:'string', validation_needed:'string', confidence:'number 0..1' }],
    limitations:['string'],
  }
}

export function buildManualTradeReviewAggregatePrompt({ aggregateCase, modelInput, strategySnapshots = [] } = {}) {
  const contract = manualTradeReviewAggregateOutputContract()
  return [
    {
      role:'system',
      content:'你是交易复盘综合分析模型。只能基于冻结的已完成手动复盘版本、确定性统计和冻结策略快照归纳共同模式。不得修改策略、记忆、回测、订单或任何服务器确定性结果；不确定时必须输出 insufficient_evidence。只返回一个 JSON 对象。',
    },
    {
      role:'user',
      content:JSON.stringify({
        task:'综合分析多条已完成手动复盘，识别重复模式、保护逻辑缺口、不同策略版本差异，并给出待人工验证的策略优化假设。',
        aggregate_case:{ id:Number(aggregateCase?.id || aggregateCase?.aggregate_case_id || 0),
          generation_no:Number(aggregateCase?.generation_no || 1),
          source_set_hash:aggregateCase?.frozen_source_set_hash || aggregateCase?.source_set_hash || null },
        frozen_strategy_snapshots:strategySnapshots,
        deterministic_input:modelInput,
        output_contract:contract,
        constraints:[
          '所有 supporting_review_refs 和 counterexample_review_refs 必须是 deterministic_input.sources.ref 中的冻结引用。',
          'recommendation_state 只能由服务器在证据门槛后保留 ready_for_human_review；模型不得声称已批准或已改写策略。',
          '不得补造缺失行情、指标、方向、止损止盈或成交事实。',
        ],
      }),
    },
  ]
}

export async function createManualTradeReviewAggregate({ actor, userId, tradingAccountId, strategyId,
  clientRequestId:requestId, sources, sourceRefs, maxAttempts = MANUAL_TRADE_REVIEW_AGGREGATE_DEFAULT_MAX_ATTEMPTS,
  db, now = beijingNow() } = {}) {
  const ownerId = assertOwner(actor, userId)
  const accountId = positiveId(tradingAccountId, 'trading_account_id')
  const strategy = positiveId(strategyId, 'strategy_id')
  const clientId = clientRequestId(requestId)
  const selections = normalizeManualTradeReviewAggregateSources(sources ?? sourceRefs)
  const selectionHash = sha256(JSON.stringify(selections.map(({ case_id, version_id, content_hash }) => ({ case_id, version_id, content_hash }))))
  const database = dbApi(db)
  const attempts = Math.max(1, Math.min(10, Number(maxAttempts) || MANUAL_TRADE_REVIEW_AGGREGATE_DEFAULT_MAX_ATTEMPTS))
  try {
    return await database.withTransaction(async run => {
      const existing = await txOne(run, `SELECT * FROM manual_trade_review_aggregate_cases
        WHERE user_id = ? AND client_request_id = ? FOR UPDATE`, [ownerId, clientId])
      if (existing) {
        if (String(existing.selection_hash) !== selectionHash
          || Number(existing.trading_account_id) !== accountId || Number(existing.strategy_id) !== strategy) {
          throw aggregateError('idempotency_conflict')
        }
        return { idempotent:true, created:false, aggregate_case:publicCase(existing) }
      }
      const pinned = await loadPinnedSources(run, selections, {
        userId:ownerId, tradingAccountId:accountId, strategyId:strategy,
      })
      const result = await txRun(run, `INSERT INTO manual_trade_review_aggregate_cases
        (client_request_id, user_id, trading_account_id, strategy_id, strategy_versions_json, selection_hash,
         status, generation_no, attempt_count, max_attempts, progress_stage, stage_updated_at, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, 'queued', 1, 0, ?, 'queued', ?, ?, ?)`, [
        clientId, ownerId, accountId, strategy, JSON.stringify(pinned.strategyVersions), selectionHash,
        attempts, now, now, now,
      ])
      const aggregateCaseId = Number(result.insertId)
      if (!Number.isSafeInteger(aggregateCaseId) || aggregateCaseId <= 0) throw aggregateError('create_failed')
      for (const row of pinned.rows) {
        await txRun(run, `INSERT INTO manual_trade_review_aggregate_sources
          (aggregate_case_id, source_case_id, source_version_id, source_content_hash, source_user_id,
           source_trading_account_id, source_strategy_id, source_strategy_version, confirmation_status, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, [
          aggregateCaseId, row.case_id, row.version_id, row.content_hash, row.user_id, row.trading_account_id,
          row.strategy_id, row.strategy_version, row.confirmation_status, now,
        ])
      }
      return {
        idempotent:false, created:true,
        aggregate_case:{ id:aggregateCaseId, user_id:ownerId, trading_account_id:accountId, strategy_id:strategy,
          strategy_versions:pinned.strategyVersions, selection_hash:selectionHash, status:'queued', generation_no:1,
          attempt_count:0, max_attempts:attempts, progress_stage:'queued', current_version_id:null },
        sources:pinned.rows.map(row => ({ ...row, content_json:undefined })),
      }
    })
  } catch (error) {
    if (!['er_dup_entry', 'duplicate'].includes(String(error?.code || '').toLowerCase())) throw error
    const existing = await database.queryOne(`SELECT * FROM manual_trade_review_aggregate_cases
      WHERE user_id = ? AND client_request_id = ?`, [ownerId, clientId])
    if (!existing) throw error
    if (String(existing.selection_hash) !== selectionHash
      || Number(existing.trading_account_id) !== accountId || Number(existing.strategy_id) !== strategy) {
      throw aggregateError('idempotency_conflict')
    }
    return { idempotent:true, created:false, aggregate_case:publicCase(existing) }
  }
}

export async function listEligibleManualTradeReviewSources({ actor, userId, tradingAccountId, strategyId,
  limit = 100, offset = 0, db } = {}) {
  const ownerId = assertOwner(actor, userId)
  const accountId = positiveId(tradingAccountId, 'trading_account_id')
  const strategy = positiveId(strategyId, 'strategy_id')
  const size = Math.min(200, Math.max(1, Number(limit) || 100))
  const skip = Math.max(0, Number(offset) || 0)
  const database = dbApi(db)
  const rows = await database.queryAll(`SELECT cases.id AS case_id, cases.user_id, cases.trading_account_id,
      cases.strategy_id, cases.strategy_version, cases.status, cases.current_version_id,
      cases.approved_version_id, versions.id AS version_id, versions.version_no, versions.content_hash,
      versions.created_at AS version_created_at
    FROM manual_trade_review_cases cases
    JOIN manual_trade_review_versions versions ON versions.id = cases.current_version_id
    WHERE cases.user_id = ? AND cases.trading_account_id = ? AND cases.strategy_id = ?
      AND cases.status IN ('draft', 'edited', 'needs_revision', 'approved')
      AND cases.current_version_id IS NOT NULL
    ORDER BY versions.created_at DESC, versions.id DESC LIMIT ? OFFSET ?`, [ownerId, accountId, strategy, size, skip])
  return rows.map(row => ({
    case_id:Number(row.case_id), version_id:Number(row.version_id), content_hash:normalizedHash(row.content_hash),
    status:row.status, confirmed:row.status === 'approved' && Number(row.approved_version_id) === Number(row.version_id),
    user_id:Number(row.user_id), trading_account_id:Number(row.trading_account_id), strategy_id:Number(row.strategy_id),
    strategy_version:Number(row.strategy_version), version_no:Number(row.version_no), created_at:row.version_created_at,
  }))
}

export async function listManualTradeReviewAggregates({ actor, userId, tradingAccountId, limit = 50, offset = 0, db } = {}) {
  const ownerId = assertOwner(actor, userId)
  const accountId = tradingAccountId == null ? null : positiveId(tradingAccountId, 'trading_account_id')
  const size = Math.min(200, Math.max(1, Number(limit) || 50))
  const skip = Math.max(0, Number(offset) || 0)
  const database = dbApi(db)
  const where = accountId == null ? 'user_id = ?' : 'user_id = ? AND trading_account_id = ?'
  const params = accountId == null ? [ownerId, size, skip] : [ownerId, accountId, size, skip]
  const rows = await database.queryAll(`SELECT * FROM manual_trade_review_aggregate_cases
    WHERE ${where} ORDER BY updated_at DESC, id DESC LIMIT ? OFFSET ?`, params)
  return rows.map(publicCase)
}

async function findOwnedAggregate(runOrQuery, aggregateId, { userId, tradingAccountId } = {}) {
  const id = positiveId(aggregateId, 'aggregate_case_id')
  const ownerId = positiveId(userId, 'user_id')
  const accountId = tradingAccountId == null ? null : positiveId(tradingAccountId, 'trading_account_id')
  const accountClause = accountId == null ? '' : ' AND trading_account_id = ?'
  const params = accountId == null ? [id, ownerId] : [id, ownerId, accountId]
  const sql = `SELECT * FROM manual_trade_review_aggregate_cases WHERE id = ? AND user_id = ?${accountClause}`
  const row = typeof runOrQuery === 'function' ? await txOne(runOrQuery, sql, params) : await runOrQuery.queryOne(sql, params)
  if (!row) throw aggregateError('not_found')
  return row
}

export async function getManualTradeReviewAggregate({ actor, userId, aggregateId, tradingAccountId, db } = {}) {
  const ownerId = assertOwner(actor, userId)
  const database = dbApi(db)
  const row = await findOwnedAggregate(database, aggregateId, { userId:ownerId, tradingAccountId })
  const sources = await database.queryAll(`SELECT * FROM manual_trade_review_aggregate_sources
    WHERE aggregate_case_id = ? ORDER BY id`, [row.id])
  const versions = await database.queryAll(`SELECT * FROM manual_trade_review_aggregate_versions
    WHERE aggregate_case_id = ? ORDER BY version_no DESC`, [row.id])
  return { aggregate_case:publicCase(row), sources:sources.map(publicSource), versions:versions.map(publicVersion) }
}

export async function getManualTradeReviewAggregateJobStatus({ actor, userId, aggregateId, tradingAccountId, db } = {}) {
  const ownerId = assertOwner(actor, userId)
  const database = dbApi(db)
  const row = await findOwnedAggregate(database, aggregateId, { userId:ownerId, tradingAccountId })
  return {
    aggregate_case_id:Number(row.id), status:row.status, generation_no:Number(row.generation_no || 1),
    attempt_count:Number(row.attempt_count || 0), max_attempts:Number(row.max_attempts || 3),
    progress_stage:row.progress_stage, stage_updated_at:row.stage_updated_at, task_deadline_at:row.task_deadline_at || null,
    model_task_id:row.model_task_id || null,
    last_error_code:row.last_error_code || null, next_attempt_at:row.next_attempt_at || null,
    completed_at:row.completed_at || null, current_version_id:row.current_version_id == null ? null : Number(row.current_version_id),
  }
}

export async function retryManualTradeReviewAggregate({ actor, userId, aggregateId, tradingAccountId, db, now = beijingNow() } = {}) {
  const ownerId = assertOwner(actor, userId)
  const accountId = tradingAccountId == null ? null : positiveId(tradingAccountId, 'trading_account_id')
  const database = dbApi(db)
  return database.withTransaction(async run => {
    const row = await findOwnedAggregate(run, aggregateId, { userId:ownerId, tradingAccountId:accountId })
    if (!MANUAL_TRADE_REVIEW_AGGREGATE_RETRY_STATUSES.has(String(row.status))) {
      throw aggregateError('retry_not_allowed')
    }
    const generationNo = Number(row.generation_no || 1) + 1
    const updated = await txRun(run, `UPDATE manual_trade_review_aggregate_cases
      SET status = 'queued', generation_no = ?, attempt_count = 0, lease_token = NULL,
        lease_expires_at = NULL, task_deadline_at = NULL, model_task_id = NULL,
        input_hash = NULL, prompt_hash = NULL, output_contract_hash = NULL,
        progress_stage = 'queued', stage_updated_at = ?,
        next_attempt_at = NULL, completed_at = NULL, last_failure_generation_no = ?, last_failure_at = ?, updated_at = ?
      WHERE id = ? AND user_id = ? AND status IN ('failed', 'deferred', 'status_unknown') AND generation_no = ?`, [
      generationNo, now, Number(row.generation_no || 1), now, now, row.id, ownerId, Number(row.generation_no || 1),
    ])
    if (Number(updated.affectedRows ?? updated.changes ?? 0) !== 1) throw aggregateError('retry_conflict')
    return { aggregate_case_id:Number(row.id), status:'queued', generation_no:generationNo, previous_error_code:row.last_error_code || null }
  })
}

export async function claimManualTradeReviewAggregate({ now = beijingNow(), leaseMs = MANUAL_TRADE_REVIEW_AGGREGATE_LEASE_MS, db } = {}) {
  const database = dbApi(db)
  return database.withTransaction(async run => {
    const row = await txOne(run, `SELECT * FROM manual_trade_review_aggregate_cases
      WHERE status = 'queued' AND (next_attempt_at IS NULL OR next_attempt_at <= ?)
      ORDER BY id LIMIT 1 FOR UPDATE`, [now])
    if (!row) return null
    const frozen = await loadAndFreezeAggregateEnvelope(run, row)
    const token = crypto.randomUUID()
    const taskDeadline = row.task_deadline_at || dateAfter(MANUAL_TRADE_REVIEW_AGGREGATE_DEADLINE_MS)
    const updated = await txRun(run, `UPDATE manual_trade_review_aggregate_cases
      SET status = 'generating', attempt_count = attempt_count + 1, lease_token = ?,
        lease_expires_at = ?, task_deadline_at = ?, frozen_source_set_json = ?, frozen_source_set_hash = ?,
        strategy_snapshot_json = ?, strategy_snapshot_hash = ?, progress_stage = 'model_aggregation',
        stage_updated_at = ?, last_error_code = NULL, updated_at = ?
      WHERE id = ? AND status = 'queued' AND selection_hash = ?`, [token, dateAfter(leaseMs), taskDeadline,
      frozen.frozen_source_set_json, frozen.frozen_source_set_hash, frozen.strategy_snapshot_json,
      frozen.strategy_snapshot_hash, now, now, row.id, row.selection_hash])
    if (Number(updated.affectedRows ?? updated.changes ?? 0) !== 1) return null
    return {
      ...publicCase({ ...row, ...frozen, task_deadline_at:taskDeadline }),
      id:Number(row.id), status:'generating', attempt_count:Number(row.attempt_count || 0) + 1,
      lease_token:token, task_deadline_at:taskDeadline, ...frozen,
    }
  })
}

/** Atomically associate one generic model task with this claimed generation. */
export async function linkManualTradeReviewAggregateModelTask({ aggregateId, generationNo, leaseToken,
  modelTaskId, sourceSetHash, inputHash, promptHash, outputContractHash, db, now = beijingNow() } = {}) {
  const id = positiveId(aggregateId, 'aggregate_case_id')
  const generation = positiveId(generationNo, 'generation_no')
  const token = nonEmptyLeaseToken(leaseToken)
  const taskId = nonEmptyTaskId(modelTaskId)
  const sourceHash = normalizedHash(sourceSetHash, 'source_set_hash')
  const input = normalizedHash(inputHash, 'input_hash')
  const prompt = normalizedHash(promptHash, 'prompt_hash')
  const contract = normalizedHash(outputContractHash, 'output_contract_hash')
  const database = dbApi(db)
  return database.withTransaction(async run => {
    const row = await txOne(run, `SELECT id, status, generation_no, lease_token,
        model_task_id, frozen_source_set_hash
      FROM manual_trade_review_aggregate_cases WHERE id = ? FOR UPDATE`, [id])
    if (!row || String(row.status) !== 'generating' || Number(row.generation_no) !== generation
      || String(row.lease_token || '') !== token || String(row.frozen_source_set_hash || '').toLowerCase() !== sourceHash) {
      throw aggregateError('lease_lost')
    }
    if (row.model_task_id && String(row.model_task_id) !== taskId) throw aggregateError('model_task_conflict')
    const result = await txRun(run, `UPDATE manual_trade_review_aggregate_cases SET
        model_task_id = ?, input_hash = ?, prompt_hash = ?, output_contract_hash = ?,
        stage_updated_at = ?, updated_at = ?
      WHERE id = ? AND status = 'generating' AND generation_no = ? AND lease_token = ?
        AND frozen_source_set_hash = ? AND (model_task_id IS NULL OR model_task_id = ?)`,
    [taskId, input, prompt, contract, now, now, id, generation, token, sourceHash, taskId])
    if (affectedRows(result) !== 1) throw aggregateError('lease_lost')
    return { aggregate_case_id:id, generation_no:generation, model_task_id:taskId,
      source_set_hash:sourceHash, input_hash:input, prompt_hash:prompt, output_contract_hash:contract }
  })
}

export async function recoverAbandonedManualTradeReviewAggregates({ now = beijingNow(), limit = 100, db } = {}) {
  const database = dbApi(db)
  const rows = await database.queryAll(`SELECT id FROM manual_trade_review_aggregate_cases
    WHERE status = 'generating' AND lease_expires_at IS NOT NULL AND lease_expires_at < ?
    ORDER BY id LIMIT ?`, [now, Math.min(500, Math.max(1, Number(limit) || 100))])
  let requeued = 0; let failed = 0; let statusUnknown = 0
  for (const item of rows) {
    await database.withTransaction(async run => {
      const row = await txOne(run, 'SELECT * FROM manual_trade_review_aggregate_cases WHERE id = ? FOR UPDATE', [item.id])
      if (!row || row.status !== 'generating' || !row.lease_expires_at || String(row.lease_expires_at) >= String(now)) return
      const task = row.model_task_id
        ? await txOne(run, 'SELECT status, lease_expires_at_utc_msc FROM ai_model_tasks WHERE task_id = ? LIMIT 1', [row.model_task_id])
        : null
      const taskState = taskStatusRequiresWait(task)
      if (taskState === 'active' || taskState === 'status_unknown' || taskState === 'terminal_succeeded') {
        const updated = await txRun(run, `UPDATE manual_trade_review_aggregate_cases SET status = 'status_unknown',
            lease_token = NULL, lease_expires_at = NULL, progress_stage = 'status_unknown',
            last_error_code = ?, updated_at = ? WHERE id = ? AND generation_no = ? AND status = 'generating'`, [
          taskState === 'terminal_succeeded' ? 'model_task_succeeded_requires_reconcile' : 'model_task_status_unknown',
          now, row.id, Number(row.generation_no || 1),
        ])
        if (affectedRows(updated) === 1) statusUnknown += 1
        return
      }
      if (taskState === 'terminal') {
        const updated = await txRun(run, `UPDATE manual_trade_review_aggregate_cases SET status = 'failed',
            lease_token = NULL, lease_expires_at = NULL, progress_stage = 'failed',
            last_error_code = 'model_task_terminal_requires_retry', last_failure_generation_no = ?,
            last_failure_at = ?, updated_at = ? WHERE id = ? AND generation_no = ? AND status = 'generating'`, [
          Number(row.generation_no || 1), now, now, row.id, Number(row.generation_no || 1),
        ])
        if (affectedRows(updated) === 1) failed += 1
        return
      }
      const exhausted = Number(row.attempt_count || 0) >= Number(row.max_attempts || 3)
      const status = exhausted ? 'failed' : 'queued'
      const updated = await txRun(run, `UPDATE manual_trade_review_aggregate_cases SET status = ?, lease_token = NULL,
        lease_expires_at = NULL, progress_stage = ?, next_attempt_at = ?,
        last_error_code = ?, last_failure_generation_no = ?, last_failure_at = ?, updated_at = ? WHERE id = ?`, [
        status, exhausted ? 'failed' : 'retry_wait', exhausted ? null : dateAfter(30_000),
        exhausted ? 'manual_trade_review_aggregate_generation_exhausted' : 'manual_trade_review_aggregate_lease_expired',
        Number(row.generation_no || 1), now, now, row.id,
      ])
      if (affectedRows(updated) !== 1) return
      if (exhausted) failed += 1
      else requeued += 1
    })
  }
  return { scanned:rows.length, requeued, failed, status_unknown:statusUnknown }
}

export async function markManualTradeReviewAggregateFailure({ aggregateId, generationNo, leaseToken,
  errorCode = 'manual_trade_review_aggregate_generation_failed', terminal = false, db, now = beijingNow() } = {}) {
  const id = positiveId(aggregateId, 'aggregate_case_id')
  const generation = positiveId(generationNo, 'generation_no')
  const token = nonEmptyLeaseToken(leaseToken)
  const database = dbApi(db)
  return database.withTransaction(async run => {
    const row = await txOne(run, 'SELECT * FROM manual_trade_review_aggregate_cases WHERE id = ? FOR UPDATE', [id])
    if (!row || Number(row.generation_no) !== generation || String(row.lease_token || '') !== token) {
      throw aggregateError('lease_lost')
    }
    const exhausted = terminal || Number(row.attempt_count || 0) >= Number(row.max_attempts || 3)
    const status = exhausted ? 'failed' : 'queued'
    const updated = await txRun(run, `UPDATE manual_trade_review_aggregate_cases SET status = ?, lease_token = NULL,
      lease_expires_at = NULL, progress_stage = ?, next_attempt_at = ?, last_error_code = ?,
      last_failure_generation_no = ?, last_failure_at = ?, updated_at = ? WHERE id = ? AND generation_no = ?
      AND lease_token = ? AND status = 'generating'`, [
      status, exhausted ? 'failed' : 'retry_wait', exhausted ? null : dateAfter(30_000), String(errorCode).slice(0, 128),
      generation, now, now, id, generation, token,
    ])
    if (affectedRows(updated) !== 1) throw aggregateError('lease_lost')
    return { aggregate_case_id:id, status, generation_no:generation, error_code:String(errorCode).slice(0, 128) }
  })
}

export async function saveManualTradeReviewAggregateOutput({ actor, userId, aggregateId, generationNo,
  leaseToken, modelTaskId, sourceSetHash, output, strategySnapshot, modelProfileId = null,
  authorType = 'model', db, now = beijingNow() } = {}) {
  const ownerId = assertOwner(actor, userId)
  const id = positiveId(aggregateId, 'aggregate_case_id')
  const generation = positiveId(generationNo, 'generation_no')
  const token = nonEmptyLeaseToken(leaseToken)
  const taskId = nonEmptyTaskId(modelTaskId)
  const expectedSourceHash = normalizedHash(sourceSetHash, 'source_set_hash')
  const database = dbApi(db)
  return database.withTransaction(async run => {
    const row = await findOwnedAggregate(run, id, { userId:ownerId })
    if (String(row.status) !== 'generating' || Number(row.generation_no) !== generation
      || String(row.lease_token || '') !== token || String(row.model_task_id || '') !== taskId
      || String(row.frozen_source_set_hash || '').toLowerCase() !== expectedSourceHash) throw aggregateError('lease_lost')
    const frozen = await loadAndFreezeAggregateEnvelope(run, row)
    if (frozen.frozen_source_set_hash !== expectedSourceHash) throw aggregateError('source_set_changed')
    const pinned = frozen.rows.map(source => ({
      case_id:source.case_id, version_id:source.version_id, content_hash:source.content_hash,
      confirmed:source.confirmed, content_json:source.content_json,
      ref:source.ref,
    }))
    const normalized = normalizeManualTradeReviewAggregateModelOutput(output, {
      sources:pinned, strategySnapshot:strategySnapshot || frozen.strategy_snapshot_for_contract,
      strategyVersions:parseJson(row.strategy_versions_json, []),
    })
    const contentJson = JSON.stringify(normalized)
    const contentHash = sha256(contentJson)
    const latest = await txOne(run, `SELECT MAX(version_no) AS version_no
      FROM manual_trade_review_aggregate_versions WHERE aggregate_case_id = ?`, [id])
    const versionNo = Number(latest?.version_no || 0) + 1
    const authorUserId = String(authorType) === 'model' ? null : ownerId
    const versionResult = await txRun(run, `INSERT INTO manual_trade_review_aggregate_versions
      (aggregate_case_id, generation_no, version_no, parent_version_id, author_type, author_user_id,
       model_profile_id, source_set_hash, content_json, content_hash, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, [
      id, generation, versionNo, row.current_version_id || null, String(authorType).slice(0, 16), authorUserId,
      modelProfileId, expectedSourceHash, contentJson, contentHash, now,
    ])
    const versionId = Number(versionResult.insertId)
    const applied = await txRun(run, `UPDATE manual_trade_review_aggregate_cases SET status = 'draft', current_version_id = ?,
      progress_stage = 'completed', stage_updated_at = ?, lease_token = NULL, lease_expires_at = NULL,
      model_task_id = NULL, last_error_code = NULL, completed_at = ?, updated_at = ?
      WHERE id = ? AND generation_no = ? AND status = 'generating' AND model_task_id = ?
        AND lease_token = ? AND frozen_source_set_hash = ?`,
    [versionId, now, now, now, id, generation, taskId, token, expectedSourceHash])
    if (affectedRows(applied) !== 1) throw aggregateError('lease_lost')
    return { aggregate_case_id:id, version_id:versionId, version_no:versionNo, content_hash:contentHash, content:normalized }
  })
}

function startManualTradeReviewAggregateLeaseHeartbeat(job, db) {
  const database = dbApi(db)
  const controller = new AbortController()
  let stopped = false
  let pending = null
  const renew = async () => {
    if (stopped || pending) return
    pending = database.queryRun(`UPDATE manual_trade_review_aggregate_cases SET lease_expires_at = ?, updated_at = ?
      WHERE id = ? AND generation_no = ? AND status = 'generating' AND lease_token = ?`,
    [dateAfter(MANUAL_TRADE_REVIEW_AGGREGATE_LEASE_MS), beijingNow(), job.id,
      Number(job.generation_no || 1), job.lease_token]).then(result => {
      if (affectedRows(result) !== 1 && !controller.signal.aborted) {
        controller.abort(aggregateError('lease_lost'))
      }
    }).catch(error => {
      if (!controller.signal.aborted) controller.abort(error)
    }).finally(() => { pending = null })
    await pending
  }
  const timer = setInterval(renew, Math.max(5_000, Math.floor(MANUAL_TRADE_REVIEW_AGGREGATE_LEASE_MS / 4)))
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

async function updateAggregateStatusUnknown(job, errorCode, db, now = beijingNow()) {
  const database = dbApi(db)
  const result = await database.queryRun(`UPDATE manual_trade_review_aggregate_cases SET status = 'status_unknown',
      lease_token = NULL, lease_expires_at = NULL, progress_stage = 'status_unknown',
      last_error_code = ?, next_attempt_at = NULL, updated_at = ?
    WHERE id = ? AND generation_no = ? AND status = 'generating' AND lease_token = ?`,
  [String(errorCode || 'model_task_status_unknown').slice(0, 128), now, job.id,
    Number(job.generation_no || 1), job.lease_token])
  if (affectedRows(result) !== 1) throw aggregateError('lease_lost')
  return { aggregate_case_id:Number(job.id), status:'status_unknown', generation_no:Number(job.generation_no || 1),
    error_code:String(errorCode || 'model_task_status_unknown').slice(0, 128) }
}

function taskStatusRequiresWait(task) {
  const status = String(task?.status || '')
  if (['queued', 'retry_wait'].includes(status)
    && Number(task?.scheduled_at_utc_msc || 0) > Date.now()) return 'active'
  if (status === 'status_unknown') return 'status_unknown'
  if (MODEL_TASK_ACTIVE_STATES.has(status)) return 'active'
  if (status === 'succeeded') return 'terminal_succeeded'
  if (MODEL_TASK_TERMINAL_STATES.has(status)) return 'terminal'
  return null
}

const AGGREGATE_TERMINAL_ERROR_CODES = new Set([
  'manual_trade_review_aggregate_model_task_missing',
  'manual_trade_review_aggregate_source_changed',
  'manual_trade_review_aggregate_source_set_changed',
  'manual_trade_review_aggregate_frozen_source_set_changed',
  'manual_trade_review_aggregate_strategy_snapshot_changed',
  'manual_trade_review_aggregate_strategy_snapshot_missing',
  'manual_trade_review_aggregate_frozen_model_input_changed',
  'manual_trade_review_aggregate_generation_deadline_exceeded',
])

async function prepareAggregateBudget(resolved, messages) {
  let capabilities = {}
  try {
    capabilities = await getModelProviderCapabilities(resolved?.model_profile_id) || {}
  } catch (error) {
    console.warn('[ManualTradeReviewAggregate] provider capability lookup unavailable:', error.message)
  }
  const budget = selectModelTaskBudget({
    taskKind:'manual_analysis', providerOutputCap:capabilities.max_output_tokens,
    contextWindowTokens:capabilities.context_window_tokens,
    maxInputTokens:capabilities.max_input_tokens ?? capabilities.provider_max_input_tokens,
    contextLimitSemantics:capabilities.context_limit_semantics, capabilities,
    profile:resolved?.model, estimatedInputTokens:estimateModelInputTokens(messages), schemaNeedTokens:0,
  })
  if (budget.reason === 'model_token_limits_unconfirmed' || budget.reason === 'model_token_limits_stale') {
    const error = new Error(budget.reason); error.code = error.message; throw error
  }
  if (budget.reason === 'model_input_limit_exceeded' || budget.inputLimitExceeded) throw aggregateError('model_input_limit_exceeded')
  if (!budget.sufficient || budget.selectedMaxOutputTokens <= 0) throw aggregateError('output_budget_insufficient')
  return { budget, capabilities }
}

/** Run at most one provider-backed aggregate generation. */
export async function runManualTradeReviewAggregateOnce({ requestModel = requestJsonObject, db } = {}) {
  const database = dbApi(db)
  const job = await claimManualTradeReviewAggregate({ db })
  if (!job) return { status:'idle' }
  const lease = startManualTradeReviewAggregateLeaseHeartbeat(job, db)
  let tracker = null
  try {
    lease.assertOwned()
    const deadlineAtMs = parseBeijingDateTime(job.task_deadline_at)
    if (!deadlineAtMs) throw aggregateError('deadline_missing')
    if (deadlineAtMs <= Date.now()) throw aggregateError('generation_deadline_exceeded')

    // A linked active/unknown task is authoritative.  Never issue a second
    // provider request for the same generation while its outcome is unknown.
    let existingTask = null
    if (job.model_task_id) {
      existingTask = await database.queryOne('SELECT * FROM ai_model_tasks WHERE task_id = ? LIMIT 1', [job.model_task_id])
      if (!existingTask) throw aggregateError('model_task_missing')
      const waitState = taskStatusRequiresWait(existingTask)
      if (waitState === 'status_unknown' || waitState === 'active' || waitState === 'terminal_succeeded') {
        const code = waitState === 'terminal_succeeded'
          ? 'model_task_succeeded_requires_reconcile' : 'model_task_status_unknown'
        return await updateAggregateStatusUnknown(job, code, db)
      }
      if (waitState === 'terminal') {
        return await markManualTradeReviewAggregateFailure({ aggregateId:job.id,
          generationNo:job.generation_no, leaseToken:job.lease_token,
          errorCode:'model_task_terminal_requires_retry', terminal:true, db })
      }
    }

    const strategySnapshot = job.strategy_snapshot_for_contract || job.strategy_snapshot || parseJson(job.strategy_snapshot_json, null)
    const strategySnapshots = job.strategy_snapshots || (Array.isArray(strategySnapshot) ? strategySnapshot : [])
    const statistics = buildManualTradeReviewAggregateStatistics(job.rows || [], {
      strategyVersions:job.strategy_versions || parseJson(job.strategy_versions_json, []),
    })
    const modelInput = buildManualTradeReviewAggregateModelInput({ aggregateCase:job, sources:job.rows || [],
      statistics, strategySnapshots, strategySnapshotHash:job.strategy_snapshot_hash })
    const messages = buildManualTradeReviewAggregatePrompt({ aggregateCase:job, modelInput, strategySnapshots })
    const outputContractHash = sha256(JSON.stringify(manualTradeReviewAggregateOutputContract()))
    const inputHash = sha256(JSON.stringify(modelInput))
    const promptHash = sha256(JSON.stringify(messages))
    if ((job.input_hash && String(job.input_hash).toLowerCase() !== inputHash)
      || (job.prompt_hash && String(job.prompt_hash).toLowerCase() !== promptHash)
      || (job.output_contract_hash && String(job.output_contract_hash).toLowerCase() !== outputContractHash)) {
      throw aggregateError('frozen_model_input_changed')
    }
    const resolved = await resolveAiTaskModel({ userId:job.user_id, strategyId:job.strategy_id, usage:'review',
      modelPurpose:'manual_trade_review_aggregate' })
    if (!resolved?.model) throw aggregateError(resolved?.error || 'model_unavailable')
    const endpoint = modelEndpoint(resolved.model)
    const { budget, capabilities } = await prepareAggregateBudget(resolved, messages)
    const generationNo = Number(job.generation_no || 1)
    const idempotencyKey = manualTradeReviewAggregateModelIdempotencyKey({ aggregateId:job.id, generationNo })
    const modelName = resolved.model.model_name || resolved.model.model
    tracker = await createModelTaskTracker({
      taskKind:'manual_analysis', queueClass:'background', ownerUserId:job.user_id, strategyId:job.strategy_id,
      domainType:'manual_trade_review_aggregate', domainId:job.id, idempotencyKey,
      inputHash, snapshotHash:job.frozen_source_set_hash, promptHash, outputContractHash,
      provider:resolved.model.provider || resolved.model.api_provider, model:modelName,
      modelProfileId:resolved.model_profile_id, protocol:endpoint.protocol, credentialSource:resolved.credential_source,
      frozenContext:{ aggregate_case_id:Number(job.id), generation_no:generationNo,
        source_set_hash:job.frozen_source_set_hash, strategy_snapshot_hash:job.strategy_snapshot_hash },
      maxAttempts:Number(job.max_attempts) || MANUAL_TRADE_REVIEW_AGGREGATE_DEFAULT_MAX_ATTEMPTS,
      taskDeadlineAtUtcMs:deadlineAtMs,
    }, { workerId:`manual-trade-review-aggregate:${process.pid}`, linkTask:taskId =>
      linkManualTradeReviewAggregateModelTask({ aggregateId:job.id, generationNo, leaseToken:job.lease_token,
        modelTaskId:taskId, sourceSetHash:job.frozen_source_set_hash, inputHash, promptHash, outputContractHash, db }) })
    await tracker.persistBudget(budget)
    const requestSignal = () => {
      const signals = [lease.signal, tracker.signal].filter(Boolean)
      return signals.length > 1 && typeof AbortSignal.any === 'function' ? AbortSignal.any(signals) : signals[0] || null
    }
    const callbacks = {
      onProviderRequest:event => tracker.onProviderRequest(event),
      onProviderUsage:event => tracker.onProviderUsage(event),
      onProviderActivity:event => tracker.onProviderActivity(event),
      onProviderQuiet:event => tracker.onProviderQuiet(event),
    }
    const deadlines = modelTaskDeadlines('manual_analysis', { nowUtcMs:Date.now(), businessDeadlineUtcMs:deadlineAtMs })
    const validateOutput = value => normalizeManualTradeReviewAggregateModelOutput(value, {
      sources:job.rows || [], strategySnapshot,
      evidenceComplete:statistics.source_summary.evidence_complete,
      strategyVersions:job.strategy_versions || parseJson(job.strategy_versions_json, []),
    })
    lease.assertOwned(); tracker.assertOwned()
    const raw = await requestModel({ url:endpoint.url, apiKey:resolved.model.api_key_encrypted,
      provider:resolved.model.provider || resolved.model.api_provider, model:modelName,
      temperature:Math.min(Number(resolved.model.temperature ?? 0.2), 0.3), maxTokens:budget.selectedMaxOutputTokens,
      thinkingEnabled:resolved.model.thinking_enabled, reasoningEffort:resolved.model.reasoning_effort,
      protocol:endpoint.protocol, messages, modelTaskBudget:budget, capabilities,
      modelProfileId:resolved.model_profile_id,
      usageContext:{ userId:job.user_id, profileId:resolved.model_profile_id, credentialSource:resolved.credential_source,
        usage:'review', strategyId:job.strategy_id },
      timeout:Math.max(1, Math.min(deadlines.attemptSafetyDeadlineUtcMs, deadlines.taskDeadlineUtcMs) - Date.now()),
      deadlineAtMs:deadlines.attemptSafetyDeadlineUtcMs, followupValidUntilMs:deadlines.taskDeadlineUtcMs,
      signal:requestSignal(), ...callbacks, allowFollowupRequests:false, validateObject:validateOutput,
    })
    lease.assertOwned(); tracker.assertOwned()
    const normalized = validateOutput(raw)
    const resultHash = sha256(JSON.stringify(normalized))
    await tracker.resultReady({ resultHash })
    await tracker.applying()
    const saved = await saveManualTradeReviewAggregateOutput({ actor:{ id:job.user_id }, userId:job.user_id,
      aggregateId:job.id, generationNo, leaseToken:job.lease_token, modelTaskId:tracker.taskId,
      sourceSetHash:job.frozen_source_set_hash, output:normalized,
      strategySnapshot,
      modelProfileId:resolved.model_profile_id, db })
    await tracker.succeeded({ resultRef:`manual_trade_review_aggregate:${job.id}:${generationNo}`, resultHash:saved.content_hash })
    return { status:'succeeded', aggregate_case_id:Number(job.id), version_id:saved.version_id,
      model_task_id:tracker.taskId }
  } catch (error) {
    const code = String(error?.code || error?.message || 'manual_trade_review_aggregate_generation_failed')
    try {
      if (tracker) {
        const exhausted = Number(job.attempt_count || 0) >= Number(job.max_attempts || 3)
        try { await tracker.failed(error, exhausted) } catch (trackerFailure) {
          console.error('[ManualTradeReviewAggregate] model task failure transition failed:', trackerFailure.message)
        }
        if (tracker.status === 'status_unknown' || tracker.status === 'provider_quiet'
          || ['status_unknown', 'provider_quiet'].includes(code)
          || code.includes('status_unknown')) {
          await updateAggregateStatusUnknown(job, code, db)
        } else {
          await markManualTradeReviewAggregateFailure({ aggregateId:job.id, generationNo:job.generation_no,
            leaseToken:job.lease_token, errorCode:code, terminal:exhausted || tracker.status === 'failed_terminal', db })
        }
      } else {
        await markManualTradeReviewAggregateFailure({ aggregateId:job.id, generationNo:job.generation_no,
          leaseToken:job.lease_token, errorCode:code, terminal:AGGREGATE_TERMINAL_ERROR_CODES.has(code), db })
      }
    } catch (failureError) {
      console.error('[ManualTradeReviewAggregate] failure state update failed:', failureError.message)
    }
    return { status:'failed', aggregate_case_id:Number(job.id), error:code }
  } finally {
    try { await tracker?.stop() } catch (error) {
      console.error('[ManualTradeReviewAggregate] model task stop failed:', error.message)
    }
    await lease.stop()
  }
}

let manualTradeReviewAggregateTimer = null
let manualTradeReviewAggregateWake = false
let manualTradeReviewAggregateRunning = false

export function requestManualTradeReviewAggregateCycle() {
  if (manualTradeReviewAggregateWake) return false
  manualTradeReviewAggregateWake = true
  setImmediate(async () => {
    manualTradeReviewAggregateWake = false
    if (manualTradeReviewAggregateRunning) return
    manualTradeReviewAggregateRunning = true
    try {
      await recoverAbandonedManualTradeReviewAggregates()
      await runManualTradeReviewAggregateOnce()
    } catch (error) {
      console.error('[ManualTradeReviewAggregate] worker cycle failed:', error.message)
    } finally {
      manualTradeReviewAggregateRunning = false
    }
  })
  return true
}

export function startManualTradeReviewAggregateWorker(intervalMs = 15_000) {
  if (manualTradeReviewAggregateTimer) return false
  manualTradeReviewAggregateTimer = setInterval(() => requestManualTradeReviewAggregateCycle(), Math.max(1_000, Number(intervalMs) || 15_000))
  manualTradeReviewAggregateTimer.unref?.()
  requestManualTradeReviewAggregateCycle()
  return true
}

export function stopManualTradeReviewAggregateWorker() {
  if (!manualTradeReviewAggregateTimer) return false
  clearInterval(manualTradeReviewAggregateTimer)
  manualTradeReviewAggregateTimer = null
  return true
}

export const validateManualTradeReviewAggregateSources = normalizeManualTradeReviewAggregateSources
export const buildAggregateStatistics = buildManualTradeReviewAggregateStatistics
export const createManualTradeReviewAggregateCase = createManualTradeReviewAggregate
export const listEligibleManualTradeReviewAggregateSources = listEligibleManualTradeReviewSources
export const listManualTradeReviewAggregateCases = listManualTradeReviewAggregates
export const getManualTradeReviewAggregateCase = getManualTradeReviewAggregate
export const getManualTradeReviewAggregateStatus = getManualTradeReviewAggregateJobStatus
export const retryManualTradeReviewAggregateCase = retryManualTradeReviewAggregate
export const claimManualTradeReviewAggregateJob = claimManualTradeReviewAggregate
export const runManualTradeReviewAggregateWorkerOnce = runManualTradeReviewAggregateOnce
