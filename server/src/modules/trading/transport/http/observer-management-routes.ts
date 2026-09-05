import type { FastifyPluginAsync } from 'fastify'
import { AuthError } from '../../../auth/domain/auth.js'
import {
  ObserverManagementError,
  type ObserverChannelConfig,
  type ObserverManagementCommand,
  type ObserverManagementList,
  type ObserverSourceConfig,
  type ObserverManagementResult,
} from '../../application/observer-management-ports.js'
import type { ObserverManagementService } from '../../application/observer-management-service.js'

export interface ObserverManagementRequestAuthenticator {
  authenticate(request: { headers: Record<string, unknown> }): Promise<{ userId: number; role: string }>
  assertWrite(request: { headers: Record<string, unknown> }): Promise<{ userId: number; role: string }>
}

export interface ObserverManagementRoutesOptions {
  service: ObserverManagementService
  auth: ObserverManagementRequestAuthenticator
}

type Querystring = Record<string, unknown>
type Params = Record<string, unknown>

const response = (requestId: string, data: unknown) => ({
  data,
  meta: { request_id: requestId, generated_at: new Date().toISOString() },
})

/**
 * Administrator-only observer registry endpoints.  This plugin is mounted
 * by the API registrar under `/api/v4/admin/observer` and deliberately does
 * not contain the admin host hook, which belongs to the application entrypoint.
 */
export const observerManagementRoutes: FastifyPluginAsync<ObserverManagementRoutesOptions> = async (fastify, options) => {
  fastify.get<{ Querystring: Querystring }>('/sources', async (request, reply) => {
    try {
      const actor = await options.auth.authenticate(request)
      return response(request.id, pageDto(await options.service.list(actor.userId, actor.role, listInput('sources', request.query)), 'sources'))
    } catch (error) { return problem(error, request, reply) }
  })

  fastify.post<{ Body: unknown }>('/sources', async (request, reply) => {
    try {
      const actor = await options.auth.assertWrite(request)
      const command: ObserverManagementCommand = { kind: 'source.create', config: sourceConfig(request.body, false) }
      const result = await options.service.write(actor.userId, actor.role, idempotencyKey(request), command)
      return reply.code(201).send(response(request.id, resultDto(result)))
    } catch (error) { return problem(error, request, reply) }
  })

  fastify.put<{ Params: Params; Body: unknown }>('/sources/:source_id', async (request, reply) => {
    try {
      const actor = await options.auth.assertWrite(request)
      const body = object(request.body, 'observer_source_body_invalid')
      const command: ObserverManagementCommand = {
        kind: 'source.update',
        id: pathId(bodyValue(request.params, 'source_id'), 'observer_source_id_invalid'),
        expectedRevision: revisionField(body, true),
        config: sourceConfig(body, true),
      }
      const result = await options.service.write(actor.userId, actor.role, idempotencyKey(request), command)
      return response(request.id, resultDto(result))
    } catch (error) { return problem(error, request, reply) }
  })

  fastify.get<{ Querystring: Querystring }>('/channels', async (request, reply) => {
    try {
      const actor = await options.auth.authenticate(request)
      return response(request.id, pageDto(await options.service.list(actor.userId, actor.role, listInput('channels', request.query)), 'channels'))
    } catch (error) { return problem(error, request, reply) }
  })

  fastify.post<{ Body: unknown }>('/channels', async (request, reply) => {
    try {
      const actor = await options.auth.assertWrite(request)
      const command: ObserverManagementCommand = { kind: 'channel.create', config: channelConfig(request.body, false) }
      const result = await options.service.write(actor.userId, actor.role, idempotencyKey(request), command)
      return reply.code(201).send(response(request.id, resultDto(result)))
    } catch (error) { return problem(error, request, reply) }
  })

  fastify.put<{ Params: Params; Body: unknown }>('/channels/:channel_id', async (request, reply) => {
    try {
      const actor = await options.auth.assertWrite(request)
      const body = object(request.body, 'observer_channel_body_invalid')
      const command: ObserverManagementCommand = {
        kind: 'channel.update',
        id: pathId(bodyValue(request.params, 'channel_id'), 'observer_channel_id_invalid'),
        expectedRevision: revisionField(body, true),
        config: channelConfig(body, true),
      }
      const result = await options.service.write(actor.userId, actor.role, idempotencyKey(request), command)
      return response(request.id, resultDto(result))
    } catch (error) { return problem(error, request, reply) }
  })

  fastify.get<{ Params: Params; Querystring: Querystring }>('/channels/:channel_id/accesses', async (request, reply) => {
    try {
      const actor = await options.auth.authenticate(request)
      const channelId = pathId(bodyValue(request.params, 'channel_id'), 'observer_channel_id_invalid')
      return response(request.id, pageDto(await options.service.list(actor.userId, actor.role, listInput('accesses', request.query, channelId)), 'accesses'))
    } catch (error) { return problem(error, request, reply) }
  })

  fastify.put<{ Params: Params; Body: unknown }>('/channels/:channel_id/accesses/:user_id', async (request, reply) => {
    try {
      const actor = await options.auth.assertWrite(request)
      const body = object(request.body, 'observer_access_body_invalid')
      exactBodyKeys(body, ['expected_revision', 'granted'])
      const command: ObserverManagementCommand = {
        kind: 'access.set',
        channelId: pathId(bodyValue(request.params, 'channel_id'), 'observer_channel_id_invalid'),
        userId: userId(bodyValue(request.params, 'user_id')),
        granted: booleanField(body.granted, 'observer_granted_invalid'),
        expectedRevision: revisionField(body, false),
      }
      const result = await options.service.write(actor.userId, actor.role, idempotencyKey(request), command)
      return response(request.id, resultDto(result))
    } catch (error) { return problem(error, request, reply) }
  })

  fastify.put<{ Body: unknown }>('/default-channel', async (request, reply) => {
    try {
      const actor = await options.auth.assertWrite(request)
      const body = object(request.body, 'observer_default_channel_body_invalid')
      exactBodyKeys(body, ['channel_id', 'expected_revision'])
      const channelId = body.channel_id === null ? null : pathId(body.channel_id, 'observer_channel_id_invalid')
      const command: ObserverManagementCommand = {
        kind: 'channel.default',
        channelId,
        expectedRevision: revisionField(body, false),
      }
      const result = await options.service.write(actor.userId, actor.role, idempotencyKey(request), command)
      return response(request.id, resultDto(result))
    } catch (error) { return problem(error, request, reply) }
  })

  fastify.get<{ Querystring: Querystring }>('/operations', async (request, reply) => {
    try {
      const actor = await options.auth.authenticate(request)
      return response(request.id, pageDto(await options.service.list(actor.userId, actor.role, listInput('operations', request.query)), 'operations'))
    } catch (error) { return problem(error, request, reply) }
  })
}

