import { capturePriceActionEvidence, captureChanCalculation, chanHistoryTarget, unresolvedMarketGap, type ConfirmedMarketGap } from '../../market/index.js'
import { calculateEma34Evidence } from '../../strategies/index.js'
import type { AnalysisTradingReader } from '../application/trading-read-capabilities.js'
import type { Timeframe, TradingAccountSummary } from '../../trading/index.js'
import type { AnalysisMarketPlan, AnalysisMarketSource } from '../application/analysis-context-builder.js'
import type { JsonObject } from '../domain/inference.js'
import { InferenceError } from '../domain/inference.js'
import type { StrategyMarketSourceAccess } from '../../market/index.js'
import { candleCoverage } from '../domain/candle-coverage.js'

export class TradingAnalysisMarketSource implements AnalysisMarketSource {
  constructor(private readonly trading: AnalysisTradingReader, private readonly sourceAccess?: StrategyMarketSourceAccess,
    private readonly publicClock?: () => Promise<{ offset: number; checkedAt: string } | null>,
    private readonly confirmedGaps?: (selection: Parameters<StrategyMarketSourceAccess['assertCurrent']>[1], timeframe: string, items: Array<{ openTime: string }>, step: number) => Promise<ConfirmedMarketGap[]>) {}

  async read(input: { userId: number; preferredAccountId: string | null; symbol: string; strategyId?: string; strategyVersionId?: string; referenceTime?: string; plan: AnalysisMarketPlan }) {
    const authorization = { userId: input.userId, strategyId: input.strategyId ?? '', versionId: input.strategyVersionId ?? '' }
    const selection = await this.sourceAccess?.select({ ...authorization, symbol: input.symbol })
    const selectedAccount = selection?.state.source
      ? await this.trading.findOwnedAccount(selection.state.source.ownerUserId, selection.state.source.accountId) : null
    if (selection && !selectedAccount) throw new Error('market_source_changed')
    const requestedSymbol = input.symbol
    if (selection) input = { ...input, symbol: selection.state.resolvedSymbol! }
    const referenceTime = input.referenceTime ?? new Date().toISOString()
    const intervalMinutes = { M1: 1, M5: 5, M15: 15, M30: 30, H1: 60, H4: 240, D1: 1440 }
    const accounts = selectedAccount ? [selectedAccount] : await this.candidates(input.userId, input.preferredAccountId)
    for (const account of accounts) {
      const quote = await this.trading.getQuote(account.id, input.symbol)
      if (!quote) continue
      const candles: Record<string, JsonObject[]> = {}
      let ema34: JsonObject | undefined
      const chan: Record<string, JsonObject> = {}
      const calculationArchive: Record<string, JsonObject> = {}
      const events: Record<string, JsonObject> = {}
      const needsClock = input.plan.chan?.enabled || input.plan.priceAction?.enabled
      const sharedClock = needsClock && selection?.pool.kind === 'public' && this.publicClock ? await this.publicClock() : null
      const clock = needsClock && selection?.pool.kind === 'public' && this.publicClock
        ? sharedClock ? { clockStatus: 'calibrated', timezoneOffsetMinutes: sharedClock.offset, observedAt: sharedClock.checkedAt, dailyCalibration: true } : null
        : needsClock ? await this.trading.getAccountSnapshot(account.id, selection?.state.source?.ownerUserId ?? input.userId) : null
      let complete = true
      for (const timeframe of new Set([...input.plan.timeframes, ...(input.plan.ema34 ? [input.plan.ema34.timeframe] : [])])) {
        const modelLimit = input.plan.candleLimits?.[timeframe] ?? input.plan.candleLimit
        const indicatorFrame = input.plan.ema34?.timeframe === timeframe
        const items = await this.trading.listCandles(account.id, input.symbol, timeframe as Timeframe, Math.max(input.plan.timeframes.includes(timeframe) ? modelLimit : 0, indicatorFrame ? 61 : 0, input.plan.priceAction?.enabled && input.plan.timeframes.includes(timeframe) ? 30 : 0, input.plan.chan?.enabled && input.plan.timeframes.includes(timeframe) ? chanHistoryTarget(timeframe) : 0))
        // At a period boundary, wait for the terminal's final close update instead of
        // freezing a forming bar as the latest available history.
        const verifiedGaps = selection && this.confirmedGaps ? await this.confirmedGaps(selection, timeframe, items, intervalMinutes[timeframe] * 60_000) : undefined
        const tail = items.at(-1)
        const closeAge = tail ? Date.parse(referenceTime) - Date.parse(tail.openTime) - intervalMinutes[timeframe] * 60_000 : -1
        if (tail && !tail.closed && closeAge >= 0)
          throw new InferenceError('market_candle_close_pending', 409)
        if (items.length === 0 && input.plan.timeframes.includes(timeframe)) { complete = false; break }
        if (input.plan.timeframes.includes(timeframe)) candles[timeframe] = items.slice(-modelLimit).map(item => ({
          open_time: item.openTime, open: item.open, high: item.high, low: item.low, close: item.close,
          tick_volume: item.tickVolume, closed: item.closed, revision: item.revision,
        }))
        if (input.plan.priceAction?.enabled && input.plan.timeframes.includes(timeframe)) {
          events[timeframe] = JSON.parse(JSON.stringify(capturePriceActionEvidence(items, {
            sourceAccountId: account.id, symbol: input.symbol, timeframe, timeframeMs: intervalMinutes[timeframe] * 60_000, referenceTime, clock, ...(verifiedGaps ? { confirmedGaps: verifiedGaps } : {}),
          }))) as JsonObject
        }
        if (input.plan.chan?.enabled && input.plan.timeframes.includes(timeframe)) {
          const { evidence,archive } = captureChanCalculation(items, { timeframe, timeframeMs:intervalMinutes[timeframe]*60_000,
            referenceTime,accountId:account.id,platform:account.platform,clock, ...(verifiedGaps ? { confirmedGaps: verifiedGaps } : {}) })
          chan[timeframe] = JSON.parse(JSON.stringify(evidence)) as JsonObject
          calculationArchive[timeframe] = JSON.parse(JSON.stringify(archive)) as JsonObject
        }
        if (indicatorFrame) {
          const history = items.slice(-61)
          const timeframeMs = intervalMinutes[timeframe] * 60_000
          const bars = history.map(item => ({ openTimeUtcMs: Date.parse(item.openTime), close: item.close, closed: item.closed }))
          const internalGapUnresolved = unresolvedMarketGap(bars.map(bar => bar.openTimeUtcMs), timeframeMs, verifiedGaps)
          ema34 = { ...calculateEma34Evidence(bars, { timeframeMs, referenceTimeUtcMs: Date.parse(referenceTime), internalGapUnresolved }),
            source_account_id: account.id, symbol: input.symbol, timeframe, reference_time: referenceTime,
            gap_policy: verifiedGaps?.length ? 'terminal_confirmed/v1' : 'contiguous_only/v1', requested_bars: 61,
            ...(verifiedGaps ? { confirmed_gaps: verifiedGaps.map(({ from, to }) => ({ from, to })) } : {}),
            input_bars: history.map(item => ({ open_time: item.openTime, close: item.close, closed: item.closed, revision: item.revision })) }
        }
      }
      if (!complete) continue
      if (selection) await this.sourceAccess!.assertCurrent(authorization, selection)
      return {
        ...(selection ? { standard_symbol: requestedSymbol, source_generation: selection.state.generation,
          source_mode: selection.pool.kind, source_connection_id: selection.state.source!.connectionId } : {}),
        ...(input.plan.priceAction?.enabled ? { events } : {}),
        ...(input.plan.chan?.enabled ? { calculation_archive: calculationArchive } : {}),
        source_account_id: account.id, source_platform: account.platform, source_broker_server: account.server,
        symbol: input.symbol,
        quote: { bid: quote.bid, ask: quote.ask, last: quote.last, spread: quote.spread, trade_mode: quote.tradeMode, observed_at: quote.observedAt, revision: quote.revision },
        candles,
        candle_coverage: candleCoverage(input.plan.timeframes.map(timeframe => ({ timeframe,
          count: input.plan.candleLimits?.[timeframe] ?? input.plan.candleLimit })), candles),
        ...(ema34 || input.plan.chan?.enabled ? { indicators: { ...(ema34 ? { ema34 } : {}), ...(input.plan.chan?.enabled ? { chan } : {}) } } : {}),
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
