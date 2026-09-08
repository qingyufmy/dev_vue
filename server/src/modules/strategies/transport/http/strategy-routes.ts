import type { FastifyPluginAsync } from 'fastify'
import type { StrategyService } from '../../application/strategy-service.js'
import { StrategyAccessError } from '../../domain/strategy.js'
import type { StrategyCompileResult, StrategyDetail, StrategySubscription, StrategyVersionDetail } from '../../domain/strategy.js'

export interface StrategyRequestAuthenticator {
  authenticate(request: { headers: Record<string, unknown> }): Promise<{ userId: number }>
  assertWrite(request: { headers: Record<string, unknown> }): Promise<{ userId: number }>
}

export interface StrategyRoutesOptions {
  service: StrategyService
  auth: StrategyRequestAuthenticator
}

const response = (requestId: string, data: unknown) => ({ data, meta: { request_id: requestId, generated_at: new Date().toISOString() } })

export const strategyRoutes: FastifyPluginAsync<StrategyRoutesOptions> = async (fastify, options) => {
  fastify.post<{ Body: Record<string, unknown> }>('/strategies/compile', async (request, reply) => {
    try {
      const { userId } = await writeUser(options, request)
      const body = objectBody(request.body)
      assertKeys(body, ['kind', 'prompt_text', 'config'])
      const kind = strategyKind(body.kind)
      return response(request.id, compileDto(options.service.compile(kind, body.prompt_text, body.config)))
    } catch (error) { return problem(error, request, reply) }
  })

  fastify.post<{ Body: Record<string, unknown> }>('/strategies', async (request, reply) => {
    try {
      const { userId } = await writeUser(options, request)
      const body = objectBody(request.body)
      assertKeys(body, ['kind', 'name', 'description', 'prompt_text', 'config'])
      const detail = await options.service.create(userId, {
        kind: strategyKind(body.kind), name: text(body.name, 'name', 1, 191),
        description: text(body.description, 'description', 0, 2000), promptText: text(body.prompt_text, 'prompt_text', 1, 100_000),
        config: objectBody(body.config),
      })
      return reply.code(201).header('ETag', etag(detail.summary.revision)).send(response(request.id, detailDto(detail)))
    } catch (error) { return problem(error, request, reply) }
  })

  fastify.get<{ Params: { strategy_id: string } }>('/strategies/:strategy_id', async (request, reply) => {
    try {
      const { userId } = await options.auth.authenticate(request)
      const detail = await options.service.detail(userId, opaque(request.params.strategy_id, 'strategy_id'))
      if (!detail) throw new StrategyAccessError('strategy_not_found', 404)
      return reply.header('ETag', etag(detail.summary.revision)).send(response(request.id, detailDto(detail)))
    } catch (error) { return problem(error, request, reply) }
  })

  fastify.patch<{ Params: { strategy_id: string }; Body: Record<string, unknown> }>('/strategies/:strategy_id', async (request, reply) => {
    try {
      const { userId } = await writeUser(options, request)
      const body = objectBody(request.body)
      assertKeys(body, ['name', 'description'])
      const detail = await options.service.updateMetadata({
        userId, strategyId: opaque(request.params.strategy_id, 'strategy_id'), expectedRevision: ifMatch(request.headers['if-match']),
        name: text(body.name, 'name', 1, 191), description: text(body.description, 'description', 0, 2000),
      })
      return reply.header('ETag', etag(detail.summary.revision)).send(response(request.id, detailDto(detail)))
    } catch (error) { return problem(error, request, reply) }
  })

  fastify.post<{ Params: { strategy_id: string }; Body: Record<string, unknown> }>('/strategies/:strategy_id/versions', async (request, reply) => {
    try {
      const { userId } = await writeUser(options, request)
      const body = objectBody(request.body)
      assertKeys(body, ['prompt_text', 'config'])
      const detail = await options.service.createVersion({
        userId, strategyId: opaque(request.params.strategy_id, 'strategy_id'), expectedRevision: ifMatch(request.headers['if-match']),
        promptText: text(body.prompt_text, 'prompt_text', 1, 100_000), config: objectBody(body.config),
      })
      return reply.code(201).header('ETag', etag(detail.summary.revision)).send(response(request.id, detailDto(detail)))
    } catch (error) { return problem(error, request, reply) }
  })

  fastify.post<{ Params: { strategy_id: string; version_id: string } }>('/strategies/:strategy_id/versions/:version_id/publish', async (request, reply) => {
    try {
      const { userId } = await writeUser(options, request)
      const detail = await options.service.publishVersion({
        userId, strategyId: opaque(request.params.strategy_id, 'strategy_id'), versionId: opaque(request.params.version_id, 'version_id'),
        expectedRevision: ifMatch(request.headers['if-match']),
      })
      return reply.header('ETag', etag(detail.summary.revision)).send(response(request.id, detailDto(detail)))
    } catch (error) { return problem(error, request, reply) }
  })

  fastify.post<{ Params: { strategy_id: string } }>('/strategies/:strategy_id/retire', async (request, reply) => {
    try {
      const { userId } = await writeUser(options, request)
      const detail = await options.service.retire({ userId, strategyId: opaque(request.params.strategy_id, 'strategy_id'), expectedRevision: ifMatch(request.headers['if-match']) })
      return reply.header('ETag', etag(detail.summary.revision)).send(response(request.id, detailDto(detail)))
    } catch (error) { return problem(error, request, reply) }
  })

  fastify.get<{ Querystring: { account_id?: string } }>('/strategy-subscriptions', async (request, reply) => {
    try {
      const { userId } = await options.auth.authenticate(request)
      const accountId = request.query.account_id === undefined ? undefined : opaque(request.query.account_id, 'account_id')
      return response(request.id, { items: (await options.service.listSubscriptions(userId, accountId)).map(subscriptionDto) })
    } catch (error) { return problem(error, request, reply) }
  })

  fastify.post<{ Body: Record<string, unknown> }>('/strategy-subscriptions', async (request, reply) => {
    try {
      const { userId } = await writeUser(options, request)
      const body = objectBody(request.body)
      assertKeys(body, ['trading_account_id', 'symbol', 'analysis_strategy_id', 'trader_strategy_id', 'analysis_enabled', 'trader_enabled', 'trade_send_enabled', 'status'])
      const subscription = await options.service.createSubscription(userId, {
        tradingAccountId: opaque(body.trading_account_id, 'trading_account_id'), standardSymbol: symbol(body.symbol),
        analysisStrategyId: opaque(body.analysis_strategy_id, 'analysis_strategy_id'), traderStrategyId: body.trader_strategy_id === null || body.trader_strategy_id === undefined ? null : opaque(body.trader_strategy_id, 'trader_strategy_id'),
        analysisEnabled: bool(body.analysis_enabled, true, 'analysis_enabled'), traderEnabled: bool(body.trader_enabled, false, 'trader_enabled'),
        tradeSendEnabled: bool(body.trade_send_enabled, false, 'trade_send_enabled'), status: subscriptionCreateStatus(body.status ?? 'active'),
      })
      return reply.code(201).header('ETag', etag(subscription.revision)).send(response(request.id, subscriptionDto(subscription)))
    } catch (error) { return problem(error, request, reply) }
  })

  fastify.patch<{ Params: { subscription_id: string }; Body: Record<string, unknown> }>('/strategy-subscriptions/:subscription_id', async (request, reply) => {
    try {
      const { userId } = await writeUser(options, request)
      const body = objectBody(request.body)
      assertKeys(body, ['symbol', 'analysis_strategy_id', 'trader_strategy_id', 'analysis_enabled', 'trader_enabled', 'trade_send_enabled', 'status'])
      if (Object.keys(body).length === 0) throw new StrategyAccessError('strategy_subscription_patch_empty', 422)
      const subscription = await options.service.updateSubscription({
        userId, subscriptionId: opaque(request.params.subscription_id, 'subscription_id'), expectedRevision: ifMatch(request.headers['if-match']),
        ...(body.symbol === undefined ? {} : { standardSymbol: symbol(body.symbol) }),
        ...(body.analysis_strategy_id === undefined ? {} : { analysisStrategyId: opaque(body.analysis_strategy_id, 'analysis_strategy_id') }),
        ...(body.trader_strategy_id === undefined ? {} : { traderStrategyId: body.trader_strategy_id === null ? null : opaque(body.trader_strategy_id, 'trader_strategy_id') }),
        ...(body.analysis_enabled === undefined ? {} : { analysisEnabled: bool(body.analysis_enabled, false, 'analysis_enabled') }),
        ...(body.trader_enabled === undefined ? {} : { traderEnabled: bool(body.trader_enabled, false, 'trader_enabled') }),
        ...(body.trade_send_enabled === undefined ? {} : { tradeSendEnabled: bool(body.trade_send_enabled, false, 'trade_send_enabled') }),
        ...(body.status === undefined ? {} : { status: subscriptionStatus(body.status) }),
      })
      return reply.header('ETag', etag(subscription.revision)).send(response(request.id, subscriptionDto(subscription)))
    } catch (error) { return problem(error, request, reply) }
  })
}