function sourceConfig(value: unknown, update: boolean): ObserverSourceConfig {
  const body = object(value, 'observer_source_body_invalid')
  const allowed = update
    ? ['analysis_strategy_id', 'display_name', 'expected_revision', 'notes', 'status', 'trading_account_id']
    : ['analysis_strategy_id', 'display_name', 'notes', 'status', 'trading_account_id']
  exactBodyKeys(body, allowed, update ? allowed : ['display_name'])
  if (typeof body.display_name !== 'string' || body.display_name.trim().length < 1 || body.display_name.length > 80) {
    throw new ObserverManagementError('observer_source_display_name_invalid', 400)
  }
  return {
    displayName: body.display_name,
    notes: body.notes === undefined ? null : nullableText(body.notes, 'observer_source_notes_invalid', 255),
    tradingAccountId: body.trading_account_id === undefined ? null : nullableId(body.trading_account_id, 'observer_trading_account_id_invalid'),
    analysisStrategyId: body.analysis_strategy_id === undefined ? null : nullableId(body.analysis_strategy_id, 'observer_strategy_id_invalid'),
    status: body.status === undefined ? 'disabled' : enumValue(body.status, ['active', 'disabled'], 'observer_source_status_invalid'),
  }
}

function channelConfig(value: unknown, update: boolean): ObserverChannelConfig {
  const body = object(value, 'observer_channel_body_invalid')
  const allowed = update
    ? ['active', 'audience', 'description', 'display_name', 'expected_revision', 'slug', 'sort_order', 'source_id']
    : ['active', 'audience', 'description', 'display_name', 'slug', 'sort_order', 'source_id']
  exactBodyKeys(body, allowed, update ? allowed : ['display_name', 'slug'])
  if (typeof body.display_name !== 'string' || body.display_name.trim().length < 1 || body.display_name.length > 80) {
    throw new ObserverManagementError('observer_channel_display_name_invalid', 400)
  }
  const slug = text(body.slug, 'observer_channel_slug_invalid', 64)
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug)) throw new ObserverManagementError('observer_channel_slug_invalid', 400)
  const sortOrder = body.sort_order === undefined ? 0 : bodyInteger(body.sort_order, 'observer_channel_sort_order_invalid', 0, 1_000_000)
  return {
    displayName: body.display_name,
    sourceId: body.source_id === undefined ? null : nullableId(body.source_id, 'observer_source_id_invalid'),
    slug,
    description: body.description === undefined ? null : nullableText(body.description, 'observer_channel_description_invalid', 255),
    audience: body.audience === undefined ? 'assigned' : enumValue(body.audience, ['all', 'plus', 'pro', 'assigned'], 'observer_channel_audience_invalid'),
    active: body.active === undefined ? false : booleanField(body.active, 'observer_channel_active_invalid'),
    sortOrder,
  }
}

