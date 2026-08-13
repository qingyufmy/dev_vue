// Unified strategy memory library service.
//
// The migration for this module is intentionally kept separate from the
// service.  Every read and write re-checks auto_prompt_types so the redundant
// scope/owner columns in the memory tables never become an authority.

import crypto from 'node:crypto'
import { queryOne, queryAll, queryRun, withTransaction, beijingNow } from '../../db.js'
import { canManagePlatformAiContent } from './platform-content-access.js'
import { buildStrategyMemorySourceManifest, normalizeStrategyMemoryMarkdownBlock } from './strategy-memory-semantics.js'
import { renderStrategyMemoryMarkdownPreview } from './strategy-memory-markdown.js'
import { containsLegacyStrategyMemoryConditions, sanitizeLegacyStrategyMemoryContent } from './strategy-memory-legacy.js'

export { sanitizeLegacyStrategyMemoryContent }

export const STRATEGY_MEMORY_DEFAULT_CAPACITY_CHARS = 120000
export const STRATEGY_MEMORY_DEFAULT_COMPRESSION_TARGET_RATIO = 0.60
export const STRATEGY_MEMORY_DEFAULT_CONFLICT_ALERT_THRESHOLD = 3

export const STRATEGY_MEMORY_UPDATE_KINDS = Object.freeze(['daily_review', 'monthly_review'])
export const STRATEGY_MEMORY_CONFLICT_STATUSES = Object.freeze([
  'observing', 'attention_required', 'resolved', 'dismissed',
])
export const STRATEGY_MEMORY_COMPRESSION_STATUSES = Object.freeze([
  'queued', 'leased', 'succeeded', 'succeeded_noop', 'failed', 'stale',
])

const EMPTY_CONTENT_HASH = sha256('')
const MAX_CAPACITY_CHARS = 10_000_000
const MAX_SOURCE_REFS = 500
const DEFAULT_COMPRESSION_LEASE_MS = 15 * 60_000
// The server appends approved updates after a model has compressed the old
// library. Keep the separator explicit so capacity planning cannot silently
// overrun the durable character limit.
const DETERMINISTIC_UPDATE_SEPARATOR_CHARS = 2

function sha256(value) {
  return crypto.createHash('sha256').update(String(value ?? ''), 'utf8').digest('hex')
}

function stableJson(value) {
  if (value === null || value === undefined) return 'null'
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`
  if (typeof value === 'object') {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`
  }
  return JSON.stringify(value)
}

function normalizeConflictExcerpt(value) {
  return normalizeStrategyMemoryMarkdownBlock(sanitizeStrategyMemoryText(value))
}

function exactExcerptMatch(source, excerpt) {
  const normalizedSource = normalizeConflictExcerpt(source)
  const normalizedExcerpt = normalizeConflictExcerpt(excerpt)
  if (!normalizedExcerpt) return false
  const first = normalizedSource.indexOf(normalizedExcerpt)
  return first >= 0 && normalizedSource.indexOf(normalizedExcerpt, first + normalizedExcerpt.length) < 0
}

function normalizedConflictCategory(value) {
  const category = String(value || 'general').trim().toLowerCase()
  return ['general', 'market_regime', 'entry_setup', 'chan_structure', 'risk_execution'].includes(category)
    ? category : 'general'
}

function jsonText(value) {
  if (value === null || value === undefined) return null
  if (typeof value === 'string') return value
  return JSON.stringify(value)
}

function nowAfter(ms) {
  const date = new Date(Date.now() + Math.max(1, Number(ms) || 1))
  return new Date(date.getTime() + 8 * 3600_000).toISOString().replace('T', ' ').substring(0, 19)
}

function positiveId(value, code = 'strategy_memory_invalid_id') {
  const id = Number(value)
  if (!Number.isInteger(id) || id <= 0) throw new Error(code)
  return id
}

function optionalPositiveId(value) {
  if (value === null || value === undefined || value === '') return null
  return positiveId(value, 'strategy_memory_invalid_source_id')
}

function numeric(value, fallback = 0) {
  const number = Number(value)
  return Number.isFinite(number) ? number : fallback
}

function integer(value, fallback = 0) {
  const number = Number(value)
  return Number.isSafeInteger(number) ? number : fallback
}

/** Remove C0/C1 controls while preserving Markdown, tabs and line breaks. */
export function sanitizeStrategyMemoryText(value) {
  return String(value ?? '')
    .replace(/\r\n?/g, '\n')
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F\u0080-\u009F]/g, '')
}

export function strategyMemoryCharCount(value) {
  return Array.from(String(value ?? '')).length
}

export function strategyMemoryEstimatedTokenCount(value) {
  return Math.ceil(Buffer.byteLength(String(value ?? ''), 'utf8') / 4)
}

export function normalizeStrategyMemoryCapacity(value, fallback = STRATEGY_MEMORY_DEFAULT_CAPACITY_CHARS) {
  if (value === undefined || value === null || value === '') return fallback
  const capacity = Number(value)
  if (!Number.isSafeInteger(capacity) || capacity <= 0 || capacity > MAX_CAPACITY_CHARS) {
    throw new Error('strategy_memory_capacity_invalid')
  }
  return capacity
}

export function normalizeStrategyMemoryRatio(value, fallback = STRATEGY_MEMORY_DEFAULT_COMPRESSION_TARGET_RATIO) {
  if (value === undefined || value === null || value === '') return fallback
  const ratio = Number(value)
  if (!Number.isFinite(ratio) || ratio <= 0 || ratio > 1) throw new Error('strategy_memory_compression_ratio_invalid')
  return Number(ratio.toFixed(4))
}

export function normalizeStrategyMemoryConflictThreshold(value, fallback = STRATEGY_MEMORY_DEFAULT_CONFLICT_ALERT_THRESHOLD) {
  if (value === undefined || value === null || value === '') return fallback
  const threshold = Number(value)
  if (!Number.isSafeInteger(threshold) || threshold <= 0 || threshold > 1000) {
    throw new Error('strategy_memory_conflict_threshold_invalid')
  }
  return threshold
}

function normalizeActor(actor, role = null) {
  if (actor && typeof actor === 'object') {
    const serverOwned = Boolean(actor.serverOwned || actor.server_owned || actor.actorType === 'server')
    return {
      userId: actor.userId ?? actor.user_id ?? actor.id ?? null,
      role: actor.role ?? actor.user_role ?? actor.userRole ?? role ?? null,
      planSource: actor.planSource ?? actor.plan_source ?? actor.user_plan_source ?? null,
      serverOwned,
      actorId: actor.actorId ?? actor.actor_id ?? actor.userId ?? actor.user_id ?? actor.id ?? null,
    }
  }
  return { userId: actor ?? null, role, planSource: null, serverOwned: false, actorId: actor ?? null }
}

function actorUserId(actor) {
  const id = Number(actor?.userId)
  return Number.isInteger(id) && id > 0 ? id : null
}

function requestWithActor(input, actorArg = null, payloadArg = null) {
  if (input && typeof input === 'object' && !Array.isArray(input)) {
    return { ...input, actor: normalizeActor(input.actor ?? input.user ?? input.userId ?? input.user_id, input.role ?? input.userRole ?? input.user_role) }
  }
  const payload = payloadArg && typeof payloadArg === 'object' ? payloadArg : {}
  return { ...payload, strategyId: input, actor: normalizeActor(actorArg, payload.role ?? payload.userRole ?? payload.user_role) }
}

function strategyMemoryDefaults(strategy) {
  const strategyId = positiveId(strategy.id, 'strategy_memory_invalid_strategy_id')
  const scope = strategy.scope === 'platform' ? 'platform' : 'private'
  const ownerUserId = scope === 'platform' ? 0 : positiveId(strategy.owner_user_id, 'strategy_memory_strategy_owner_missing')
  return {
    strategy_id: strategyId,
    strategy_scope: scope,
    owner_user_id: ownerUserId,
    content_text: '',
    version_no: 0,
    content_hash: EMPTY_CONTENT_HASH,
    char_count: 0,
    estimated_token_count: 0,
    capacity_chars: STRATEGY_MEMORY_DEFAULT_CAPACITY_CHARS,
    compression_target_ratio: STRATEGY_MEMORY_DEFAULT_COMPRESSION_TARGET_RATIO,
    conflict_alert_threshold: STRATEGY_MEMORY_DEFAULT_CONFLICT_ALERT_THRESHOLD,
    pending_update_count: 0,
    compression_status: 'idle',
    last_compacted_at: null,
    updated_by_user_id: null,
  }
}

function normalizeLibrary(row, strategy = null) {
  const fallback = strategyMemoryDefaults(strategy || {
    id: row?.strategy_id,
    scope: row?.strategy_scope || 'private',
    owner_user_id: row?.owner_user_id || 0,
  })
  const content = sanitizeStrategyMemoryText(row?.content_text ?? fallback.content_text)
  return {
    ...fallback,
    ...row,
    strategy_id: positiveId(row?.strategy_id ?? fallback.strategy_id, 'strategy_memory_invalid_strategy_id'),
    strategy_scope: row?.strategy_scope || fallback.strategy_scope,
    owner_user_id: integer(row?.owner_user_id, fallback.owner_user_id),
    content_text: content,
    version_no: integer(row?.version_no, fallback.version_no),
    content_hash: String(row?.content_hash || sha256(content)),
    char_count: integer(row?.char_count, strategyMemoryCharCount(content)),
    estimated_token_count: integer(row?.estimated_token_count, strategyMemoryEstimatedTokenCount(content)),
    capacity_chars: normalizeStrategyMemoryCapacity(row?.capacity_chars, fallback.capacity_chars),
    compression_target_ratio: normalizeStrategyMemoryRatio(row?.compression_target_ratio, fallback.compression_target_ratio),
    conflict_alert_threshold: normalizeStrategyMemoryConflictThreshold(row?.conflict_alert_threshold, fallback.conflict_alert_threshold),
    pending_update_count: Math.max(0, integer(row?.pending_update_count, fallback.pending_update_count)),
    compression_status: row?.compression_status || fallback.compression_status,
  }
}

function strategyText(strategy) {
  return strategy?.system_prompt || strategy?.description || ''
}

async function loadStrategy(strategyId) {
  const id = positiveId(strategyId, 'strategy_memory_invalid_strategy_id')
  const row = await queryOne(
    `SELECT id, scope, owner_user_id, visibility_status, is_active, deleted_at,
            title, version, system_prompt, description
       FROM auto_prompt_types
      WHERE id = ? AND deleted_at IS NULL`,
    [id]
  )
  if (!row || row.deleted_at) throw new Error('strategy_memory_strategy_not_found')
  if (!['platform', 'private'].includes(String(row.scope))) throw new Error('strategy_memory_strategy_scope_invalid')
  return row
}

function assertStrategyAccess(strategy, actor, action = 'manage') {
  const normalized = normalizeActor(actor)
  const id = actorUserId(normalized)
  if (action === 'runtime') {
    if (strategy.visibility_status !== 'active' || !Number(strategy.is_active)) {
      throw new Error('strategy_memory_strategy_not_active')
    }
    if (strategy.scope === 'private' && Number(strategy.owner_user_id) !== id) {
      throw new Error('strategy_memory_forbidden')
    }
    return normalized
  }
  if (strategy.scope === 'private') {
    if (Number(strategy.owner_user_id) !== id) throw new Error('strategy_memory_forbidden')
    return normalized
  }
  if (strategy.scope === 'platform') {
    if (!canManagePlatformAiContent(normalized)) throw new Error('strategy_memory_platform_forbidden')
    return normalized
  }
  throw new Error('strategy_memory_strategy_scope_invalid')
}

function assertServerOwnedStrategyAccess(strategy, input) {
  const actor = normalizeActor(input?.actor)
  if (!actor.serverOwned) return false
  const validated = input.validatedReviewCase || input.validated_case || null
  const scope = input.strategyScope ?? input.strategy_scope ?? validated?.strategy_scope ?? validated?.scope
  const owner = input.strategyOwnerUserId ?? input.strategy_owner_user_id ?? validated?.owner_user_id
  if (scope !== strategy.scope || Number(owner ?? (strategy.scope === 'platform' ? 0 : NaN)) !== Number(strategy.owner_user_id)) {
    throw new Error('strategy_memory_server_actor_invalid')
  }
  if (validated && validated.strategy_id != null && Number(validated.strategy_id) !== Number(strategy.id)) {
    throw new Error('strategy_memory_server_actor_invalid')
  }
  return true
}

async function getAuthorizedStrategy(strategyId, actor, action = 'manage', input = null) {
  const strategy = await loadStrategy(strategyId)
  if (action === 'server_update' && assertServerOwnedStrategyAccess(strategy, input || { actor })) return strategy
  assertStrategyAccess(strategy, actor, action === 'server_update' ? 'manage' : action)
  return strategy
}

function txRows(raw) {
  if (Array.isArray(raw)) return Array.isArray(raw[0]) ? raw[0] : []
  if (Array.isArray(raw?.rows)) return raw.rows
  return []
}

function txResult(raw) {
  if (Array.isArray(raw)) return raw[0] || {}
  return raw || {}
}

async function txOne(run, sql, params = []) {
  return txRows(await run(sql, params))[0] || null
}

function affected(result) {
  const value = txResult(result)
  return Number(value.affectedRows ?? value.changes ?? value.affected_rows ?? 0)
}

function revisionReason(value) {
  const reason = String(value || '').trim()
  return reason || 'manual_edit'
}

function normalizeSourceRefs(value) {
  if (value === undefined || value === null || value === '') return null
  const refs = Array.isArray(value) ? value.slice(0, MAX_SOURCE_REFS) : [value]
  return refs
}

function assertStrategyMemoryBodyHasNoConditions(value) {
  if (containsLegacyStrategyMemoryConditions(value)) {
    throw new Error('strategy_memory_applicability_forbidden')
  }
}

function parseReviewJson(value) {
  if (!value) return {}
  if (typeof value === 'object') return value
  try {
    const parsed = JSON.parse(value)
    return parsed && typeof parsed === 'object' ? parsed : {}
  } catch {
    return {}
  }
}

