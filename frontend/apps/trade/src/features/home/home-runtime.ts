import { ref } from 'vue'
import type { MarketCandle, MarketQuote, OpenPosition, PendingOrder, PublicMarketSnapshotData } from '@aurum/contracts'
import { applyAccountSnapshot } from '~/features/trading-context'
export { accountSnapshot, realtimeState } from '~/features/trading-context'

export type ChartQuote = Omit<MarketQuote, 'accountId' | 'tradeMode'>
export type ChartCandle = Omit<MarketCandle, 'accountId'>
export const marketSourceKey = ref<string | null>(null)
export const marketQuote = ref<ChartQuote | null>(null)
export const marketCandles = ref<ChartCandle[]>([])
export const marketStructure = ref<PublicMarketSnapshotData['structure']>(null)
export const openPositions = ref<OpenPosition[]>([])
export const pendingOrders = ref<PendingOrder[]>([])
export const resourceRevisions = ref({ account: 0, quote: 0, candle: 0, positions: 0, pendingOrders: 0 })


export function clearAccountRuntime() {
  applyAccountSnapshot(null)
  marketSourceKey.value = null
  marketQuote.value = null
  marketCandles.value = []
  marketStructure.value = null
  openPositions.value = []
  pendingOrders.value = []
  resourceRevisions.value = { account: 0, quote: 0, candle: 0, positions: 0, pendingOrders: 0 }
}
