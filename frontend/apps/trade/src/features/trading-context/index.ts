export { createContextCommandController, ContextCommandRecoveryError } from './context-command-controller'
export type { ContextCommandAction, ContextCommandScope, ContextCommandIntent, ContextCommandReceipt, ContextCommandTransport, ContextCommandStorage } from './context-command-controller'
import { computed, readonly, ref } from 'vue'
import type { AccountSnapshot, ObserverChannel, TradingAccount, TradingContext } from '@aurum/contracts'
export { createRequestScope } from './request-scope'

const context = ref<TradingContext | null>(null)
const accounts = ref<TradingAccount[]>([])
const channels = ref<ObserverChannel[]>([])

export const tradingContext = readonly(context)
export const tradingAccounts = readonly(accounts)
export const observerChannels = readonly(channels)

// Callers accept server responses only after their request/user scope checks.
// This module owns the projection; it does not grant account access.
export function applyTradingContext(value: TradingContext | null) {
  if (!value || context.value?.accountId !== value?.accountId || context.value?.observerChannelId !== value?.observerChannelId || context.value?.mode !== value?.mode) {
    snapshot.value = null
    connectionState.value = 'idle'
  }
  context.value = structuredClone(value)
}
export function applyTradingAccounts(value: TradingAccount[]) { accounts.value = structuredClone(value) }
export function applyObserverChannels(value: ObserverChannel[]) { channels.value = structuredClone(value) }

const snapshot = ref<AccountSnapshot | null>(null)
const connectionState = ref<'idle' | 'connecting' | 'live' | 'recovering' | 'offline'>('idle')
export const accountSnapshot = readonly(snapshot)
export const realtimeState = readonly(connectionState)
export const currentAccount = computed(() => snapshot.value?.id === context.value?.accountId
  ? accountSnapshot.value : tradingAccounts.value.find(item => item.id === context.value?.accountId) ?? null)

export function applyAccountSnapshot(value: AccountSnapshot | null) { snapshot.value = value ? { ...value } : null }
export function applyRealtimeState(value: typeof connectionState.value) { connectionState.value = value }