function canonicalReviewSourceRefs(reviewCase) {
  const refs = new Set()
  const evidence = parseReviewJson(reviewCase?.evidence_json)
  const sources = Array.isArray(evidence.sources) ? evidence.sources : []
  if (String(reviewCase?.period_type || '') === 'daily') {
    for (const source of sources) {
      const outcomeId = Number(source?.outcome_id ?? source?.outcomeId)
      if (Number.isSafeInteger(outcomeId) && outcomeId > 0) refs.add(`outcome:${outcomeId}`)
    }
  } else if (String(reviewCase?.period_type || '') === 'monthly') {
    for (const source of sources) {
      const periodCaseId = Number(source?.period_case_id ?? source?.periodCaseId)
      if (Number.isSafeInteger(periodCaseId) && periodCaseId > 0) refs.add(`period_review_case:${periodCaseId}`)
    }
  }
  return refs
}

function normalizeCanonicalReviewSourceRefs(value, reviewCase) {
  const explicitlySupplied = value !== undefined && value !== null
  if (explicitlySupplied && (value === '' || (Array.isArray(value) && !value.length))) {
    throw new Error('strategy_memory_source_ref_invalid')
  }
  const raw = normalizeSourceRefs(value)
  const supplied = raw == null ? [] : raw
  if (raw !== null && raw !== undefined && !supplied.length) throw new Error('strategy_memory_source_ref_invalid')
  if (supplied.length && supplied.some(ref => String(ref ?? '').trim() === '')) {
    throw new Error('strategy_memory_source_ref_invalid')
  }
  const allowed = canonicalReviewSourceRefs(reviewCase)
  const caseId = Number(reviewCase?.id)
  const versionId = Number(reviewCase?.approved_version_id)
  if (Number.isSafeInteger(caseId) && caseId > 0) allowed.add(`period_review_case:${caseId}`)
  if (Number.isSafeInteger(versionId) && versionId > 0) allowed.add(`period_review_version:${versionId}`)
  const refs = []
  for (const valueRef of supplied) {
    const ref = String(valueRef || '').trim()
    if (!ref || !allowed.has(ref)) throw new Error('strategy_memory_source_ref_invalid')
    if (!refs.includes(ref)) refs.push(ref)
  }
  // Current review identity is always authoritative and is never left to a
  // provider/model supplied source list.
  const currentRefs = [`period_review_case:${caseId}`, `period_review_version:${versionId}`]
  for (const ref of currentRefs) {
    if (!refs.includes(ref)) refs.push(ref)
  }
  const preservedCurrent = currentRefs.filter(ref => refs.includes(ref))
  const historical = refs.filter(ref => !preservedCurrent.includes(ref))
  return [...historical.slice(0, Math.max(0, MAX_SOURCE_REFS - preservedCurrent.length)), ...preservedCurrent]
}

function validateContent(content, capacityChars) {
  const normalized = sanitizeStrategyMemoryText(content)
  // Runtime memory is intentionally a plain human-readable body. Condition
  // JSON from review/model payloads must never cross this persistence gate.
  assertStrategyMemoryBodyHasNoConditions(normalized)
  const chars = strategyMemoryCharCount(normalized)
  if (chars > capacityChars) throw new Error('strategy_memory_capacity_exceeded')
  return {
    content_text: normalized,
    char_count: chars,
    estimated_token_count: strategyMemoryEstimatedTokenCount(normalized),
    content_hash: sha256(normalized),
  }
}

function buildRevisionParams({ strategyId, versionNo, parentVersionNo, content, reason,
  sourcePeriodReviewVersionId, sourceType = null, sourceId = null, sourceRefs,
  sourceMetadata = null, authorUserId, createdAt }) {
  const metadata = {
    ...(parentVersionNo == null ? {} : { parent_version_no:Number(parentVersionNo) }),
    ...(sourceRefs == null ? {} : { source_refs:sourceRefs }),
    ...(sourceMetadata && typeof sourceMetadata === 'object' ? sourceMetadata : {}),
  }
  return [strategyId, versionNo, reason, sourceType || (sourcePeriodReviewVersionId ? 'period_review_version' : null),
    sourceId || sourcePeriodReviewVersionId || null, content.content_text, content.content_hash,
    content.char_count, content.estimated_token_count, authorUserId || null,
    Object.keys(metadata).length ? JSON.stringify(metadata) : null, createdAt]
}

