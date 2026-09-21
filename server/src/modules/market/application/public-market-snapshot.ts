import { createHash } from 'node:crypto'
import { assertMarketSourceScope, parseBridgeMarketState } from '../domain/market-source.js'
import { chanHistoryTarget } from './chan-market-evidence.js'
import { publicChanChart } from './public-chan-chart.js'

export type PublicMarketTimeframe = 'M1' | 'M5' | 'M15' | 'M30' | 'H1' | 'H4' | 'D1'
export function publicCacheKey(symbol: string, accountId: string, resolvedSymbol: string) {
  return createHash('sha256').update(JSON.stringify(['public-cache', symbol, accountId, resolvedSymbol])).digest('hex')
}
export interface PublicMarketCache {
  getPublicDisplayClock(owners: number[]): Promise<{ offset: number; checkedAt: string; ownerUserId: number } | null>
  getPublicSourceClock(ownerUserId: number, accountId: string): Promise<{ offset: number; checkedAt: string } | null>
  findPublicCachedSource(owners: number[], symbol: string, timeframe: PublicMarketTimeframe): Promise<{ accountId: string; ownerUserId: number; resolvedSymbol: string; platform: 'mt4' | 'mt5' } | null>
  findOwnedAccount(userId: number, accountId: string): Promise<{ id: string } | null>
  getQuote(accountId: string, symbol: string): Promise<{
    accountId: string; symbol: string; bid: string; ask: string; last: string | null; spread: string; observedAt: string; revision: number
  } | null>
  listCandles(accountId: string, symbol: string, timeframe: PublicMarketTimeframe, limit: number, before?: string): Promise<Array<{
    accountId: string; symbol: string; timeframe: PublicMarketTimeframe; openTime: string
    open: string; high: string; low: string; close: string; tickVolume: string; closed: boolean; revision: number
  }>>
}

/** Cached public data survives collector route changes. Never probes a terminal or reads a viewer's private pool. */
export class PublicMarketSnapshot {
  private readonly structureCache = new Map<string, { revision: string; closedRevisions: Map<string, number>; value: ReturnType<typeof publicChanChart> }>()
  constructor(private readonly providers: { list(): Promise<number[]> },
    private readonly trading: PublicMarketCache,
    private readonly catalog: { list(): Promise<string[]> },
    private readonly demand?: { use(scope: import('../domain/market-source.js').MarketSourceScope): Promise<void> },
    private readonly sources?: Pick<import('./market-source-ports.js').MarketSourceStore, 'read'>) {}

  async symbols() {
    const items = await this.catalog.list()
    const owners = await this.providers.list()
    const market_states = await Promise.all(items.map(async symbol => {
      const source = await this.sources?.read({ pool: { kind: 'public' }, symbol })
      const value = parseBridgeMarketState(source?.marketState)
      const valid = source?.source && owners.includes(source.source.ownerUserId) && !source.failures && value
        && Date.now() - value.checked_at_utc_msc <= 45000 && value.checked_at_utc_msc <= Date.now() + 15000
        && !!await this.trading.findOwnedAccount(source.source.ownerUserId, source.source.accountId)
        && (await this.providers.list()).includes(source.source.ownerUserId)
      return { symbol, state: valid ? value.state : 'unknown' as const, reason: valid ? value.reason : 'source_unavailable', checked_at: valid ? new Date(value.checked_at_utc_msc).toISOString() : null }
    }))
    const clock = await this.trading.getPublicDisplayClock(await this.providers.list())
    if (!clock || !(await this.providers.list()).includes(clock.ownerUserId)) return { items, timezone: null, market_states }
    return { items, market_states, timezone: { offset_minutes: clock.offset, checked_at: clock.checkedAt,
      status: Date.now() - Date.parse(clock.checkedAt) <= 25 * 3600000 ? 'calibrated' as const : 'stale' as const } }
  }

  async read(symbol: string, timeframe: PublicMarketTimeframe, limit = 200, before?: string) {
    if (before !== undefined && (!/^\d{4}-\d{2}-\d{2}T.*Z$/.test(before) || !Number.isFinite(Date.parse(before)))) throw new Error('public_market_query_invalid')
    const scope = { pool: { kind: 'public' as const }, symbol }
    assertMarketSourceScope(scope)
    if (!['M1', 'M5', 'M15', 'M30', 'H1', 'H4', 'D1'].includes(timeframe) || !Number.isInteger(limit) || limit < 1 || limit > 500) throw new Error('public_market_query_invalid')
    const enabled = (await this.catalog.list()).includes(symbol)
    if (enabled) await this.demand?.use(scope)
    if (!enabled) return { symbol, timeframe, source_key: null, source_generation: null, status: 'unavailable' as const, quote: null, candles: [], structure: null }
    return this.readCached(symbol, timeframe, limit, before)
  }

