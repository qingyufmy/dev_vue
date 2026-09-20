import { validHistoryQueryCoverage, type HistoryQueryCoverage } from './history-query-coverage.js'
import { randomUUID } from 'node:crypto'
import type { BridgeGatewayRoute } from './bridge-gateway.js'
import { BridgeGatewayError } from './bridge-gateway.js'
import type { BridgeWireRoute } from '../../execution/index.js'

export type BridgeHistoryResource = 'history.orders' | 'history.trades' | 'history.deals'
export type BridgeReadResource = BridgeHistoryResource | 'market.instrument' | 'market.symbols' | 'market.candles'

export interface BridgeQueryRequestEnvelope<R extends BridgeReadResource = BridgeHistoryResource> {
  v: 4
  message_id: string
  type: 'query.request'
  sent_at_utc_msc: number
  correlation_id: null
  route: BridgeWireRoute
  payload: {
    request_id: string
    resource: R
    params: R extends 'market.instrument' ? { symbol: string } : R extends 'market.symbols' | 'market.candles' ? Record<string, unknown> : {
      range_start_utc_msc: number
      range_end_utc_msc: number
      limit: number
      cursor: string | null
    }
    deadline_utc_msc: number
  }
}

export interface BridgeQueryResponseEnvelope {
  v: 4
  message_id: string
  type: 'query.response'
  sent_at_utc_msc: number
  correlation_id: string
  route: BridgeWireRoute
  payload: {
    request_id: string
    resource: BridgeReadResource
    observed_at_utc_msc: number
    source_revision: string
    source: 'terminal' | 'local_projection'
    history_coverage?: HistoryQueryCoverage
    items: Record<string, unknown>[]
    has_more: boolean
    next_cursor: string | null
  }
}

export interface BridgeQueryErrorEnvelope {
  v: 4
  message_id: string
  type: 'query.error'
  sent_at_utc_msc: number
  correlation_id: string
  route: BridgeWireRoute
  payload: {
    request_id: string
    resource: BridgeReadResource
    code: string
    message: string
    retryable: boolean
  }
}

export type BridgeQueryResultEnvelope = BridgeQueryResponseEnvelope | BridgeQueryErrorEnvelope

export function instrumentQueryEnvelope(input: {
  route: BridgeGatewayRoute; symbol: string; deadlineUtcMsc: number; nowUtcMsc: number
}): BridgeQueryRequestEnvelope<'market.instrument'> {
  if (typeof input.symbol !== 'string' || input.symbol.length < 1 || input.symbol.length > 64
    || input.symbol.trim() !== input.symbol) fail('bridge_query_symbol_invalid')
  integer(input.nowUtcMsc, 'bridge_query_deadline_invalid')
  integer(input.deadlineUtcMsc, 'bridge_query_deadline_invalid')
  if (input.deadlineUtcMsc <= input.nowUtcMsc) fail('bridge_query_deadline_invalid')
  return { v: 4, message_id: `message:${randomUUID()}`, type: 'query.request', sent_at_utc_msc: input.nowUtcMsc,
    correlation_id: null, route: wireRoute(input.route), payload: { request_id: `query:${randomUUID()}`,
      resource: 'market.instrument', params: { symbol: input.symbol }, deadline_utc_msc: input.deadlineUtcMsc } }
}

