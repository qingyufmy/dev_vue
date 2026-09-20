<script setup lang="ts">
import { Eye, LogOut } from '@lucide/vue'
import { computed } from 'vue'
import type { AccountSnapshot, ObserverChannel, TradingAccount } from '@aurum/contracts'
import { Badge } from '@aurum/ui/badge'
import { Card, CardContent, CardHeader, CardTitle } from '@aurum/ui/card'
import { Button } from '@aurum/ui/button'
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from '@aurum/ui/select'
import { accountMoney as money } from './account-money'

const props = defineProps<{ accounts: readonly TradingAccount[]; observers: readonly ObserverChannel[]; accountId: string | null; observerChannelId: string | null; snapshot: AccountSnapshot | null; loading: boolean; positionProfit?: string | null }>()
const emit = defineEmits<{ select: [accountId: string]; observer: [observerChannelId: string]; leaveObserver: [] }>()
const selectedAccount = computed(() => props.accounts.find(account => account.id === props.accountId))
const selection = computed(() => props.observerChannelId ? `observer:${props.observerChannelId}` : props.accountId ? `account:${props.accountId}` : undefined)
function select(value: unknown) {
  const selection = String(value)
  if (selection.startsWith('observer:') && selection.length > 9) emit('observer', selection.slice(9))
  else if (selection.startsWith('account:') && selection.length > 8) emit('select', selection.slice(8))
}
</script>

<template>
  <Card class="shadow-none">
    <CardHeader class="gap-3 border-b py-3 sm:flex-row sm:items-center sm:justify-between">
      <div class="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1">
        <p class="text-xs font-medium text-muted-foreground">当前交易账户</p>
        <CardTitle class="truncate text-base">
          {{ snapshot ? `${snapshot.platform.toUpperCase()} · ${snapshot.login}` : selectedAccount ? `${selectedAccount.platform.toUpperCase()} · ${selectedAccount.login}` : '等待账户快照' }}
        </CardTitle>
        <p class="mt-1 truncate text-xs text-muted-foreground">{{ snapshot?.server ?? selectedAccount?.server ?? '连接量见智桥后显示服务器信息' }}</p>

      </div>
      <div class="flex flex-wrap items-center gap-2">
        <Badge v-if="observerChannelId" variant="secondary"><Eye aria-hidden="true" />观摩模式</Badge>
        <Select v-if="observers.some(item => item.active)" :model-value="observerChannelId ? selection : undefined" :disabled="loading || (accounts.length === 0 && observers.length === 0)" @update:model-value="select">
          <SelectTrigger aria-label="选择观摩源" class="min-h-11 w-[min(18rem,70vw)]"><SelectValue placeholder="选择观摩源" /></SelectTrigger>
          <SelectContent>
            <SelectGroup>
              <SelectItem v-for="observer in observers.filter(item => item.active)" :key="observer.id" :value="`observer:${observer.id}`">
                观摩 · {{ observer.displayName }}
              </SelectItem>
            </SelectGroup>
          </SelectContent>
        </Select>
        <Button v-if="observerChannelId" variant="outline" size="sm" :disabled="loading" @click="emit('leaveObserver')"><LogOut />退出观摩</Button>
      </div>
    </CardHeader>
    <CardContent class="grid grid-cols-2 gap-px bg-border p-0 sm:grid-cols-2 xl:grid-cols-5">
      <div v-for="metric in [
        ['净值', money(snapshot?.equity, snapshot?.currency)], ['余额', money(snapshot?.balance, snapshot?.currency)],
        ['浮动盈亏', money(positionProfit, snapshot?.currency)], ['可用保证金', money(snapshot?.freeMargin, snapshot?.currency)],
        ['杠杆', snapshot?.leverage ? `1:${snapshot.leverage}` : '--'],
      ]" :key="metric[0]" class="bg-card px-4 py-3" :class="metric[0] === '杠杆' ? 'col-span-2 xl:col-span-1' : ''">
        <p class="text-xs text-muted-foreground">{{ metric[0] }}</p>
        <p class="mt-1 font-mono text-base font-semibold tabular-nums" :class="metric[0] === '浮动盈亏' && positionProfit != null && Number(positionProfit) !== 0 ? (Number(positionProfit) >= 0 ? 'text-trade-up' : 'text-trade-down') : ''">{{ metric[1] }}</p>
      </div>
    </CardContent>
  </Card>
</template>
