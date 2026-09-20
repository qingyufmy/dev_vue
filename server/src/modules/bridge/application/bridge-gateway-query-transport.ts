import type { BridgeGatewayDirectory, BridgeGatewayLeaseStore, BridgeGatewayRouteRepository } from './bridge-gateway-ports.js'
import { BridgeGatewayError, type BridgeGatewayRoute } from '../domain/bridge-gateway.js'
import {
  assertQueryResultEnvelope, historyQueryEnvelope, instrumentQueryEnvelope, marketQueryEnvelope, sameQueryRoute,
  type BridgeHistoryResource, type BridgeReadResource, type BridgeQueryResponseEnvelope, type BridgeQueryResultEnvelope,
} from '../domain/bridge-query.js'

interface PendingQuery {
  route: BridgeGatewayRoute
  resource: BridgeReadResource
  correlationId: string
  timer: NodeJS.Timeout
  resolve: (value: BridgeQueryResponseEnvelope) => void
  reject: (error: Error) => void
}

export interface BridgeHistoryQueryInput {
  route: BridgeGatewayRoute
  resource: BridgeHistoryResource
  rangeStartUtcMsc: number
  rangeEndUtcMsc: number
  limit?: number
  cursor?: string | null
  timeoutMs?: number
}

export interface BridgeHistoryQueryClient {
  query(input: BridgeHistoryQueryInput): Promise<BridgeQueryResponseEnvelope>
}
export interface BridgeInstrumentQueryInput { route: BridgeGatewayRoute; symbol: string; timeoutMs?: number }
export interface BridgeInstrumentQueryClient {
  queryInstrument(input: BridgeInstrumentQueryInput): Promise<BridgeQueryResponseEnvelope>
}

export interface BridgeMarketQueryInput { route: BridgeGatewayRoute; resource: 'market.symbols' | 'market.candles'; params: Record<string, unknown>; timeoutMs?: number }

export class BridgeGatewayQueryTransport implements BridgeHistoryQueryClient, BridgeInstrumentQueryClient {
  private readonly pending = new Map<string, PendingQuery>()

  constructor(
    private readonly leases: BridgeGatewayLeaseStore,
    private readonly directory: BridgeGatewayDirectory,
    private readonly authorization: Pick<BridgeGatewayRouteRepository, 'isAuthorized'>,
    private readonly now = () => new Date(),
  ) {}

  async query(input: BridgeHistoryQueryInput) {
    return this.sendQuery(input)
  }

  async queryInstrument(input: BridgeInstrumentQueryInput) {
    return this.sendQuery({ ...input, resource: 'market.instrument' })
  }

  async queryMarket(input: BridgeMarketQueryInput) { return this.sendQuery(input) }

  private async sendQuery(input: BridgeHistoryQueryInput | BridgeMarketQueryInput | (BridgeInstrumentQueryInput & { resource: 'market.instrument' })) {
    input = structuredClone(input)
    const current = await this.leases.current(input.route.accountId)
    if (!current || current.connectionId !== input.route.connectionId || !sameRoute(current, input.route)) {
      throw new BridgeGatewayError('bridge_query_route_unavailable', 409)
    }
    if (!await this.authorization.isAuthorized(current)) throw new BridgeGatewayError('bridge_route_authorization_revoked', 403)
    if ((await this.leases.current(input.route.accountId))?.connectionId !== current.connectionId) {
      throw new BridgeGatewayError('bridge_query_route_unavailable', 409)
    }
    if ([...this.pending.values()].some(value => value.route.connectionId === current.connectionId)) {
      throw new BridgeGatewayError('bridge_query_inflight', 409)
    }
    const sink = this.directory.get(current.connectionId)
    if (!sink) throw new BridgeGatewayError('bridge_query_process_unavailable', 503)
    const timeoutMs = Math.min(Math.max(input.timeoutMs ?? 15_000, 1_000), 30_000)
    const now = this.now().getTime()
    const request = 'params' in input
      ? marketQueryEnvelope({ ...input, deadlineUtcMsc: now + timeoutMs, nowUtcMsc: now })
      : input.resource === 'market.instrument'
      ? instrumentQueryEnvelope({ ...input, deadlineUtcMsc: now + timeoutMs, nowUtcMsc: now })
      : historyQueryEnvelope({ ...input, limit: input.limit ?? 500, cursor: input.cursor ?? null, deadlineUtcMsc: now + timeoutMs, nowUtcMsc: now })
    const response = new Promise<BridgeQueryResponseEnvelope>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(request.payload.request_id)
        reject(new BridgeGatewayError('bridge_query_timeout', 504))
      }, timeoutMs)
      timer.unref?.()
      this.pending.set(request.payload.request_id, { route: current, resource: input.resource, correlationId: request.message_id, timer, resolve, reject })
    })
    try {
      await sink.send(request)
    } catch {
      this.reject(request.payload.request_id, new BridgeGatewayError('bridge_query_write_failed', 503))
    }
    return response
  }

  receive(route: BridgeGatewayRoute, value: unknown) {
    const envelope = assertQueryResultEnvelope(value)
    const pending = this.pending.get(envelope.payload.request_id)
    // A response may arrive after a local deadline or disconnect cancellation.
    // It is read-only and has no acknowledgement contract, so ignore it rather
    // than tearing down a healthy terminal session.
    if (!pending) return null
    if (pending.route.connectionId !== route.connectionId || !sameQueryRoute(envelope.route, pending.route)
      || envelope.payload.resource !== pending.resource || envelope.correlation_id !== pending.correlationId) {
      this.reject(envelope.payload.request_id, new BridgeGatewayError('bridge_query_result_correlation_invalid', 409))
      throw new BridgeGatewayError('bridge_query_result_correlation_invalid', 409)
    }
    this.pending.delete(envelope.payload.request_id)
    clearTimeout(pending.timer)
    if (envelope.type === 'query.error') {
      pending.reject(new BridgeQueryRemoteError(envelope.payload.code, envelope.payload.retryable))
      return envelope
    }
    pending.resolve(envelope)
    return envelope
  }

  cancelConnection(connectionId: string, code = 'bridge_query_connection_closed') {
    for (const [requestId, pending] of this.pending) {
      if (pending.route.connectionId === connectionId) this.reject(requestId, new BridgeGatewayError(code, 409))
    }
  }

  inflight() { return this.pending.size }

  private reject(requestId: string, error: Error) {
    const pending = this.pending.get(requestId)
    if (!pending) return
    this.pending.delete(requestId)
    clearTimeout(pending.timer)
    pending.reject(error)
  }
}

export class BridgeQueryRemoteError extends Error {
  constructor(readonly code: string, readonly retryable: boolean) { super(code); this.name = 'BridgeQueryRemoteError' }
}

function sameRoute(left: BridgeGatewayRoute, right: BridgeGatewayRoute) {
  return left.accountId === right.accountId && left.terminalInstanceId === right.terminalInstanceId
    && left.brokerServer === right.brokerServer && left.login === right.login && left.connectionEpoch === right.connectionEpoch
}