export function historyQueryEnvelope(input: {
  route: BridgeGatewayRoute
  resource: BridgeHistoryResource
  rangeStartUtcMsc: number
  rangeEndUtcMsc: number
  limit: number
  cursor: string | null
  deadlineUtcMsc: number
  nowUtcMsc: number
}): BridgeQueryRequestEnvelope {
  integer(input.rangeStartUtcMsc, 'bridge_query_range_invalid')
  integer(input.rangeEndUtcMsc, 'bridge_query_range_invalid')
  if (input.rangeEndUtcMsc <= input.rangeStartUtcMsc) fail('bridge_query_range_invalid')
  if (!Number.isSafeInteger(input.limit) || input.limit < 1 || input.limit > 500) fail('bridge_query_limit_invalid')
  if (input.cursor !== null && (typeof input.cursor !== 'string' || input.cursor.length < 1 || input.cursor.length > 2048)) fail('bridge_query_cursor_invalid')
  if (!Number.isSafeInteger(input.deadlineUtcMsc) || input.deadlineUtcMsc <= input.nowUtcMsc) fail('bridge_query_deadline_invalid')
  const requestId = `query:${randomUUID()}`
  return {
    v: 4,
    message_id: `message:${randomUUID()}`,
    type: 'query.request',
    sent_at_utc_msc: input.nowUtcMsc,
    correlation_id: null,
    route: wireRoute(input.route),
    payload: {
      request_id: requestId,
      resource: input.resource,
      params: {
        range_start_utc_msc: input.rangeStartUtcMsc,
        range_end_utc_msc: input.rangeEndUtcMsc,
        limit: input.limit,
        cursor: input.cursor,
      },
      deadline_utc_msc: input.deadlineUtcMsc,
    },
  }
}

export function assertQueryResultEnvelope(value: unknown): BridgeQueryResultEnvelope {
  if (!record(value) || value.v !== 4 || (value.type !== 'query.response' && value.type !== 'query.error')) fail('bridge_query_result_invalid')
  opaque(value.message_id, 'bridge_query_result_invalid')
  integer(value.sent_at_utc_msc, 'bridge_query_result_invalid')
  opaque(value.correlation_id, 'bridge_query_result_invalid')
  route(value.route)
  if (!record(value.payload)) fail('bridge_query_result_invalid')
  const payload = value.payload
  opaque(payload.request_id, 'bridge_query_result_invalid')
  resource(payload.resource)
  if (value.type === 'query.error') {
    code(payload.code)
    if (typeof payload.message !== 'string' || payload.message.length > 512 || typeof payload.retryable !== 'boolean') fail('bridge_query_result_invalid')
    return value as unknown as BridgeQueryErrorEnvelope
  }
  integer(payload.observed_at_utc_msc, 'bridge_query_result_invalid')
  if (typeof payload.source_revision !== 'string' || payload.source_revision.length < 1 || payload.source_revision.length > 191) fail('bridge_query_result_invalid')
  if (payload.source !== 'terminal' && payload.source !== 'local_projection') fail('bridge_query_result_invalid')
  if (Object.hasOwn(payload, 'history_coverage') && !validHistoryQueryCoverage(payload.history_coverage, payload.resource, payload.source_revision, Number(payload.observed_at_utc_msc))) fail('bridge_history_coverage_invalid')
  if (!Array.isArray(payload.items) || payload.items.length > 500 || payload.items.some(item => !record(item))) fail('bridge_query_result_invalid')
  if (typeof payload.has_more !== 'boolean') fail('bridge_query_result_invalid')
  if (payload.next_cursor !== null && (typeof payload.next_cursor !== 'string' || payload.next_cursor.length < 1 || payload.next_cursor.length > 2048)) fail('bridge_query_result_invalid')
  if (payload.has_more !== (payload.next_cursor !== null)) fail('bridge_query_cursor_state_invalid')
  if (payload.resource === 'market.instrument' && (payload.items.length !== 1 || payload.has_more || payload.next_cursor !== null)) fail('bridge_query_instrument_result_invalid')
  return value as unknown as BridgeQueryResponseEnvelope
}

export function sameQueryRoute(routeValue: BridgeWireRoute, expected: BridgeGatewayRoute) {
  return routeValue.terminal_instance_id === expected.terminalInstanceId
    && routeValue.account_ref.broker_server === expected.brokerServer
    && routeValue.account_ref.login === expected.login
    && routeValue.connection_epoch === expected.connectionEpoch
}

