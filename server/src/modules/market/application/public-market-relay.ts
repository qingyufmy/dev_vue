import { publicCacheKey } from './public-market-snapshot.js'
import type { MarketSourceStore } from './market-source-ports.js'
import { createHash } from 'node:crypto'
import type { PublicMarketSnapshot, PublicMarketTimeframe } from './public-market-snapshot.js'

interface MarketNotice { eventId: string; resource: string; resourceId: string; accountId: string | null; userId: number | null; revision: number }
export interface PublicMarketEvent {
  eventId: string; type: 'market.public.updated'; occurredAt: string; userId: null; accountId: null; terminalInstanceId: null
  resource: 'public_market'; resourceId: string; revision: number
  data: { symbol: string; timeframe: PublicMarketTimeframe | null; source_key: string; source_generation: string
    quote: Awaited<ReturnType<PublicMarketSnapshot['read']>>['quote']; candle: Awaited<ReturnType<PublicMarketSnapshot['read']>>['candles'][number] | null }
}

/** Relay only committed public cache values, never raw account publication payloads. */
export class PublicMarketRelay {
  private readonly pending = new Map<string, MarketNotice>()
  private draining: Promise<void> | null = null
  private stopped = false
  constructor(private readonly catalog: { list(): Promise<string[]> }, private readonly sources: MarketSourceStore,
    private readonly snapshots: Pick<PublicMarketSnapshot, 'read'>, private readonly publish: (event: PublicMarketEvent) => Promise<unknown>,
    private readonly failed: () => void) {}

  accept(event: MarketNotice) {
    if (this.stopped || !['market.quote', 'market.candle'].includes(event.resource) || !event.accountId || !event.userId) return
    const key = `${event.accountId}:${event.resource}:${event.resourceId}`
    if (this.pending.size >= 256 && !this.pending.has(key)) { this.failed(); return }
    const previous = this.pending.get(key)
    if (previous && previous.revision >= event.revision) return
    this.pending.set(key, { eventId: event.eventId, resource: event.resource, resourceId: event.resourceId,
      accountId: event.accountId, userId: event.userId, revision: event.revision })
    this.startDrain()
  }
  async close() { this.stopped = true; this.pending.clear(); await this.draining }
  async flush() { while (this.draining) await this.draining }

  private startDrain() {
    if (this.draining || this.stopped || !this.pending.size) return
    this.draining = this.drain().finally(() => {
      this.draining = null
      this.startDrain()
    })
  }

  private async drain() {
    while (!this.stopped && this.pending.size) {
      const [key, event] = this.pending.entries().next().value!
      this.pending.delete(key)
      try { await this.relay(event) } catch { this.failed() }
    }
  }
  private async relay(event: MarketNotice) {
    const [actual, period] = event.resourceId.split(':')
    const timeframe = event.resource === 'market.candle' ? period as PublicMarketTimeframe : null
    if (event.resource === 'market.quote' && period !== undefined
      || timeframe !== null && !['M1', 'M5', 'M15', 'M30', 'H1', 'H4', 'D1'].includes(timeframe)) return
    for (const symbol of await this.catalog.list()) {
      if (!actual?.toUpperCase().startsWith(symbol)) continue
      const state = await this.sources.read({ pool: { kind: 'public' }, symbol })
      if (state?.source?.accountId !== event.accountId || state.source.ownerUserId !== event.userId || state.resolvedSymbol !== actual) continue
      const snapshot = await this.snapshots.read(symbol, timeframe ?? 'M5', 2)
      const current = await this.sources.read({ pool: { kind: 'public' }, symbol })
      if (this.stopped || current?.generation !== state.generation || snapshot.source_generation !== '1' || !snapshot.source_key || snapshot.source_key !== publicCacheKey(symbol, event.accountId!, actual!)) continue
      const quote = timeframe === null && snapshot.quote?.revision === String(event.revision) ? snapshot.quote : null
      const candle = timeframe !== null ? snapshot.candles.find(item => item.revision === String(event.revision)) ?? null : null
      if (!quote && !candle) continue
      await this.publish({ eventId: createHash('sha256').update(`${snapshot.source_key}:${event.eventId}`).digest('hex'), type: 'market.public.updated', occurredAt: new Date().toISOString(),
        userId: null, accountId: null, terminalInstanceId: null, resource: 'public_market', resourceId: `${symbol}:${timeframe ?? 'quote'}`, revision: event.revision,
        data: { symbol, timeframe, source_key: snapshot.source_key, source_generation: snapshot.source_generation,
          quote, candle } })
    }
  }
}