  private async readCached(symbol: string, timeframe: PublicMarketTimeframe, limit: number, before?: string) {
    const source = await this.trading.findPublicCachedSource(await this.providers.list(), symbol, timeframe)
    const empty = { symbol, timeframe, source_key: null, source_generation: null, status: 'unavailable' as const, quote: null, candles: [], structure: null }
    if (!source) return empty
    const authorized = async () => (await this.catalog.list()).includes(symbol)
      && (await this.providers.list()).includes(source.ownerUserId)
      && !!await this.trading.findOwnedAccount(source.ownerUserId, source.accountId)
    if (!await authorized()) return empty
    const [quote, candles] = await Promise.all([
      this.trading.getQuote(source.accountId, source.resolvedSymbol),
      this.trading.listCandles(source.accountId, source.resolvedSymbol, timeframe, limit, before),
    ])
    if (!await authorized()) throw new Error('public_market_source_changed')
    if (quote && (quote.accountId !== source.accountId || quote.symbol !== source.resolvedSymbol)
      || candles.some(c => c.accountId !== source.accountId || c.symbol !== source.resolvedSymbol || c.timeframe !== timeframe)) throw new Error('public_market_scope_invalid')
    const structureTarget = chanHistoryTarget(timeframe)
    let structure: ReturnType<typeof publicChanChart> = null
    if (structureTarget > 0) {
      if (before !== undefined) {
        const [structureCandles, clock] = await Promise.all([
          this.trading.listCandles(source.accountId, source.resolvedSymbol, timeframe, structureTarget, before),
          this.trading.getPublicSourceClock(source.ownerUserId, source.accountId),
        ])
        if (!await authorized()) throw new Error('public_market_source_changed')
        if (structureCandles.some(c => c.accountId !== source.accountId || c.symbol !== source.resolvedSymbol || c.timeframe !== timeframe)) throw new Error('public_market_scope_invalid')
        const causalClock = clock && Date.parse(clock.checkedAt) <= Date.parse(before) ? clock : null
        structure = publicChanChart({ accountId: source.accountId, platform: source.platform,
          timeframe, candles: structureCandles, clock: causalClock, referenceTime: before, includeDeveloping: false })
      } else {
        const latestClosed = [...candles].reverse().find(candle => candle.closed)
        const structureKey = `${publicCacheKey(symbol, source.accountId, source.resolvedSymbol)}:${timeframe}`
        const revision = latestClosed ? `${latestClosed.openTime}:${latestClosed.revision}` : 'empty'
        const cached = this.structureCache.get(structureKey)
        // Snapshot sizes differ (relay: 2, chart: 500). Compare each returned
        // closed bar with the calculation window, rather than hashing the page
        // or only checking the newest bar and missing a preceding correction.
        if (cached?.revision === revision && candles.every(candle => !candle.closed
          || cached.closedRevisions.get(candle.openTime) === candle.revision)) structure = cached.value
        else {
          const [structureCandles, clock] = await Promise.all([
            // The live tail normally contains one forming candle. Ask for one
            // extra record so the closed-bar calculation still receives its
            // complete policy window while the market is open.
            this.trading.listCandles(source.accountId, source.resolvedSymbol, timeframe, structureTarget + 1),
            this.trading.getPublicSourceClock(source.ownerUserId, source.accountId),
          ])
          if (!await authorized()) throw new Error('public_market_source_changed')
          if (structureCandles.some(c => c.accountId !== source.accountId || c.symbol !== source.resolvedSymbol || c.timeframe !== timeframe)) throw new Error('public_market_scope_invalid')
          const lastStructureBar = structureCandles.at(-1)
          const quoteTime = Date.parse(quote?.observedAt ?? '')
          const closedThrough = lastStructureBar?.closed
            ? Date.parse(lastStructureBar.openTime) + (timeframe === 'M1' ? 60_000 : timeframe === 'M5' ? 300_000
              : timeframe === 'M15' ? 900_000 : timeframe === 'M30' ? 1_800_000 : timeframe === 'H1' ? 3_600_000
                : timeframe === 'H4' ? 14_400_000 : 86_400_000)
            : Date.parse(lastStructureBar?.openTime ?? '')
          const referenceTime = new Date(Math.max(Number.isFinite(quoteTime) ? quoteTime : 0,
            Number.isFinite(closedThrough) ? closedThrough : 0, Date.now())).toISOString()
          structure = publicChanChart({ accountId: source.accountId, platform: source.platform,
            timeframe, candles: structureCandles, clock, referenceTime })
          this.structureCache.set(structureKey, { revision,
            closedRevisions: new Map(structureCandles.filter(candle => candle.closed).map(candle => [candle.openTime, candle.revision])), value: structure })
        }
      }
    }
    return { symbol, timeframe, source_key: publicCacheKey(symbol, source.accountId, source.resolvedSymbol), source_generation: '1', status: 'cached' as const,
      quote: quote ? { bid: quote.bid, ask: quote.ask, last: quote.last, spread: quote.spread, observed_at: quote.observedAt, revision: String(quote.revision) } : null,
      candles: candles.map(c => ({ open_time: c.openTime, open: c.open, high: c.high, low: c.low, close: c.close,
        tick_volume: c.tickVolume, closed: c.closed, revision: String(c.revision) })), structure }
  }

}