function listInput(kind: ObserverManagementList['kind'], query: Querystring, channelId?: string): ObserverManagementList {
  exactQueryKeys(query, ['cursor', 'limit'])
  const limit = query.limit === undefined ? 50 : integerValue(query.limit, 'observer_list_limit_invalid', 1, 100)
  const afterId = query.cursor === undefined ? null : cursor(query.cursor, kind)
  if (kind === 'accesses') return { kind, afterId, limit, channelId: channelId! }
  return { kind, afterId, limit }
}

function exactQueryKeys(query: Querystring, allowed: readonly string[]) {
  const actual = Object.keys(query)
  const known = new Set(allowed)
  if (actual.some((key) => !known.has(key))) {
    throw new ObserverManagementError('observer_unknown_query_field', 400)
  }
}

function cursor(value: unknown, kind: ObserverManagementList['kind']) {
  const textValue = text(value, 'observer_cursor_invalid', 64)
  const valid = kind === 'operations'
    ? /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(textValue)
    : isBoundedUnsignedId(textValue)
  if (!valid) throw new ObserverManagementError('observer_cursor_invalid', 400)
  return textValue
}

function idempotencyKey(request: { headers: Record<string, unknown> }) {
  const value = request.headers['idempotency-key']
  if (Array.isArray(value) || typeof value !== 'string') throw new ObserverManagementError('observer_idempotency_key_invalid', 400)
  return value
}

function revisionField(body: Record<string, unknown>, update: boolean) {
  if (!Object.prototype.hasOwnProperty.call(body, 'expected_revision')) {
    throw new ObserverManagementError('observer_revision_required', 400)
  }
  const value = body.expected_revision
  const minimum = update ? 1 : 0
  return integerValue(value, 'observer_revision_invalid', minimum, Number.MAX_SAFE_INTEGER)
}

function pathId(value: unknown, code: string) {
  const textValue = text(value, code, 20)
  if (!isBoundedUnsignedId(textValue)) throw new ObserverManagementError(code, 400)
  return textValue
}

function userId(value: unknown) {
  const textValue = pathId(value, 'observer_user_id_invalid')
  const parsed = Number(textValue)
  if (!Number.isSafeInteger(parsed) || parsed > 2_147_483_647) throw new ObserverManagementError('observer_user_id_invalid', 400)
  return parsed
}

function nullableId(value: unknown, code: string) {
  if (value === null) return null
  return pathId(value, code)
}

function nullableText(value: unknown, code: string, maxLength: number) {
  if (value === null) return null
  if (typeof value !== 'string' || value.length > maxLength || [...value].some((character) => character < ' ' && character !== '\t' && character !== '\n' && character !== '\r')) {
    throw new ObserverManagementError(code, 400)
  }
  return value
}

function text(value: unknown, code: string, maxLength: number) {
  if (typeof value !== 'string' || value.length < 1 || value.length > maxLength || [...value].some((character) => character < ' ' && character !== '\t' && character !== '\n' && character !== '\r')) {
    throw new ObserverManagementError(code, 400)
  }
  return value
}

function integerValue(value: unknown, code: string, minimum: number, maximum: number) {
  const parsed = typeof value === 'number'
    ? value
    : typeof value === 'string' && /^(?:0|[1-9][0-9]{0,15})$/.test(value) ? Number(value) : Number.NaN
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) throw new ObserverManagementError(code, 400)
  return parsed
}

function bodyInteger(value: unknown, code: string, minimum: number, maximum: number) {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new ObserverManagementError(code, 400)
  }
  return value
}

function booleanField(value: unknown, code: string) {
  if (typeof value !== 'boolean') throw new ObserverManagementError(code, 400)
  return value
}

