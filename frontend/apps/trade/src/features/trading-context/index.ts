import { readonly, ref } from 'vue'
import type { ObserverChannel, TradingAccount, TradingContext } from '@aurum/contracts'

const context = ref<TradingContext | null>(null)
const accounts = ref<TradingAccount[]>([])
const channels = ref<ObserverChannel[]>([])

export const tradingContext = readonly(context)
export const tradingAccounts = readonly(accounts)
export const observerChannels = readonly(channels)

// Callers accept server responses only after their request/user scope checks.
// This module owns the projection; it does not grant account access.
export function applyTradingContext(value: TradingContext | null) { context.value = structuredClone(value) }
export function applyTradingAccounts(value: TradingAccount[]) { accounts.value = structuredClone(value) }
export function applyObserverChannels(value: ObserverChannel[]) { channels.value = structuredClone(value) }
