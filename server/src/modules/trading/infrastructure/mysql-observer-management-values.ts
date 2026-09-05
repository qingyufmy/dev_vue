import type { ResultSetHeader, RowDataPacket } from 'mysql2/promise'
import {
  ObserverManagementError,
  type ObserverChannelConfig,
  type ObserverManagementCommand,
  type ObserverManagementList,
  type ObserverManagementResult,
  type ObserverManagementWrite,
  type ObserverSourceConfig,
} from '../application/observer-management-ports.js'

const MANAGEMENT_COMMANDS = new Set<ObserverManagementCommand['kind']>([
  'source.create', 'source.update', 'channel.create', 'channel.update', 'channel.default', 'access.set',
])
const LIST_KINDS = new Set<ObserverManagementList['kind']>(['sources', 'channels', 'accesses', 'operations'])
const ID_PATTERN = /^[1-9][0-9]{0,19}$/
const OPERATION_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const ASCII_TEXT_PATTERN = /^[A-Za-z0-9._:-]{8,128}$/
const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/

export function normalizeList(input: ObserverManagementList): ObserverManagementList {
  if (!input || typeof input !== 'object' || !LIST_KINDS.has(input.kind)) {
    throw managementError('observer_management_list_kind_invalid', 400)
  }
  if (!Number.isSafeInteger(input.limit) || input.limit < 1 || input.limit > 100) {
    throw managementError('observer_management_list_limit_invalid', 400)
  }
  const afterId = input.afterId
  if (afterId !== null && afterId !== undefined && typeof afterId !== 'string') {
    throw managementError('observer_management_cursor_invalid', 400)
  }
  if (afterId !== null && afterId !== undefined && afterId.length === 0) {
    throw managementError('observer_management_cursor_invalid', 400)
  }
  if (afterId !== null && afterId !== undefined) {
    const valid = input.kind === 'operations' ? OPERATION_ID_PATTERN.test(afterId) : isPositiveId(afterId)
    if (!valid) throw managementError('observer_management_cursor_invalid', 400)
  }
  if (input.kind === 'accesses') {
    if (typeof input.channelId !== 'string') throw managementError('observer_management_access_channel_required', 400)
    validateId(input.channelId, 'observer_channel_id_invalid')
  }
  return { ...input, afterId: afterId ?? null }
}

export function validateWrite(input: ObserverManagementWrite) {
  if (!input || typeof input !== 'object') throw managementError('observer_management_request_invalid', 400)
  validateUserId(input.actorUserId, 'observer_management_actor_invalid')
  if (typeof input.idempotencyKey !== 'string' || !ASCII_TEXT_PATTERN.test(input.idempotencyKey)) {
    throw managementError('observer_management_idempotency_key_invalid', 400)
  }
  if (typeof input.requestHash !== 'string' || !/^[a-f0-9]{64}$/i.test(input.requestHash)) {
    throw managementError('observer_management_request_hash_invalid', 400)
  }
  if (!input.command || typeof input.command !== 'object' || !MANAGEMENT_COMMANDS.has(input.command.kind)) {
    throw managementError('observer_management_command_invalid', 400)
  }
}

export function validateSourceConfig(config: ObserverSourceConfig) {
  if (!config || typeof config.displayName !== 'string' || config.displayName.trim().length < 1 || config.displayName.length > 80
    || (config.notes !== null && (typeof config.notes !== 'string' || config.notes.length > 255))
    || (config.tradingAccountId !== null && !isPositiveId(config.tradingAccountId))
    || (config.analysisStrategyId !== null && !isPositiveId(config.analysisStrategyId))
    || !['active', 'disabled'].includes(config.status)) throw managementError('observer_source_config_invalid', 400)
  if (hasControlCharacter(config.displayName) || (config.notes !== null && hasControlCharacter(config.notes))) {
    throw managementError('observer_source_config_invalid', 400)
  }
}

export function validateChannelConfig(config: ObserverChannelConfig) {
  if (!config || typeof config.displayName !== 'string' || config.displayName.trim().length < 1 || config.displayName.length > 80
    || typeof config.slug !== 'string' || config.slug.length > 64 || !SLUG_PATTERN.test(config.slug)
    || (config.description !== null && (typeof config.description !== 'string' || config.description.length > 255))
    || (config.sourceId !== null && !isPositiveId(config.sourceId)) || typeof config.active !== 'boolean'
    || !['all', 'plus', 'pro', 'assigned'].includes(config.audience)
    || !Number.isSafeInteger(config.sortOrder) || config.sortOrder < 0 || config.sortOrder > 1_000_000) {
    throw managementError('observer_channel_config_invalid', 400)
  }
  if (hasControlCharacter(config.displayName) || (config.description !== null && hasControlCharacter(config.description))) {
    throw managementError('observer_channel_config_invalid', 400)
  }
}