function wireRoute(value: BridgeGatewayRoute): BridgeWireRoute {
  return { terminal_instance_id: value.terminalInstanceId, account_ref: { broker_server: value.brokerServer, login: value.login }, connection_epoch: value.connectionEpoch }
}
function route(value: unknown) {
  if (!record(value) || !opaque(value.terminal_instance_id, 'bridge_query_result_invalid') || !record(value.account_ref)
    || typeof value.account_ref.broker_server !== 'string' || value.account_ref.broker_server.length < 1 || value.account_ref.broker_server.length > 128
    || typeof value.account_ref.login !== 'string' || value.account_ref.login.length < 1 || value.account_ref.login.length > 64
    || !Number.isSafeInteger(value.connection_epoch) || Number(value.connection_epoch) < 1) fail('bridge_query_result_invalid')
}
function resource(value: unknown): asserts value is BridgeReadResource { if (!['history.orders', 'history.trades', 'history.deals', 'market.instrument', 'market.symbols', 'market.candles'].includes(String(value))) fail('bridge_query_resource_invalid') }
function code(value: unknown) { if (typeof value !== 'string' || !/^[a-z][a-z0-9_]{1,127}$/.test(value)) fail('bridge_query_error_code_invalid') }
function opaque(value: unknown, errorCode: string): value is string { if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{7,190}$/.test(value)) fail(errorCode); return true }
function integer(value: unknown, errorCode: string) { if (!Number.isSafeInteger(value) || Number(value) < 1) fail(errorCode) }
function record(value: unknown): value is Record<string, unknown> { return Boolean(value && typeof value === 'object' && !Array.isArray(value)) }
function fail(codeValue: string): never { throw new BridgeGatewayError(codeValue, 400) }

export function marketQueryEnvelope(input: { route: BridgeGatewayRoute; resource: 'market.symbols' | 'market.candles'; params: Record<string, unknown>; deadlineUtcMsc: number; nowUtcMsc: number }): BridgeQueryRequestEnvelope<'market.symbols' | 'market.candles'> {
 integer(input.nowUtcMsc, 'bridge_query_deadline_invalid'); integer(input.deadlineUtcMsc, 'bridge_query_deadline_invalid')
 if (input.deadlineUtcMsc <= input.nowUtcMsc) fail('bridge_query_deadline_invalid')
 const p = input.params
 const expected = input.resource === 'market.symbols' ? 'cursor,limit' : 'cursor,limit,range_end_utc_msc,range_start_utc_msc,symbol,timeframe'
 if (Object.keys(p).sort().join(',') !== expected || !Number.isSafeInteger(p.limit) || Number(p.limit) < 1 || Number(p.limit) > 500) fail('bridge_query_params_invalid')
 if (input.resource === 'market.symbols') {
  if (p.cursor !== null && (typeof p.cursor !== 'string' || !/^[0-9]{1,5}$/.test(p.cursor))) fail('bridge_query_cursor_invalid')
 } else {
  const durations: Record<string, number> = { M1: 1, M5: 5, M15: 15, M30: 30, H1: 60, H4: 240, D1: 1440 }
  if (p.cursor !== null || typeof p.symbol !== 'string' || !/^[A-Za-z0-9._-]{1,64}$/.test(p.symbol)
   || typeof p.timeframe !== 'string' || !Object.hasOwn(durations, p.timeframe) || Number(p.limit) < 2) fail('bridge_query_params_invalid')
  integer(p.range_start_utc_msc, 'bridge_query_range_invalid'); integer(p.range_end_utc_msc, 'bridge_query_range_invalid')
  const span = Number(p.range_end_utc_msc) - Number(p.range_start_utc_msc)
  if (span <= 0 || span > durations[p.timeframe]! * 60_000 * (Number(p.limit) - 1) || Number(p.range_end_utc_msc) > input.nowUtcMsc + 15_000) fail('bridge_query_range_invalid')
 }
 return { v: 4, message_id: `message:${randomUUID()}`, type: 'query.request', sent_at_utc_msc: input.nowUtcMsc, correlation_id: null, route: wireRoute(input.route),
  payload: { request_id: `query:${randomUUID()}`, resource: input.resource, params: structuredClone(input.params), deadline_utc_msc: input.deadlineUtcMsc } }
}
