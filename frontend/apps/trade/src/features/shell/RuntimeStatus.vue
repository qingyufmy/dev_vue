<script setup lang="ts">
const RuntimeControls = defineAsyncComponent(() => import('~/features/strategist').then(module => module.RuntimeControls))
import { computed, defineAsyncComponent, ref, onBeforeUnmount, watch } from 'vue'
import { createApiClient } from '@aurum/api-client'
import { RouterLink, useRoute } from 'vue-router'
import { Cable, ChevronDown } from '@lucide/vue'
import { Button } from '@aurum/ui/button'
import { DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuItem } from '@aurum/ui/dropdown-menu'
import { tradingAccounts, tradingContext } from '~/features/trading-context'
import { publicMarketStates, activeMarketSymbol, activeTerminalMarketObservation, applyTerminalMarketObservation } from '~/features/trading-context'
import { useTradeSession } from '~/features/auth'
import { readHomePreferences } from '~/features/home/home-preferences'
const client = createApiClient()
const { session } = useTradeSession()
const route = useRoute()
const now = ref(Date.now())
const timer = setInterval(() => { now.value = Date.now() }, 1000)
const market = computed(() => publicMarketStates.value.find(item => item.symbol === activeMarketSymbol.value))
const terminalMarketCurrent = computed(() => activeTerminalMarketObservation.value?.symbol === activeMarketSymbol.value
  && now.value - Date.parse(activeTerminalMarketObservation.value.observedAt) <= 45_000)
const marketState = computed(() => terminalMarketCurrent.value ? 'open'
  : market.value?.checked_at && now.value - Date.parse(market.value.checked_at) <= 45000 ? market.value.state : 'unknown')
const marketLabel = computed(() => ({ open: '交易中', closed: '休市', restricted: '交易受限', stale: '报价待更新', unknown: '待确认' }[marketState.value]))

const currentAccount = computed(() => tradingAccounts.value.find(item => item.id === tradingContext.value?.accountId) ?? null)
watch(() => `${session.value?.user.id ?? ''}:${tradingContext.value?.mode ?? ''}:${tradingContext.value?.accountId ?? ''}:${tradingContext.value?.observerChannelId ?? ''}`,
  () => {
    const userId = String(session.value?.user.id ?? '')
    const context = tradingContext.value
    if (!userId || !context) return
    const scope = context.mode === 'observer' && context.observerChannelId
      ? `observer:${context.observerChannelId}` : context.accountId ? `account:${context.accountId}` : ''
    if (!scope) return
    const stored = readHomePreferences(localStorage, userId, scope)
    if (stored?.symbol) activeMarketSymbol.value = stored.symbol
  }, { immediate: true })
let quoteGeneration = 0
async function refreshTerminalMarket() {
  const generation = ++quoteGeneration
  const accountId = currentAccount.value?.id
  const symbol = activeMarketSymbol.value
  if (!accountId || currentAccount.value?.bridgeState !== 'online' || !symbol || tradingContext.value?.mode === 'observer') return
  try {
    const result = await client.getMarketQuote(accountId, symbol)
    if (result.data && generation === quoteGeneration && currentAccount.value?.id === accountId && activeMarketSymbol.value === symbol) {
      applyTerminalMarketObservation({ symbol, observedAt: result.data.observedAt })
    }
  } catch { /* The last observation expires naturally; public market state remains the fallback. */ }
}
async function primeTerminalClockSymbol() {
  const accountId = currentAccount.value?.id
  const symbol = activeMarketSymbol.value
  if (route.path === '/' || !accountId || currentAccount.value?.bridgeState !== 'online' || !symbol || tradingContext.value?.mode === 'observer') return
  try { await client.getTerminalMarketWindow(accountId, symbol, 'M1', Date.now(), 2) }
  catch { /* Sampling preference is opportunistic; account and page reads remain independent. */ }
}
watch(() => `${currentAccount.value?.id ?? ''}:${currentAccount.value?.bridgeState ?? ''}:${activeMarketSymbol.value}:${tradingContext.value?.mode ?? ''}:${route.path}`,
  () => { void refreshTerminalMarket(); void primeTerminalClockSymbol() }, { immediate: true })
const quoteTimer = setInterval(() => { void refreshTerminalMarket() }, 15000)
onBeforeUnmount(() => { quoteGeneration++; clearInterval(timer); clearInterval(quoteTimer) })
const bridgeLabel = computed(() => currentAccount.value ? {
  online: '智桥已连接', offline: '智桥未连接', paused: '智桥已暂停', replaced: '连接已替换', unauthorized: '智桥未获授权',
}[currentAccount.value.bridgeState] : '智桥状态待确认')
const permissionLabel = computed(() => tradingContext.value?.mode === 'observer' ? '仅供观摩'
  : !currentAccount.value ? '权限待确认' : currentAccount.value.tradePermission ? '账户允许交易' : '账户只读')
</script>

<template>
  <div class="flex flex-wrap items-center gap-x-4 gap-y-2 text-xs" aria-label="运行状态">
    <DropdownMenu>
      <DropdownMenuTrigger as-child>
        <Button variant="ghost" class="h-11 gap-2 px-2 text-xs text-muted-foreground" aria-label="查看连接与权限状态">
          <Cable class="size-4" :class="currentAccount?.bridgeState === 'online' ? 'text-system-ok' : 'text-muted-foreground'" aria-hidden="true" />
          <span class="hidden lg:inline">{{ currentAccount?.bridgeState === 'online' ? '连接正常' : '连接待确认' }}</span>
          <ChevronDown class="size-3" aria-hidden="true" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" class="w-56">
        <DropdownMenuLabel>连接与权限</DropdownMenuLabel>
        <div class="space-y-3 px-2 py-3 text-xs">
          <p>{{ bridgeLabel }}</p><p>{{ permissionLabel }}</p>
        </div>
        <DropdownMenuSeparator />
        <DropdownMenuItem as-child><RouterLink to="/bridge">管理量见智桥</RouterLink></DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
    <RuntimeControls :market-states="publicMarketStates" />
    <span class="flex h-8 items-center gap-2 whitespace-nowrap sm:border-l sm:pl-4" :title="`${activeMarketSymbol} · ${terminalMarketCurrent ? '当前账户终端报价确认' : '平台公共行情确认'}`">
      <span class="size-1.5 rounded-full" :class="marketState === 'open' ? 'bg-system-ok' : 'bg-muted-foreground'" aria-hidden="true" />
      <span>{{ marketLabel }}</span>
    </span>

  </div>
</template>
