import type { MarketSourceCandidates, MarketSourceCandidate, MarketSourceScope, MarketSourceProbe } from '../../market/index.js'
import { parseBridgeMarketState } from '../../market/index.js'
import type { TradingReadRepository } from '../application/trading-ports.js'
import type { TerminalMarketReader } from '../application/terminal-market-reader.js'
interface LiveRoute { accountId: string; userId: number; connectionId: string; connectionEpoch: number }
export class BridgeMarketSourceCandidates implements MarketSourceCandidates {
  constructor(private readonly accounts: Pick<TradingReadRepository, 'listAccounts'>,
    private readonly providers: { list(): Promise<number[]> }, private readonly routes: { current(accountId: string): Promise<LiveRoute | null> },
    private readonly reader: TerminalMarketReader) {}
  async list(scope: MarketSourceScope) {
    const owners = scope.pool.kind === 'public' ? await this.providers.list() : [scope.pool.userId]
    const result: MarketSourceCandidate[] = []
    for (const owner of owners) {
      for (const account of await this.accounts.listAccounts(owner)) {
        if (account.bridgeState !== 'online') continue
        const route = await this.routes.current(account.id)
        if (route?.userId === owner && route.accountId === account.id) result.push({ accountId: account.id, ownerUserId: owner,
          connectionId: route.connectionId, connectionEpoch: route.connectionEpoch })
        if (result.length > 100) throw new Error('market_source_inventory_limit')
      }
    }
    return result
  }
  async probe(scope: MarketSourceScope, source: MarketSourceCandidate): Promise<MarketSourceProbe> {
    try {
      const page = await this.reader.read(source.ownerUserId, source.accountId,
        { kind: 'instrument', symbol: scope.symbol, timeframe: null, before: null, limit: 1, cursor: null })
      // MT4 instrument uses symbol; MT5 symbol_snapshot uses name.
      const identities = [page.items[0]?.symbol, page.items[0]?.name].filter(value => value !== undefined)
      const resolved = identities[0]
      if (page.items.length !== 1 || typeof resolved !== 'string' || !/^[A-Za-z0-9._-]{1,64}$/.test(resolved)
        || identities.some(value => value !== resolved) || !resolved.toUpperCase().startsWith(scope.symbol)) return { status: 'unsupported' }
      const marketState = parseBridgeMarketState(page.items[0]?.market_state)
      return { status: 'ready', resolvedSymbol: resolved, ...(marketState && Math.abs(Date.now() - marketState.checked_at_utc_msc) <= 30000 ? { marketState } : {}) }
    } catch (error) {
      const code = (error as { code?: string }).code
      if (code === 'terminal_market_busy' || code === 'bridge_query_inflight') return { status: 'busy' }
      if (code === 'terminal_market_symbol_unsupported') return { status: 'unsupported' }
      return { status: 'temporary_failure' }
    }
  }
}
