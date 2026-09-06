<script setup lang="ts">
import { Cable, Eye, LogOut, ShieldCheck } from '@lucide/vue'
import { computed } from 'vue'
import { terminalDisplayTimezone } from '~/lib/terminal-display-time'
import type { AccountSnapshot, ObserverChannel, TradingAccount } from '@aurum/contracts'
import { Badge } from '@aurum/ui/badge'
import { Card, CardContent, CardHeader, CardTitle } from '@aurum/ui/card'
import { Button } from '@aurum/ui/button'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@aurum/ui/select'

const props = defineProps<{ accounts: TradingAccount[]; observers: ObserverChannel[]; accountId: string | null; observerChannelId: string | null; snapshot: AccountSnapshot | null; loading: boolean }>()
const emit = defineEmits<{ select: [accountId: string]; observer: [observerChannelId: string]; leaveObserver: [] }>()
const displayTimezone = computed(() => terminalDisplayTimezone(props.snapshot?.timezoneOffsetMinutes, props.snapshot?.clockStatus))
const selection = computed(() => props.observerChannelId ? `observer:${props.observerChannelId}` : props.accountId ? `account:${props.accountId}` : undefined)
function select(value: unknown) {
  const selection = String(value)
  if (selection.startsWith('observer:') && selection.length > 9) emit('observer', selection.slice(9))
  else if (selection.startsWith('account:') && selection.length > 8) emit('select', selection.slice(8))
}
const money = (value?: string, currency = '') => value === undefined ? '--' : `${Number(value).toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ${currency}`.trim()
</script>

<template>
  <Card class="shadow-none">
    <CardHeader class="gap-4 border-b lg:flex-row lg:items-center lg:justify-between">
      <div class="min-w-0">
        <p class="text-xs font-medium text-muted-foreground">当前交易账户</p>
        <CardTitle class="mt-1 truncate text-lg">
          {{ snapshot ? `${snapshot.platform.toUpperCase()} · ${snapshot.login}` : '等待账户快照' }}
        </CardTitle>
        <p class="mt-1 truncate text-xs text-muted-foreground">{{ snapshot?.server ?? '连接量见智桥后显示服务器信息' }}</p>
        <p class="mt-1 text-xs text-muted-foreground">显示时区 {{ displayTimezone.label }} · {{ displayTimezone.statusLabel }}</p>
      </div>
      <div class="flex flex-wrap items-center gap-2">
        <Badge v-if="observerChannelId" variant="secondary"><Eye aria-hidden="true" />观摩模式</Badge>
        <Badge :variant="snapshot?.bridgeState === 'online' ? 'default' : 'outline'">
          <Cable aria-hidden="true" />{{ snapshot?.bridgeState === 'online' ? '智桥在线' : '智桥离线' }}
        </Badge>
        <Badge :variant="snapshot?.tradePermission ? 'default' : 'secondary'">
          <ShieldCheck aria-hidden="true" />{{ snapshot?.tradePermission ? '允许交易' : '只读账户' }}
        </Badge>
        <Select :model-value="selection" :disabled="loading || (accounts.length === 0 && observers.length === 0)" @update:model-value="select">
          <SelectTrigger class="h-10 w-[min(18rem,70vw)]"><SelectValue placeholder="选择账户或观摩源" /></SelectTrigger>
          <SelectContent>
            <SelectItem v-for="account in accounts" :key="account.id" :value="`account:${account.id}`">
              {{ account.platform.toUpperCase() }} · {{ account.login }} · {{ account.server }}
            </SelectItem>
            <SelectItem v-for="observer in observers" :key="observer.id" :value="`observer:${observer.id}`">
              观摩 · {{ observer.displayName }}
            </SelectItem>
          </SelectContent>
        </Select>
        <Button v-if="observerChannelId" variant="outline" size="sm" :disabled="loading" @click="emit('leaveObserver')"><LogOut />退出观摩</Button>
      </div>
    </CardHeader>
    <CardContent class="grid gap-px bg-border p-0 sm:grid-cols-2 xl:grid-cols-5">
      <div v-for="metric in [
        ['净值', money(snapshot?.equity, snapshot?.currency)], ['余额', money(snapshot?.balance, snapshot?.currency)],
        ['浮动盈亏', money(snapshot?.floatingProfit, snapshot?.currency)], ['可用保证金', money(snapshot?.freeMargin, snapshot?.currency)],
        ['杠杆', snapshot?.leverage ? `1:${snapshot.leverage}` : '--'],
      ]" :key="metric[0]" class="bg-card px-5 py-4">
        <p class="text-xs text-muted-foreground">{{ metric[0] }}</p>
        <p class="mt-1 font-mono text-base font-semibold tabular-nums" :class="metric[0] === '浮动盈亏' && snapshot ? (Number(snapshot.floatingProfit) >= 0 ? 'text-trade-up' : 'text-trade-down') : ''">{{ metric[1] }}</p>
      </div>
    </CardContent>
  </Card>
</template>
