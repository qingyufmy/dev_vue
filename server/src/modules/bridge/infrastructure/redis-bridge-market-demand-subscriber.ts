import { createHash, randomUUID } from 'node:crypto'
import type { Redis } from 'ioredis'
import { BRIDGE_MARKET_DEMAND_CHANNEL, parseBridgeMarketDemand } from '../../../shared/bridge-market-demand.js'
import type { BridgeGatewayDirectory, BridgeGatewayLeaseStore, BridgeGatewayRouteRepository } from '../application/bridge-gateway-ports.js'
export class RedisBridgeMarketDemandSubscriber {
  private chain: Promise<void> = Promise.resolve()
  private stopped = false
  private pending = 0
  constructor(private readonly redis: Redis, private readonly leases: BridgeGatewayLeaseStore,
    private readonly routes: Pick<BridgeGatewayRouteRepository, 'isAuthorized'>, private readonly directory: BridgeGatewayDirectory,
    private readonly failed: (code: string) => void = () => {}) {}
  async start() {
    this.redis.on('message', this.receive)
    await this.redis.subscribe(BRIDGE_MARKET_DEMAND_CHANNEL)
  }
  async close() { this.stopped = true; this.redis.off('message', this.receive); await this.redis.unsubscribe(BRIDGE_MARKET_DEMAND_CHANNEL); await this.chain }
  private readonly receive = (channel: string, raw: string) => {
    if (this.stopped || channel !== BRIDGE_MARKET_DEMAND_CHANNEL || raw.length > 16_384 || this.pending >= 128) return
    this.pending++
    this.chain = this.chain.then(() => this.apply(raw)).catch(() => this.failed('bridge_market_demand_failed')).finally(() => { this.pending-- })
  }
  async apply(raw: string) {
    const demand = parseBridgeMarketDemand(JSON.parse(raw))
    if (!demand || demand.expiresAt > Date.now() + 95_000) return
    const cancel = demand.expiresAt <= Date.now()
    for (const target of demand.targets) {
      const route = await this.leases.current(target.accountId)
      if (!route || route.userId !== demand.userId || !await this.routes.isAuthorized(route)) continue
      if ((await this.leases.current(target.accountId))?.connectionId !== route.connectionId) continue
      const sink = this.directory.get(route.connectionId)
      if (!sink) continue
      const subscriptionId = 'market-' + createHash('sha256').update(`${demand.id}:${target.accountId}:${target.symbol}:${target.timeframe ?? ''}`).digest('hex').slice(0, 32)
      await sink.send({ v: 4, message_id: randomUUID(), type: cancel ? 'stream.unsubscribe' : 'stream.subscribe', sent_at_utc_msc: Date.now(), correlation_id: null,
        route: { terminal_instance_id: route.terminalInstanceId, account_ref: { broker_server: route.brokerServer, login: route.login }, connection_epoch: route.connectionEpoch },
        payload: cancel ? { subscription_id: subscriptionId } : { subscription_id: subscriptionId, stream: target.timeframe ? 'current_candle' : 'quotes',
          filter: { symbol: target.symbol, timeframe: target.timeframe, expires_at_utc_msc: demand.expiresAt } } })
    }
  }
}
