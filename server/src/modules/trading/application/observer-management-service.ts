import { createHash } from 'node:crypto'
import {
  ObserverManagementError,
  type ObserverChannelConfig,
  type ObserverManagementCommand,
  type ObserverManagementList,
  type ObserverManagementPage,
  type ObserverManagementRepository,
  type ObserverManagementResult,
  type ObserverSourceConfig,
} from './observer-management-ports.js'

const sourceStatuses = new Set<ObserverSourceConfig['status']>(['active', 'disabled'])
const audiences = new Set<ObserverChannelConfig['audience']>(['all', 'plus', 'pro', 'assigned'])
const listKinds = new Set<ObserverManagementList['kind']>(['sources', 'channels', 'accesses', 'operations'])
const sourceConfigKeys = ['analysisStrategyId', 'displayName', 'notes', 'status', 'tradingAccountId']
const channelConfigKeys = ['active', 'audience', 'description', 'displayName', 'slug', 'sortOrder', 'sourceId']

const ID_PATTERN = /^[1-9][0-9]{0,19}$/
const OPERATION_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const KEY_PATTERN = /^[A-Za-z0-9._:-]{8,128}$/
const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/

/**
 * Application boundary for the low-frequency observer registry.  The
 * repository owns the short transaction, locking order, audit receipt and
 * outbox write.  This service only authenticates the actor and freezes a
 * strict, canonical command before it crosses that boundary.
 */
export class ObserverManagementService {
  constructor(private readonly repository: ObserverManagementRepository) {}

  async list(actorUserId: number, role: string, input: ObserverManagementList): Promise<ObserverManagementPage> {
    assertAdministrator(actorUserId, role)
    const normalized = normalizeList(input)
    return this.repository.list(actorUserId, normalized)
  }

  async write(
    actorUserId: number,
    role: string,
    idempotencyKey: string,
    command: ObserverManagementCommand,
  ): Promise<ObserverManagementResult> {
    assertAdministrator(actorUserId, role)
    const key = normalizeIdempotencyKey(idempotencyKey)
    const normalized = normalizeCommand(command)
    const requestHash = createHash('sha256').update(canonicalJson(normalized), 'utf8').digest('hex')
    return this.repository.execute({ actorUserId, idempotencyKey: key, requestHash, command: normalized })
  }
}

function assertAdministrator(actorUserId: number, role: string) {
  if (role !== 'admin') throw new ObserverManagementError('observer_admin_required', 403)
  if (!Number.isSafeInteger(actorUserId) || actorUserId < 1 || actorUserId > 2_147_483_647) {
    throw new ObserverManagementError('observer_actor_invalid', 422)
  }
}

function normalizeIdempotencyKey(value: unknown) {
  if (typeof value !== 'string' || !KEY_PATTERN.test(value)) {
    throw new ObserverManagementError('observer_idempotency_key_invalid', 400)
  }
  return value
}

function normalizeList(value: ObserverManagementList): ObserverManagementList {
  if (!plainObject(value)) throw new ObserverManagementError('observer_list_invalid', 400)
  const keys = Object.keys(value)
  if (!keys.includes('kind') || !keys.includes('afterId') || !keys.includes('limit')) {
    throw new ObserverManagementError('observer_list_invalid', 400)
  }
  const kind = value.kind
  if (typeof kind !== 'string' || !listKinds.has(kind as ObserverManagementList['kind'])) {
    throw new ObserverManagementError('observer_list_kind_invalid', 400)
  }
  const allowed = kind === 'accesses' ? new Set(['kind', 'afterId', 'limit', 'channelId']) : new Set(['kind', 'afterId', 'limit'])
  if (keys.some((key) => !allowed.has(key))) throw new ObserverManagementError('observer_unknown_field', 400)
  const limit = value.limit
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
    throw new ObserverManagementError('observer_list_limit_invalid', 400)
  }
  const afterId = normalizeCursor(kind, value.afterId)
  if (kind === 'accesses') {
    if (typeof value.channelId !== 'string' || !boundedUnsignedId(value.channelId)) {
      throw new ObserverManagementError('observer_channel_id_invalid', 400)
    }
    return { kind, afterId, limit, channelId: value.channelId }
  }
  return { kind, afterId, limit }
}