async function writeUser(options: StrategyRoutesOptions, request: { headers: Record<string, unknown> }) {
  return options.auth.assertWrite(request)
}

function objectBody(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new StrategyAccessError('request_body_invalid', 400)
  return value as Record<string, unknown>
}

function assertKeys(body: Record<string, unknown>, allowed: string[]) {
  const allowedSet = new Set(allowed)
  const unknown = Object.keys(body).find(key => !allowedSet.has(key))
  if (unknown) throw new StrategyAccessError('request_field_unknown', 422, [{ level: 'error', code: 'field_unknown', message: `不支持的字段：${unknown}`, path: unknown }])
}

function text(value: unknown, field: string, min: number, max: number) {
  if (typeof value !== 'string') throw new StrategyAccessError('request_field_invalid', 422, [{ level: 'error', code: 'string_required', message: `${field} 必须是文本`, path: field }])
  const normalized = value.trim()
  if (normalized.length < min || normalized.length > max) throw new StrategyAccessError('request_field_invalid', 422, [{ level: 'error', code: 'length_invalid', message: `${field} 长度不符合要求`, path: field }])
  return normalized
}

function bool(value: unknown, fallback: boolean, field: string) {
  if (value === undefined) return fallback
  if (typeof value !== 'boolean') throw new StrategyAccessError('request_field_invalid', 422, [{ level: 'error', code: 'boolean_required', message: `${field} 必须是布尔值`, path: field }])
  return value
}

