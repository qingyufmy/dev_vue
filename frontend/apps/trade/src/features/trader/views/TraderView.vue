<script setup lang="ts">
import { AlertCircle, Bot, Cable, Eye, RefreshCw } from '@lucide/vue'
import { computed, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { Alert, AlertDescription, AlertTitle } from '@aurum/ui/alert'
import { Badge } from '@aurum/ui/badge'
import { Button } from '@aurum/ui/button'
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from '@aurum/ui/empty'
import InventoryDetailSheet from '../components/InventoryDetailSheet.vue'
import InventoryWorkspace from '../components/InventoryWorkspace.vue'
import TraderAccountSummary from '../components/TraderAccountSummary.vue'
import TraderDecisionDetail from '../components/TraderDecisionDetail.vue'
import TraderDecisionHistory from '../components/TraderDecisionHistory.vue'
import { useTraderWorkspace } from '../composables/use-trader-workspace'

const route = useRoute()
const router = useRouter()
const resourceOpen = ref(false)
const resourceSelection = ref<{ kind: 'position' | 'order'; ticket: string } | null>(null)
const selectedDecisionId = computed(() => typeof route.query.decision_id === 'string' ? route.query.decision_id : '')

function selectDecision(id: string) {
  const query = { ...route.query }
  if (id) query.decision_id = id
  else delete query.decision_id
  void router.replace({ path: '/trader', query })
}

const workspace = useTraderWorkspace(selectedDecisionId, selectDecision)
const selectedResource = computed(() => {
  const selection = resourceSelection.value
  if (!selection) return null
  return selection.kind === 'position'
    ? workspace.positions.value.find((item) => item.ticket === selection.ticket) ?? null
    : workspace.pendingOrders.value.find((item) => item.ticket === selection.ticket) ?? null
})
const realtimeLabel = computed(() => ({
  idle: '未连接', connecting: '连接中', live: '实时同步', recovering: '正在恢复', offline: '快照模式',
})[workspace.realtime.value])

function inspectResource(kind: 'position' | 'order', ticket: string) {
  resourceSelection.value = { kind, ticket }
  resourceOpen.value = true
}
</script>

<template>
  <div class="mx-auto grid w-full max-w-[1680px] gap-4 p-3 sm:p-5 lg:p-6">
    <header class="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
      <div>
        <div class="flex items-center gap-2 text-xs font-medium text-primary"><Bot aria-hidden="true" />AI 交易团队</div>
        <h1 class="mt-1 text-2xl font-semibold tracking-tight">AI 交易员</h1>
        <p class="mt-1 max-w-2xl text-sm leading-6 text-muted-foreground">围绕当前交易账户查看持仓、挂单与 AI 交易决定。行情判断来自 AI 分析师，账户动作仍需通过服务端风控与执行链确认。</p>
      </div>
      <div class="flex flex-wrap items-center gap-2">
        <Badge variant="outline">{{ realtimeLabel }}</Badge>
        <Button variant="outline" size="lg" :disabled="workspace.loading.value || workspace.refreshing.value" @click="workspace.refresh">
          <RefreshCw :class="workspace.refreshing.value ? 'animate-spin motion-reduce:animate-none' : ''" aria-hidden="true" />
          刷新账户
        </Button>
      </div>
    </header>

    <Alert v-if="workspace.error.value" variant="destructive">
      <AlertCircle aria-hidden="true" />
      <AlertTitle>交易员数据读取失败</AlertTitle>
      <AlertDescription>{{ workspace.error.value }}</AlertDescription>
    </Alert>

    <Alert v-if="workspace.isObserver.value">
      <Eye aria-hidden="true" />
      <AlertTitle>当前为观摩模式</AlertTitle>
      <AlertDescription>你可以查看来源账户的持仓和挂单；账户级 AI 交易决定与所有交易操作仅对账户所有者开放。</AlertDescription>
    </Alert>

    <Alert v-if="workspace.operationNotice.value">
      <RefreshCw aria-hidden="true" />
      <AlertTitle>执行状态已更新</AlertTitle>
      <AlertDescription>{{ workspace.operationNotice.value }}</AlertDescription>
    </Alert>

    <TraderAccountSummary
      v-if="workspace.activeAccountId.value"
      :accounts="workspace.accounts.value"
      :account-id="workspace.activeAccountId.value"
      :account="workspace.account.value"
      :snapshot="workspace.snapshot.value"
      :loading="workspace.loading.value"
      :switching="workspace.switching.value"
      :observer="workspace.isObserver.value"
      :realtime="workspace.realtime.value"
      @account-change="workspace.selectAccount"
      @refresh="workspace.refresh"
    />

    <Empty v-if="!workspace.loading.value && !workspace.activeAccountId.value" class="min-h-[28rem]">
      <EmptyHeader>
        <EmptyMedia variant="icon"><Cable /></EmptyMedia>
        <EmptyTitle>还没有可用的交易账户</EmptyTitle>
        <EmptyDescription>连接量见智桥并绑定交易账户后，持仓、挂单和账户级 AI 交易决定会显示在这里。</EmptyDescription>
      </EmptyHeader>
    </Empty>

    <template v-else-if="workspace.activeAccountId.value">
      <InventoryWorkspace
        :positions="workspace.positions.value"
        :orders="workspace.pendingOrders.value"
        :loading="workspace.loading.value"
        :timezone-offset-minutes="workspace.snapshot.value?.timezoneOffsetMinutes ?? null"
        @inspect="inspectResource"
      />

      <div class="grid min-w-0 gap-4 xl:grid-cols-[21rem_minmax(0,1fr)]">
        <TraderDecisionHistory
          :items="workspace.decisions.value"
          :strategies="workspace.strategies.value"
          :selected-id="selectedDecisionId"
          :loading="workspace.decisionsLoading.value"
          :refreshing="workspace.refreshing.value"
          :error="workspace.decisionsError.value"
          :timezone-offset-minutes="workspace.snapshot.value?.timezoneOffsetMinutes ?? null"
          @select="selectDecision"
        />
        <section class="min-w-0" aria-label="AI 交易员决定详情">
          <TraderDecisionDetail
            :detail="workspace.detail.value"
            :strategies="workspace.strategies.value"
            :loading="workspace.detailLoading.value"
            :error="workspace.detailError.value"
            :timezone-offset-minutes="workspace.snapshot.value?.timezoneOffsetMinutes ?? null"
          />
        </section>
      </div>
    </template>

    <InventoryDetailSheet
      v-model:open="resourceOpen"
      :resource="selectedResource"
      :read-only="workspace.context.value?.readOnly ?? true"
      :timezone-offset-minutes="workspace.snapshot.value?.timezoneOffsetMinutes ?? null"
    />
  </div>
</template>
