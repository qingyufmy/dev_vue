import { parseStandardMarketSymbols } from '../../../shared/standard-market-symbols.js'
import type { MarketSourceSelector } from './market-source-selector.js'
import type { MarketSourceState } from '../domain/market-source.js'

interface StreamLease { renew(): Promise<void>; close(): void }
export interface PublicMarketStreams {
  create(userId: number, targets: Array<{ accountId: string; symbol: string; timeframe: string | null }>): StreamLease
}
const TIMEFRAMES = ['M1', 'M5', 'M15', 'M30', 'H1', 'H4', 'D1']

/** One worker maintains shared demand; viewer count never multiplies collection. */
export class PublicMarketCollector {
  private readonly active = new Map<string, { generation: number; lease: StreamLease }>()
  private running = false
  private closed = false
  constructor(private readonly catalog: { list(): Promise<string[]> },
    private readonly selector: Pick<MarketSourceSelector, 'select' | 'isCurrent'>,
    private readonly streams: PublicMarketStreams) {}

  async tick() {
    if (this.closed || this.running) return { active: this.active.size, failed: [] as string[] }
    this.running = true
    try {
      const symbols = parseStandardMarketSymbols(await this.catalog.list())
      for (const symbol of this.active.keys()) if (!symbols.includes(symbol)) this.release(symbol)
      const failed: string[] = []
      await Promise.all(symbols.map(async symbol => {
        try {
          const scope = { pool: { kind: 'public' as const }, symbol }
          const state = await this.selector.select(scope)
          if (this.closed) return
          if (!state.source || !state.resolvedSymbol || !await this.selector.isCurrent(scope, state)) { this.release(symbol); return }
          if (this.closed) return
          let active = this.active.get(symbol)
          if (active?.generation !== state.generation) {
            this.release(symbol)
            active = { generation: state.generation, lease: this.createLease(state) }
            this.active.set(symbol, active)
          }
          await active!.lease.renew()
          if (this.closed || !await this.selector.isCurrent(scope, state)) this.release(symbol)
        } catch { this.release(symbol); failed.push(symbol) }
      }))
      return { active: this.active.size, failed: failed.sort() }
    } catch (error) {
      for (const symbol of this.active.keys()) this.release(symbol)
      throw error
    } finally { this.running = false }
  }

  close() { this.closed = true; for (const symbol of this.active.keys()) this.release(symbol) }
  private release(symbol: string) { const value = this.active.get(symbol); this.active.delete(symbol); value?.lease.close() }
  private createLease(state: MarketSourceState) {
    const source = state.source!, symbol = state.resolvedSymbol!
    return this.streams.create(source.ownerUserId, [null, ...TIMEFRAMES].map(timeframe => ({ accountId: source.accountId, symbol, timeframe })))
  }
}
