<script setup lang="ts">
import { onBeforeUnmount, ref, watch } from 'vue'
import { createApiClient } from '@aurum/api-client'
import { Button } from '@aurum/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@aurum/ui/card'
import { formatBeijingTime } from '@aurum/ui/lib/time'
import { useTradeSession } from '~/features/auth'
import { createMarketWorkspace } from '../model/market-workspace'
import MarketCalendar from '../components/MarketCalendar.vue'
import MarketSnapshotDetail from '../components/MarketSnapshotDetail.vue'
import { startMarketRealtime } from '../model/market-realtime'

const { session } = useTradeSession()
const api = createApiClient()
const workspace = createMarketWorkspace(api)
const realtime = ref<'connecting' | 'live' | 'offline'>('offline')
let subscription: ReturnType<typeof startMarketRealtime> | undefined
const { overview, detail } = workspace
const detailOpen = ref(false)
const status = { fresh: '研究已更新', stale: '研究已过期', partial: '部分数据缺失', unavailable: '研究暂不可用' }
function refresh() { if (overview.value.status !== 'loading') void workspace.refresh() }
function inspect(id: string) { detailOpen.value = true; void workspace.selectSnapshot(id) }
function setDetailOpen(open: boolean) { detailOpen.value = open; if (!open) workspace.closeDetail() }
watch(() => session.value?.user.id, userId => {
  subscription?.stop(); subscription = undefined; realtime.value = 'offline'
  detailOpen.value = false; workspace.reset()
  if (userId && session.value) {
    void workspace.refresh()
    const csrf = session.value.csrf_token
    subscription = startMarketRealtime({ userId, url: `${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}/realtime/v4`,
      ticket: () => api.createRealtimeTicket(csrf), onState: state => { realtime.value = state },
      invalidate: () => { void workspace.refresh(); if (detailOpen.value) void workspace.retryDetail() } })
  }
}, { immediate: true, flush: 'sync' })
onBeforeUnmount(() => { subscription?.stop(); workspace.dispose() })
</script>

<template>
  <div class="mx-auto grid w-full max-w-6xl gap-5 p-3 sm:p-5 lg:p-6">
    <header class="flex flex-wrap items-end justify-between gap-4">
      <div><h1 class="text-2xl font-semibold tracking-tight">市场行情</h1><p class="mt-2 text-sm text-muted-foreground">宏观研究背景与重要经济事件 · 北京时间</p></div>
      <Button variant="outline" :aria-busy="overview.status === 'loading'" :aria-disabled="overview.status === 'loading'" @click="refresh">{{ overview.status === 'loading' ? '正在刷新…' : '刷新市场数据' }}</Button>
    </header>
    <p class="text-xs text-muted-foreground" role="status">{{ realtime === 'live' ? '变更自动更新' : realtime === 'connecting' ? '正在连接更新通知' : '快照模式，可手动刷新' }}</p>
    <p v-if="overview.status === 'loading'" role="status" class="rounded-lg border p-6 text-sm text-muted-foreground">正在获取市场数据…</p>
    <p v-else-if="overview.status === 'error'" role="alert" class="rounded-lg border p-6 text-sm">{{ overview.error }}</p>
    <div v-else-if="overview.data" class="grid min-w-0 items-start gap-5 lg:grid-cols-2">
      <Card class="min-w-0 shadow-none">
        <CardHeader><CardTitle>中期宏观研究</CardTitle><p class="text-sm text-muted-foreground">{{ overview.data.snapshot ? status[overview.data.snapshot.status] : '尚无已发布研究' }}</p></CardHeader>
        <CardContent class="grid gap-4">
          <template v-if="overview.data.snapshot">
            <p class="whitespace-pre-wrap break-words text-sm leading-7">{{ overview.data.snapshot.summary }}</p>
            <p class="text-xs text-muted-foreground">发布于 {{ formatBeijingTime(overview.data.snapshot.publishedAt) }} · {{ overview.data.snapshot.factorCount }} 个因子</p>
            <Button variant="outline" class="w-fit" @click="inspect(overview.data.snapshot.id)">查看研究与因子</Button>
          </template>
          <p v-else class="py-6 text-sm leading-6 text-muted-foreground">暂无符合展示条件的宏观研究。发布后可在这里查看摘要与关键因子。</p>
        </CardContent>
      </Card>
      <MarketCalendar :events="overview.data.high_impact_events" />
    </div>
    <MarketSnapshotDetail :open="detailOpen" :detail="detail.data" :loading="detail.status === 'loading'" :error="detail.error" @update:open="setDetailOpen" @retry="workspace.retryDetail()" />
  </div>
</template>