function enumValue<T extends string>(value: unknown, values: readonly T[], code: string): T {
  if (typeof value !== 'string' || !values.includes(value as T)) throw new ObserverManagementError(code, 400)
  return value as T
}

function object(value: unknown, code: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ObserverManagementError(code, 400)
  return value as Record<string, unknown>
}

function bodyValue(value: unknown, key: string) {
  return object(value, 'observer_path_invalid')[key]
}

function exactBodyKeys(body: Record<string, unknown>, allowed: readonly string[], required: readonly string[] = allowed) {
  const actual = Object.keys(body).sort()
  const known = new Set(allowed)
  if (actual.some((key) => !known.has(key)) || required.some((key) => !Object.prototype.hasOwnProperty.call(body, key))) {
    throw new ObserverManagementError('observer_unknown_field', 400)
  }
}

function isBoundedUnsignedId(value: string) {
  if (!/^[1-9][0-9]{0,19}$/.test(value)) return false
  if (value.length < 20) return true
  return value <= '18446744073709551615'
}

function pageDto(page: Awaited<ReturnType<ObserverManagementService['list']>>, kind: ObserverManagementList['kind']) {
  return {
    items: page.items.map(item => managementItemDto(item, kind)),
    next_cursor: page.next_cursor,
    registry_revision: String(page.registry_revision),
  }
}

function managementItemDto(item: Record<string, unknown>, kind: ObserverManagementList['kind']) {
  if (kind === 'sources') {
    return pickFields(item, [
      'id', 'display_name', 'notes', 'operator_user_id', 'trading_account_id',
      'analysis_strategy_id', 'status', 'configuration_status', 'created_by_user_id',
      'created_at_utc', 'updated_at_utc', 'revision',
    ], true)
  }
  if (kind === 'channels') {
    return pickFields(item, [
      'id', 'source_id', 'source_trading_account_id', 'display_name', 'slug', 'description',
      'audience', 'active', 'is_default', 'sort_order', 'created_at_utc', 'updated_at_utc', 'revision',
    ], true)
  }
  if (kind === 'accesses') {
    return pickFields(item, [
      'observer_channel_id', 'user_id', 'granted_at_utc', 'revoked_at_utc',
      'granted_by_user_id', 'revision',
    ], true)
  }
  const result = pickFields(item, [
    'id', 'action', 'actor_user_id', 'target_id', 'result', 'created_at_utc',
  ])
  if (!isResultRecord(item.result)) throw new ObserverManagementError('observer_management_unavailable', 503)
  result.result = resultDto(item.result)
  // The repository keeps the DB column name as audit internally. The HTTP
  // contract exposes the canonical command under its explicit JSON name.
  const audit = Object.prototype.hasOwnProperty.call(item, 'audit_json') ? item.audit_json : item.audit
  if (!plainRecord(audit)) throw new ObserverManagementError('observer_management_unavailable', 503)
  result.audit_json = audit
  return result
}

function pickFields(item: Record<string, unknown>, fields: readonly string[], stringifyRevision = false) {
  const result: Record<string, unknown> = {}
  for (const field of fields) {
    if (!Object.prototype.hasOwnProperty.call(item, field) || item[field] === undefined) continue
    result[field] = item[field]
  }
  if (stringifyRevision && typeof result.revision === 'number') result.revision = String(result.revision)
  return result
}

function resultDto(result: Awaited<ReturnType<ObserverManagementService['write']>>) {
  return {
    operation_id: result.operation_id,
    target_id: result.target_id,
    revision: String(result.revision),
    registry_revision: String(result.registry_revision),
  }
}

function plainRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

function isResultRecord(value: unknown): value is ObserverManagementResult {
  if (!plainRecord(value)) return false
  return typeof value.operation_id === 'string' && typeof value.target_id === 'string'
    && Number.isSafeInteger(value.revision) && Number.isSafeInteger(value.registry_revision)
}

function problem(error: unknown, request: { id: string; url: string }, reply: { code(status: number): { send(body: unknown): unknown } }) {
  const known = error instanceof ObserverManagementError || error instanceof AuthError
    ? error
    : new ObserverManagementError('observer_management_unavailable', 503)
  return reply.code(known.status).send({
    type: `urn:aurum:problem:${known.code}`,
    title: 'Observer management request failed',
    status: known.status,
    code: known.code,
    detail: known.code,
    instance: request.url,
    correlation_id: request.id,
    retryable: known.status >= 500,
  })
}
