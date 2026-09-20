import { randomUUID } from 'node:crypto'
import { AuthError } from '../../../auth/index.js'
import { createHttpContractValidator, HttpContractError } from '../../../../transport/http-contract.js'
import { httpRuntimeContracts } from '../../../../transport/generated/http-contracts.js'
import { assertStrategyKind, type StrategyKind } from '../../domain/strategy.js'
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify'
import type { StrategyService } from '../../application/strategy-service.js'
import { StrategyAccessError } from '../../domain/strategy.js'
import type { StrategyCompileResult, StrategyDetail, StrategySubscription, StrategyVersionDetail } from '../../domain/strategy.js'

export interface StrategyRequestAuthenticator {
  authenticate(request: { headers: Record<string, unknown> }): Promise<{ userId: number }>
  assertWrite(request: { headers: Record<string, unknown> }): Promise<{ userId: number }>
}

import type { PlatformStrategyPublisher } from '../../application/platform-strategy-publisher.js'

export interface StrategyRoutesOptions {
  platformPublisher?: PlatformStrategyPublisher
  service: StrategyService
  auth: StrategyRequestAuthenticator
}

const response = (requestId: string, data: unknown) => ({ data, meta: { request_id: requestId, generated_at: new Date().toISOString() } })

export const strategyRoutes: FastifyPluginAsync<StrategyRoutesOptions> = async (fastify, options) => {
  const contract = createHttpContractValidator(httpRuntimeContracts, ['setAccountTrader', 'listStrategies', 'getStrategy', 'listStrategySubscriptions', 'createStrategy', 'updateStrategyMetadata', 'createStrategyVersion', 'publishStrategyVersion', 'retireStrategy', 'createStrategySubscription', 'updateStrategySubscription', 'compileStrategy'])
  fastify.get<{ Querystring: { kind?: StrategyKind } }>('/strategies', async (request, reply) => {
    reply.header('Cache-Control', 'no-store')
    try {
      const { userId } = await options.auth.authenticate(request)
      if (Object.keys(request.query).some(key => key !== 'kind')) throw new HttpContractError('api_request_invalid', 400)
      contract.request('listStrategies', request)
      if (request.query.kind !== undefined) assertStrategyKind(request.query.kind)
      const items = (await options.service.list(userId, request.query.kind)).map(value => ({ id: value.id, kind: value.kind,
        scope: value.scope, owner_user_id: value.ownerUserId === null ? null : String(value.ownerUserId), name: value.name,
        description: value.description, status: value.status, active_version_id: value.activeVersionId, revision: String(value.revision) }))
      return contract.response('listStrategies', response(request.id, { items }))
    } catch (error) { return listProblem(error, request.id, reply, contract, 'listStrategies') }
  })
  fastify.post<{ Body: Record<string, unknown> }>('/strategies/compile', async (request, reply) => {
    reply.header('Cache-Control', 'no-store')
    try {
      await writeUser(options, request)
      if (Object.keys(request.query as object).length) throw new HttpContractError('api_request_invalid', 400)
      contract.request('compileStrategy', request)
      const body = request.body
      return contract.response('compileStrategy', response(request.id, compileDto(options.service.compile(strategyKind(body.kind), body.prompt_text, body.config))))
    } catch (error) { return problem(error, request, reply, contract, 'compileStrategy') }
  })

  fastify.post<{ Body: Record<string, unknown> }>('/strategies', async (request, reply) => {
    reply.header('Cache-Control', 'no-store')
    let completed = false
    try {
      const { userId } = await writeUser(options, request)
      if (Object.keys(request.query as object).length) throw new HttpContractError('api_request_invalid', 400)
      contract.request('createStrategy', request)
      const body = request.body
      const detail = await options.service.create(userId, {
        idempotencyKey: request.headers['idempotency-key'] as string,
        kind: strategyKind(body.kind), name: body.name as string, description: body.description as string,
        promptText: body.prompt_text as string, config: body.config as Record<string, unknown>,
      })
      completed = true
      return reply.code(201).header('ETag', etag(detail.summary.revision))
        .send(contract.response('createStrategy', response(request.id, detailDto(detail)), 201))
    } catch (error) {
      return problem(completed ? new StrategyAccessError('strategy_commit_unknown', 503) : error, request, reply, contract)
    }
  })

  fastify.get<{ Params: { strategy_id: string } }>('/strategies/:strategy_id', async (request, reply) => {
    reply.header('Cache-Control', 'no-store')
    try {
      const { userId } = await options.auth.authenticate(request)
      if (Object.keys(request.query as object).length) throw new HttpContractError('api_request_invalid', 400)
      contract.request('getStrategy', request)
      const detail = await options.service.detail(userId, opaque(request.params.strategy_id, 'strategy_id'))
      if (!detail) throw new StrategyAccessError('strategy_not_found', 404)
      return reply.header('ETag', etag(detail.summary.revision)).send(contract.response('getStrategy', response(request.id, detailDto(detail))))
    } catch (error) { return listProblem(error, request.id, reply, contract, 'getStrategy') }
  })

  fastify.patch<{ Params: { strategy_id: string }; Body: Record<string, unknown> }>('/strategies/:strategy_id', async (request, reply) => {
    reply.header('Cache-Control', 'no-store')
    let completed = false
    try {
      const { userId } = await writeUser(options, request)
      const expectedRevision = ifMatch(request.headers['if-match'])
      if (Object.keys(request.query as object).length) throw new HttpContractError('api_request_invalid', 400)
      contract.request('updateStrategyMetadata', request)
      const detail = await options.service.updateMetadata({
        userId, idempotencyKey: request.headers['idempotency-key'] as string,
        strategyId: request.params.strategy_id, expectedRevision,
        name: request.body.name as string, description: request.body.description as string,
      })
      completed = true
      return reply.header('ETag', etag(detail.summary.revision))
        .send(contract.response('updateStrategyMetadata', response(request.id, detailDto(detail))))
    } catch (error) {
      return problem(completed ? new StrategyAccessError('strategy_commit_unknown', 503) : error, request, reply, contract, 'updateStrategyMetadata')
    }
  })

  async function versionWrite(request: FastifyRequest, reply: FastifyReply, operation: string,
    write: (userId: number, expectedRevision: number) => Promise<StrategyDetail>, status = 200) {
    reply.header('Cache-Control', 'no-store')
    let completed = false
    try {
      const { userId } = await writeUser(options, request)
      const revision = ifMatch(request.headers['if-match'])
      if (Object.keys(request.query as object).length || (operation !== 'createStrategyVersion' && request.body !== undefined)) {
        throw new HttpContractError('api_request_invalid', 400)
      }
      contract.request(operation, request)
      const detail = await write(userId, revision)
      completed = true
      return reply.code(status).header('ETag', etag(detail.summary.revision))
        .send(contract.response(operation, response(request.id, detailDto(detail)), status))
    } catch (error) {
      return problem(completed ? new StrategyAccessError('strategy_commit_unknown', 503) : error, request, reply, contract, operation)
    }
  }

  const versionWriter = async (userId: number, id: string) => (await options.service.detail(userId, id))?.summary.scope === 'platform' ? options.platformPublisher : undefined

  fastify.post<{ Params: { strategy_id: string }; Body: Record<string, unknown> }>('/strategies/:strategy_id/versions', (request, reply) =>
    versionWrite(request, reply, 'createStrategyVersion', async (userId, expectedRevision) => (await versionWriter(userId, request.params.strategy_id) ?? options.service).createVersion({
      userId, expectedRevision, idempotencyKey: request.headers['idempotency-key'] as string, strategyId: request.params.strategy_id,
      promptText: request.body.prompt_text as string, config: request.body.config as Record<string, unknown>,
      ...(request.body.name === undefined ? {} : { name: request.body.name as string }),
      ...(request.body.description === undefined ? {} : { description: request.body.description as string }),
      ...(request.body.status === undefined ? {} : { status: request.body.status as 'draft' | 'active' }),
    }), 201))

  fastify.post<{ Params: { strategy_id: string; version_id: string } }>('/strategies/:strategy_id/versions/:version_id/publish', (request, reply) =>
    versionWrite(request, reply, 'publishStrategyVersion', async (userId, expectedRevision) => {
      const publisher = await versionWriter(userId, request.params.strategy_id)
      return (publisher ? publisher.publish.bind(publisher) : options.service.publishVersion.bind(options.service))({
      userId, expectedRevision, idempotencyKey: request.headers['idempotency-key'] as string,
      strategyId: request.params.strategy_id, versionId: request.params.version_id,
    }) }))

  fastify.post<{ Params: { strategy_id: string } }>('/strategies/:strategy_id/retire', (request, reply) =>
    versionWrite(request, reply, 'retireStrategy', (userId, expectedRevision) => options.service.retire({
      userId, expectedRevision, idempotencyKey: request.headers['idempotency-key'] as string, strategyId: request.params.strategy_id,
    })))

  fastify.post<{ Body: { account_id: string; enabled: boolean; expected: { id: string; revision: number }[] } }>('/strategy-subscriptions/trader-control', async (request, reply) => {
    reply.header('Cache-Control', 'no-store')
    let completed = false
    try {
      const { userId } = await writeUser(options, request)
      if (Object.keys(request.query as object).length) throw new HttpContractError('api_request_invalid', 400)
      contract.request('setAccountTrader', request)
      const data = await options.service.setAccountTrader({ userId, accountId: request.body.account_id,
        enabled: request.body.enabled, expected: request.body.expected, idempotencyKey: request.headers['idempotency-key'] as string })
      completed = true
      return contract.response('setAccountTrader', response(request.id, data))
    } catch (error) { return problem(completed ? new StrategyAccessError('strategy_commit_unknown', 503) : error, request, reply, contract, 'setAccountTrader') }
  })

  fastify.get<{ Querystring: { account_id?: string } }>('/strategy-subscriptions', async (request, reply) => {
    reply.header('Cache-Control', 'no-store')
    try {
      const { userId } = await options.auth.authenticate(request)
      if (Object.keys(request.query).some(key => key !== 'account_id')) throw new HttpContractError('api_request_invalid', 400)
      contract.request('listStrategySubscriptions', request)
      const accountId = request.query.account_id === undefined ? undefined : opaque(request.query.account_id, 'account_id')
      return contract.response('listStrategySubscriptions', response(request.id, { items: (await options.service.listSubscriptions(userId, accountId)).map(subscriptionDto) }))
    } catch (error) { return listProblem(error, request.id, reply, contract, 'listStrategySubscriptions') }
  })

  fastify.post<{ Body: Record<string, unknown> }>('/strategy-subscriptions', async (request, reply) => {
    reply.header('Cache-Control', 'no-store')
    let completed = false
    try {
      const { userId } = await writeUser(options, request)
      if (Object.keys(request.query as object).length) throw new HttpContractError('api_request_invalid', 400)
      if (request.body?.status === 'ended') throw new StrategyAccessError('subscription_status_invalid', 422)
      contract.request('createStrategySubscription', request)
      const body = request.body
      const subscription = await options.service.createSubscription(userId, {
        idempotencyKey: request.headers['idempotency-key'] as string,
        tradingAccountId: body.trading_account_id as string, standardSymbol: body.symbol as string,
        analysisStrategyId: body.analysis_strategy_id as string,
        ...(body.trader_strategy_id === undefined ? {} : { traderStrategyId: body.trader_strategy_id as string | null }),
        ...(body.receive_window === undefined ? {} : { receiveWindow: body.receive_window as Record<string, unknown> }),
        ...(body.analysis_enabled === undefined ? {} : { analysisEnabled: body.analysis_enabled as boolean }),
        ...(body.trader_enabled === undefined ? {} : { traderEnabled: body.trader_enabled as boolean }),
        ...(body.trade_send_enabled === undefined ? {} : { tradeSendEnabled: body.trade_send_enabled as boolean }),
        ...(body.status === undefined ? {} : { status: body.status as 'active' | 'paused' }),
      })
      completed = true
      return reply.code(201).header('ETag', etag(subscription.revision))
        .send(contract.response('createStrategySubscription', response(request.id, subscriptionDto(subscription)), 201))
    } catch (error) {
      return problem(completed ? new StrategyAccessError('strategy_commit_unknown', 503) : error, request, reply, contract, 'createStrategySubscription')
    }
  })

  fastify.patch<{ Params: { subscription_id: string }; Body: Record<string, unknown> }>('/strategy-subscriptions/:subscription_id', async (request, reply) => {
    reply.header('Cache-Control', 'no-store')
    let completed = false
    try {
      const { userId } = await writeUser(options, request)
      const expectedRevision = ifMatch(request.headers['if-match'])
      if (Object.keys(request.query as object).length) throw new HttpContractError('api_request_invalid', 400)
      contract.request('updateStrategySubscription', request)
      const body = request.body
      if (Object.keys(body).length === 0) throw new StrategyAccessError('strategy_subscription_patch_empty', 422)
      const subscription = await options.service.updateSubscription({
        userId, expectedRevision, idempotencyKey: request.headers['idempotency-key'] as string, subscriptionId: request.params.subscription_id,
        ...(body.symbol === undefined ? {} : { standardSymbol: body.symbol as string }),
        ...(body.analysis_strategy_id === undefined ? {} : { analysisStrategyId: body.analysis_strategy_id as string }),
        ...(body.trader_strategy_id === undefined ? {} : { traderStrategyId: body.trader_strategy_id as string | null }),
        ...(body.receive_window === undefined ? {} : { receiveWindow: body.receive_window as Record<string, unknown> }),
        ...(body.analysis_enabled === undefined ? {} : { analysisEnabled: body.analysis_enabled as boolean }),
        ...(body.trader_enabled === undefined ? {} : { traderEnabled: body.trader_enabled as boolean }),
        ...(body.trade_send_enabled === undefined ? {} : { tradeSendEnabled: body.trade_send_enabled as boolean }),
        ...(body.status === undefined ? {} : { status: body.status as StrategySubscription['status'] }),
      })
      completed = true
      return reply.header('ETag', etag(subscription.revision))
        .send(contract.response('updateStrategySubscription', response(request.id, subscriptionDto(subscription))))
    } catch (error) {
      return problem(completed ? new StrategyAccessError('strategy_commit_unknown', 503) : error, request, reply, contract, 'updateStrategySubscription')
    }
  })
}

