<script setup lang="ts">
import { Cable, Eye, RefreshCw, ShieldCheck } from '@lucide/vue'
import type { AccountSnapshot, TradingAccount } from '@aurum/contracts'
import { computed } from 'vue'
import { Badge } from '@aurum/ui/badge'
import { Button } from '@aurum/ui/button'
import { Card, CardContent } from '@aurum/ui/card'
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from '@aurum/ui/select'

const props = withDefaults(defineProps<{
  accounts: readonly TradingAccount[]
  accountId: string | null
  account: TradingAccount | AccountSnapshot | null
  loading?: boolean
  switching?: boolean
  observer?: boolean
  realtime?: string
}>(), { loading: false, switching: false, observer: false, realtime: 'idle' })

const emit = defineEmits<{ 'account-change': [accountId: string]; refresh: [] }>()
const bridgeOnline = computed(() => (props.account?.bridgeState ?? 'offline') === 'online')
const accountLabel = computed(() => props.account ? `${props.account.platform.toUpperCase()} · ${props.account.login}` : '等待选择账户')
const realtimeLabel = computed(() => ({ live: '实时同步', connecting: '连接中', recovering: '正在恢复', offline: '快照模式', idle: '未连接' })[props.realtime] ?? '未连接')

function selectAccount(value: unknown) {
  const id = String(value)
  if (id && id !== props.accountId) emit('account-change', id)
}
</script>

<template>
  <Card class="shadow-none">
    <CardContent class="flex flex-col gap-4 p-4 lg:flex-row lg:items-center lg:justify-between lg:p-5">
      <div class="flex min-w-0 items-center gap-3">
        <span class="flex size-11 shrink-0 items-center justify-center rounded-xl bg-primary/10 text-primary"><ShieldCheck class="size-5" aria-hidden="true" /></span>
        <div class="min-w-0">
          <div class="flex flex-wrap items-center gap-2">
            <strong class="truncate text-base">{{ accountLabel }}</strong>
            <Badge v-if="observer" variant="secondary"><Eye aria-hidden="true" />观摩模式</Badge>
          </div>
          <p class="mt-0.5 truncate text-xs text-muted-foreground">{{ account?.server ?? '连接量见智桥后显示交易服务器' }}</p>
        </div>
      </div>

      <div class="flex flex-wrap items-center gap-2">
        <Badge :variant="bridgeOnline ? 'default' : 'outline'"><Cable aria-hidden="true" />{{ bridgeOnline ? '智桥在线' : '智桥离线' }}</Badge>
        <Badge variant="outline"><span class="size-1.5 rounded-full bg-current" aria-hidden="true" />{{ realtimeLabel }}</Badge>
        <Select :model-value="accountId ?? undefined" :disabled="loading || switching || !accounts.length" @update:model-value="selectAccount">
          <SelectTrigger class="min-h-11 w-[min(20rem,78vw)]" aria-label="切换风控账户"><SelectValue placeholder="选择交易账户" /></SelectTrigger>
          <SelectContent>
            <SelectGroup>
              <SelectItem v-for="item in accounts" :key="item.id" :value="item.id">{{ item.platform.toUpperCase() }} · {{ item.login }} · {{ item.server }}</SelectItem>
            </SelectGroup>
          </SelectContent>
        </Select>
        <Button variant="outline" size="icon-lg" :disabled="loading || switching" aria-label="刷新风控状态" @click="emit('refresh')">
          <RefreshCw :class="loading || switching ? 'animate-spin motion-reduce:animate-none' : ''" data-icon="inline-start" />
        </Button>
      </div>
    </CardContent>
  </Card>
</template>