function normalizeCursor(kind: ObserverManagementList['kind'], value: unknown) {
  if (value !== null && typeof value !== 'string') throw new ObserverManagementError('observer_cursor_invalid', 400)
  if (value === null) return null
  const valid = kind === 'operations' ? OPERATION_ID_PATTERN.test(value) : boundedUnsignedId(value)
  if (!valid) throw new ObserverManagementError('observer_cursor_invalid', 400)
  return value
}

function normalizeCommand(value: ObserverManagementCommand): ObserverManagementCommand {
  if (!plainObject(value) || typeof value.kind !== 'string') {
    throw new ObserverManagementError('observer_command_invalid', 400)
  }
  switch (value.kind) {
    case 'source.create':
      exactKeys(value, ['config', 'kind'])
      return { kind: value.kind, config: normalizeSourceCreateConfig(value.config) }
    case 'source.update':
      exactKeys(value, ['config', 'expectedRevision', 'id', 'kind'])
      return {
        kind: value.kind,
        id: normalizeId(value.id, 'observer_source_id_invalid'),
        expectedRevision: normalizeRevision(value.expectedRevision, false),
        config: normalizeSourceConfig(value.config),
      }
    case 'channel.create':
      exactKeys(value, ['config', 'kind'])
      return { kind: value.kind, config: normalizeChannelCreateConfig(value.config) }
    case 'channel.update':
      exactKeys(value, ['config', 'expectedRevision', 'id', 'kind'])
      return {
        kind: value.kind,
        id: normalizeId(value.id, 'observer_channel_id_invalid'),
        expectedRevision: normalizeRevision(value.expectedRevision, false),
        config: normalizeChannelConfig(value.config),
      }
    case 'channel.default':
      exactKeys(value, ['channelId', 'expectedRevision', 'kind'])
      return {
        kind: value.kind,
        channelId: value.channelId === null ? null : normalizeId(value.channelId, 'observer_channel_id_invalid'),
        expectedRevision: normalizeRevision(value.expectedRevision, true),
      }
    case 'access.set':
      exactKeys(value, ['channelId', 'expectedRevision', 'granted', 'kind', 'userId'])
      if (typeof value.granted !== 'boolean') throw new ObserverManagementError('observer_granted_invalid', 400)
      return {
        kind: value.kind,
        channelId: normalizeId(value.channelId, 'observer_channel_id_invalid'),
        userId: normalizeUserId(value.userId),
        granted: value.granted,
        expectedRevision: normalizeRevision(value.expectedRevision, true),
      }
    default:
      throw new ObserverManagementError('observer_command_kind_invalid', 400)
  }
}

function normalizeSourceConfig(value: unknown): ObserverSourceConfig {
  if (!plainObject(value)) throw new ObserverManagementError('observer_source_config_invalid', 400)
  exactKeys(value, sourceConfigKeys)
  return {
    displayName: normalizeText(value.displayName, 80, 'observer_source_display_name_invalid'),
    notes: normalizeNullableText(value.notes, 255, 'observer_source_notes_invalid'),
    tradingAccountId: normalizeNullableId(value.tradingAccountId, 'observer_trading_account_id_invalid'),
    analysisStrategyId: normalizeNullableId(value.analysisStrategyId, 'observer_strategy_id_invalid'),
    status: normalizeEnum(value.status, sourceStatuses, 'observer_source_status_invalid'),
  }
}

function normalizeSourceCreateConfig(value: unknown): ObserverSourceConfig {
  const config = normalizeSourceConfig(value)
  if (config.status !== 'disabled') {
    throw new ObserverManagementError('observer_source_create_must_start_disabled', 422)
  }
  return config
}

