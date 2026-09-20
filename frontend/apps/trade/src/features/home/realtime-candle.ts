import type { Timeframe } from '@aurum/contracts'
import type { ChartCandle } from './home-runtime'
import { marketCandles, marketQuote } from './home-runtime'

const TIMEFRAME_MS: Record<Timeframe, number> = {
  M1: 60_000,
  M5: 300_000,
  M15: 900_000,
  M30: 1_800_000,
  H1: 3_600_000,
  H4: 14_400_000,
  D1: 86_400_000,
}

/** Keep the forming candle visually aligned with the latest accepted quote. */
export function syncCandleWithQuote() {
  const quote = marketQuote.value
  const last = marketCandles.value.at(-1)
  if (!quote || !last || quote.symbol !== last.symbol) return

  const elapsed = Date.parse(quote.observedAt) - Date.parse(last.openTime)
  const duration = TIMEFRAME_MS[last.timeframe]
  const price = Number(quote.bid)
  if (!Number.isFinite(elapsed) || elapsed < 0 || !Number.isFinite(price) || price <= 0) return

  // Anchor to the terminal's last bar to preserve broker H4/D1 alignment.
  // Missing periods are repaired by a snapshot instead of fabricating bars.
  if (elapsed >= duration) {
    if (elapsed >= duration * 2) return
    marketCandles.value = [...marketCandles.value, {
      ...last,
      openTime: new Date(Date.parse(last.openTime) + duration).toISOString(),
      open: quote.bid,
      high: quote.bid,
      low: quote.bid,
      close: quote.bid,
      tickVolume: '0',
      closed: false,
      revision: 0,
    }]
    return
  }

  if (last.closed) return
  if (quote.bid === last.close && price <= Number(last.high) && price >= Number(last.low)) return
  const updated: ChartCandle = {
    ...last,
    high: price > Number(last.high) ? quote.bid : last.high,
    low: price < Number(last.low) ? quote.bid : last.low,
    close: quote.bid,
  }
  // Local rendering never advances the server's revision watermark.
  marketCandles.value = [...marketCandles.value.slice(0, -1), updated]
}
