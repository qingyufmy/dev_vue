<script setup lang="ts">
import { AlertCircle, ArrowRight, Cable, RefreshCw } from '@lucide/vue'
import { onBeforeUnmount, onMounted } from 'vue'
import { RouterLink } from 'vue-router'
import { Alert, AlertDescription, AlertTitle } from '@aurum/ui/alert'
import { Button } from '@aurum/ui/button'
import { Card, CardContent } from '@aurum/ui/card'
import { Skeleton } from '@aurum/ui/skeleton'
import AccountSummaryCard from './AccountSummaryCard.vue'
import LatestSignalCard from './LatestSignalCard.vue'
import MarketWorkspaceCard from './MarketWorkspaceCard.vue'
import TradingResourcesCard from './TradingResourcesCard.vue'
import { realtimeState } from './home-runtime'
import { useHomeWorkspace } from './use-home-workspace'

const workspace = useHomeWorkspace()
onMounted(() => void workspace.load())
onBeforeUnmount(workspace.stop)
</script>

<template>
  <div class="mx-auto w-full max-w-[1680px] space-y-4 p-3 sm:p-5 lg:p-6">
    <div class="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
      <div><p class="text-xs font-medium text-primary">交易工作区</p><h1 class="mt-1 text-2xl font-semibold tracking-tight">账户概览</h1><p class="mt-1 text-sm text-muted-foreground">账户、行情和交易资源保持实时同步。</p></div>
      <Button variant="outline" size="sm" :disabled="workspace.loading.value" @click="workspace.load"><RefreshCw :class="workspace.loading.value ? 'animate-spin motion-reduce:animate-none' : ''" />刷新快照</Button>
    </div>

    <Alert v-if="workspace.error.value" variant="destructive"><AlertCircle /><AlertTitle>数据读取失败</AlertTitle><AlertDescription>{{ workspace.error.value }}</AlertDescription></Alert>

    <template v-if="workspace.loading.value && !workspace.snapshot.value">
      <Skeleton class="h-48 w-full" /><div class="grid gap-4 xl:grid-cols-[minmax(0,1.8fr)_minmax(20rem,0.7fr)]"><Skeleton class="h-[34rem]" /><Skeleton class="h-[34rem]" /></div>
    </template>

    <Card v-else-if="!workspace.hasAccount.value" class="shadow-none">
      <CardContent class="flex min-h-[28rem] flex-col items-center justify-center gap-4 text-center">
        <span class="flex size-12 items-center justify-center rounded-xl bg-primary/10 text-primary"><Cable class="size-6" /></span>
        <div><h2 class="text-lg font-semibold">还没有可用的交易账户</h2><p class="mt-2 max-w-md text-sm leading-6 text-muted-foreground">连接量见智桥后，账户会自动出现在这里。账户档案可随时更换，只有当前在线连接占用额度。</p></div>
        <Button as-child><RouterLink to="/bridge">配置量见智桥<ArrowRight /></RouterLink></Button>
      </CardContent>
    </Card>

    <template v-else>
      <AccountSummaryCard :accounts="workspace.accounts.value" :observers="workspace.observers.value" :account-id="workspace.context.value?.accountId ?? null" :observer-channel-id="workspace.context.value?.observerChannelId ?? null" :snapshot="workspace.snapshot.value" :loading="workspace.loading.value" @select="workspace.selectAccount" @observer="workspace.selectObserver" @leave-observer="workspace.leaveObserver" />
      <div class="grid min-w-0 gap-4 xl:grid-cols-[minmax(0,1.9fr)_minmax(21rem,0.7fr)]">
        <MarketWorkspaceCard :timezone-offset-minutes="workspace.snapshot.value?.timezoneOffsetMinutes" :symbols="workspace.symbols.value" :symbol="workspace.symbol.value" :timeframe="workspace.timeframe.value" :quote="workspace.quote.value" :candles="workspace.candles.value" :realtime="realtimeState" :history-version="workspace.marketHistoryVersion.value" @symbol="workspace.selectSymbol" @timeframe="workspace.selectTimeframe" />
        <LatestSignalCard :analysis="workspace.latestAnalysis.value" :strategies="workspace.analysisStrategies.value" :loading="workspace.analysisLoading.value" :error="workspace.analysisError.value" />
      </div>
      <TradingResourcesCard :positions="workspace.positions.value" :orders="workspace.pendingOrders.value" />
    </template>
  </div>
</template>
