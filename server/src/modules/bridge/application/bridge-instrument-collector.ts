import { matchesMarketSymbol, type InstrumentProjectionWriter, type InstrumentRevisionReader } from '../../trading/index.js'
import { BridgeGatewayError, type BridgeGatewayRoute } from '../domain/bridge-gateway.js'
import { sameQueryRoute } from '../domain/bridge-query.js'
import type { BridgeInstrumentQueryClient } from './bridge-gateway-query-transport.js'

/** Gateway owns the live query; trading owns normalization, authorization recheck and the write transaction. */
export class BridgeInstrumentCollector {
  constructor(private readonly queries: BridgeInstrumentQueryClient,
    private readonly snapshots: InstrumentRevisionReader, private readonly writer: InstrumentProjectionWriter,
    private readonly now = () => new Date()) {}

  async collect(input: { route: BridgeGatewayRoute; symbol: string; collectionLease: { requestId: string; leaseToken: string } }) {
    const { route, symbol, collectionLease } = structuredClone(input)
    const { installationId, credentialGeneration, ownershipRevision } = route
    if (!installationId || typeof credentialGeneration !== 'number' || !Number.isSafeInteger(credentialGeneration)
      || credentialGeneration < 1 || typeof ownershipRevision !== 'string' || !/^[1-9]\d*$/.test(ownershipRevision)
      || !route.connectionId) throw new BridgeGatewayError('bridge_instrument_route_proof_missing', 403)
    const started = this.now().getTime()
    const response = await this.queries.queryInstrument({ route, symbol })
    const finished = this.now().getTime(), payload = response.payload
    if (payload.resource !== 'market.instrument' || !sameQueryRoute(response.route, route)
      || payload.has_more || payload.next_cursor !== null || payload.items.length !== 1
      || (payload.source !== 'terminal' && payload.source !== 'local_projection')) {
      throw new BridgeGatewayError('bridge_instrument_result_invalid', 409)
    }
    // Query is a current contract read, not historical market time. Cached pre-request facts cannot refresh it.
    if (!Number.isSafeInteger(payload.observed_at_utc_msc) || payload.observed_at_utc_msc < started
      || payload.observed_at_utc_msc > finished || !Number.isFinite(started) || !Number.isFinite(finished)) {
      throw new BridgeGatewayError('bridge_instrument_observation_stale', 409)
    }
    const raw = structuredClone(payload.items[0]!)
    const actualSymbol = raw.symbol ?? raw.name
    if (typeof actualSymbol !== 'string' || !matchesMarketSymbol(actualSymbol, symbol)
      || [raw.symbol, raw.name].some(value => value !== undefined && value !== actualSymbol)) {
      throw new BridgeGatewayError('bridge_instrument_result_invalid', 409)
    }
    const expectedRevision = await this.snapshots.readRevision(route.accountId, actualSymbol)
    return this.writer.write({ route: { ...route, installationId, credentialGeneration, ownershipRevision }, symbol: actualSymbol, requestedSymbol: symbol,
      raw, expectedRevision, sourceRevision: payload.source_revision, collectionLease,
      observedAt: new Date(payload.observed_at_utc_msc).toISOString() })
  }
}
