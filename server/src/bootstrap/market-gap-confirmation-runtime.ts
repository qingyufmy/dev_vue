import { createHash } from 'node:crypto'
import type { Redis } from 'ioredis'
import type { MarketSourceSelector, StrategyMarketSourceAccess, ConfirmedMarketGap } from '../modules/market/index.js'
import type { MarketCandle, TerminalFactRoute } from '../modules/trading/index.js'
type Selection = Parameters<StrategyMarketSourceAccess['assertCurrent']>[1]
interface Request { selection: Selection; timeframe: string; step: number; gap: ConfirmedMarketGap }
const QUEUE = 'aurum:v4:market-gap:pending:1'
const proofKey = (r: Request) => 'aurum:v4:market-gap:confirmed:1:' + createHash('sha256').update(JSON.stringify([
  r.selection.pool, r.selection.state.source, r.selection.state.resolvedSymbol, r.timeframe, r.gap,
])).digest('hex')
export class MarketGapConfirmations {
  constructor(private readonly cache: Redis) {}
  async read(selection: Selection, timeframe: string, items: Array<{ openTime: string }>, step: number) {
    const confirmed: ConfirmedMarketGap[] = []
    for (let i = 1; i < items.length; i++) {
      if (Date.parse(items[i]!.openTime) - Date.parse(items[i-1]!.openTime) <= step) continue
      const stable = { ...selection, state: { ...selection.state, revision: 0, lastCheckedAt: 0, marketState: null } }
      const r: Request = { selection: stable, timeframe, step, gap: { from: items[i-1]!.openTime, to: items[i]!.openTime } }
      if (await this.cache.get(proofKey(r))) confirmed.push(r.gap)
      else await this.cache.zadd(QUEUE, 'NX', Date.now(), JSON.stringify(r))
    }
    return confirmed
  }
  async tick(selector: MarketSourceSelector, routes: { current(accountId: string): Promise<TerminalFactRoute | null> },
    io: { read(user: number, account: string, symbol: string, tf: string, before: number, limit: number): Promise<{ items: MarketCandle[] }>; write(route: TerminalFactRoute, items: MarketCandle[]): Promise<void> }) {
    const [raw] = await this.cache.zrangebyscore(QUEUE, '-inf', Date.now(), 'LIMIT', 0, 1)
    if (!raw) return
    const r = JSON.parse(raw) as Request, captured = r.selection.state
    if (await this.cache.get(proofKey(r))) { await this.cache.zrem(QUEUE, raw); return }
    const scope = { pool: r.selection.pool, symbol: r.selection.standardSymbol }
    if (!captured.source || !captured.resolvedSymbol || !await selector.isCurrent(scope, captured)) { await this.cache.zrem(QUEUE, raw); return }
    const source = captured.source, route = await routes.current(source.accountId)
    if (!route || route.userId !== source.ownerUserId || route.connectionId !== source.connectionId || route.connectionEpoch !== source.connectionEpoch) return
    try {
      // Query both known endpoints; no-data responses without these anchors cannot prove coverage.
      const from = Date.parse(r.gap.from), to = Date.parse(r.gap.to)
      if (!Number.isSafeInteger(r.step) || r.step <= 0 || to <= from || (to-from)/r.step > 10000) throw new Error('market_gap_range_invalid')
      const rows = new Map<string, MarketCandle>()
      for (let before = to + 1; before > from;) {
        const limit = Math.min(200, Math.ceil((before-from)/r.step) + 1)
        const page = await io.read(source.ownerUserId, source.accountId, captured.resolvedSymbol, r.timeframe, before, limit)
        if (!await selector.isCurrent(scope, captured) || (await routes.current(source.accountId))?.connectionId !== route.connectionId) throw new Error('market_gap_source_changed')
        for (const item of page.items) {
          if (!item.closed || item.accountId !== source.accountId || item.symbol !== captured.resolvedSymbol || item.timeframe !== r.timeframe) throw new Error('market_gap_response_invalid')
          if (Date.parse(item.openTime) >= from && Date.parse(item.openTime) <= to) rows.set(item.openTime, item)
        }
        before -= (limit - 1) * r.step
      }
      if (!rows.has(r.gap.from) || !rows.has(r.gap.to)) throw new Error('market_gap_anchors_missing')
      const items = [...rows.values()].sort((a,b) => a.openTime.localeCompare(b.openTime))
      await io.write(route, items)
      if (!await selector.isCurrent(scope, captured)) throw new Error('market_gap_source_changed')
      for (let i=1; i<items.length; i++) {
        if (Date.parse(items[i]!.openTime)-Date.parse(items[i-1]!.openTime) <= r.step) continue
        const gap = { from: items[i-1]!.openTime, to: items[i]!.openTime }
        await this.cache.set(proofKey({ ...r, gap }), JSON.stringify({ gap, checkedAt: new Date().toISOString(), source: captured.source }))
      }
      await this.cache.zrem(QUEUE, raw)
    } catch (error) {
      await this.cache.zadd(QUEUE, Date.now() + 60000, raw)
      throw error
    }
  }
}
