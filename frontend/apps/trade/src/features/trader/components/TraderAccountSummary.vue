<script setup lang="ts">
import { Cable, Eye, RefreshCw, ShieldCheck, WalletCards } from '@lucide/vue'
import type { AccountSnapshot, TradingAccount } from '@aurum/contracts'
import { computed } from 'vue'
import { Badge } from '@aurum/ui/badge'
import { Button } from '@aurum/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@aurum/ui/card'
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from '@aurum/ui/select'
import { terminalDisplayTimezone } from '~/lib/terminal-display-time'
import { formatDateTime, formatDecimal } from '../model/trader-presentation'

const props = withDefaults(defineProps<{
  accounts?: readonly TradingAccount[]
  accountId?: string | null
  account?: TradingAccount | AccountSnapshot | null
  snapshot?: AccountSnapshot | null
  loading?: boolean
  switching?: boolean
  observer?: boolean
  realtime?: string
}>(), {
  accounts: () => [],
  accountId: null,
  account: null,
  snapshot: null,
  loading: false,
  switching: false,
  observer: false,
  realtime: 'idle',
})

const emit = defineEmits<{
  'account-change': [accountId: string]
  refresh: []
}>()

const displayTimezone = computed(() => terminalDisplayTimezone(props.snapshot?.timezoneOffsetMinutes, props.snapshot?.clockStatus))
const selectedId = computed(() => props.accountId ?? props.account?.id ?? undefined)
const accountName = computed(() => {
  if (!props.account) return '等待选择交易账户'
  return `${props.account.platform.toUpperCase()} · ${props.account.login}`
})
const serverName = computed(() => props.account?.server ?? '连接量见智桥后显示服务器')
const bridgeLabel = computed(() => {
  const state = props.snapshot?.bridgeState ?? props.account?.bridgeState
  return state === 'online' ? '智桥在线' : state === 'paused' ? '已暂停' : state === 'unauthorized' ? '未授权' : '智桥离线'
})
const bridgeVariant = computed(() => (bridgeLabel.value === '智桥在线' ? 'default' : 'outline'))
const permissionLabel = computed(() => props.snapshot?.tradePermission || props.account?.tradePermission ? '允许交易' : '只读账户')
const permissionVariant = computed(() => permissionLabel.value === '允许交易' ? 'default' : 'secondary')
const realtimeLabel = computed(() => ({
  idle: '未连接', connecting: '连接中', live: '实时同步', recovering: '正在恢复', offline: '快照模式',
}[props.realtime] ?? '同步状态未知'))

const metrics = computed(() => [
  { label: '净值', value: props.snapshot?.equity, suffix: props.snapshot?.currency ?? '' },
  { label: '余额', value: props.snapshot?.balance, suffix: props.snapshot?.currency ?? '' },
  { label: '浮动盈亏', value: props.snapshot?.floatingProfit, suffix: props.snapshot?.currency ?? '', profit: true },
  { label: '可用保证金', value: props.snapshot?.freeMargin, suffix: props.snapshot?.currency ?? '' },
  { label: '保证金', value: props.snapshot?.margin, suffix: props.snapshot?.currency ?? '' },
])

function formatMetric(value: string | undefined, suffix: string) {
  if (value === undefined) return '--'
  const formatted = formatDecimal(value, 2)
  return suffix ? `${formatted} ${suffix}` : formatted
}

function metricClass(metric: { profit?: boolean; value?: string }) {
  if (!metric.profit || metric.value === undefined) return ''
  return Number(metric.value) >= 0 ? 'text-trade-up' : 'text-trade-down'
}

function selectAccount(value: unknown) {
  const next = String(value)
  if (next && next !== selectedId.value) emit('account-change', next)
}

function accountOptionLabel(account: TradingAccount) {
  return `${account.platform.toUpperCase()} · ${account.login} · ${account.server}`
}
</script>

<template>
  <Card class="shadow-none">
    <CardHeader class="gap-4 border-b lg:flex-row lg:items-center lg:justify-between">
      <div class="min-w-0">
        <div class="flex flex-wrap items-center gap-2">
          <p class="text-xs font-medium text-muted-foreground">当前交易账户</p>
          <Badge v-if="observer" variant="secondary"><Eye aria-hidden="true" />观摩模式</Badge>
        </div>
        <CardTitle class="mt-1 truncate text-lg">{{ accountName }}</CardTitle>
        <CardDescription class="mt-1 truncate">{{ serverName }}</CardDescription>
      </div>

      <div class="flex flex-wrap items-center gap-2">
        <Badge :variant="bridgeVariant"><Cable aria-hidden="true" />{{ bridgeLabel }}</Badge>
        <Badge :variant="permissionVariant"><ShieldCheck aria-hidden="true" />{{ permissionLabel }}</Badge>
        <Badge variant="outline"><span class="size-1.5 rounded-full bg-current" aria-hidden="true" />{{ realtimeLabel }}</Badge>
        <Select :model-value="selectedId" :disabled="loading || switching || !accounts.length" @update:model-value="selectAccount">
          <SelectTrigger class="min-h-11 w-[min(19rem,82vw)]" aria-label="选择交易账户"><SelectValue placeholder="选择交易账户" /></SelectTrigger>
          <SelectContent>
            <SelectGroup>
              <SelectItem v-for="item in accounts" :key="item.id" :value="item.id">{{ accountOptionLabel(item) }}</SelectItem>
            </SelectGroup>
          </SelectContent>
        </Select>
        <Button variant="outline" size="icon-lg" :disabled="loading || switching" aria-label="刷新账户状态" @click="emit('refresh')">
          <RefreshCw data-icon="inline-start" :class="loading || switching ? 'animate-spin motion-reduce:animate-none' : ''" />
        </Button>
      </div>
    </CardHeader>

    <CardContent class="grid gap-px bg-border p-0 sm:grid-cols-2 lg:grid-cols-5">
      <div v-for="metric in metrics" :key="metric.label" class="bg-card px-5 py-4">
        <p class="text-xs text-muted-foreground">{{ metric.label }}</p>
        <p class="mt-1 font-mono text-base font-semibold tabular-nums" :class="metricClass(metric)">{{ formatMetric(metric.value, metric.suffix) }}</p>
      </div>
      <div class="bg-card px-5 py-4 sm:col-span-2 lg:col-span-5 lg:flex lg:items-center lg:justify-between">
        <div class="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
          <WalletCards class="size-4" aria-hidden="true" />
          <span>终端杠杆</span>
          <strong class="font-mono text-foreground">{{ props.snapshot?.leverage ? `1:${props.snapshot.leverage}` : '--' }}</strong>
          <span aria-hidden="true">·</span>
          <span>显示时区 {{ displayTimezone.label }}</span>
          <span>{{ displayTimezone.statusLabel }}</span>
        </div>
        <p class="mt-2 text-xs text-muted-foreground lg:mt-0">
          {{ props.snapshot ? `快照时间 ${formatDateTime(props.snapshot.observedAt, props.snapshot.timezoneOffsetMinutes)}` : '等待账户快照，当前仅显示账户连接信息' }}
        </p>
      </div>
    </CardContent>
  </Card>
</template>
