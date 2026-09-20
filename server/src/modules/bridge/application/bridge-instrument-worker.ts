import type { InstrumentCollectionTasks } from '../../trading/index.js'
import type { BridgeGatewayLeaseStore } from './bridge-gateway-ports.js'
import type { BridgeInstrumentCollector } from './bridge-instrument-collector.js'

export type BridgeInstrumentWorkResult =
  | { state: 'terminal' }
  | { state: 'collected'; revision: number }
  | { state: 'retry'; retryAt: string }

/** Queue payloads identify durable requests; account scope is never trusted from the queue. */
export class BridgeInstrumentWorker {
  constructor(private readonly tasks: InstrumentCollectionTasks,
    private readonly routes: Pick<BridgeGatewayLeaseStore, 'current'>,
    private readonly collector: Pick<BridgeInstrumentCollector, 'collect'>,
    private readonly now = () => Date.now()) {}

  async run(requestId: string): Promise<BridgeInstrumentWorkResult> {
    const result = await this.tasks.claim(requestId)
    if (result.state === 'terminal') return result
    if (result.state === 'busy') return { state: 'retry', retryAt: result.retryAt }
    const claim = structuredClone(result.claim)
    let revision: number
    try {
      const route = await this.routes.current(claim.accountId)
      if (!route || route.accountId !== claim.accountId || route.userId !== claim.userId) {
        throw new Error('bridge_instrument_route_unavailable')
      }
      revision = (await this.collector.collect({ route, symbol: claim.symbol,
        collectionLease: { requestId: claim.requestId, leaseToken: claim.leaseToken } })).revision
    } catch {
      // Keep arbitrary transport/SQL error text out of durable public error codes.
      await this.tasks.release(claim, 'instrument_collection_failed')
      return this.retry()
    }
    // A lost completion acknowledgement must be reread on redelivery, never released as a collection failure.
    if (!await this.tasks.complete(claim, revision)) return this.retry()
    return { state: 'collected', revision }
  }

  private retry(): BridgeInstrumentWorkResult {
    return { state: 'retry', retryAt: new Date(this.now() + 5000).toISOString() }
  }
}
