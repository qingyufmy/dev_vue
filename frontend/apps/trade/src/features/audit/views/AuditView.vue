<script setup lang="ts">
import { Activity, AlertCircle, Clock3, Eye, RefreshCw } from '@lucide/vue'
import { computed, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { Alert, AlertDescription, AlertTitle } from '@aurum/ui/alert'
import { Badge } from '@aurum/ui/badge'
import { Button } from '@aurum/ui/button'
import AuditDetailSheet from '../components/AuditDetailSheet.vue'
import AuditEventTable from '../components/AuditEventTable.vue'
import AuditFilterBar from '../components/AuditFilterBar.vue'
import AuditSummaryCards from '../components/AuditSummaryCards.vue'
import { useAuditWorkspace } from '../composables/use-audit-workspace'
import { emptyAuditFilters, type AuditFilters, type AuditEvent } from '../model/audit-presentation'

const route = useRoute()
const router = useRouter()
const text = (value: unknown) => typeof value === 'string' ? value : ''

const accountId = ref(text(route.query.account_id))
const filters = ref<AuditFilters>({
  category: validFilter(text(route.query.category), ['analysis', 'trading', 'risk', 'execution', 'terminal', 'configuration'] as const),
  status: validFilter(text(route.query.status), ['queued', 'running', 'succeeded', 'partially_succeeded', 'rejected', 'failed', 'uncertain', 'cancelled', 'info'] as const),
  actor: validFilter(text(route.query.actor), ['ai', 'user', 'system', 'bridge'] as const),
  from: text(route.query.from),
  to: text(route.query.to),
  query: text(route.query.q),
})
const sourceKind = computed(() => text(route.query.source_kind))
const sourceId = computed(() => text(route.query.source_id))
const workspace = useAuditWorkspace(accountId, filters)

const detailOpen = computed(() => Boolean(
  (sourceKind.value && sourceId.value)
  || workspace.selected.value
  || workspace.detailLoading.value
  || workspace.detailError.value,
))
const realtimeLabel = computed(() => ({
  idle: '未连接', connecting: '连接中', live: '实时同步', recovering: '恢复中', offline: '快照模式',
})[workspace.realtime.value])
const scopeLabel = computed(() => workspace.selectedAccount.value
  ? `${workspace.selectedAccount.value.platform.toUpperCase()} · ${workspace.selectedAccount.value.login}`
  : '全部账户')

function filterQuery() {
  const value = filters.value
  const query: Record<string, string> = {}
  if (accountId.value) query.account_id = accountId.value
  if (value.category) query.category = value.category
  if (value.status) query.status = value.status
  if (value.actor) query.actor = value.actor
  if (value.from) query.from = value.from
  if (value.to) query.to = value.to
  if (value.query) query.q = value.query
  return query
}

async function applyFilters() {
  workspace.closeDetail()
  await router.replace({ path: '/audit', query: filterQuery() })
  await workspace.load(true)
}

async function resetFilters() {
  filters.value = emptyAuditFilters()
  workspace.closeDetail()
  await router.replace({ path: '/audit', query: accountId.value ? { account_id: accountId.value } : {} })
  await workspace.load(true)
}

function openDetail(item: AuditEvent) {
  void router.replace({ path: '/audit', query: { ...filterQuery(), source_kind: item.sourceKind, source_id: item.sourceId } })
  void workspace.loadDetail(item.sourceKind, item.sourceId)
}

function closeDetail() {
  workspace.closeDetail()
  const query = { ...route.query }
  delete query.source_kind
  delete query.source_id
  void router.replace({ path: '/audit', query })
}

watch([sourceKind, sourceId], ([kind, id]) => {
  if (kind && id) void workspace.loadDetail(kind, id)
}, { immediate: true })

watch(accountId, (value) => {
  if (text(route.query.account_id) === value) return
  const query = { ...route.query }
  if (value) query.account_id = value
  else delete query.account_id
  delete query.source_kind
  delete query.source_id
  void router.replace({ path: '/audit', query })
})

function validFilter<T extends string>(value: string, values: readonly T[]): '' | T {
  return values.includes(value as T) ? value as T : ''
}
</script>

<template>
  <div class="mx-auto grid min-w-0 w-full max-w-[1680px] gap-5 overflow-x-hidden p-4 sm:p-6 lg:p-8">
    <header class="flex min-w-0 flex-col gap-4 md:flex-row md:items-end md:justify-between">
      <div class="min-w-0">
        <div class="flex items-center gap-2 text-xs font-medium text-primary"><Activity aria-hidden="true" />操作与执行证据</div>
        <h1 class="mt-2 text-3xl font-semibold tracking-tight sm:text-4xl">系统审计</h1>
        <p class="mt-2 max-w-3xl text-sm leading-6 text-muted-foreground">查看当前系统账号下的操作日志、自动分析和信号执行链路。事件详情只展示已核实的摘要与证据。</p>
      </div>
      <div class="flex flex-wrap items-center gap-2">
        <Badge variant="outline"><span class="size-1.5 rounded-full bg-current" aria-hidden="true" />{{ realtimeLabel }}</Badge>
        <Badge variant="secondary">{{ scopeLabel }}</Badge>
        <Button variant="outline" class="min-h-11" :disabled="workspace.loading.value" @click="workspace.load(true)"><RefreshCw data-icon="inline-start" :class="workspace.loading.value ? 'animate-spin motion-reduce:animate-none' : ''" />刷新</Button>
      </div>
    </header>

    <Alert v-if="workspace.isObserver.value" variant="default">
      <Eye aria-hidden="true" />
      <AlertTitle>观摩模式下审计只读</AlertTitle>
      <AlertDescription>当前服务端不会向观摩会话开放账户审计。切换回本人交易账户后再查看对应的操作与执行链路。</AlertDescription>
    </Alert>

    <Alert v-if="workspace.error.value" variant="destructive" role="alert">
      <AlertCircle aria-hidden="true" />
      <AlertTitle>审计数据读取失败</AlertTitle>
      <AlertDescription class="flex flex-wrap items-center gap-3">{{ workspace.error.value }}<Button variant="outline" class="min-h-11" @click="workspace.load(true)">重新读取</Button></AlertDescription>
    </Alert>

    <Alert v-else-if="workspace.realtime.value === 'offline' || workspace.realtime.value === 'recovering'">
      <Clock3 aria-hidden="true" />
      <AlertTitle>{{ realtimeLabel }}</AlertTitle>
      <AlertDescription>页面保留最近一次已确认的 HTTP 快照；实时连接恢复后会自动重新读取事件列表。</AlertDescription>
    </Alert>

    <AuditSummaryCards :summary="workspace.summary.value" :loading="workspace.loading.value" />
    <AuditFilterBar v-model:account-id="accountId" v-model:filters="filters" :accounts="workspace.accounts.value" :loading="workspace.loading.value" @apply="applyFilters" @reset="resetFilters" />
    <AuditEventTable :items="workspace.items.value" :accounts="workspace.accounts.value" :loading="workspace.loading.value" :loading-more="workspace.loadingMore.value" :has-more="workspace.hasMore.value" @select="openDetail" @more="workspace.load(false)" />
    <AuditDetailSheet :open="detailOpen" :detail="workspace.selected.value" :loading="workspace.detailLoading.value" :error="workspace.detailError.value" :accounts="workspace.accounts.value" @update:open="value => { if (!value) closeDetail() }" />
  </div>
</template>