function normalizeChannelConfig(value: unknown): ObserverChannelConfig {
  if (!plainObject(value)) throw new ObserverManagementError('observer_channel_config_invalid', 400)
  exactKeys(value, channelConfigKeys)
  if (typeof value.active !== 'boolean') throw new ObserverManagementError('observer_channel_active_invalid', 400)
  const sortOrder = value.sortOrder
  if (typeof sortOrder !== 'number' || !Number.isSafeInteger(sortOrder) || sortOrder < 0 || sortOrder > 1_000_000) {
    throw new ObserverManagementError('observer_channel_sort_order_invalid', 400)
  }
  if (typeof value.slug !== 'string' || value.slug.length < 1 || value.slug.length > 64 || !SLUG_PATTERN.test(value.slug)) {
    throw new ObserverManagementError('observer_channel_slug_invalid', 400)
  }
  return {
    displayName: normalizeText(value.displayName, 80, 'observer_channel_display_name_invalid'),
    sourceId: normalizeNullableId(value.sourceId, 'observer_source_id_invalid'),
    slug: value.slug,
    description: normalizeNullableText(value.description, 255, 'observer_channel_description_invalid'),
    audience: normalizeEnum(value.audience, audiences, 'observer_channel_audience_invalid'),
    active: value.active,
    sortOrder,
  }
}

function normalizeChannelCreateConfig(value: unknown): ObserverChannelConfig {
  const config = normalizeChannelConfig(value)
  if (config.active) throw new ObserverManagementError('observer_channel_create_must_start_inactive', 422)
  return config
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[]) {
  const actual = Object.keys(value).sort()
  const required = [...expected].sort()
  if (actual.length !== required.length || actual.some((key, index) => key !== required[index])) {
    throw new ObserverManagementError('observer_unknown_field', 400)
  }
}

function normalizeText(value: unknown, maxLength: number, code: string) {
  if (typeof value !== 'string' || value.trim().length < 1 || value.length > maxLength || hasControlCharacter(value)) {
    throw new ObserverManagementError(code, 400)
  }
  return value
}

function normalizeNullableText(value: unknown, maxLength: number, code: string) {
  if (value === null) return null
  if (typeof value !== 'string' || value.length > maxLength || hasControlCharacter(value)) {
    throw new ObserverManagementError(code, 400)
  }
  return value
}

function hasControlCharacter(value: string) {
  return [...value].some((character) => character !== '\t' && character !== '\n' && character !== '\r' && character < ' ')
}

function normalizeNullableId(value: unknown, code: string) {
  if (value === null) return null
  return normalizeId(value, code)
}

function normalizeId(value: unknown, code: string) {
  if (typeof value !== 'string' || !boundedUnsignedId(value)) throw new ObserverManagementError(code, 400)
  return value
}

function normalizeUserId(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1 || value > 2_147_483_647 || !/^[1-9][0-9]*$/.test(String(value))) {
    throw new ObserverManagementError('observer_user_id_invalid', 400)
  }
  return value
}

function normalizeRevision(value: unknown, allowZero: boolean) {
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value) || value < (allowZero ? 0 : 1)) {
      throw new ObserverManagementError('observer_revision_invalid', 400)
    }
    return value
  }
  if (typeof value !== 'string' || !/^(?:0|[1-9][0-9]{0,15})$/.test(value)) {
    throw new ObserverManagementError('observer_revision_invalid', 400)
  }
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed < (allowZero ? 0 : 1)) {
    throw new ObserverManagementError('observer_revision_invalid', 400)
  }
  return parsed
}

function normalizeEnum<T extends string>(value: unknown, values: ReadonlySet<T>, code: string): T {
  if (typeof value !== 'string' || !values.has(value as T)) throw new ObserverManagementError(code, 400)
  return value as T
}

function plainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

function boundedUnsignedId(value: string) {
  if (!ID_PATTERN.test(value)) return false
  return value.length < 20 || value <= '18446744073709551615'
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  if (plainObject(value)) {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`
  }
  const serialized = JSON.stringify(value)
  if (serialized === undefined) throw new ObserverManagementError('observer_command_invalid', 400)
  return serialized
}
