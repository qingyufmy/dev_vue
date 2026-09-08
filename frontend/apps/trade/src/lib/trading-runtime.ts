import { computed, ref } from 'vue'
import type { AccountSnapshot, MarketCandle, MarketQuote, OpenPosition, PendingOrder } from '@aurum/contracts'
import { tradingContext, tradingAccounts } from '~/features/trading-context'

export const accountSnapshot = ref<AccountSnapshot | null>(null)
export const marketQuote = ref<MarketQuote | null>(null)
export const marketCandles = ref<MarketCandle[]>([])
export const openPositions = ref<OpenPosition[]>([])
export const pendingOrders = ref<PendingOrder[]>([])
export const realtimeState = ref<'idle' | 'connecting' | 'live' | 'recovering' | 'offline'>('idle')
export const resourceRevisions = ref({ account: 0, quote: 0, candle: 0, positions: 0, pendingOrders: 0 })

export const currentAccount = computed(() => accountSnapshot.value ?? tradingAccounts.value.find((item) => item.id === tradingContext.value?.accountId) ?? null)

export function clearAccountRuntime() {
  accountSnapshot.value = null
  marketQuote.value = null
  marketCandles.value = []
  openPositions.value = []
  pendingOrders.value = []
  resourceRevisions.value = { account: 0, quote: 0, candle: 0, positions: 0, pendingOrders: 0 }
}
