import { randomUUID } from 'node:crypto'
import type { Redis } from 'ioredis'
import { BRIDGE_MARKET_DEMAND_CHANNEL, parseBridgeMarketDemand } from '../../../shared/bridge-market-demand.js'
import type { MarketDemandPublisher, MarketDemandTarget } from '../application/market-demand-port.js'
export class RedisMarketDemandPublisher implements MarketDemandPublisher {
  constructor(private readonly redis: Pick<Redis, 'publish'>, private readonly failed: (code: string) => void = () => {}) {}
  create(userId: number, targets: MarketDemandTarget[]) {
    const id = randomUUID(), scope = structuredClone(targets)
    let closed = false
    const send = async (expiresAt: number) => {
      const value = parseBridgeMarketDemand({ v: 1, id, userId, targets: scope, expiresAt })
      if (!value) throw new Error('market_demand_invalid')
      await this.redis.publish(BRIDGE_MARKET_DEMAND_CHANNEL, JSON.stringify(value))
    }
    return { renew: async () => { if (!closed) await send(Date.now() + 90_000) },
      close: () => { if (closed) return; closed = true; void send(0).catch(() => this.failed('market_demand_cancel_failed')) } }
  }
}
