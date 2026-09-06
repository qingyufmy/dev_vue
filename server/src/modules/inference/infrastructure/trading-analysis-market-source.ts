import { calculateEma34Evidence } from '../../strategies/index.js'
import type { TradingReadRepository } from '../../trading/application/trading-ports.js'
import type { Timeframe, TradingAccountSummary } from '../../trading/domain/trading.js'
import type { AnalysisMarketPlan, AnalysisMarketSource } from '../application/analysis-context-builder.js'
import type { JsonObject } from '../domain/inference.js'
import { InferenceError } from '../domain/inference.js'

export class TradingAnalysisMarketSource implements AnalysisMarketSource {
  constructor(private readonly trading: TradingReadRepository) {}

  async read(input: { userId: number; preferredAccountId: string | null; symbol: string; referenceTime?: string; plan: AnalysisMarketPlan }) {
    const referenceTime = input.referenceTime ?? new Date().toISOString()
    const intervalMinutes = { M1: 1, M5: 5, M15: 15, M30: 30, H1: 60, H4: 240, D1: 1440 }
    const accounts = await this.candidates(input.userId, input.preferredAccountId)
    for (const account of accounts) {
      const quote = await this.trading.getQuote(account.id, input.symbol)
      if (!quote) continue
      const candles: Record<string, JsonObject[]> = {}
      let ema34: JsonObject | undefined
      let complete = true
      for (const timeframe of new Set([...input.plan.timeframes, ...(input.plan.ema34 ? [input.plan.ema34.timeframe] : [])])) {
        const modelLimit = input.plan.candleLimits?.[timeframe] ?? input.plan.candleLimit
        const indicatorFrame = input.plan.ema34?.timeframe === timeframe
        const items = await this.trading.listCandles(account.id, input.symbol, timeframe as Timeframe, Math.max(input.plan.timeframes.includes(timeframe) ? modelLimit : 0, indicatorFrame ? 61 : 0))
        if (items.length === 0 && input.plan.timeframes.includes(timeframe)) { complete = false; break }
        if (input.plan.timeframes.includes(timeframe)) candles[timeframe] = items.slice(-modelLimit).map(item => ({
          open_time: item.openTime, open: item.open, high: item.high, low: item.low, close: item.close,
          tick_volume: item.tickVolume, closed: item.closed, revision: item.revision,
        }))
        if (indicatorFrame) {
          const history = items.slice(-61)
          const timeframeMs = intervalMinutes[timeframe] * 60_000
          const bars = history.map(item => ({ openTimeUtcMs: Date.parse(item.openTime), close: item.close, closed: item.closed }))
          const internalGapUnresolved = bars.some((bar, i) => i > 0 && bar.openTimeUtcMs - bars[i - 1]!.openTimeUtcMs !== timeframeMs)
          ema34 = { ...calculateEma34Evidence(bars, { timeframeMs, referenceTimeUtcMs: Date.parse(referenceTime), internalGapUnresolved }),
            source_account_id: account.id, symbol: input.symbol, timeframe, reference_time: referenceTime,
            gap_policy: 'contiguous_only/v1', requested_bars: 61,
            input_bars: history.map(item => ({ open_time: item.openTime, close: item.close, closed: item.closed, revision: item.revision })) }
        }
      }
      if (!complete) continue
      return {
        source_account_id: account.id, source_platform: account.platform, source_broker_server: account.server,
        symbol: input.symbol,
        quote: { bid: quote.bid, ask: quote.ask, last: quote.last, spread: quote.spread, trade_mode: quote.tradeMode, observed_at: quote.observedAt, revision: quote.revision },
        candles,
        ...(ema34 ? { indicators: { ema34 } } : {}),
        ...(input.plan.primaryTimeframe ? { primary_timeframe: input.plan.primaryTimeframe,
          market_data_plan: { version: 1, primary_timeframe: input.plan.primaryTimeframe,
            timeframes: input.plan.timeframes.map(timeframe => ({ timeframe, kline_count: input.plan.candleLimits?.[timeframe] ?? input.plan.candleLimit })) } } : {}),
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
