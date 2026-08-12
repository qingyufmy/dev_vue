// Unified strategy memory library service.
//
// The migration for this module is intentionally kept separate from the
// service.  Every read and write re-checks auto_prompt_types so the redundant
// scope/owner columns in the memory tables never become an authority.

import crypto from 'node:crypto'
import { queryOne, queryAll, queryRun, withTransaction, beijingNow } from '../../db.js'
import { canManagePlatformAiContent } from './platform-content-access.js'

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

function validateContent(content, capacityChars) {
  const normalized = sanitizeStrategyMemoryText(content)
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

async function getLibraryRow(strategyId) {
  return await queryOne('SELECT * FROM strategy_memory_libraries WHERE strategy_id = ?', [strategyId])
}

function publicLibrary(library) {
  if (!library) return null
  return normalizeLibrary(library)
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
            lib.updated_at, lib.updated_by_user_id
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
    const content = validateContent(revision.content_text || '', current.capacity_chars)
    const nextVersion = expected + 1
    const now = beijingNow()
    const newRevisionId = await insertRevisionTx(run, {
      strategyId:strategy.id, versionNo:nextVersion, parentVersionNo:expected,
      content, reason:'restore', sourceType:'restore', sourceId:revision.id,
      sourceRefs:revision.source_metadata_json, authorUserId:actorId, createdAt:now,
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
  const raw = await run(
    `INSERT INTO strategy_memory_compression_jobs
      (strategy_id, trigger_type, source_version_no, source_content_hash, source_set_hash,
       pending_update_ids_json, target_chars, status, attempt_count, lease_token,
       lease_expires_at, next_attempt_at, model_task_id, last_error_code,
       result_revision_id, created_at, updated_at, completed_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'queued', 0, NULL, NULL, NULL, ?, NULL, NULL, ?, ?, NULL)
     ON DUPLICATE KEY UPDATE id = LAST_INSERT_ID(id), updated_at = VALUES(updated_at)`,
    [options.strategyId, options.triggerType || options.trigger, options.sourceVersionNo, options.sourceContentHash || null,
      sourceSetHash, JSON.stringify(updateIds), targetChars, options.modelTaskId || null, now, now]
  )
  const insertId = Number(txResult(raw).insertId || 0)
  return { id:insertId || null, sourceSetHash, targetChars }
}

export async function enqueueApprovedStrategyMemoryUpdate(strategyIdOrInput, actorArg = null, payloadArg = null) {
  const input = requestWithActor(strategyIdOrInput, actorArg, payloadArg)
  if (!approvedReviewInput(input)) throw new Error('strategy_memory_approved_review_required')
  const strategy = await getAuthorizedStrategy(input.strategyId, input.actor, 'server_update', input)
  const periodReviewVersionId = positiveId(input.period_review_version_id ?? input.periodReviewVersionId,
    'strategy_memory_period_review_version_required')
  const updateKind = normalizeUpdateKind(input.update_kind ?? input.updateKind)
  const contentText = deterministicReviewUpdateText(
    input.content_text ?? input.content ?? input.memory_update ?? '', updateKind)
  if (!contentText.trim()) throw new Error('strategy_memory_update_empty')
  const sourceRefs = normalizeSourceRefs(input.source_refs ?? input.sourceRefs)
  let result = null
  await withTransaction(async run => {
    const current = await ensureLibraryTx(run, strategy, { actor:input.actor })
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
      [strategy.id, updateKind, optionalPositiveId(input.period_review_case_id ?? input.periodReviewCaseId),
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
          source_period_review_case_id:optionalPositiveId(input.period_review_case_id ?? input.periodReviewCaseId) },
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
  const explicit = String(input.conflict_key ?? input.conflictKey ?? '').trim()
  if (explicit) return explicit.length <= 64 ? explicit : sha256(explicit)
  const value = {
    category:input.category || input.conflict_type || input.conflictType || '',
    description:sanitizeStrategyMemoryText(input.description || input.conflict_description || ''),
    strategy_excerpt:sanitizeStrategyMemoryText(input.strategy_excerpt || input.strategyExcerpt || ''),
    suggested_action:sanitizeStrategyMemoryText(input.suggested_action || input.suggestedAction || ''),
  }
  return sha256(stableJson(value))
}

export function buildStrategyMemoryConflictKey(input = {}) {
  return conflictKeyFromInput(input)
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
  const key = conflictKeyFromInput(input)
  const description = sanitizeStrategyMemoryText(input.description || input.conflict_description || input.conflict || '')
  const strategyExcerpt = sanitizeStrategyMemoryText(input.strategy_excerpt || input.strategyExcerpt || '')
  const suggestedAction = sanitizeStrategyMemoryText(input.suggested_action || input.suggestedAction || '')
  let result = null
  await withTransaction(async run => {
    const currentLibrary = await ensureLibraryTx(run, strategy, { actor:input.actor })
    let conflict = await txOne(run,
      `SELECT * FROM strategy_memory_conflicts
        WHERE strategy_id = ? AND conflict_key = ? FOR UPDATE`, [strategy.id, key])
    if (!conflict) {
      const inserted = await run(
        `INSERT INTO strategy_memory_conflicts
          (strategy_id, conflict_key, conflict_category, conflict_summary, strategy_excerpt,
           suggested_change, evidence_count, alert_threshold, status, first_observed_at,
           last_observed_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, 0, ?, 'observing', ?, ?, ?, ?)`,
        [strategy.id, key, input.category || input.conflict_type || input.conflictType || 'general',
          description, strategyExcerpt, suggestedAction, currentLibrary.conflict_alert_threshold,
          beijingNow(), beijingNow(), beijingNow(), beijingNow()]
      )
      conflict = {
        id:Number(txResult(inserted).insertId || 0) || null,
        strategy_id:Number(strategy.id), conflict_key:key, conflict_category:input.category || 'general',
        conflict_summary:description, strategy_excerpt:strategyExcerpt, suggested_change:suggestedAction,
        evidence_count:0, alert_threshold:currentLibrary.conflict_alert_threshold, status:'observing',
      }
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
        (conflict_id, strategy_id, period_review_case_id, period_review_version_id, evidence_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [conflict.id, strategy.id, periodReviewCaseId, periodReviewVersionId,
        jsonText({ summary:description, strategy_excerpt:strategyExcerpt, suggested_change:suggestedAction,
          source_refs:normalizeSourceRefs(input.source_refs ?? input.sourceRefs) }), now]
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
    `SELECT * FROM strategy_memory_conflicts
      WHERE strategy_id = ? ORDER BY CASE status WHEN 'attention_required' THEN 0 WHEN 'observing' THEN 1 ELSE 2 END, updated_at DESC, id DESC`,
    [strategy.id]
  )
}

export async function updateStrategyMemoryConflict(conflictIdOrInput, actorArg = null, payloadArg = null) {
  const input = requestWithActor(conflictIdOrInput, actorArg, payloadArg)
  const action = String(input.action || '').toLowerCase()
  if (!['resolve', 'dismiss', 'reopen'].includes(action)) throw new Error('strategy_memory_conflict_action_invalid')
  const conflict = await conflictForActor(input.conflict_id ?? input.conflictId ?? conflictIdOrInput, input.actor, input)
  const status = action === 'resolve' ? 'resolved' : action === 'dismiss' ? 'dismissed'
    : (Number(conflict.evidence_count || 0) >= Number(conflict.alert_threshold || STRATEGY_MEMORY_DEFAULT_CONFLICT_ALERT_THRESHOLD) ? 'attention_required' : 'observing')
  const now = beijingNow()
  const actorId = actorUserId(input.actor)
  const result = await queryRun(
    `UPDATE strategy_memory_conflicts
        SET status = ?, resolution_note = ?, resolved_by_user_id = ?, resolved_at = ?, updated_at = ?
      WHERE id = ?`,
    [status, input.note || input.resolution_note || null, action === 'reopen' ? null : actorId,
      action === 'reopen' ? null : now, now, conflict.id]
  )
  if (!affected(result)) throw new Error('strategy_memory_conflict_not_found')
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
    })
    await run(`UPDATE strategy_memory_libraries SET compression_status = 'queued', updated_at = ? WHERE strategy_id = ?`, [beijingNow(), strategy.id])
    result = { ...job, strategy_id:Number(strategy.id), trigger, source_version_no:sourceVersionNo, source_content_hash:sourceContentHash, status:'queued' }
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
    const where = jobId != null
      ? `id = ? AND attempt_count < max_attempts AND COALESCE(last_error_code, '') <> 'provider_status_unknown'
          AND (next_attempt_at IS NULL OR next_attempt_at <= ?)`
      : `attempt_count < max_attempts AND COALESCE(last_error_code, '') <> 'provider_status_unknown'
          AND (next_attempt_at IS NULL OR next_attempt_at <= ?)
          AND (model_task_id IS NULL OR NOT EXISTS (
            SELECT 1 FROM ai_model_tasks tasks WHERE tasks.task_id = strategy_memory_compression_jobs.model_task_id
              AND tasks.status IN ('leased','preparing','submitted','provider_running','provider_quiet',
                'status_unknown','reconciling','response_received','validating','repairing','result_ready','applying')
          ))
          AND (status = 'queued' OR status = 'failed' OR (status = 'leased' AND lease_expires_at < ?))`
    const params = jobId != null
      ? [positiveId(jobId, 'strategy_memory_compression_job_not_found'), now]
      : [now, now]
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
    const resultValidation = JSON.stringify({ source_version_no:Number(library.version_no),
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