async function writeUser(options: StrategyRoutesOptions, request: { headers: Record<string, unknown> }) {
  return options.auth.assertWrite(request)
}

function strategyKind(value: unknown) {
  if (value !== 'analysis' && value !== 'trader') throw new StrategyAccessError('strategy_kind_invalid', 422)
  return value
}

function opaque(value: unknown, field: string) {
  const normalized = typeof value === 'string' ? value.trim() : ''
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,190}$/.test(normalized)) throw new StrategyAccessError('request_field_invalid', 422, [{ level: 'error', code: 'opaque_id_invalid', message: `${field} 格式无效`, path: field }])
  return normalized
}

function ifMatch(value: unknown) {
  const normalized = String(value ?? '').trim().replace(/^W\//, '').replace(/^"|"$/g, '')
  if (!/^\d+$/.test(normalized)) throw new StrategyAccessError('if_match_required', 428)
  return Number(normalized)
}

function etag(revision: number) { return `"${revision}"` }

export function detailDto(value: StrategyDetail) {
  return { ...summaryDto(value.summary), versions: value.versions.map(versionDto) }
}

export function summaryDto(value: StrategyDetail['summary']) {
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

function problem(error: unknown, request: { id: string; url: string }, reply: FastifyReply, contract?: ReturnType<typeof createHttpContractValidator>, operation = 'createStrategy') {
  const known = error instanceof StrategyAccessError || error instanceof AuthError || error instanceof HttpContractError ? error : new StrategyAccessError('strategy_unavailable', 503)
  const body = {
    type: `urn:aurum:problem:${known.code}`, title: 'Strategy request failed', status: known.status,
    code: known.code, detail: known.code, instance: request.url, correlation_id: request.id,
    retryable: known.status >= 500 && known.code !== 'strategy_commit_unknown', ...(known instanceof StrategyAccessError && known.errors.length ? { errors: known.errors.map(item => ({ field: item.path ?? '', code: item.code, message: item.message })) } : {}),
  }
  return reply.header('Cache-Control', 'no-store').type('application/problem+json').code(known.status)
    .send(contract ? contract.response(operation, body, known.status, 'application/problem+json') : body)
}

function listProblem(error: unknown, id: string, reply: FastifyReply, contract: ReturnType<typeof createHttpContractValidator>, operation: string) {
  const known = error instanceof StrategyAccessError || error instanceof AuthError || error instanceof HttpContractError ? error : new StrategyAccessError('strategy_unavailable', 503)
  const body = { type: `urn:aurum:problem:${known.code}`, title: 'Strategy list failed', status: known.status, code: known.code,
    detail: known.code, instance: '/api/v4/strategies', correlation_id: id, retryable: known.status >= 500 }
  try { return reply.type('application/problem+json').code(known.status).send(contract.response(operation, body, known.status, 'application/problem+json')) }
  catch {
    const fallback = { ...body, type: 'urn:aurum:problem:api_response_invalid', code: 'api_response_invalid', detail: 'api_response_invalid', status: 503, correlation_id: randomUUID(), retryable: true }
    return reply.type('application/problem+json').code(503).send(contract.response(operation, fallback, 503, 'application/problem+json'))
  }
}
