<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import { createApiClient } from '@aurum/api-client'
import { ChevronDown } from '@lucide/vue'
import { Button } from '@aurum/ui/button'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@aurum/ui/dropdown-menu'
import { useTradeSession } from '~/features/auth'
import { applyTradingAccounts, applyTradingContext, tradingAccounts, tradingContext,
  contextCommandState, runContextCommand, preferredOnlineAccount } from '~/features/trading-context'

const client = createApiClient()
const { session } = useTradeSession()
const error = ref('')
const loading = ref(false)
const online = computed(() => tradingAccounts.value.filter(account => account.bridgeState === 'online'))
const selected = computed(() => online.value.find(account => account.id === tradingContext.value?.accountId))
const label = computed(() => tradingContext.value?.mode === 'observer' ? '观摩模式'
  : selected.value ? `${selected.value.platform.toUpperCase()} · ${selected.value.login}` : '暂无在线账号')
let generation = 0
let polling = false

async function choose(id: string) {
  const identity = session.value, context = tradingContext.value
  if (!identity || !context || contextCommandState.value.busy || loading.value || !online.value.some(account => account.id === id)) return
  if (context.mode === 'full' && context.accountId === id) return
  const scope = generation
  loading.value = true; error.value = ''
  try {
    const result = await runContextCommand(identity, 'select_account', id, context.revision)
    if (scope === generation) applyTradingContext(result.data)
  } catch {
    if (scope === generation) error.value = '切换未完成，请重试'
  } finally { if (scope === generation) loading.value = false }
}

async function refresh() {
  if (!session.value || polling || loading.value || contextCommandState.value.busy) return
  polling = true
  const scope = generation, previous = tradingContext.value
  try {
    const [accounts, context] = await Promise.all([client.listTradingAccounts(), client.getTradingContext()])
    if (scope !== generation || loading.value || contextCommandState.value.busy || tradingContext.value !== previous) return
    error.value = ''
    applyTradingAccounts(accounts.data.items)
    applyTradingContext(context.data)
    // Preserve an explicit observer session. Own-account defaults come only from live gateway routes.
    if (context.data.mode !== 'observer') {
      const id = preferredOnlineAccount(accounts.data.items, context.data.accountId)
      if (id && id !== context.data.accountId) await choose(id)
    }
  } catch { if (scope === generation) error.value = '在线账号暂不可用' }
  finally { polling = false }
}

watch(() => JSON.stringify([session.value?.user.id, session.value?.authenticated_at]), () => {
  generation++; loading.value = false; error.value = ''
  void refresh()
}, { immediate: true })
const timer = setInterval(() => { void refresh() }, 5000)
onBeforeUnmount(() => { generation++; clearInterval(timer) })
</script>

<template>
  <div v-if="online.length > 1" class="min-w-0 shrink-0">
    <DropdownMenu>
      <DropdownMenuTrigger as-child>
        <Button variant="outline" class="h-11 max-w-[46vw] gap-2 px-3 sm:max-w-64" aria-label="切换在线交易账号"
          :disabled="loading || contextCommandState.busy || online.length === 0" :aria-busy="loading">
          <span class="truncate tabular-nums">{{ label }}</span>
          <ChevronDown v-if="online.length > 1 || tradingContext?.mode === 'observer'" class="size-4 shrink-0" aria-hidden="true" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" class="min-w-44">
        <DropdownMenuItem v-for="account in online" :key="account.id" :disabled="loading"
          class="min-h-11 tabular-nums" @select="choose(account.id)">
          {{ account.platform.toUpperCase() }} · {{ account.login }}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
    <p v-if="error" role="status" class="mt-1 max-w-52 text-xs text-destructive">{{ error }}</p>
  </div>
</template>
