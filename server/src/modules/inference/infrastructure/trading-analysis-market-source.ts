import type { TradingReadRepository } from '../../trading/application/trading-ports.js'
import type { Timeframe, TradingAccountSummary } from '../../trading/domain/trading.js'
import type { AnalysisMarketPlan, AnalysisMarketSource } from '../application/analysis-context-builder.js'
import type { JsonObject } from '../domain/inference.js'
import { InferenceError } from '../domain/inference.js'

export class TradingAnalysisMarketSource implements AnalysisMarketSource {
  constructor(private readonly trading: TradingReadRepository) {}

  async read(input: { userId: number; preferredAccountId: string | null; symbol: string; plan: AnalysisMarketPlan }) {
    const accounts = await this.candidates(input.userId, input.preferredAccountId)
    for (const account of accounts) {
      const quote = await this.trading.getQuote(account.id, input.symbol)
      if (!quote) continue
      const candles: Record<string, JsonObject[]> = {}
      let complete = true
      for (const timeframe of input.plan.timeframes) {
        const items = await this.trading.listCandles(account.id, input.symbol, timeframe as Timeframe, input.plan.candleLimit)
        if (items.length === 0) { complete = false; break }
        candles[timeframe] = items.map(item => ({
          open_time: item.openTime, open: item.open, high: item.high, low: item.low, close: item.close,
          tick_volume: item.tickVolume, closed: item.closed, revision: item.revision,
        }))
      }
      if (!complete) continue
      return {
        source_account_id: account.id, source_platform: account.platform, source_broker_server: account.server,
        symbol: input.symbol,
        quote: { bid: quote.bid, ask: quote.ask, last: quote.last, spread: quote.spread, trade_mode: quote.tradeMode, observed_at: quote.observedAt, revision: quote.revision },
        candles,
      } satisfies JsonObject
    }
    throw new InferenceError('market_snapshot_unavailable', 409)
  }

  private async candidates(userId: number, preferredAccountId: string | null) {
    const preferred = preferredAccountId ? await this.trading.findOwnedAccount(userId, preferredAccountId) : null
    const available = (await this.trading.listAccounts(userId))
      .filter(item => item.bridgeState === 'online')
      .sort((left, right) => left.id.localeCompare(right.id, 'en', { numeric: true }))
    const unique = new Map<string, TradingAccountSummary>()
    if (preferred?.bridgeState === 'online') unique.set(preferred.id, preferred)
    for (const account of available) unique.set(account.id, account)
    return [...unique.values()]
  }
}
