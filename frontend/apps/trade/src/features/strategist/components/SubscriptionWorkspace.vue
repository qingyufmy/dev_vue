<script setup lang="ts">
import { Bot, Cable, Pause, Pencil, Plus, RefreshCw, ShieldCheck, StopCircle } from '@lucide/vue'
import type { StrategySummary, TradingAccount } from '@aurum/contracts'
import { computed } from 'vue'
import { Badge } from '@aurum/ui/badge'
import { Button } from '@aurum/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@aurum/ui/card'
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from '@aurum/ui/empty'
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from '@aurum/ui/select'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@aurum/ui/table'
import type { StrategySubscriptionView } from '../model/strategy-presentation'
import { findStrategyName, subscriptionStatusLabel } from '../model/strategy-presentation'

const props = withDefaults(defineProps<{
  accountId: string
  accounts: TradingAccount[]
  strategies: StrategySummary[]
  subscriptions: StrategySubscriptionView[]
  loading?: boolean
  refreshing?: boolean
}>(), { loading: false, refreshing: false })
const emit = defineEmits<{ 'account-change': [id: string]; create: []; edit: [item: StrategySubscriptionView]; end: [item: StrategySubscriptionView]; refresh: [] }>()
const account = computed(() => props.accounts.find((item) => item.id === props.accountId) ?? null)
function accountChange(value: unknown) { const id = String(value); if (id && id !== props.accountId) emit('account-change', id) }
</script>

<template>
  <div class="grid gap-4">
    <Card class="shadow-none">
      <CardContent class="flex flex-col gap-4 p-4 lg:flex-row lg:items-center lg:justify-between lg:p-5">
        <div class="flex min-w-0 items-center gap-3">
          <span class="flex size-11 shrink-0 items-center justify-center rounded-xl bg-primary/10 text-primary"><Cable class="size-5" aria-hidden="true" /></span>
          <div class="min-w-0"><p class="text-xs text-muted-foreground">当前订阅账户</p><strong class="mt-1 block truncate">{{ account ? `${account.platform.toUpperCase()} · ${account.login}` : '选择交易账户' }}</strong><p class="truncate text-xs text-muted-foreground">{{ account?.server ?? '每个账户可以订阅不同策略' }}</p></div>
        </div>
        <div class="flex flex-wrap gap-2">
          <Select :model-value="accountId || undefined" :disabled="loading || !accounts.length" @update:model-value="accountChange"><SelectTrigger class="min-h-11 w-[min(21rem,78vw)]" aria-label="切换订阅账户"><SelectValue placeholder="选择交易账户" /></SelectTrigger><SelectContent><SelectGroup><SelectItem v-for="item in accounts" :key="item.id" :value="item.id">{{ item.platform.toUpperCase() }} · {{ item.login }} · {{ item.server }}</SelectItem></SelectGroup></SelectContent></Select>
          <Button variant="outline" size="icon-lg" :disabled="loading || refreshing" aria-label="刷新订阅" @click="emit('refresh')"><RefreshCw :class="refreshing ? 'animate-spin motion-reduce:animate-none' : ''" /></Button>
          <Button size="lg" :disabled="loading || !accountId" @click="emit('create')"><Plus />新增订阅</Button>
        </div>
      </CardContent>
    </Card>

    <Card class="min-w-0 shadow-none">
      <CardHeader class="border-b"><CardTitle>账户策略订阅</CardTitle><CardDescription>为当前账户选择策略、设置分析时间和交易发送权限。</CardDescription></CardHeader>
      <CardContent class="p-0">
        <div v-if="loading" class="grid gap-2 p-4" aria-busy="true"><div v-for="index in 3" :key="index" class="h-20 animate-pulse rounded-lg bg-muted motion-reduce:animate-none" /></div>
        <Empty v-else-if="!subscriptions.length" class="min-h-80"><EmptyHeader><EmptyMedia variant="icon"><Bot /></EmptyMedia><EmptyTitle>这个账户还没有策略订阅</EmptyTitle><EmptyDescription>先选择已发布的行情分析策略；需要自动管理交易时，再绑定交易执行策略。</EmptyDescription></EmptyHeader></Empty>
        <template v-else>
          <div class="hidden overflow-x-auto md:block">
            <Table>
              <TableHeader><TableRow><TableHead>品种</TableHead><TableHead>行情分析</TableHead><TableHead>AI 交易员</TableHead><TableHead>交易发送</TableHead><TableHead>状态</TableHead><TableHead class="text-right">操作</TableHead></TableRow></TableHeader>
              <TableBody><TableRow v-for="item in subscriptions" :key="item.id">
                <TableCell class="font-mono font-semibold">{{ item.symbol }}</TableCell>
                <TableCell><div class="font-medium">{{ findStrategyName(strategies, item.analysisStrategyId) }}</div><span class="text-xs text-muted-foreground">{{ item.analysisEnabled ? `每 ${Math.round(item.cadenceSeconds / 60)} 分钟` : '已关闭' }}</span></TableCell>
                <TableCell>{{ item.traderEnabled ? findStrategyName(strategies, item.traderStrategyId) : '仅分析' }}</TableCell>
                <TableCell><Badge :variant="item.tradeSendEnabled ? 'default' : 'secondary'"><ShieldCheck v-if="item.tradeSendEnabled" /><Pause v-else />{{ item.tradeSendEnabled ? '允许' : '不发送' }}</Badge></TableCell>
                <TableCell><Badge variant="outline">{{ subscriptionStatusLabel[item.status] }}</Badge></TableCell>
                <TableCell><div class="flex justify-end gap-2"><Button variant="ghost" size="sm" :disabled="item.status === 'ended'" @click="emit('edit', item)"><Pencil />编辑</Button><Button variant="ghost" size="sm" :disabled="item.status === 'ended'" @click="emit('end', item)"><StopCircle />结束</Button></div></TableCell>
              </TableRow></TableBody>
            </Table>
          </div>
          <div class="grid gap-3 p-3 md:hidden">
            <article v-for="item in subscriptions" :key="item.id" class="grid gap-3 rounded-xl border p-4">
              <div class="flex items-center justify-between gap-3"><strong class="font-mono">{{ item.symbol }}</strong><Badge variant="outline">{{ subscriptionStatusLabel[item.status] }}</Badge></div>
              <dl class="grid gap-2 text-sm"><div><dt class="text-xs text-muted-foreground">行情分析</dt><dd class="mt-1 font-medium">{{ findStrategyName(strategies, item.analysisStrategyId) }}</dd></div><div><dt class="text-xs text-muted-foreground">AI 交易员</dt><dd class="mt-1 font-medium">{{ item.traderEnabled ? findStrategyName(strategies, item.traderStrategyId) : '仅分析，不触发交易员' }}</dd></div><div><dt class="text-xs text-muted-foreground">交易发送</dt><dd class="mt-1">{{ item.tradeSendEnabled ? '允许，仍需通过风控' : '不发送' }}</dd></div></dl>
              <div class="grid grid-cols-2 gap-2"><Button variant="outline" size="lg" :disabled="item.status === 'ended'" @click="emit('edit', item)"><Pencil />编辑</Button><Button variant="ghost" size="lg" :disabled="item.status === 'ended'" @click="emit('end', item)"><StopCircle />结束</Button></div>
            </article>
          </div>
        </template>
      </CardContent>
    </Card>
  </div>
</template>