async function insertRevisionTx(run, options) {
  const result = await run(
    `INSERT INTO strategy_memory_library_revisions
      (strategy_id, version_no, change_reason, source_type, source_id, content_text,
       content_hash, char_count, estimated_token_count, actor_user_id,
       source_metadata_json, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    buildRevisionParams(options)
  )
  return Number(txResult(result).insertId || 0) || null
}

function libraryInsertParams(strategy, defaults, now) {
  return [defaults.strategy_id, defaults.strategy_scope, defaults.owner_user_id,
    defaults.content_text, defaults.version_no, defaults.content_hash, defaults.char_count,
    defaults.estimated_token_count, defaults.capacity_chars, defaults.compression_target_ratio,
    defaults.conflict_alert_threshold, defaults.pending_update_count, defaults.compression_status,
    defaults.last_compacted_at, now, now, defaults.updated_by_user_id]
}

async function ensureLibraryTx(run, strategy, options = {}) {
  const locked = await txOne(run,
    'SELECT * FROM strategy_memory_libraries WHERE strategy_id = ? FOR UPDATE', [strategy.id])
  if (locked) return normalizeLibrary(locked, strategy)
  const defaults = {
    ...strategyMemoryDefaults(strategy),
    capacity_chars: normalizeStrategyMemoryCapacity(options.capacityChars),
    compression_target_ratio: normalizeStrategyMemoryRatio(options.compressionTargetRatio),
    conflict_alert_threshold: normalizeStrategyMemoryConflictThreshold(options.conflictAlertThreshold),
    updated_by_user_id: actorUserId(options.actor),
  }
  await run(
    `INSERT INTO strategy_memory_libraries
      (strategy_id, strategy_scope, owner_user_id, content_text, version_no,
       content_hash, char_count, estimated_token_count, capacity_chars,
       compression_target_ratio, conflict_alert_threshold, pending_update_count,
       compression_status, last_compacted_at, created_at, updated_at, updated_by_user_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    libraryInsertParams(strategy, defaults, beijingNow())
  )
  return defaults
}

// Legacy unified-library rows may contain the structured applicability payload
// imported by migration 181. Correct it through the same append-only revision
// path used by normal edits, so the old revision remains restorable/auditable.
// This helper is intentionally called before an approved review append (and by
// the startup migration), never from a read path.
async function repairLegacyStrategyMemoryLibraryTx(run, strategy, current, actor = null) {
  const cleaned = sanitizeLegacyStrategyMemoryContent(current?.content_text || '')
  if (!cleaned.changed) return { library:current, correction:null }
  const content = validateContent(cleaned.content, current.capacity_chars)
  const nextVersion = Number(current.version_no || 0) + 1
  const now = beijingNow()
  const revisionId = await insertRevisionTx(run, {
    strategyId:Number(strategy.id), versionNo:nextVersion, parentVersionNo:current.version_no,
    content, reason:'legacy_applicability_cleanup', sourceType:'legacy_cleanup',
    sourceId:Number(current.version_no || 0) || null, sourceRefs:null,
    sourceMetadata:{ cleanup_contract:'strategy-memory-legacy-v1', removed_items:cleaned.removed,
      previous_version_no:Number(current.version_no || 0), previous_content_hash:current.content_hash },
    authorUserId:actorUserId(actor), createdAt:now,
  })
  const compressionStatus = current.compression_status || 'idle'
  const update = await run(
    `UPDATE strategy_memory_libraries
        SET content_text = ?, version_no = ?, content_hash = ?, char_count = ?,
            estimated_token_count = ?, compression_status = ?, updated_at = ?, updated_by_user_id = ?
      WHERE strategy_id = ? AND version_no = ? AND content_hash = ?`,
    [content.content_text, nextVersion, content.content_hash, content.char_count,
      content.estimated_token_count, compressionStatus, now, actorUserId(actor),
      strategy.id, current.version_no, current.content_hash]
  )
  if (!affected(update)) throw new Error('strategy_memory_version_conflict')
  return {
    library:{ ...current, ...content, version_no:nextVersion, compression_status:compressionStatus,
      updated_by_user_id:actorUserId(actor) },
    correction:{ revision_id:revisionId, previous_version_no:Number(current.version_no || 0),
      version_no:nextVersion, removed_items:cleaned.removed },
  }
}

async function getLibraryRow(strategyId) {
  return await queryOne('SELECT * FROM strategy_memory_libraries WHERE strategy_id = ?', [strategyId])
}

function publicLibrary(library) {
  if (!library) return null
  return normalizeLibrary(library)
}

// Old approved libraries may predate the plain-Markdown memory contract. Do
// not echo a legacy conditional payload into a new review prompt; it can be
// ignored for this run while the durable historical revision remains intact.
export function sanitizeStrategyMemoryPrompt(library) {
  if (!library || typeof library !== 'object') return library
  const result = { ...library }
  // Read paths must not synthesize a new body/hash for the same persisted
  // version. Until the append-only migration or a write-path correction has
  // committed, fail closed and omit the legacy body from model input.
  if (containsLegacyStrategyMemoryConditions(result.content_text || '')) {
    result.content_text = ''
    result.char_count = 0
    result.estimated_token_count = 0
  }
  return result
}

export async function assertStrategyMemoryAccess(strategyId, actor, action = 'manage') {
  const strategy = await getAuthorizedStrategy(strategyId, actor, action)
  return { strategy, actor: normalizeActor(actor) }
}

export async function getOrCreateStrategyMemoryLibrary(strategyIdOrInput, actorArg = null, payloadArg = null) {
  const input = requestWithActor(strategyIdOrInput, actorArg, payloadArg)
  const strategy = await getAuthorizedStrategy(input.strategyId, input.actor, 'manage', input)
  const current = await getLibraryRow(strategy.id)
  if (current) return publicLibrary(current)
  let created = null
  await withTransaction(async run => {
    const locked = await txOne(run,
      'SELECT * FROM strategy_memory_libraries WHERE strategy_id = ? FOR UPDATE', [strategy.id])
    if (locked) {
      created = normalizeLibrary(locked, strategy)
      return
    }
    created = await ensureLibraryTx(run, strategy, input)
  })
  const persisted = await getLibraryRow(strategy.id)
  return publicLibrary(persisted || created)
}

export async function listStrategyMemoryLibraries(actorOrInput, roleArg = null, options = {}) {
  const input = actorOrInput && typeof actorOrInput === 'object'
    ? { ...actorOrInput, actor: normalizeActor(actorOrInput.actor ?? actorOrInput.userId ?? actorOrInput.user_id, actorOrInput.role ?? actorOrInput.userRole) }
    : { actor: normalizeActor(actorOrInput, roleArg), ...options }
  const actor = normalizeActor(input.actor)
  const rows = await queryAll(
    `SELECT apt.id AS strategy_id, apt.scope AS strategy_scope, apt.owner_user_id,
            apt.title, apt.version AS strategy_version, apt.visibility_status,
            apt.is_active, lib.content_text, lib.version_no, lib.content_hash,
            lib.char_count, lib.estimated_token_count, lib.capacity_chars,
            lib.compression_target_ratio, lib.conflict_alert_threshold,
            lib.pending_update_count, lib.compression_status, lib.last_compacted_at,
            lib.updated_at, lib.updated_by_user_id,
            (SELECT COUNT(*) FROM strategy_memory_conflicts conflicts
              WHERE conflicts.strategy_id = apt.id AND conflicts.status = 'attention_required'
                AND conflicts.verification_status = 'matched') AS attention_required_count,
            (SELECT COUNT(*) FROM strategy_memory_conflicts conflicts
              WHERE conflicts.strategy_id = apt.id AND conflicts.status = 'observing'
                AND conflicts.evidence_count > 0 AND conflicts.verification_status = 'matched') AS observing_count,
            (SELECT COUNT(*) FROM strategy_memory_conflicts conflicts
              WHERE conflicts.strategy_id = apt.id AND conflicts.status = 'observing'
                AND conflicts.evidence_count = 0 AND conflicts.verification_status = 'matched') AS unverified_count,
            (SELECT COUNT(*) FROM strategy_memory_conflicts conflicts
              WHERE conflicts.strategy_id = apt.id AND conflicts.verification_status = 'location_stale') AS location_stale_count,
            (SELECT jobs.status FROM strategy_memory_consistency_jobs jobs
              WHERE jobs.strategy_id = apt.id ORDER BY jobs.id DESC LIMIT 1) AS consistency_check_status,
            (SELECT jobs.completed_at FROM strategy_memory_consistency_jobs jobs
              WHERE jobs.strategy_id = apt.id ORDER BY jobs.id DESC LIMIT 1) AS last_consistency_checked_at
       FROM auto_prompt_types apt
       LEFT JOIN strategy_memory_libraries lib ON lib.strategy_id = apt.id
      WHERE apt.deleted_at IS NULL
      ORDER BY apt.scope ASC, apt.id ASC`,
    []
  )
  return (rows || []).filter(row => {
    const strategy = { id: row.strategy_id, scope: row.strategy_scope, owner_user_id: row.owner_user_id }
    try { assertStrategyAccess({ ...strategy, visibility_status:row.visibility_status, is_active:row.is_active }, actor, 'manage'); return true } catch { return false }
  }).map(row => ({
    strategy_id: Number(row.strategy_id), strategy_scope: row.strategy_scope, owner_user_id: Number(row.owner_user_id || 0),
    title: row.title || null, strategy_version: row.strategy_version == null ? null : Number(row.strategy_version),
    visibility_status: row.visibility_status || null, is_active: Boolean(Number(row.is_active)),
    attention_required_count:Number(row.attention_required_count || 0),
    observing_count:Number(row.observing_count || 0),
    unverified_count:Number(row.unverified_count || 0),
    location_stale_count:Number(row.location_stale_count || 0),
    consistency_check_status:row.consistency_check_status || null,
    last_consistency_checked_at:row.last_consistency_checked_at || null,
    library: row.version_no == null ? null : publicLibrary({ ...row, strategy_id:row.strategy_id }),
  }))
}

export async function getStrategyMemoryLibrary(strategyIdOrInput, actorArg = null, options = {}) {
  const input = requestWithActor(strategyIdOrInput, actorArg, options)
  const strategy = await getAuthorizedStrategy(input.strategyId, input.actor, 'manage', input)
  const row = await getLibraryRow(strategy.id)
  const library = publicLibrary(row || strategyMemoryDefaults(strategy))
  if (input.includeStrategy || options.includeStrategy) return { strategy, library }
  return library
}

export async function getStrategyMemoryLibraryForRuntime(strategyIdOrInput, userIdArg = null, roleArg = null) {
  const input = strategyIdOrInput && typeof strategyIdOrInput === 'object'
    ? strategyIdOrInput
    : { strategyId: strategyIdOrInput, userId:userIdArg, role:roleArg }
  const actor = normalizeActor(input.actor ?? input.userId ?? input.user_id, input.role ?? input.userRole ?? input.user_role)
  const strategy = await getAuthorizedStrategy(input.strategyId, actor, 'runtime', input)
  const row = await getLibraryRow(strategy.id)
  const library = publicLibrary(row || strategyMemoryDefaults(strategy))
  return {
    strategy_id: Number(strategy.id), strategy_scope: strategy.scope, strategy_version: strategy.version ?? null,
    strategy_text: strategyText(strategy), library,
  }
}

export const getRuntimeStrategyMemoryLibrary = getStrategyMemoryLibraryForRuntime
export const readStrategyMemoryLibraryForRuntime = getStrategyMemoryLibraryForRuntime

export async function listStrategyMemoryLibraryRevisions(strategyIdOrInput, actorArg = null, options = {}) {
  const input = requestWithActor(strategyIdOrInput, actorArg, options)
  const strategy = await getAuthorizedStrategy(input.strategyId, input.actor, 'manage', input)
  const limit = Math.min(200, Math.max(1, integer(input.limit, 50)))
  return await queryAll(
    `SELECT * FROM strategy_memory_library_revisions
      WHERE strategy_id = ? ORDER BY version_no DESC, id DESC LIMIT ${limit}`,
    [strategy.id]
  )
}

const STRATEGY_MEMORY_COMPRESSION_TERMINAL_STATUSES = new Set([
  'succeeded', 'succeeded_noop', 'failed', 'stale', 'status_unknown',
])

// The persisted compression job state predates the presentation-safe status
// contract.  Recovery can therefore leave a job as `failed` while retaining a
// stable code that proves it was actually unknown or stale.  Keep this map
// deliberately allow-listed; arbitrary provider/error text must never change
// the user-facing terminal state.
const STRATEGY_MEMORY_COMPRESSION_STATUS_UNKNOWN_ERROR_CODES = new Set([
  'provider_status_unknown', 'provider_status_unknown_after_recovery',
])
const STRATEGY_MEMORY_COMPRESSION_STALE_ERROR_CODES = new Set([
  'strategy_memory_compression_stale',
  'strategy_memory_pending_update_stale',
  'model_task_recovery_stale',
])

function safeCompressionErrorCode(value) {
  const raw = String(value || '').trim()
  if (!raw) return null
  const code = raw.split(':', 1)[0]
  return /^[a-z][a-z0-9_.-]{1,127}$/i.test(code) ? code : 'strategy_memory_compression_failed'
}

function safeCompressionValidationStatus(value) {
  const raw = String(value || '').trim()
  return /^[a-z][a-z0-9_.-]{0,31}$/i.test(raw) ? raw : null
}

function compressionRevisionSummary(row) {
  if (!row) return null
  return {
    revision_id: Number(row.id || 0) || null,
    version_no: integer(row.version_no, 0),
    char_count: Math.max(0, integer(row.char_count, 0)),
  }
}

function parseCompressionValidation(value) {
  if (value && typeof value === 'object') return value
  if (typeof value !== 'string' || !value.trim()) return null
  try {
    const parsed = JSON.parse(value)
    return parsed && typeof parsed === 'object' ? parsed : null
  } catch {
    return null
  }
}

function compressionPresentationStatus(job, task = null) {
  const raw = String(job?.status || '')
  const errorCode = safeCompressionErrorCode(job?.last_error_code)
  if (raw === 'failed' && STRATEGY_MEMORY_COMPRESSION_STATUS_UNKNOWN_ERROR_CODES.has(errorCode)) {
    return { status:'status_unknown', presentation_stage:'status_unknown' }
  }
  if (raw === 'failed' && STRATEGY_MEMORY_COMPRESSION_STALE_ERROR_CODES.has(errorCode)) {
    return { status:'stale', presentation_stage:'stale' }
  }
  if (raw === 'queued') return { status:'queued', presentation_stage:'queued' }
  if (raw === 'leased') {
    const taskStatus = String(task?.status || '')
    const presentationStage = taskStatus === 'applying' ? 'applying'
      : ['validating', 'repairing', 'result_ready'].includes(taskStatus) ? 'validating' : 'running'
    return { status:'running', presentation_stage:presentationStage }
  }
  if (STRATEGY_MEMORY_COMPRESSION_TERMINAL_STATUSES.has(raw)) {
    return { status:raw, presentation_stage:raw }
  }
  return { status:'status_unknown', presentation_stage:'status_unknown' }
}

/**
 * Read one compression job for its strategy owner.  This intentionally
 * returns only presentation-safe metadata: lease tokens, model task IDs,
 * provider responses and prompt material never leave the service layer.
 */
export async function getStrategyMemoryCompressionJobStatus(inputOrStrategyId, actorArg = null, payloadArg = null) {
  const input = compressionInput(inputOrStrategyId, actorArg, payloadArg)
  const strategy = await getAuthorizedStrategy(input.strategyId, input.actor, 'manage', input)
  const jobId = positiveId(input.jobId ?? input.job_id, 'strategy_memory_compression_job_not_found')
  const job = await queryOne(
    `SELECT id, strategy_id, status, source_version_no, source_content_hash,
            target_chars, last_error_code, result_revision_id,
            result_validation_status, result_validation_json,
            created_at, updated_at, completed_at, model_task_id
       FROM strategy_memory_compression_jobs
      WHERE id = ? AND strategy_id = ? LIMIT 1`, [jobId, strategy.id]
  )
  if (!job) throw new Error('strategy_memory_compression_job_not_found')

  // A model-task row is consulted only while the business job is leased.  It
  // can refine the presentation stage, but it never becomes the job status
  // authority and its internal identifier is not returned.
  const task = job.status === 'leased' && job.model_task_id
    ? await queryOne('SELECT status FROM ai_model_tasks WHERE task_id = ? LIMIT 1', [job.model_task_id])
    : null
  const currentRow = await queryOne(
    `SELECT strategy_id, version_no, char_count, content_hash
       FROM strategy_memory_libraries WHERE strategy_id = ? LIMIT 1`, [strategy.id]
  )
  const sourceVersionNo = integer(job.source_version_no, 0)
  const sourceRevisionRow = await queryOne(
    `SELECT id, strategy_id, version_no, char_count, content_hash
       FROM strategy_memory_library_revisions
      WHERE strategy_id = ? AND version_no = ? ORDER BY id DESC LIMIT 1`, [strategy.id, sourceVersionNo]
  )
  const resultRevisionRow = Number(job.result_revision_id || 0) > 0
    ? await queryOne(
      `SELECT id, strategy_id, version_no, char_count, content_hash
         FROM strategy_memory_library_revisions
        WHERE id = ? AND strategy_id = ? LIMIT 1`, [job.result_revision_id, strategy.id]
    )
    : null
  const sourceRevision = compressionRevisionSummary(sourceRevisionRow)
    || (sourceVersionNo === 0 && String(job.source_content_hash || '') === EMPTY_CONTENT_HASH
      ? { revision_id:null, version_no:0, char_count:0 } : null)
  const current = currentRow ? compressionRevisionSummary({
    id:null, version_no:currentRow.version_no, char_count:currentRow.char_count,
  }) : null
  let result = compressionRevisionSummary(resultRevisionRow)
  const validation = parseCompressionValidation(job.result_validation_json)
  if (!result && ['succeeded', 'succeeded_noop'].includes(String(job.status || ''))) {
    const currentMatchesSource = currentRow
      && Number(currentRow.version_no) === sourceVersionNo
      && String(currentRow.content_hash || '') === String(job.source_content_hash || '')
    const validatedChars = Number(validation?.result_char_count)
    if (currentMatchesSource) {
      result = { revision_id:null, version_no:current.version_no, char_count:current.char_count }
    } else if (Number.isSafeInteger(validatedChars) && validatedChars >= 0) {
      // A later library version means the old source version is no longer a
      // truthful result version.  Keep the validated character count useful,
      // but leave version_no null until a result revision proves its lineage.
      result = { revision_id:null, version_no:null, char_count:validatedChars }
    }
  }
  const status = compressionPresentationStatus(job, task)
  return {
    id:Number(job.id), strategy_id:Number(strategy.id), ...status,
    source_version_no:sourceVersionNo,
    result_revision_id:Number(job.result_revision_id || 0) || null,
    target_chars:Math.max(0, integer(job.target_chars, 0)),
    result_validation_status:safeCompressionValidationStatus(job.result_validation_status),
    last_error_code:safeCompressionErrorCode(job.last_error_code),
    created_at:job.created_at || null, updated_at:job.updated_at || null,
    completed_at:job.completed_at || null,
    source:sourceRevision,
    result,
    current,
    source_char_count:sourceRevision?.char_count ?? null,
    result_char_count:result?.char_count ?? null,
    current_char_count:current?.char_count ?? null,
    source_version:sourceRevision?.version_no ?? sourceVersionNo,
    result_version:result?.version_no ?? null,
    current_version:current?.version_no ?? null,
  }
}

export const getStrategyMemoryCompressionJob = getStrategyMemoryCompressionJobStatus

export async function getLatestStrategyMemoryCompressionJobStatus(inputOrStrategyId, actorArg = null, payloadArg = null) {
  const input = compressionInput(inputOrStrategyId, actorArg, payloadArg)
  const strategy = await getAuthorizedStrategy(input.strategyId, input.actor, 'manage', input)
  const latest = await queryOne(
    `SELECT id FROM strategy_memory_compression_jobs
      WHERE strategy_id = ? ORDER BY id DESC LIMIT 1`, [strategy.id]
  )
  if (!latest) return null
  return getStrategyMemoryCompressionJobStatus({ ...input, strategyId:Number(strategy.id), jobId:Number(latest.id) })
}

export async function saveStrategyMemoryLibrary(strategyIdOrInput, actorArg = null, payloadArg = null) {
  const input = requestWithActor(strategyIdOrInput, actorArg, payloadArg)
  const strategy = await getAuthorizedStrategy(input.strategyId, input.actor, 'manage', input)
  if (input.expected_version_no === undefined || input.expected_version_no === null || input.expected_version_no === '') {
    throw new Error('strategy_memory_expected_version_required')
  }
  const expectedVersion = integer(input.expected_version_no, -1)
  if (expectedVersion < 0) throw new Error('strategy_memory_expected_version_invalid')
  const actorId = actorUserId(input.actor)
  let result = null
  await withTransaction(async run => {
    const current = await ensureLibraryTx(run, strategy, { ...input, actor:input.actor })
    if (Number(current.version_no) !== expectedVersion) throw new Error('strategy_memory_version_conflict')
    const capacity = normalizeStrategyMemoryCapacity(input.capacity_chars ?? input.capacityChars, current.capacity_chars)
    const ratio = normalizeStrategyMemoryRatio(input.compression_target_ratio ?? input.compressionTargetRatio, current.compression_target_ratio)
    const threshold = normalizeStrategyMemoryConflictThreshold(input.conflict_alert_threshold ?? input.conflictAlertThreshold, current.conflict_alert_threshold)
    const content = validateContent(input.content_text ?? input.content ?? '', capacity)
    const nextVersion = expectedVersion + 1
    const compressionStatus = content.char_count > 0 && content.char_count >= capacity ? 'queued' : 'idle'
    const now = beijingNow()
    const revisionId = await insertRevisionTx(run, {
      strategyId:strategy.id, versionNo:nextVersion, parentVersionNo:expectedVersion,
      content, reason:'manual_edit', sourcePeriodReviewVersionId:null, sourceRefs:null,
      authorUserId:actorId, createdAt:now,
    })
    const update = await run(
      `UPDATE strategy_memory_libraries
          SET strategy_scope = ?, owner_user_id = ?, content_text = ?, version_no = ?,
              content_hash = ?, char_count = ?, estimated_token_count = ?, capacity_chars = ?,
              compression_target_ratio = ?, conflict_alert_threshold = ?,
              compression_status = ?, updated_at = ?, updated_by_user_id = ?
        WHERE strategy_id = ? AND version_no = ?`,
      [strategy.scope, Number(strategy.owner_user_id || 0), content.content_text, nextVersion,
        content.content_hash, content.char_count, content.estimated_token_count, capacity,
        ratio, threshold, compressionStatus, now, actorId, strategy.id, expectedVersion]
    )
    if (!affected(update)) throw new Error('strategy_memory_version_conflict')
    let compressionJobId = null
    if (compressionStatus === 'queued') {
      const job = await insertCompressionJobTx(run, {
        strategyId:Number(strategy.id), trigger:'capacity', sourceVersionNo:nextVersion,
        sourceContentHash:content.content_hash, sourceUpdateIds:[], capacityChars:capacity,
        targetRatio:ratio, now,
      })
      compressionJobId = job.id
    }
    result = { ...current, ...content, strategy_scope:strategy.scope, owner_user_id:Number(strategy.owner_user_id || 0),
      version_no:nextVersion, capacity_chars:capacity, compression_target_ratio:ratio,
      conflict_alert_threshold:threshold, compression_status:compressionStatus, updated_by_user_id:actorId,
      revision_id:revisionId, compression_job_id:compressionJobId }
  })
  return publicLibrary(result)
}

export const updateStrategyMemoryLibrary = saveStrategyMemoryLibrary

export async function restoreStrategyMemoryLibraryRevision(strategyIdOrInput, actorArg = null, payloadArg = null) {
  const input = requestWithActor(strategyIdOrInput, actorArg, payloadArg)
  const strategy = await getAuthorizedStrategy(input.strategyId, input.actor, 'manage', input)
  if (input.expected_version_no === undefined || input.expected_version_no === null || input.expected_version_no === '') {
    throw new Error('strategy_memory_expected_version_required')
  }
  const expected = integer(input.expected_version_no, -1)
  if (expected < 0) throw new Error('strategy_memory_expected_version_invalid')
  const revisionId = positiveId(input.revision_id ?? input.revisionId, 'strategy_memory_revision_not_found')
  const actorId = actorUserId(input.actor)
  let result = null
  await withTransaction(async run => {
    const current = await ensureLibraryTx(run, strategy, { actor:input.actor })
    if (Number(current.version_no) !== expected) throw new Error('strategy_memory_version_conflict')
    const revision = await txOne(run,
      `SELECT * FROM strategy_memory_library_revisions
        WHERE id = ? AND strategy_id = ? FOR UPDATE`, [revisionId, strategy.id])
    if (!revision) throw new Error('strategy_memory_revision_not_found')
    const cleaned = sanitizeLegacyStrategyMemoryContent(revision.content_text || '')
    const content = validateContent(cleaned.changed ? cleaned.content : (revision.content_text || ''), current.capacity_chars)
    const nextVersion = expected + 1
    const now = beijingNow()
    const newRevisionId = await insertRevisionTx(run, {
      strategyId:strategy.id, versionNo:nextVersion, parentVersionNo:expected,
      content, reason:cleaned.changed ? 'restore_legacy_cleaned' : 'restore',
      sourceType:'restore', sourceId:revision.id, sourceRefs:revision.source_metadata_json,
      sourceMetadata:cleaned.changed ? { cleanup_contract:'strategy-memory-legacy-v1',
        removed_items:cleaned.removed, restored_from_revision_id:Number(revision.id) } : null,
      authorUserId:actorId, createdAt:now,
    })
    const update = await run(
      `UPDATE strategy_memory_libraries
          SET content_text = ?, version_no = ?, content_hash = ?, char_count = ?,
              estimated_token_count = ?, compression_status = 'idle', updated_at = ?, updated_by_user_id = ?
        WHERE strategy_id = ? AND version_no = ?`,
      [content.content_text, nextVersion, content.content_hash, content.char_count,
        content.estimated_token_count, now, actorId, strategy.id, expected]
    )
    if (!affected(update)) throw new Error('strategy_memory_version_conflict')
    result = { ...current, ...content, version_no:nextVersion, compression_status:'idle', updated_by_user_id:actorId, revision_id:newRevisionId }
  })
  return publicLibrary(result)
}

export const restoreStrategyMemoryRevision = restoreStrategyMemoryLibraryRevision

function approvedReviewInput(input) {
  const status = String(input.review_status ?? input.reviewStatus ?? input.status ?? input.validatedReviewCase?.status ?? '').toLowerCase()
  return input.approved === true || status === 'approved' || input.approved_version_id != null || input.approvedVersionId != null
}

function normalizeUpdateKind(value) {
  const kind = String(value || 'daily_review').trim().toLowerCase()
  if (!STRATEGY_MEMORY_UPDATE_KINDS.includes(kind)) throw new Error('strategy_memory_update_kind_invalid')
  return kind
}

export function combineStrategyMemoryText(current, addition) {
  if (!current) return addition
  if (!addition) return current
  return `${current.trimEnd()}\n\n${addition.trimStart()}`
}

// Keep the source text human-readable and stable. Structured applicability
// remains in review evidence/source metadata; it is deliberately not copied
// into the runtime memory正文.
function deterministicReviewUpdateText(content, updateKind) {
  const normalized = sanitizeStrategyMemoryText(content).trim()
  if (!normalized) return ''
  assertStrategyMemoryBodyHasNoConditions(normalized)
  if (/^##\s+/u.test(normalized)) return normalized
  const title = updateKind === 'monthly_review' ? '## 月复盘确认经验' : '## 日复盘确认经验'
  return `${title}\n\n${normalized}`
}

function parsePendingUpdateIds(value) {
  let parsed = value
  if (typeof value === 'string') {
    try { parsed = JSON.parse(value || '[]') } catch { parsed = [] }
  }
  return [...new Set((Array.isArray(parsed) ? parsed : [])
    .map(Number).filter(id => Number.isSafeInteger(id) && id > 0))]
}

function compressionTargetForPending({ capacityChars, targetRatio, pendingText, pendingCount = 1 }) {
  const target = Math.floor(Number(capacityChars) * Number(targetRatio))
  const pendingChars = strategyMemoryCharCount(pendingText)
  return target - pendingChars - (DETERMINISTIC_UPDATE_SEPARATOR_CHARS * Math.max(1, Number(pendingCount) || 1))
}

function safeCompressionValidationManifest(value) {
  const input = value && typeof value === 'object' && !Array.isArray(value) ? value : {}
  const result = {}
  const hash = String(input.semantic_manifest_hash || '').trim()
  if (/^[a-f0-9]{64}$/i.test(hash)) result.semantic_manifest_hash = hash.toLowerCase()
  const blockIds = [...new Set((Array.isArray(input.source_block_ids) ? input.source_block_ids : [])
    .map(item => String(item ?? '').trim()).filter(item => /^[a-z0-9:_-]{1,128}$/i.test(item)))].slice(0, 500)
  result.source_block_ids = blockIds
  const auditHashes = key => [...new Set((Array.isArray(input[key]) ? input[key] : [])
    .map(item => sha256(typeof item === 'string' ? item : stableJson(item))))].slice(0, 500)
  // Provider explanations are useful while validating, but the job row must
  // not become a second memory store. Persist only stable audit hashes.
  result.unresolved_conflict_hashes = auditHashes('unresolved_conflicts')
  result.removed_redundancy_hashes = auditHashes('removed_redundancies')
  const dispositions = new Set(['preserved', 'merged_duplicate'])
  if (Array.isArray(input.coverage_map)) {
    result.coverage_map = input.coverage_map.slice(0, 500).map(row => {
      if (!row || typeof row !== 'object' || Array.isArray(row)) return null
      const sourceBlockId = String(row.source_block_id || '').trim()
      const disposition = String(row.disposition || '').trim()
      if (!/^[a-z0-9:_-]{1,128}$/i.test(sourceBlockId) || !dispositions.has(disposition)) return null
      return { source_block_id:sourceBlockId, disposition,
        result_section_hash:sha256(String(row.result_section || '')) }
    }).filter(Boolean)
  }
  return result
}

async function insertCompressionJobTx(run, options) {
  const updateIds = (options.sourceUpdateIds || []).map(Number).filter(id => Number.isInteger(id) && id > 0)
  const sourceSetHash = options.sourceSetHash || sha256(stableJson({
    strategyId:options.strategyId, sourceVersionNo:options.sourceVersionNo,
    trigger:options.triggerType || options.trigger, updateIds,
  }))
  const targetChars = Number.isFinite(Number(options.targetChars))
    ? Math.trunc(Number(options.targetChars))
    : Math.floor(Number(options.capacityChars) * Number(options.targetRatio))
  if (targetChars <= 0) throw new Error('strategy_memory_compression_capacity_insufficient')
  const now = options.now || beijingNow()
  const lookupExisting = async () => await txOne(run,
    `SELECT id, strategy_id, trigger_type, source_version_no, source_content_hash,
            source_set_hash, target_chars, status, attempt_count, max_attempts,
            lease_expires_at, next_attempt_at, model_task_id, last_error_code,
            result_revision_id, result_content_hash, result_validation_status,
            created_at, updated_at, completed_at
       FROM strategy_memory_compression_jobs
      WHERE strategy_id = ? AND trigger_type = ? AND source_version_no = ?
        AND source_set_hash = ? LIMIT 1 FOR UPDATE`,
    [options.strategyId, options.triggerType || options.trigger, options.sourceVersionNo, sourceSetHash])
  // Read the existing unique-key row before the upsert when the caller needs
  // replay metadata.  This is deliberately opt-in because the worker's
  // internal follow-up jobs only need an ID and should keep their single-write
  // transaction path.
  let existing = options.readExisting ? await lookupExisting() : null
  const raw = await run(
    `INSERT INTO strategy_memory_compression_jobs
      (strategy_id, trigger_type, source_version_no, source_content_hash, source_set_hash,
       pending_update_ids_json, target_chars, status, attempt_count, lease_token,
       lease_expires_at, next_attempt_at, model_task_id, last_error_code,
       result_revision_id, result_content_hash, result_validation_status,
       result_validation_json, created_at, updated_at, completed_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'queued', 0, NULL, NULL, NULL, ?, NULL, NULL,
       NULL, 'pending', NULL, ?, ?, NULL)
     ON DUPLICATE KEY UPDATE id = LAST_INSERT_ID(id)`,
    [options.strategyId, options.triggerType || options.trigger, options.sourceVersionNo, options.sourceContentHash || null,
      sourceSetHash, JSON.stringify(updateIds), targetChars, options.modelTaskId || null, now, now]
  )
  const result = txResult(raw)
  const insertId = Number(result.insertId || 0)
  // MySQL reports one affected row for a fresh insert and two (or zero when
  // every value is identical) for the ON DUPLICATE KEY UPDATE path.  The
  // queue endpoint needs the existing row's durable status so a replay of a
  // terminal no-op cannot make the library look queued again.  Keep the
  // lookup opt-in: the internal compression transitions only need the ID and
  // should not pay for an extra SELECT on every newly-created follow-up job.
  const created = Number(result.affectedRows ?? result.changes ?? 0) === 1
  if (!existing && !created && options.readExisting) {
    // The row may have been inserted by a concurrent transaction after the
    // initial lookup.  Resolve it by the deterministic ID returned through
    // LAST_INSERT_ID, then fall back to the unique key for conservative
    // drivers that do not expose that value on duplicate updates.
    existing = insertId
      ? await txOne(run,
        `SELECT id, strategy_id, trigger_type, source_version_no, source_content_hash,
                source_set_hash, target_chars, status, attempt_count, max_attempts,
                lease_expires_at, next_attempt_at, model_task_id, last_error_code,
                result_revision_id, result_content_hash, result_validation_status,
                created_at, updated_at, completed_at
           FROM strategy_memory_compression_jobs
          WHERE id = ? LIMIT 1 FOR UPDATE`, [insertId])
      : await lookupExisting()
  }
  return { id:insertId || Number(existing?.id) || null, sourceSetHash, targetChars,
    created:options.readExisting ? created && !existing : undefined,
    replayed:options.readExisting ? Boolean(existing) : undefined,
    existing }
}

export async function enqueueApprovedStrategyMemoryUpdate(strategyIdOrInput, actorArg = null, payloadArg = null) {
  const input = requestWithActor(strategyIdOrInput, actorArg, payloadArg)
  if (!approvedReviewInput(input)) throw new Error('strategy_memory_approved_review_required')
  const strategy = await getAuthorizedStrategy(input.strategyId, input.actor, 'server_update', input)
  const periodReviewVersionId = positiveId(input.period_review_version_id ?? input.periodReviewVersionId,
    'strategy_memory_period_review_version_required')
  const periodReviewCaseId = positiveId(input.period_review_case_id ?? input.periodReviewCaseId,
    'strategy_memory_period_review_case_required')
  const updateKind = normalizeUpdateKind(input.update_kind ?? input.updateKind)
  const contentText = deterministicReviewUpdateText(
    input.content_text ?? input.content ?? input.memory_update ?? '', updateKind)
  if (!contentText.trim()) throw new Error('strategy_memory_update_empty')
  let sourceRefs = null
  let result = null
  await withTransaction(async run => {
    // The caller's `approved` flag and validated object are only hints. Reload
    // the durable case/version identity under the same transaction that writes
    // the update so stale or forged approvals cannot reach the library.
    const canonical = await txOne(run,
      `SELECT cases.*, versions.id AS canonical_version_id,
              versions.period_case_id AS canonical_version_case_id,
              versions.content_hash AS canonical_version_content_hash
         FROM period_review_cases cases
         JOIN period_review_versions versions
           ON versions.id = cases.approved_version_id
          AND versions.period_case_id = cases.id
        WHERE cases.id = ? AND cases.approved_version_id = ?
          AND cases.current_version_id = cases.approved_version_id
          AND cases.status = 'approved'
        LIMIT 1 FOR UPDATE`, [periodReviewCaseId, periodReviewVersionId])
    if (!canonical || Number(canonical.strategy_id) !== Number(strategy.id)
      || Number(canonical.canonical_version_id) !== periodReviewVersionId
      || Number(canonical.canonical_version_case_id) !== periodReviewCaseId) {
      throw new Error('strategy_memory_approved_review_not_canonical')
    }
    const validated = input.validatedReviewCase || input.validated_case || null
    if (validated && (
      (validated.id != null && Number(validated.id) !== periodReviewCaseId)
      || (validated.strategy_id != null && Number(validated.strategy_id) !== Number(strategy.id))
      || (validated.approved_version_id != null && Number(validated.approved_version_id) !== periodReviewVersionId)
      || (validated.status != null && String(validated.status).toLowerCase() !== 'approved')
    )) throw new Error('strategy_memory_approved_review_not_canonical')
    sourceRefs = normalizeCanonicalReviewSourceRefs(input.source_refs ?? input.sourceRefs, {
      ...canonical, approved_version_id:periodReviewVersionId,
    })
    let current = await ensureLibraryTx(run, strategy, { actor:input.actor })
    const repaired = await repairLegacyStrategyMemoryLibraryTx(run, strategy, current, input.actor)
    current = repaired.library
    const existing = await txOne(run,
      `SELECT * FROM strategy_memory_pending_updates
        WHERE strategy_id = ? AND source_period_review_version_id = ? AND update_kind = ?
        FOR UPDATE`, [strategy.id, periodReviewVersionId, updateKind])
    if (existing) {
      const status = String(existing.status || '')
      if (status === 'merged') {
        // A status flag is not proof of persistence. Refuse to report a
        // historical false-success unless the referenced revision exists and
        // carries this update's durable source identity.
        const revision = existing.merged_revision_id
          ? await txOne(run,
            `SELECT id, strategy_id, version_no, content_hash, source_type, source_id,
                    source_metadata_json
               FROM strategy_memory_library_revisions
              WHERE id = ? AND strategy_id = ? FOR UPDATE`, [existing.merged_revision_id, strategy.id])
          : null
        let metadata = null
        try { metadata = JSON.parse(revision?.source_metadata_json || '{}') } catch { metadata = null }
        const sourceMatches = revision && (
          Number(revision.source_id || 0) === periodReviewVersionId
          || Number(metadata?.source_period_review_version_id || 0) === periodReviewVersionId
          || (Array.isArray(metadata?.pending_update_ids)
            && metadata.pending_update_ids.map(Number).includes(Number(existing.id)))
        )
        if (!sourceMatches) throw new Error('strategy_memory_pending_update_integrity')
        result = { idempotent:true, merged:true, pending:false,
          pending_update_id:Number(existing.id), merged_revision_id:Number(existing.merged_revision_id),
          revision_id:Number(existing.merged_revision_id), status:'merged', library:current,
          update_kind:updateKind }
        return
      }
      if (status === 'pending') {
        const job = await txOne(run,
          `SELECT id, status FROM strategy_memory_compression_jobs
            WHERE strategy_id = ? AND JSON_CONTAINS(pending_update_ids_json, CAST(? AS JSON))
            ORDER BY id DESC LIMIT 1`, [strategy.id, JSON.stringify(Number(existing.id))])
        result = { idempotent:true, merged:false, pending:true,
          pending_update_id:Number(existing.id), compression_job_id:Number(job?.id || 0) || null,
          status:'pending', update_kind:updateKind,
          library:{ ...current, pending_update_count:Number(current.pending_update_count || 0), compression_status:current.compression_status } }
        return
      }
      throw new Error('strategy_memory_pending_update_integrity')
    }
    const mergedText = combineStrategyMemoryText(current.content_text, contentText)
    const mergedChars = strategyMemoryCharCount(mergedText)
    // A previously queued/running compression never owns persistence of a
    // newly approved review. If the complete deterministic append fits, apply
    // it now; the older job will fail its source-version CAS and can be
    // retried against this new authoritative revision.
    const canMerge = mergedChars <= current.capacity_chars
    const now = beijingNow()
    const insert = await run(
      `INSERT INTO strategy_memory_pending_updates
        (strategy_id, update_kind, source_period_case_id, source_period_review_version_id,
         content_text, content_hash, source_refs_json, status, merged_revision_id,
         created_at, updated_at, completed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', NULL, ?, ?, NULL)`,
      [strategy.id, updateKind, periodReviewCaseId,
        periodReviewVersionId, contentText, sha256(contentText), jsonText(sourceRefs), now, now]
    )
    const pendingId = Number(txResult(insert).insertId || 0) || null
    if (!pendingId) throw new Error('strategy_memory_pending_update_create_failed')
    if (canMerge) {
      const nextVersion = Number(current.version_no) + 1
      const content = validateContent(mergedText, current.capacity_chars)
      const revisionId = await insertRevisionTx(run, {
        strategyId:strategy.id, versionNo:nextVersion, parentVersionNo:current.version_no,
        content, reason:updateKind === 'monthly_review' ? 'monthly_review_append' : 'daily_review_append',
        sourcePeriodReviewVersionId:periodReviewVersionId,
         sourceRefs, sourceMetadata:{ pending_update_ids:[pendingId], source_period_review_version_id:periodReviewVersionId,
           source_period_review_case_id:periodReviewCaseId },
        authorUserId:actorUserId(input.actor), createdAt:now,
      })
      // Monthly review persistence is deliberately independent from the
      // optional compression request. The newly created version is already
      // authoritative and remains so if the provider later fails.
      const shouldCompress = updateKind === 'monthly_review'
        || content.char_count >= current.capacity_chars
      const compressionStatus = shouldCompress ? 'queued' : 'idle'
      const update = await run(
        `UPDATE strategy_memory_libraries
            SET content_text = ?, version_no = ?, content_hash = ?, char_count = ?,
                estimated_token_count = ?, compression_status = ?, updated_at = ?, updated_by_user_id = ?
          WHERE strategy_id = ? AND version_no = ?`,
        [content.content_text, nextVersion, content.content_hash, content.char_count,
          content.estimated_token_count, compressionStatus,
          now, actorUserId(input.actor), strategy.id, current.version_no]
      )
      if (!affected(update)) throw new Error('strategy_memory_version_conflict')
      const pendingUpdate = await run(
        `UPDATE strategy_memory_pending_updates
            SET status = 'merged', merged_revision_id = ?, updated_at = ?, completed_at = ?
          WHERE id = ? AND status = 'pending'`, [revisionId, now, now, pendingId]
      )
      if (!affected(pendingUpdate)) throw new Error('strategy_memory_pending_update_conflict')
      let compressionJobId = null
      if (shouldCompress) {
        const job = await insertCompressionJobTx(run, {
          strategyId:Number(strategy.id), trigger:updateKind === 'monthly_review' ? 'monthly_review' : 'capacity', sourceVersionNo:nextVersion,
          sourceContentHash:content.content_hash, sourceUpdateIds:[],
          capacityChars:current.capacity_chars, targetRatio:current.compression_target_ratio, now,
        })
        compressionJobId = job.id
      }
      result = { merged:true, pending:false, pending_update_id:pendingId, revision_id:revisionId,
        compression_job_id:compressionJobId,
        library:{ ...current, ...content, version_no:nextVersion, compression_status:compressionStatus }, update_kind:updateKind }
      return
    }
    const targetChars = compressionTargetForPending({ capacityChars:current.capacity_chars,
      targetRatio:current.compression_target_ratio, pendingText:contentText, pendingCount:1 })
    if (targetChars <= 0) throw new Error('strategy_memory_pending_update_capacity_exceeded')
    const sourceUpdateIds = [pendingId]
    const job = await insertCompressionJobTx(run, {
      strategyId:Number(strategy.id), trigger:'capacity',
      sourceVersionNo:Number(current.version_no), sourceContentHash:current.content_hash,
      sourceUpdateIds, capacityChars:current.capacity_chars,
      targetRatio:current.compression_target_ratio, targetChars, now,
    })
    await run(
      `UPDATE strategy_memory_libraries
          SET pending_update_count = pending_update_count + 1, compression_status = 'queued',
              updated_at = ?, updated_by_user_id = ?
        WHERE strategy_id = ? AND version_no = ?`, [now, actorUserId(input.actor), strategy.id, current.version_no]
    )
    result = { merged:false, pending:true, pending_update_id:pendingId, compression_job_id:job.id,
      update_kind:updateKind, library:{ ...current, pending_update_count:current.pending_update_count + 1, compression_status:'queued' } }
  })
  return result
}

export const enqueueApprovedReviewMemoryUpdate = enqueueApprovedStrategyMemoryUpdate

function conflictKeyFromInput(input) {
  const category = normalizedConflictCategory(input.category || input.conflict_type || input.conflictType)
  const strategyExcerpt = normalizeConflictExcerpt(input.strategy_excerpt || input.strategyExcerpt)
  const memoryExcerpt = normalizeConflictExcerpt(input.memory_excerpt || input.memoryExcerpt
    || input.description || input.conflict_description)
  const strategyRuleHash = sha256(strategyExcerpt)
  const memoryClaimHash = sha256(memoryExcerpt)
  const canonicalLineageKey = sha256(`${String(input.conflict_target || input.conflictTarget || 'existing_memory')}\u0000${memoryClaimHash}`)
  // A model-supplied conflict_key is deliberately ignored. Identity is owned
  // by the server and only derives from exact, validated excerpts.
  return sha256(stableJson({ identity_version:1, strategy_id:Number(input.strategyId || input.strategy_id || 0),
    category, strategy_rule_hash:strategyRuleHash, canonical_lineage_key:canonicalLineageKey }))
}

export function buildStrategyMemoryConflictKey(input = {}) {
  return conflictKeyFromInput(input)
}

export function validateStrategyMemoryConflictCandidate(input = {}, context = {}) {
  const conflictTarget = String(input.conflict_target || input.conflictTarget || '').trim()
  if (!['existing_memory', 'proposed_experience'].includes(conflictTarget)) {
    throw new Error('strategy_memory_conflict_target_invalid')
  }
  const category = normalizedConflictCategory(input.category || input.conflict_type || input.conflictType)
  const strategyExcerpt = normalizeConflictExcerpt(input.strategy_excerpt || input.strategyExcerpt)
  const memoryExcerpt = normalizeConflictExcerpt(input.memory_excerpt || input.memoryExcerpt)
  if (!strategyExcerpt || !exactExcerptMatch(context.strategyText, strategyExcerpt)) {
    throw new Error('strategy_memory_conflict_strategy_excerpt_invalid')
  }
  if (!memoryExcerpt) throw new Error('strategy_memory_conflict_memory_excerpt_invalid')
  const memoryManifest = buildStrategyMemorySourceManifest({
    content_text:context.memoryText || '', namespace:'current_library', includePendingUpdates:false,
  })
  let sourceBlock = null
  if (conflictTarget === 'existing_memory') {
    const matches = memoryManifest.source_blocks.filter(block => exactExcerptMatch(block.text, memoryExcerpt))
    if (matches.length !== 1) throw new Error('strategy_memory_conflict_memory_excerpt_invalid')
    sourceBlock = matches[0]
  } else {
    const proposed = (Array.isArray(context.proposedExperiences) ? context.proposedExperiences : [])
      .map(normalizeConflictExcerpt).filter(Boolean)
    if (proposed.filter(text => exactExcerptMatch(text, memoryExcerpt)).length !== 1) {
      throw new Error('strategy_memory_conflict_proposed_excerpt_invalid')
    }
  }
  const strategyRuleHash = sha256(strategyExcerpt)
  const memoryClaimHash = sha256(memoryExcerpt)
  const canonicalLineageKey = sha256(`${conflictTarget}\u0000${sourceBlock?.hash || memoryClaimHash}`)
  const conflictKey = sha256(stableJson({ identity_version:1,
    strategy_id:Number(context.strategyId || input.strategyId || input.strategy_id || 0), category,
    strategy_rule_hash:strategyRuleHash, canonical_lineage_key:canonicalLineageKey }))
  return {
    conflict_key:conflictKey, identity_version:1, conflict_kind:`${conflictTarget}_vs_strategy`,
    conflict_target:conflictTarget, category, strategy_excerpt:strategyExcerpt,
    memory_excerpt:memoryExcerpt, strategy_rule_hash:strategyRuleHash,
    memory_claim_hash:memoryClaimHash, canonical_lineage_key:canonicalLineageKey,
    source_block_id:sourceBlock?.id || null, source_block_hash:sourceBlock?.hash || null,
  }
}

export async function recordStrategyMemoryConflictEvidence(strategyIdOrInput, actorArg = null, payloadArg = null) {
  const input = requestWithActor(strategyIdOrInput, actorArg, payloadArg)
  if (!approvedReviewInput(input)) throw new Error('strategy_memory_approved_review_required')
  const strategy = await getAuthorizedStrategy(input.strategyId, input.actor, 'server_update', input)
  const periodReviewVersionId = positiveId(input.period_review_version_id ?? input.periodReviewVersionId,
    'strategy_memory_period_review_version_required')
  const periodReviewCaseId = positiveId(input.period_review_case_id ?? input.periodReviewCaseId
    ?? input.validatedReviewCase?.id ?? input.validatedReviewCase?.period_case_id,
  'strategy_memory_period_review_case_required')
  const description = sanitizeStrategyMemoryText(input.description || input.conflict_description || input.conflict || '')
  const suggestedAction = sanitizeStrategyMemoryText(input.suggested_action || input.suggestedAction || '')
  let result = null
  await withTransaction(async run => {
    // Conflict evidence has the same second-layer approval gate as a memory
    // append.  Never let an `approved` flag or stale validated object create a
    // third occurrence for an unrelated case/version.
    const canonical = await txOne(run,
      `SELECT cases.*, versions.id AS canonical_version_id,
              versions.period_case_id AS canonical_version_case_id,
              versions.content_hash AS canonical_version_content_hash
         FROM period_review_cases cases
         JOIN period_review_versions versions
           ON versions.id = cases.approved_version_id
          AND versions.period_case_id = cases.id
        WHERE cases.id = ? AND cases.approved_version_id = ?
          AND cases.current_version_id = cases.approved_version_id
          AND cases.status = 'approved'
        LIMIT 1 FOR UPDATE`, [periodReviewCaseId, periodReviewVersionId])
    if (!canonical || Number(canonical.strategy_id) !== Number(strategy.id)
      || Number(canonical.canonical_version_id) !== periodReviewVersionId
      || Number(canonical.canonical_version_case_id) !== periodReviewCaseId) {
      throw new Error('strategy_memory_approved_review_not_canonical')
    }
    const validated = input.validatedReviewCase || input.validated_case || null
    if (validated && (
      (validated.id != null && Number(validated.id) !== periodReviewCaseId)
      || (validated.strategy_id != null && Number(validated.strategy_id) !== Number(strategy.id))
      || (validated.approved_version_id != null && Number(validated.approved_version_id) !== periodReviewVersionId)
      || (validated.status != null && String(validated.status).toLowerCase() !== 'approved')
    )) throw new Error('strategy_memory_approved_review_not_canonical')
    const sourceRefs = normalizeCanonicalReviewSourceRefs(input.source_refs ?? input.sourceRefs, {
      ...canonical, approved_version_id:periodReviewVersionId,
    })
    const currentLibrary = await ensureLibraryTx(run, strategy, { actor:input.actor })
    const verified = validateStrategyMemoryConflictCandidate(input, {
      strategyId:strategy.id,
      strategyText:input.frozen_strategy_text ?? input.frozenStrategyText ?? strategyText(strategy),
      memoryText:input.frozen_memory_text ?? input.frozenMemoryText ?? currentLibrary.content_text,
      proposedExperiences:input.proposed_experiences ?? input.proposedExperiences,
    })
    const key = verified.conflict_key
    let conflict = await txOne(run,
      `SELECT * FROM strategy_memory_conflicts
        WHERE strategy_id = ? AND conflict_key = ? FOR UPDATE`, [strategy.id, key])
    if (!conflict) {
      const inserted = await run(
        `INSERT INTO strategy_memory_conflicts
          (strategy_id, conflict_key, conflict_category, conflict_summary, strategy_excerpt,
           suggested_change, evidence_count, alert_threshold, status, first_observed_at,
           last_observed_at, created_at, updated_at, identity_version, conflict_kind,
           strategy_rule_hash, canonical_lineage_key, verification_status, last_validated_at)
         VALUES (?, ?, ?, ?, ?, ?, 0, ?, 'observing', ?, ?, ?, ?, ?, ?, ?, ?, 'matched', ?)`,
        [strategy.id, key, verified.category,
          description, verified.strategy_excerpt, suggestedAction, currentLibrary.conflict_alert_threshold,
          beijingNow(), beijingNow(), beijingNow(), beijingNow(), verified.identity_version,
          verified.conflict_kind, verified.strategy_rule_hash, verified.canonical_lineage_key, beijingNow()]
      )
      conflict = {
        id:Number(txResult(inserted).insertId || 0) || null,
        strategy_id:Number(strategy.id), conflict_key:key, conflict_category:verified.category,
        conflict_summary:description, strategy_excerpt:verified.strategy_excerpt, suggested_change:suggestedAction,
        evidence_count:0, alert_threshold:currentLibrary.conflict_alert_threshold, status:'observing',
      }
    }
    let bindingId = null
    if (verified.source_block_id) {
      const now = beijingNow()
      await run(`INSERT INTO strategy_memory_conflict_bindings
        (conflict_id, strategy_id, strategy_version, library_version_no, library_content_hash,
         memory_block_id, memory_block_hash, memory_excerpt, memory_claim_hash,
         strategy_excerpt, strategy_rule_hash, location_status, detector_contract_version,
         consistency_job_id, created_at, validated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'matched', 'v1', NULL, ?, ?)
       ON DUPLICATE KEY UPDATE memory_excerpt = VALUES(memory_excerpt), memory_claim_hash = VALUES(memory_claim_hash),
         strategy_excerpt = VALUES(strategy_excerpt), strategy_rule_hash = VALUES(strategy_rule_hash),
         location_status = 'matched', validated_at = VALUES(validated_at), superseded_at = NULL`,
      [conflict.id, strategy.id, Number(strategy.version || 1), currentLibrary.version_no, currentLibrary.content_hash,
        verified.source_block_id, verified.source_block_hash, verified.memory_excerpt, verified.memory_claim_hash,
        verified.strategy_excerpt, verified.strategy_rule_hash, now, now])
      const binding = await txOne(run, `SELECT id FROM strategy_memory_conflict_bindings
        WHERE conflict_id = ? AND strategy_version = ? AND library_version_no = ? AND memory_block_id = ? LIMIT 1`,
      [conflict.id, Number(strategy.version || 1), currentLibrary.version_no, verified.source_block_id])
      bindingId = Number(binding?.id || 0) || null
    }
    const occurrence = await txOne(run,
      `SELECT * FROM strategy_memory_conflict_occurrences
        WHERE conflict_id = ? AND period_review_version_id = ? FOR UPDATE`,
      [conflict.id, periodReviewVersionId])
    if (occurrence) {
      result = { recorded:false, duplicate:true, conflict }
      return
    }
    const now = beijingNow()
    await run(
      `INSERT INTO strategy_memory_conflict_occurrences
        (conflict_id, strategy_id, period_review_case_id, period_review_version_id, evidence_json, created_at,
         binding_id, strategy_version, library_version_no, library_content_hash, memory_block_id,
         memory_block_hash, memory_excerpt, conflict_kind)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [conflict.id, strategy.id, periodReviewCaseId, periodReviewVersionId,
        jsonText({ summary:description, strategy_excerpt:verified.strategy_excerpt,
          memory_excerpt:verified.memory_excerpt, suggested_change:suggestedAction, source_refs:sourceRefs }), now,
        bindingId, Number(strategy.version || 1), currentLibrary.version_no, currentLibrary.content_hash,
        verified.source_block_id, verified.source_block_hash, verified.memory_excerpt, verified.conflict_kind]
    )
    const count = Number(conflict.evidence_count || 0) + 1
    const currentStatus = String(conflict.status || 'observing')
    const nextStatus = currentStatus === 'dismissed'
      ? currentStatus
      : (count >= Number(conflict.alert_threshold || currentLibrary.conflict_alert_threshold) ? 'attention_required' : 'observing')
    await run(
      `UPDATE strategy_memory_conflicts
          SET evidence_count = ?, status = ?, last_observed_at = ?, updated_at = ?
        WHERE id = ?`, [count, nextStatus, now, now, conflict.id]
    )
    result = {
      recorded:true, duplicate:false,
      conflict:{ ...conflict, evidence_count:count, status:nextStatus, alert_threshold:Number(conflict.alert_threshold || currentLibrary.conflict_alert_threshold) },
    }
  })
  return result
}

export const addStrategyMemoryConflictEvidence = recordStrategyMemoryConflictEvidence

async function conflictForActor(conflictId, actor, input = {}) {
  const id = positiveId(conflictId, 'strategy_memory_conflict_not_found')
  const conflict = await queryOne('SELECT * FROM strategy_memory_conflicts WHERE id = ?', [id])
  if (!conflict) throw new Error('strategy_memory_conflict_not_found')
  await getAuthorizedStrategy(conflict.strategy_id, actor, input.serverOwned ? 'server_update' : 'manage', input)
  return conflict
}

export async function listStrategyMemoryConflicts(strategyIdOrInput, actorArg = null, options = {}) {
  const input = requestWithActor(strategyIdOrInput, actorArg, options)
  const strategy = await getAuthorizedStrategy(input.strategyId, input.actor, 'manage', input)
  return await queryAll(
    `SELECT conflicts.*,
            binding.id AS binding_id, binding.strategy_version AS binding_strategy_version,
            binding.library_version_no AS binding_library_version_no,
            binding.library_content_hash AS binding_library_content_hash,
            binding.memory_block_id, binding.memory_block_hash, binding.memory_excerpt,
            binding.location_status
       FROM strategy_memory_conflicts conflicts
       LEFT JOIN strategy_memory_conflict_bindings binding ON binding.id = (
         SELECT MAX(candidate.id) FROM strategy_memory_conflict_bindings candidate
          WHERE candidate.conflict_id = conflicts.id AND candidate.location_status = 'matched'
       )
      WHERE conflicts.strategy_id = ? ORDER BY CASE conflicts.status WHEN 'attention_required' THEN 0 WHEN 'observing' THEN 1 ELSE 2 END, conflicts.updated_at DESC, conflicts.id DESC`,
    [strategy.id]
  )
}

function conflictPresentationState(conflict) {
  if (['resolved', 'dismissed'].includes(String(conflict.status || ''))) return null
  if (String(conflict.location_status || '') !== 'matched') return null
  if (String(conflict.status || '') === 'attention_required') return 'attention_required'
  if (Number(conflict.evidence_count || 0) > 0) return 'observing'
  return 'unverified'
}

export async function getStrategyMemoryLibraryPreview(strategyIdOrInput, actorArg = null, options = {}) {
  const input = requestWithActor(strategyIdOrInput, actorArg, options)
  let previewFlag = null
  try {
    previewFlag = await queryOne("SELECT strategy_memory_markdown_preview_enabled AS enabled FROM ai_feature_flags WHERE scope = 'global' AND user_id = 0 LIMIT 1")
  } catch (error) {
    // Keep old/partially-migrated test and rollback environments readable.
    // The rollout flag only disables preview when it can be read explicitly.
    previewFlag = null
  }
  if (previewFlag?.enabled != null && !Boolean(Number(previewFlag.enabled))) {
    throw new Error('strategy_memory_markdown_preview_disabled')
  }
  const strategy = await getAuthorizedStrategy(input.strategyId, input.actor, 'manage', input)
  const current = publicLibrary(await getLibraryRow(strategy.id) || strategyMemoryDefaults(strategy))
  let library = current
  const requestedVersion = input.version_no ?? input.versionNo
  if (requestedVersion !== undefined && requestedVersion !== null && requestedVersion !== '') {
    const versionNo = integer(requestedVersion, -1)
    if (versionNo < 0) throw new Error('strategy_memory_revision_not_found')
    if (versionNo !== Number(current.version_no)) {
      const revision = await queryOne(`SELECT * FROM strategy_memory_library_revisions
        WHERE strategy_id = ? AND version_no = ? ORDER BY id DESC LIMIT 1`, [strategy.id, versionNo])
      if (!revision) throw new Error('strategy_memory_revision_not_found')
      library = publicLibrary({ ...current, ...revision, strategy_id:strategy.id, version_no:versionNo })
    }
  }
  const rendered = renderStrategyMemoryMarkdownPreview({ content_text:library.content_text,
    namespace:'current_library' })
  if (rendered.content_hash !== library.content_hash) throw new Error('strategy_memory_preview_hash_mismatch')
  const conflicts = await listStrategyMemoryConflicts({ strategyId:strategy.id, actor:input.actor })
  const byBlock = new Map()
  for (const conflict of conflicts) {
    if (Number(conflict.binding_strategy_version) !== Number(strategy.version)
      || Number(conflict.binding_library_version_no) !== Number(library.version_no)
      || String(conflict.binding_library_content_hash || '') !== String(library.content_hash || '')) continue
    const state = conflictPresentationState(conflict)
    if (!state || !conflict.memory_block_id) continue
    const rows = byBlock.get(String(conflict.memory_block_id)) || []
    rows.push(conflict)
    byBlock.set(String(conflict.memory_block_id), rows)
  }
  const rank = { attention_required:3, observing:2, unverified:1 }
  const blocks = rendered.blocks.map(block => {
    const rows = byBlock.get(block.block_id) || []
    const states = rows.map(conflictPresentationState).filter(Boolean)
    const conflictState = states.sort((left, right) => rank[right] - rank[left])[0] || null
    return { block_id:block.block_id, block_hash:block.block_hash, order:block.order,
      html:block.html, conflict_state:conflictState, conflict_ids:rows.map(row => Number(row.id)),
      conflicts:rows.map(row => ({ id:Number(row.id), status:row.status,
        verification_status:row.verification_status, evidence_count:Number(row.evidence_count || 0),
        alert_threshold:Number(row.alert_threshold || current.conflict_alert_threshold),
        summary:row.conflict_summary, strategy_excerpt:row.strategy_excerpt,
        memory_excerpt:row.memory_excerpt, suggested_change:row.suggested_change })) }
  })
  const summary = { attention_required:0, observing:0, unverified:0, location_stale:0 }
  for (const conflict of conflicts) {
    const state = conflictPresentationState(conflict)
    if (state) summary[state] += 1
    else if (String(conflict.verification_status || 'location_stale') === 'location_stale') summary.location_stale += 1
  }
  return { library_identity:{ strategy_id:Number(strategy.id), strategy_version:Number(strategy.version || 0),
    version_no:Number(library.version_no), content_hash:library.content_hash },
  render_schema_version:rendered.render_schema_version, blocks, summary }
}

export async function applyStrategyMemoryConsistencyFindings({ job, candidates } = {}) {
  if (!job || !Array.isArray(candidates)) throw new Error('strategy_memory_consistency_result_invalid')
  const strategy = await loadStrategy(job.strategy_id)
  const now = beijingNow()
  let matched = 0
  await withTransaction(async run => {
    const currentLibrary = await txOne(run,
      'SELECT * FROM strategy_memory_libraries WHERE strategy_id = ? FOR UPDATE', [strategy.id])
    if (!currentLibrary || Number(currentLibrary.version_no) !== Number(job.library_version_no)
      || String(currentLibrary.content_hash || '') !== String(job.library_content_hash || '')
      || Number(strategy.version || 0) !== Number(job.strategy_version)) {
      throw new Error('strategy_memory_consistency_source_stale')
    }
    const foundKeys = []
    for (const candidate of candidates) {
      const verified = validateStrategyMemoryConflictCandidate({
        ...candidate, conflict_target:'existing_memory',
      }, { strategyId:strategy.id, strategyText:job.strategy_text_snapshot,
        memoryText:job.memory_content_snapshot })
      foundKeys.push(verified.conflict_key)
      let conflict = await txOne(run, `SELECT * FROM strategy_memory_conflicts
        WHERE strategy_id = ? AND conflict_key = ? FOR UPDATE`, [strategy.id, verified.conflict_key])
      if (!conflict) {
        const inserted = await run(`INSERT INTO strategy_memory_conflicts
          (strategy_id, conflict_key, conflict_category, conflict_summary, strategy_excerpt,
           suggested_change, evidence_count, alert_threshold, status, first_observed_at,
           last_observed_at, created_at, updated_at, identity_version, conflict_kind,
           strategy_rule_hash, canonical_lineage_key, detection_count, verification_status,
           last_detected_at, last_validated_at)
         VALUES (?, ?, ?, ?, ?, ?, 0, ?, 'observing', ?, ?, ?, ?, ?, ?, ?, ?, 1, 'matched', ?, ?)`,
        [strategy.id, verified.conflict_key, verified.category,
          sanitizeStrategyMemoryText(candidate.summary || ''), verified.strategy_excerpt,
          sanitizeStrategyMemoryText(candidate.suggested_change || ''),
          currentLibrary.conflict_alert_threshold, now, now, now, now, verified.identity_version,
          verified.conflict_kind, verified.strategy_rule_hash, verified.canonical_lineage_key, now, now])
        conflict = { id:Number(txResult(inserted).insertId), status:'observing', evidence_count:0 }
      } else if (String(conflict.status || '') !== 'dismissed') {
        await run(`UPDATE strategy_memory_conflicts SET conflict_summary = ?, strategy_excerpt = ?,
          suggested_change = ?, detection_count = detection_count + 1, verification_status = 'matched',
          last_detected_at = ?, last_validated_at = ?, updated_at = ? WHERE id = ?`,
        [sanitizeStrategyMemoryText(candidate.summary || conflict.conflict_summary || ''), verified.strategy_excerpt,
          sanitizeStrategyMemoryText(candidate.suggested_change || conflict.suggested_change || ''), now, now, now, conflict.id])
      }
      await run(`INSERT INTO strategy_memory_conflict_bindings
        (conflict_id, strategy_id, strategy_version, library_version_no, library_content_hash,
         memory_block_id, memory_block_hash, memory_excerpt, memory_claim_hash, strategy_excerpt,
         strategy_rule_hash, location_status, detector_contract_version, consistency_job_id,
         created_at, validated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'matched', ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE memory_excerpt = VALUES(memory_excerpt), memory_claim_hash = VALUES(memory_claim_hash),
         strategy_excerpt = VALUES(strategy_excerpt), strategy_rule_hash = VALUES(strategy_rule_hash),
         location_status = 'matched', detector_contract_version = VALUES(detector_contract_version),
         consistency_job_id = VALUES(consistency_job_id), validated_at = VALUES(validated_at), superseded_at = NULL`,
      [conflict.id, strategy.id, job.strategy_version, job.library_version_no, job.library_content_hash,
        verified.source_block_id, verified.source_block_hash, verified.memory_excerpt,
        verified.memory_claim_hash, verified.strategy_excerpt, verified.strategy_rule_hash,
        String(job.detector_contract_version || 'strategy-memory-consistency-v1'), Number(job.id), now, now])
      matched += 1
    }
    const active = txRows(await run(`SELECT id, conflict_key FROM strategy_memory_conflicts
      WHERE strategy_id = ? AND verification_status = 'matched' FOR UPDATE`, [strategy.id]))
    const staleIds = active.filter(row => !foundKeys.includes(String(row.conflict_key))).map(row => Number(row.id))
    if (staleIds.length) {
      await run(`UPDATE strategy_memory_conflicts SET verification_status = 'location_stale',
        last_validated_at = ?, updated_at = ? WHERE id IN (${staleIds.map(() => '?').join(',')})`, [now, now, ...staleIds])
      await run(`UPDATE strategy_memory_conflict_bindings SET location_status = 'location_stale',
        superseded_at = ? WHERE conflict_id IN (${staleIds.map(() => '?').join(',')})
        AND location_status = 'matched'`, [now, ...staleIds])
    }
  })
  return { matched_count:matched }
}

export async function updateStrategyMemoryConflict(conflictIdOrInput, actorArg = null, payloadArg = null) {
  const input = requestWithActor(conflictIdOrInput, actorArg, payloadArg)
  const action = String(input.action || '').toLowerCase()
  if (!['resolve', 'dismiss', 'reopen'].includes(action)) throw new Error('strategy_memory_conflict_action_invalid')
  const conflict = await conflictForActor(input.conflict_id ?? input.conflictId ?? conflictIdOrInput, input.actor, input)
  const expectedUpdatedAt = input.expected_updated_at ?? input.expectedUpdatedAt
  if (expectedUpdatedAt !== undefined && expectedUpdatedAt !== null
    && String(expectedUpdatedAt) !== String(conflict.updated_at || '')) {
    throw new Error('strategy_memory_conflict_version_conflict')
  }
  const status = action === 'resolve' ? 'resolved' : action === 'dismiss' ? 'dismissed'
    : (Number(conflict.evidence_count || 0) >= Number(conflict.alert_threshold || STRATEGY_MEMORY_DEFAULT_CONFLICT_ALERT_THRESHOLD) ? 'attention_required' : 'observing')
  const now = beijingNow()
  const actorId = actorUserId(input.actor)
  const result = await queryRun(
    `UPDATE strategy_memory_conflicts
        SET status = ?, resolution_note = ?, resolved_by_user_id = ?, resolved_at = ?, updated_at = ?
      WHERE id = ?${expectedUpdatedAt !== undefined && expectedUpdatedAt !== null ? ' AND updated_at = ?' : ''}`,
    [status, input.note || input.resolution_note || null, action === 'reopen' ? null : actorId,
      action === 'reopen' ? null : now, now, conflict.id,
      ...(expectedUpdatedAt !== undefined && expectedUpdatedAt !== null ? [expectedUpdatedAt] : [])]
  )
  if (!affected(result)) throw new Error(expectedUpdatedAt !== undefined && expectedUpdatedAt !== null
    ? 'strategy_memory_conflict_version_conflict' : 'strategy_memory_conflict_not_found')
  return { ...conflict, status, resolution_note:input.note || input.resolution_note || null,
    resolved_by_user_id:action === 'reopen' ? null : actorId, resolved_at:action === 'reopen' ? null : now }
}

export async function resolveStrategyMemoryConflict(conflictIdOrInput, actorArg = null, payloadArg = null) {
  const input = requestWithActor(conflictIdOrInput, actorArg, payloadArg)
  return updateStrategyMemoryConflict({ ...input, conflict_id:input.conflict_id ?? input.conflictId ?? conflictIdOrInput, action:'resolve' }, input.actor)
}

export async function dismissStrategyMemoryConflict(conflictIdOrInput, actorArg = null, payloadArg = null) {
  const input = requestWithActor(conflictIdOrInput, actorArg, payloadArg)
  return updateStrategyMemoryConflict({ ...input, conflict_id:input.conflict_id ?? input.conflictId ?? conflictIdOrInput, action:'dismiss' }, input.actor)
}

export async function reopenStrategyMemoryConflict(conflictIdOrInput, actorArg = null, payloadArg = null) {
  const input = requestWithActor(conflictIdOrInput, actorArg, payloadArg)
  return updateStrategyMemoryConflict({ ...input, conflict_id:input.conflict_id ?? input.conflictId ?? conflictIdOrInput, action:'reopen' }, input.actor)
}

export async function createStrategyMemoryInjectionLog(inputOrStrategyId, actorArg = null, payloadArg = null) {
  const input = requestWithActor(inputOrStrategyId, actorArg, payloadArg)
  const strategy = await getAuthorizedStrategy(input.strategyId, input.actor, 'runtime', input)
  const library = input.library || publicLibrary(await getLibraryRow(strategy.id) || strategyMemoryDefaults(strategy))
  const now = beijingNow()
  const result = await queryRun(
    `INSERT INTO strategy_memory_injection_logs
      (strategy_id, library_version_no, library_content_hash, char_count,
       estimated_token_count, usage_kind, user_id, signal_id, inference_snapshot_id,
       period_review_case_id, model_task_id, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [strategy.id, library.version_no, library.content_hash, library.char_count, library.estimated_token_count,
      input.injection_kind ?? input.injectionKind ?? 'analysis', actorUserId(input.actor),
      optionalPositiveId(input.signal_id ?? input.signalId), optionalPositiveId(input.inference_snapshot_id ?? input.inferenceSnapshotId),
      optionalPositiveId(input.period_review_case_id ?? input.periodReviewCaseId),
      input.model_task_id ?? input.modelTaskId ?? null, now]
  )
  return { id:Number(result?.insertId || 0) || null, strategy_id:Number(strategy.id), library_version_no:library.version_no,
    library_content_hash:library.content_hash, char_count:library.char_count,
    estimated_token_count:library.estimated_token_count, usage_kind:input.injection_kind ?? input.injectionKind ?? 'analysis' }
}

export const attachStrategyMemoryInjectionLog = createStrategyMemoryInjectionLog

export async function updateStrategyMemoryInjectionLog(logIdOrInput, payloadArg = null, maybePayload = null) {
  const input = logIdOrInput && typeof logIdOrInput === 'object'
    ? { ...logIdOrInput }
    : { ...(maybePayload || payloadArg || {}), logId:logIdOrInput }
  const id = positiveId(input.log_id ?? input.logId, 'strategy_memory_injection_log_not_found')
  const sets = []
  const params = []
  const add = (column, value) => { sets.push(`${column} = ?`); params.push(value) }
  if (input.usage_kind !== undefined || input.usageKind !== undefined) add('usage_kind', String(input.usage_kind ?? input.usageKind))
  if (input.user_id !== undefined || input.userId !== undefined) add('user_id', optionalPositiveId(input.user_id ?? input.userId))
  if (input.signal_id !== undefined || input.signalId !== undefined) add('signal_id', optionalPositiveId(input.signal_id ?? input.signalId))
  if (input.inference_snapshot_id !== undefined || input.inferenceSnapshotId !== undefined) add('inference_snapshot_id', optionalPositiveId(input.inference_snapshot_id ?? input.inferenceSnapshotId))
  if (input.period_review_case_id !== undefined || input.periodReviewCaseId !== undefined) add('period_review_case_id', optionalPositiveId(input.period_review_case_id ?? input.periodReviewCaseId))
  if (input.model_task_id !== undefined || input.modelTaskId !== undefined) add('model_task_id', input.model_task_id ?? input.modelTaskId)
  if (!sets.length) return await queryOne('SELECT * FROM strategy_memory_injection_logs WHERE id = ?', [id])
  params.push(id)
  const result = await queryRun(`UPDATE strategy_memory_injection_logs SET ${sets.join(', ')} WHERE id = ?`, params)
  if (!affected(result)) throw new Error('strategy_memory_injection_log_not_found')
  return await queryOne('SELECT * FROM strategy_memory_injection_logs WHERE id = ?', [id])
}

export const updateRuntimeStrategyMemoryInjectionLog = updateStrategyMemoryInjectionLog

function compressionInput(inputOrStrategyId, actorArg = null, payloadArg = null) {
  const input = requestWithActor(inputOrStrategyId, actorArg, payloadArg)
  return { ...input, strategyId:input.strategyId ?? input.strategy_id }
}

function compressionJobCanKeepLibraryQueued(job, now) {
  const status = String(job?.status || '')
  const errorCode = String(job?.last_error_code || '')
  const nonRetryable = STRATEGY_MEMORY_COMPRESSION_STATUS_UNKNOWN_ERROR_CODES.has(errorCode)
    || STRATEGY_MEMORY_COMPRESSION_STALE_ERROR_CODES.has(errorCode)
  // A live lease is already being processed; its original queue transition
  // owns the library state.  Only an expired lease is claimable again and
  // therefore eligible to restore a stale library status to queued.
  if (status === 'leased') return Boolean(job.lease_expires_at && String(job.lease_expires_at) <= String(now))
  if (status === 'queued') {
    return Number(job.attempt_count || 0) < Number(job.max_attempts || 3) && !nonRetryable
  }
  if (status !== 'failed') return false
  if (Number(job.attempt_count || 0) >= Number(job.max_attempts || 3)) return false
  if (nonRetryable) return false
  return !job.next_attempt_at || String(job.next_attempt_at) <= String(now)
}

export async function queueStrategyMemoryCompressionJob(inputOrStrategyId, actorArg = null, payloadArg = null) {
  const input = compressionInput(inputOrStrategyId, actorArg, payloadArg)
  const strategy = await getAuthorizedStrategy(input.strategyId, input.actor, input.serverOwned ? 'server_update' : 'manage', input)
  let result = null
  await withTransaction(async run => {
    const current = await ensureLibraryTx(run, strategy, { actor:input.actor })
    const sourceVersionNo = integer(input.source_version_no ?? input.sourceVersionNo, current.version_no)
    const sourceContentHash = input.source_content_hash ?? input.sourceContentHash ?? current.content_hash
    const trigger = String(input.trigger || input.reason || 'manual').trim() || 'manual'
    const sourceUpdateIds = (input.source_update_ids ?? input.sourceUpdateIds ?? []).map(Number).filter(id => Number.isInteger(id) && id > 0)
    const job = await insertCompressionJobTx(run, {
      strategyId:Number(strategy.id), trigger, sourceVersionNo, sourceContentHash,
      sourceUpdateIds, sourceSetHash:input.source_set_hash ?? input.sourceSetHash,
      capacityChars:current.capacity_chars, targetRatio:current.compression_target_ratio,
      modelTaskId:input.model_task_id ?? input.modelTaskId,
      readExisting:true,
    })
    const now = beijingNow()
    const replayed = Boolean(job.existing)
    const persistedStatus = replayed ? String(job.existing.status || 'status_unknown') : 'queued'
    const markQueued = !replayed || compressionJobCanKeepLibraryQueued(job.existing, now)
    const status = markQueued && ['failed', 'leased'].includes(persistedStatus) ? 'queued' : persistedStatus
    if (markQueued) {
      await run(`UPDATE strategy_memory_libraries SET compression_status = 'queued', updated_at = ? WHERE strategy_id = ?`, [now, strategy.id])
    }
    const persistedSourceVersionNo = replayed && job.existing.source_version_no != null
      ? Number(job.existing.source_version_no) : sourceVersionNo
    const persistedSourceContentHash = replayed && job.existing.source_content_hash
      ? job.existing.source_content_hash : sourceContentHash
    const persistedTrigger = replayed && job.existing.trigger_type
      ? job.existing.trigger_type : trigger
    const persistedTargetChars = replayed && job.existing.target_chars != null
      ? Number(job.existing.target_chars) : job.targetChars
    result = { id:job.id || Number(job.existing?.id) || null, sourceSetHash:job.sourceSetHash,
      targetChars:persistedTargetChars, strategy_id:Number(strategy.id), trigger:persistedTrigger,
      source_version_no:persistedSourceVersionNo, source_content_hash:persistedSourceContentHash, status,
      created:replayed ? false : true, replayed, library_status_updated:markQueued }
  })
  return result
}

export const enqueueStrategyMemoryCompressionJob = queueStrategyMemoryCompressionJob

export async function claimStrategyMemoryCompressionJob(input = {}) {
  const workerId = String(input.workerId ?? input.worker_id ?? 'strategy-memory-worker').slice(0, 191)
  const leaseMs = Math.min(60 * 60_000, Math.max(5_000, integer(input.leaseMs ?? input.lease_ms, DEFAULT_COMPRESSION_LEASE_MS)))
  const jobId = input.jobId ?? input.job_id
  let result = null
  await withTransaction(async run => {
    const now = beijingNow()
    const nonRetryableErrorCodes = [
      ...STRATEGY_MEMORY_COMPRESSION_STATUS_UNKNOWN_ERROR_CODES,
      ...STRATEGY_MEMORY_COMPRESSION_STALE_ERROR_CODES,
    ]
    const retryableErrorClause = `COALESCE(last_error_code, '') NOT IN (${nonRetryableErrorCodes.map(() => '?').join(',')})`
    const where = jobId != null
      ? `id = ? AND attempt_count < max_attempts AND ${retryableErrorClause}
          AND (next_attempt_at IS NULL OR next_attempt_at <= ?)`
      : `attempt_count < max_attempts AND ${retryableErrorClause}
          AND (next_attempt_at IS NULL OR next_attempt_at <= ?)
          AND (model_task_id IS NULL OR NOT EXISTS (
            SELECT 1 FROM ai_model_tasks tasks WHERE tasks.task_id = strategy_memory_compression_jobs.model_task_id
              AND tasks.status IN ('leased','preparing','submitted','provider_running','provider_quiet',
                'status_unknown','reconciling','response_received','validating','repairing','result_ready','applying')
          ))
          AND (status = 'queued' OR status = 'failed' OR (status = 'leased' AND lease_expires_at < ?))`
    const params = jobId != null
      ? [positiveId(jobId, 'strategy_memory_compression_job_not_found'), ...nonRetryableErrorCodes, now]
      : [...nonRetryableErrorCodes, now, now]
    const job = await txOne(run,
      `SELECT * FROM strategy_memory_compression_jobs WHERE ${where} ORDER BY id ASC LIMIT 1 FOR UPDATE`, params)
    if (!job) return
    if (jobId != null && !['queued', 'failed'].includes(String(job.status))
      && !(job.status === 'leased' && job.lease_expires_at && String(job.lease_expires_at) < now)) {
      throw new Error('strategy_memory_compression_not_claimable')
    }
    const leaseToken = crypto.randomUUID()
    const expires = nowAfter(leaseMs)
    const update = await run(
      `UPDATE strategy_memory_compression_jobs
          SET status = 'leased', lease_token = ?, lease_expires_at = ?, next_attempt_at = NULL,
              attempt_count = attempt_count + 1, updated_at = ?
        WHERE id = ?`, [leaseToken, expires, now, job.id]
    )
    if (!affected(update)) throw new Error('strategy_memory_compression_claim_lost')
    result = { ...job, id:Number(job.id), status:'leased', lease_token:leaseToken, lease_expires_at:expires,
      attempt_count:Number(job.attempt_count || 0) + 1, worker_id:workerId }
  })
  return result
}

export async function renewStrategyMemoryCompressionLease(inputOrJobId, tokenArg = null, options = {}) {
  const input = inputOrJobId && typeof inputOrJobId === 'object'
    ? inputOrJobId
    : { jobId:inputOrJobId, leaseToken:tokenArg, ...options }
  const id = positiveId(input.jobId ?? input.job_id, 'strategy_memory_compression_job_not_found')
  const token = String(input.leaseToken ?? input.lease_token ?? '').trim()
  if (!token) throw new Error('strategy_memory_compression_lease_required')
  const expires = nowAfter(Math.min(60 * 60_000, Math.max(5_000, integer(input.leaseMs ?? input.lease_ms, DEFAULT_COMPRESSION_LEASE_MS))))
  const now = beijingNow()
  const result = await queryRun(
    `UPDATE strategy_memory_compression_jobs SET lease_expires_at = ?, updated_at = ?
      WHERE id = ? AND status = 'leased' AND lease_token = ?`, [expires, now, id, token]
  )
  if (!affected(result)) throw new Error('strategy_memory_compression_lease_lost')
  return { id, lease_token:token, lease_expires_at:expires, status:'leased' }
}

export const leaseStrategyMemoryCompressionJob = renewStrategyMemoryCompressionLease

export async function applyStrategyMemoryCompressionJob(input = {}) {
  const id = positiveId(input.jobId ?? input.job_id, 'strategy_memory_compression_job_not_found')
  const token = String(input.leaseToken ?? input.lease_token ?? '').trim()
  if (!token) throw new Error('strategy_memory_compression_lease_required')
  const content = sanitizeStrategyMemoryText(input.content_text ?? input.content ?? '')
  let result = null
  await withTransaction(async run => {
    const job = await txOne(run, 'SELECT * FROM strategy_memory_compression_jobs WHERE id = ? FOR UPDATE', [id])
    if (!job || job.status !== 'leased' || String(job.lease_token || '') !== token) throw new Error('strategy_memory_compression_lease_lost')
    const strategy = await loadStrategy(job.strategy_id)
    const current = await txOne(run, 'SELECT * FROM strategy_memory_libraries WHERE strategy_id = ? FOR UPDATE', [job.strategy_id])
    if (!current) throw new Error('strategy_memory_library_not_found')
    const library = normalizeLibrary(current, strategy)
    if (Number(library.version_no) !== Number(job.source_version_no)
      || String(library.content_hash) !== String(job.source_content_hash || library.content_hash)) {
      throw new Error('strategy_memory_compression_stale')
    }
    const ids = parsePendingUpdateIds(job.pending_update_ids_json)
    let pendingUpdates = []
    if (ids.length) {
      pendingUpdates = txRows(await run(
        `SELECT id, strategy_id, update_kind, source_period_case_id, source_period_review_version_id,
                content_text, content_hash, source_refs_json, status
           FROM strategy_memory_pending_updates
          WHERE strategy_id = ? AND status = 'pending' AND id IN (${ids.map(() => '?').join(',')})
          ORDER BY id ASC FOR UPDATE`, [job.strategy_id, ...ids]))
      const found = new Set(pendingUpdates.map(row => Number(row.id)))
      if (pendingUpdates.length !== ids.length || ids.some(updateId => !found.has(updateId))) {
        throw new Error('strategy_memory_pending_update_stale')
      }
    }
    const target = Number(job.target_chars || Math.floor(library.capacity_chars * library.compression_target_ratio))
    const checked = validateContent(content, library.capacity_chars)
    if (checked.char_count > target) throw new Error('strategy_memory_compression_output_exceeds_target')
    // The provider only compresses the old current library. Approved pending
    // updates are appended by the server after validation, never trusted from
    // provider output.
    let finalContent = checked
    if (pendingUpdates.length) {
      let combinedText = checked.content_text
      for (const update of pendingUpdates) {
        combinedText = combineStrategyMemoryText(combinedText,
          sanitizeStrategyMemoryText(update.content_text || ''))
      }
      finalContent = validateContent(combinedText, library.capacity_chars)
    }
    const contentChanged = finalContent.content_hash !== library.content_hash
    const now = beijingNow()
    const remaining = txRows(await run(
      `SELECT id, update_kind, content_text FROM strategy_memory_pending_updates
        WHERE strategy_id = ? AND status = 'pending' ORDER BY id FOR UPDATE`, [job.strategy_id]
    ))
    const remainingIds = remaining.map(row => Number(row.id)).filter(idValue => !ids.includes(idValue))
    const nextCompressionStatus = remainingIds.length ? 'queued' : 'idle'
    let revisionId = null
    let nextVersion = Number(library.version_no)
    if (contentChanged) {
      nextVersion += 1
      revisionId = await insertRevisionTx(run, {
        strategyId:Number(job.strategy_id), versionNo:nextVersion, parentVersionNo:library.version_no,
        content:finalContent,
        reason:String(job.trigger_type || 'capacity') === 'monthly_review' ? 'monthly_review_compression' : 'capacity_compression',
        sourcePeriodReviewVersionId:null, sourceRefs:null,
        sourceMetadata:{ pending_update_ids:ids, source_version_no:Number(library.version_no),
          source_content_hash:library.content_hash },
        authorUserId:actorUserId(input.actor), createdAt:now,
      })
    }
    const update = await run(
      `UPDATE strategy_memory_libraries
          SET content_text = ?, version_no = ?, content_hash = ?, char_count = ?,
              estimated_token_count = ?, pending_update_count = ?, compression_status = ?,
              last_compacted_at = ?, updated_at = ?, updated_by_user_id = ?
        WHERE strategy_id = ? AND version_no = ? AND content_hash = ?`,
      [finalContent.content_text, nextVersion, finalContent.content_hash, finalContent.char_count,
        finalContent.estimated_token_count, remainingIds.length, nextCompressionStatus,
        contentChanged ? now : (library.last_compacted_at || null), now, actorUserId(input.actor),
        job.strategy_id, library.version_no, library.content_hash]
    )
    if (!affected(update)) throw new Error('strategy_memory_compression_stale')
    if (ids.length) {
      const pendingUpdate = await run(
        `UPDATE strategy_memory_pending_updates
            SET status = 'merged', merged_revision_id = ?, updated_at = ?, completed_at = ?
          WHERE strategy_id = ? AND id IN (${ids.map(() => '?').join(',')}) AND status = 'pending'`,
        [revisionId, now, now, job.strategy_id, ...ids]
      )
      if (Number(affected(pendingUpdate)) !== ids.length || !revisionId) {
        throw new Error('strategy_memory_pending_update_conflict')
      }
    }
    let nextJob = null
    if (remainingIds.length) {
      const nextTrigger = remaining.some(row => row.update_kind === 'monthly_review') ? 'monthly_review' : 'capacity'
      const nextPendingText = remaining.filter(row => remainingIds.includes(Number(row.id)))
        .map(row => String(row.content_text || '')).join('\n\n')
      const nextTargetChars = compressionTargetForPending({ capacityChars:library.capacity_chars,
        targetRatio:library.compression_target_ratio, pendingText:nextPendingText,
        pendingCount:remainingIds.length })
      if (nextTargetChars <= 0) throw new Error('strategy_memory_pending_update_capacity_exceeded')
      nextJob = await insertCompressionJobTx(run, {
        strategyId:Number(job.strategy_id), trigger:nextTrigger,
        sourceVersionNo:nextVersion, sourceContentHash:finalContent.content_hash,
        sourceUpdateIds:remainingIds, capacityChars:library.capacity_chars,
        targetRatio:library.compression_target_ratio, targetChars:nextTargetChars, now,
      })
    }
    const finalStatus = contentChanged ? 'succeeded' : 'succeeded_noop'
    const semanticValidation = safeCompressionValidationManifest(input.result_validation ?? input.resultValidation)
    const resultValidation = JSON.stringify({ ...semanticValidation,
      source_version_no:Number(library.version_no),
      source_content_hash:library.content_hash, result_content_hash:finalContent.content_hash,
      result_char_count:finalContent.char_count, pending_update_ids:ids,
      validation_status:finalStatus === 'succeeded_noop' ? 'noop' : 'accepted' })
    const jobUpdate = await run(
      `UPDATE strategy_memory_compression_jobs
          SET status = ?, result_revision_id = ?, result_content_hash = ?,
              result_validation_status = ?, result_validation_json = ?, lease_token = NULL,
              lease_expires_at = NULL, last_error_code = NULL, completed_at = ?, updated_at = ?
        WHERE id = ? AND status = 'leased' AND lease_token = ?`,
      [finalStatus, revisionId, finalContent.content_hash,
        finalStatus === 'succeeded_noop' ? 'noop' : 'accepted', resultValidation,
        now, now, id, token]
    )
    if (!affected(jobUpdate)) throw new Error('strategy_memory_compression_lease_lost')
    result = { id, strategy_id:Number(job.strategy_id), status:finalStatus, revision_id:revisionId,
      next_compression_job_id:nextJob?.id || null,
      library:{ ...library, ...finalContent, version_no:nextVersion, pending_update_count:remainingIds.length,
        compression_status:nextCompressionStatus, last_compacted_at:contentChanged ? now : library.last_compacted_at } }
  })
  return result
}

export const applyStrategyMemoryCompression = applyStrategyMemoryCompressionJob

export async function failStrategyMemoryCompressionJob(input = {}) {
  const id = positiveId(input.jobId ?? input.job_id, 'strategy_memory_compression_job_not_found')
  const token = String(input.leaseToken ?? input.lease_token ?? '').trim()
  if (!token) throw new Error('strategy_memory_compression_lease_required')
  const retryable = input.retryable !== false
  const status = retryable ? 'queued' : 'failed'
  const errorCode = String(input.errorCode ?? input.error_code ?? 'strategy_memory_compression_failed').slice(0, 128)
  const now = beijingNow()
  const retryDelaySeconds = Math.min(3600, 60 * (2 ** Math.max(0, integer(input.attemptCount ?? input.attempt_count, 1) - 1)))
  const nextAttemptAt = retryable ? nowAfter(retryDelaySeconds * 1000) : null
  const result = await queryRun(
    `UPDATE strategy_memory_compression_jobs
        SET status = ?, last_error_code = ?, result_validation_status = 'rejected',
            result_validation_json = ?, lease_token = NULL, lease_expires_at = NULL,
            next_attempt_at = ?, updated_at = ?
      WHERE id = ? AND status = 'leased' AND lease_token = ?`,
    [status, errorCode, JSON.stringify({ error_code:errorCode, memory_preserved:true }), nextAttemptAt, now, id, token]
  )
  if (!affected(result)) throw new Error('strategy_memory_compression_lease_lost')
  // Failure never changes content. Keep the library visibly queued for a
  // retry, or failed when the provider result is unknown/non-retryable; both
  // states preserve the deterministic revision already in the current row.
  const job = await queryOne(
    'SELECT strategy_id, pending_update_ids_json FROM strategy_memory_compression_jobs WHERE id = ? LIMIT 1', [id])
  if (job?.strategy_id) {
    await queryRun(`UPDATE strategy_memory_libraries SET compression_status = ?, updated_at = ?
      WHERE strategy_id = ? AND compression_status IN ('queued','leased','failed')`,
    [status === 'queued' ? 'queued' : 'failed', now, job.strategy_id])
  }
  return { id, status, error_code:errorCode, next_attempt_at:nextAttemptAt, memory_preserved:true }
}

export const markStrategyMemoryCompressionFailed = failStrategyMemoryCompressionJob
