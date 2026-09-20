import { marketCandleSchema, marketQuoteSchema, type BrowserRealtimeEvent, type MarketCandle, type MarketQuote, type Timeframe } from '@aurum/contracts'
import { marketCandles, marketQuote, marketSourceKey, marketStructure, resourceRevisions } from './home-runtime'

function stripCandle(value: MarketCandle) {
  const { accountId: _accountId, ...candle } = value
  return candle
}

function stripQuote(value: MarketQuote) {
  const { accountId: _accountId, tradeMode: _tradeMode, ...quote } = value
  return quote
}

export function terminalMarketSourceKey(accountId: string, symbol: string, timeframe: Timeframe) {
  return `terminal:${accountId}:${symbol}:${timeframe}`
}

export function applyTerminalMarketSnapshot(input: { accountId: string; symbol: string; timeframe: Timeframe; candles: MarketCandle[]; quote: MarketQuote | null }) {
  marketSourceKey.value = terminalMarketSourceKey(input.accountId, input.symbol, input.timeframe)
  marketCandles.value = input.candles.map(stripCandle).sort((left, right) => left.openTime.localeCompare(right.openTime))
  marketQuote.value = input.quote ? stripQuote(input.quote) : null
  marketStructure.value = null
  resourceRevisions.value.quote = input.quote?.revision ?? 0
  resourceRevisions.value.candle = Math.max(0, ...input.candles.map(item => item.revision))
}

export function mergeTerminalMarketHistory(accountId: string, symbol: string, timeframe: Timeframe, candles: MarketCandle[]) {
  if (marketSourceKey.value !== terminalMarketSourceKey(accountId, symbol, timeframe)) return false
  const merged = new Map(marketCandles.value.map(item => [item.openTime, item]))
  for (const item of candles) {
    if (item.accountId !== accountId || item.symbol !== symbol || item.timeframe !== timeframe) return false
    const candle = stripCandle(item)
    const previous = merged.get(candle.openTime)
    if (!previous || previous.revision <= candle.revision) merged.set(candle.openTime, candle)
  }
  marketCandles.value = [...merged.values()].sort((left, right) => left.openTime.localeCompare(right.openTime)).slice(-2000)
  resourceRevisions.value.candle = Math.max(resourceRevisions.value.candle, ...candles.map(item => item.revision))
  return true
}

export function applyTerminalMarketEvent(event: BrowserRealtimeEvent, accountId: string, symbol: string, timeframe: Timeframe) {
  if (event.scope.trading_account_id !== accountId || event.scope.observer_channel_id !== null || event.resource.kind === 'public_market') return 'ignored'
  if (event.type === 'market.quote.updated') {
    const data = typeof event.data === 'object' && event.data !== null ? event.data : {}
    const parsed = marketQuoteSchema.safeParse({ ...data, account_id: accountId, trade_mode: 'unknown', revision: event.revision })
    if (!parsed.success || parsed.data.symbol !== symbol) return 'ignored'
    if (parsed.data.revision > resourceRevisions.value.quote) {
      marketQuote.value = stripQuote(parsed.data)
      resourceRevisions.value.quote = parsed.data.revision
    }
    return 'applied'
  }
  if (event.type === 'market.candle.updated' || event.type === 'market.candle.closed') {
    const data = typeof event.data === 'object' && event.data !== null ? event.data : {}
    const parsed = marketCandleSchema.safeParse({ ...data, account_id: accountId, revision: event.revision })
    if (!parsed.success || parsed.data.symbol !== symbol || parsed.data.timeframe !== timeframe) return 'ignored'
    mergeTerminalMarketHistory(accountId, symbol, timeframe, [parsed.data])
    return 'applied'
  }
  return 'ignored'
}
