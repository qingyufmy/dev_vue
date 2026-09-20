<script setup lang="ts">
import { Cable, Eye, ShieldCheck } from '@lucide/vue'
import type { AccountSnapshot, TradingAccount } from '@aurum/contracts'
import { computed } from 'vue'
import { Badge } from '@aurum/ui/badge'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@aurum/ui/card'
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from '@aurum/ui/select'
import { formatDecimal } from '../model/trader-presentation'

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

const onlineAccounts = computed(() => props.accounts.filter((item) => item.bridgeState === 'online'))
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
const permissionLabel = computed(() => (props.snapshot?.tradePermission ?? props.account?.tradePermission) ? '允许交易' : '只读账户')
const permissionVariant = computed(() => permissionLabel.value === '允许交易' ? 'default' : 'secondary')
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
  return `${account.platform.toUpperCase()} · ${account.login}`
}
</script>

<template>
  <Card class="gap-3 py-4 shadow-none">
    <CardHeader class="flex flex-col gap-3 border-b xl:flex-row xl:items-center xl:justify-between">
      <div class="min-w-0">
        <div class="flex flex-wrap items-center gap-2">
          <p class="text-xs font-medium text-muted-foreground">当前交易账户</p>
          <Badge v-if="observer" variant="secondary"><Eye aria-hidden="true" />观摩模式</Badge>
        </div>
        <CardTitle class="mt-1 truncate text-base">{{ accountName }}</CardTitle>
        <CardDescription class="mt-1 truncate">{{ serverName }} <span class="ml-2 font-mono">{{ snapshot?.leverage ? `1:${snapshot.leverage}` : '' }}</span></CardDescription>
      </div>

      <div class="flex flex-wrap items-center gap-2">
        <Badge :variant="bridgeVariant"><Cable aria-hidden="true" />{{ bridgeLabel }}</Badge>
        <Badge :variant="permissionVariant"><ShieldCheck aria-hidden="true" />{{ permissionLabel }}</Badge>

        <Select v-if="onlineAccounts.length > 1" :model-value="selectedId" :disabled="loading || switching || !accounts.length" @update:model-value="selectAccount">
          <SelectTrigger class="min-h-11 w-[min(19rem,82vw)]" aria-label="选择交易账户"><SelectValue placeholder="选择交易账户" /></SelectTrigger>
          <SelectContent>
            <SelectGroup>
              <SelectItem v-for="item in onlineAccounts" :key="item.id" :value="item.id">{{ accountOptionLabel(item) }}</SelectItem>
            </SelectGroup>
          </SelectContent>
        </Select>

      </div>
    </CardHeader>

    <CardContent class="grid grid-cols-2 gap-px bg-border p-0 sm:grid-cols-3 xl:grid-cols-5">
      <div v-for="metric in metrics" :key="metric.label" class="bg-card px-4 py-3">
        <p class="text-xs text-muted-foreground">{{ metric.label }}</p>
        <p class="mt-1 font-mono text-base font-semibold tabular-nums" :class="metricClass(metric)">{{ formatMetric(metric.value, metric.suffix) }}</p>
      </div>
    </CardContent>
  </Card>
</template>