function strategyKind(value: unknown) {
  if (value !== 'analysis' && value !== 'trader') throw new StrategyAccessError('strategy_kind_invalid', 422)
  return value
}

function subscriptionStatus(value: unknown) {
  if (value !== 'active' && value !== 'paused' && value !== 'ended') throw new StrategyAccessError('subscription_status_invalid', 422)
  return value
}

function subscriptionCreateStatus(value: unknown) {
  if (value !== 'active' && value !== 'paused') throw new StrategyAccessError('subscription_status_invalid', 422)
  return value
}

function opaque(value: unknown, field: string) {
  const normalized = typeof value === 'string' ? value.trim() : ''
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,190}$/.test(normalized)) throw new StrategyAccessError('request_field_invalid', 422, [{ level: 'error', code: 'opaque_id_invalid', message: `${field} 格式无效`, path: field }])
  return normalized
}

function symbol(value: unknown) {
  const normalized = typeof value === 'string' ? value.trim().toUpperCase() : ''
  if (!/^[A-Z0-9._-]{1,64}$/.test(normalized)) throw new StrategyAccessError('request_field_invalid', 422, [{ level: 'error', code: 'symbol_invalid', message: '品种格式无效', path: 'symbol' }])
  return normalized
}

function ifMatch(value: unknown) {
  const normalized = String(value ?? '').trim().replace(/^W\//, '').replace(/^"|"$/g, '')
  if (!/^\d+$/.test(normalized)) throw new StrategyAccessError('if_match_required', 428)
  return Number(normalized)
}

function etag(revision: number) { return `"${revision}"` }

function detailDto(value: StrategyDetail) {
  return { ...summaryDto(value.summary), versions: value.versions.map(versionDto) }
}

function summaryDto(value: StrategyDetail['summary']) {
  return { id: value.id, kind: value.kind, scope: value.scope, owner_user_id: value.ownerUserId === null ? null : String(value.ownerUserId), name: value.name, description: value.description, status: value.status, active_version_id: value.activeVersionId, revision: String(value.revision) }
}

function versionDto(value: StrategyVersionDetail) {
  return { id: value.id, strategy_id: value.strategyId, kind: value.kind, version: value.version, prompt_text: value.promptText, prompt_hash: value.promptHash, config: value.config, input_contract_version: value.inputContractVersion, output_contract_version: value.outputContractVersion, created_by_user_id: String(value.createdByUserId), created_at: value.createdAt }
}

function compileDto(value: StrategyCompileResult) {
  return { valid: value.valid, kind: value.kind, prompt_hash: value.promptHash, normalized_config: value.normalizedConfig, input_contract_version: value.inputContractVersion, output_contract_version: value.outputContractVersion, issues: value.issues.map(item => ({ level: item.level, code: item.code, message: item.message, path: item.path })) }
}

function subscriptionDto(value: StrategySubscription) {
  return {
    id: value.id, user_id: String(value.userId), trading_account_id: value.tradingAccountId, symbol: value.standardSymbol,
    analysis_strategy_id: value.analysisStrategyId, analysis_strategy_version_id: value.analysisStrategyVersionId,
    trader_strategy_id: value.traderStrategyId, trader_strategy_version_id: value.traderStrategyVersionId,
    analysis_enabled: value.analysisEnabled, trader_enabled: value.traderEnabled, trade_send_enabled: value.tradeSendEnabled,
    status: value.status, revision: String(value.revision), created_at: value.createdAt, updated_at: value.updatedAt,
    schedule: { cadence_seconds: value.schedule.cadenceSeconds, receive_timezone: value.schedule.receiveTimezone, receive_window: value.schedule.receiveWindow, next_due_at: value.schedule.nextDueAt, revision: String(value.schedule.revision) },
  }
}

function problem(error: unknown, request: { id: string; url: string }, reply: { code(status: number): { send(body: unknown): unknown } }) {
  const known = error instanceof StrategyAccessError ? error : new StrategyAccessError('strategy_unavailable', 503)
  return reply.code(known.status).send({
    type: `urn:aurum:problem:${known.code}`, title: 'Strategy request failed', status: known.status,
    code: known.code, detail: known.code, instance: request.url, correlation_id: request.id,
    retryable: known.status >= 500, ...(known.errors.length ? { errors: known.errors.map(item => ({ field: item.path ?? '', code: item.code, message: item.message })) } : {}),
  })
}