export function validateActor(userId: number) { validateUserId(userId, 'observer_management_actor_invalid') }

export function validateUserId(userId: number, code: string) {
  if (!Number.isSafeInteger(userId) || userId < 1 || userId > 2_147_483_647) throw managementError(code, 400)
}

export function validateExpectedRevision(revision: number, allowZero = true) {
  if (!Number.isSafeInteger(revision) || revision < (allowZero ? 0 : 1)) {
    throw managementError('observer_management_revision_invalid', 400)
  }
}

export function validateId(value: string, code: string) { if (!isPositiveId(value)) throw managementError(code, 400) }

export function isPositiveId(value: unknown) {
  return typeof value === 'string' && ID_PATTERN.test(value)
    && (value.length < 20 || value <= '18446744073709551615')
}

export function nullableId(value: string | number | null | undefined) { return value === null || value === undefined ? null : String(value) }

export function cursorStart(kind: ObserverManagementList['kind']) { return kind === 'operations' ? '' : '0' }

export function cursorForRow(input: ObserverManagementList, row: RowDataPacket) {
  if (input.kind === 'accesses') return String((row as { user_id: string | number }).user_id)
  return String((row as { id: string | number }).id)
}

export function toRevision(value: number | string) {
  const revision = Number(value)
  if (!Number.isSafeInteger(revision) || revision < 0) throw managementError('observer_management_storage_unavailable', 503)
  return revision
}

export function toSafeUserId(value: number | string) {
  const userId = Number(value)
  if (!Number.isSafeInteger(userId) || userId < 1 || userId > 2_147_483_647) throw managementError('observer_management_storage_unavailable', 503)
  return userId
}

export function insertedId(result: ResultSetHeader) {
  if (typeof result.insertId === 'number' && !Number.isSafeInteger(result.insertId)) {
    throw managementError('observer_management_storage_unavailable', 503)
  }
  const value = String(result.insertId)
  if (!isPositiveId(value)) throw managementError('observer_management_storage_unavailable', 503)
  return value
}

export function toIso(value: Date | string) {
  if (value instanceof Date) {
    if (!Number.isFinite(value.getTime())) throw managementError('observer_management_storage_unavailable', 503)
    return value.toISOString()
  }
  if (typeof value !== 'string') throw managementError('observer_management_storage_unavailable', 503)
  const raw = value.trim()
  const parsed = new Date(/[zZ]|[+-][0-9]{2}:[0-9]{2}$/.test(raw) ? raw : `${raw.replace(' ', 'T')}Z`)
  if (!Number.isFinite(parsed.getTime())) throw managementError('observer_management_storage_unavailable', 503)
  return parsed.toISOString()
}

export function parseResult(value: string | Record<string, unknown>): ObserverManagementResult {
  let parsed: unknown = value
  if (typeof value === 'string') {
    try { parsed = JSON.parse(value) } catch { throw managementError('observer_management_storage_unavailable', 503) }
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw managementError('observer_management_storage_unavailable', 503)
  const result = parsed as Partial<ObserverManagementResult>
  if (typeof result.operation_id !== 'string' || !OPERATION_ID_PATTERN.test(result.operation_id)
    || typeof result.target_id !== 'string' || result.target_id.length < 1 || result.target_id.length > 191
    || typeof result.revision !== 'number' || !Number.isSafeInteger(result.revision) || result.revision < 0
    || typeof result.registry_revision !== 'number' || !Number.isSafeInteger(result.registry_revision) || result.registry_revision < 0) {
    throw managementError('observer_management_storage_unavailable', 503)
  }
  return { operation_id: result.operation_id, target_id: result.target_id, revision: result.revision, registry_revision: result.registry_revision }
}

export function parseAudit(value: string | Record<string, unknown> | null) {
  if (value === null) return null
  let parsed: unknown = value
  if (typeof value === 'string') {
    try { parsed = JSON.parse(value) } catch { throw managementError('observer_management_storage_unavailable', 503) }
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw managementError('observer_management_storage_unavailable', 503)
  return parsed as Record<string, unknown>
}

export function managementError(code: string, status: 400 | 403 | 404 | 409 | 503) {
  return new ObserverManagementError(code, status)
}

function hasControlCharacter(value: string) {
  return [...value].some((character) => character !== '\t' && character !== '\n' && character !== '\r' && character < ' ')
}
