<script setup lang="ts">
import { AlertCircle, Play, RefreshCw, RadioTower } from '@lucide/vue'
import { computed, ref } from 'vue'
import { activeMarketSymbol } from '~/features/trading-context'
import { RouterLink, useRoute, useRouter } from 'vue-router'
import { Alert, AlertDescription, AlertTitle } from '@aurum/ui/alert'
import { Badge } from '@aurum/ui/badge'
import { Button } from '@aurum/ui/button'
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from '@aurum/ui/empty'
import { Skeleton } from '@aurum/ui/skeleton'
import AnalysisDetailPanel from '../components/AnalysisDetailPanel.vue'
import AnalysisHistoryPanel from '../components/AnalysisHistoryPanel.vue'
import ManualAnalysisSheet from '../components/ManualAnalysisSheet.vue'
import { useAnalystWorkspace } from '../composables/use-analyst-workspace'

const route = useRoute()
const router = useRouter()
const manualOpen = ref(false)
const selectedId = computed(() => typeof route.query.analysis_id === 'string' ? route.query.analysis_id : '')

function selectAnalysis(id: string) {
  void router.replace({ path: '/analyst', query: { analysis_id: id } })
}

const workspace = useAnalystWorkspace(selectedId, selectAnalysis)
const realtimeLabel = computed(() => ({
  idle: '未连接', connecting: '连接中', live: '实时更新', recovering: '正在恢复', offline: '快照模式',
})[workspace.realtime.value])

async function runManual(strategyId: string, symbol: string) {
  await workspace.runManual(strategyId, symbol).catch(() => undefined)
}
</script>

<template>
  <div class="mx-auto grid w-full max-w-[1680px] gap-4 p-3 sm:p-5 lg:p-6">
    <header class="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
      <div>
        <div class="flex items-center gap-2 text-xs font-medium text-primary"><RadioTower />AI 交易团队</div>
        <h1 class="mt-1 text-2xl font-semibold tracking-tight">AI 分析师</h1>
        <p class="mt-1 max-w-2xl text-sm leading-6 text-muted-foreground">查看行情判断、交易机会和分析依据。</p>
      </div>
      <div class="flex flex-wrap items-center gap-2">
        <Badge variant="outline">{{ realtimeLabel }}</Badge>
        <Button variant="outline" size="lg" :disabled="workspace.refreshing.value" @click="workspace.refresh()"><RefreshCw :class="workspace.refreshing.value ? 'animate-spin motion-reduce:animate-none' : ''" />刷新记录</Button>
        <Button size="lg" :disabled="!workspace.strategies.value.length" @click="manualOpen = true"><Play />手动分析</Button>
      </div>
    </header>

    <Alert v-if="workspace.strategiesError.value" variant="destructive"><AlertTitle>策略读取失败</AlertTitle><AlertDescription>{{ workspace.strategiesError.value }}<Button variant="outline" @click="workspace.refresh()">重新读取</Button></AlertDescription></Alert>
    <Alert v-else-if="!workspace.strategiesLoading.value && !workspace.strategies.value.length"><AlertTitle>暂无可用分析策略</AlertTitle><AlertDescription>请先在策略师中配置可用的分析策略，再发起分析。<Button as-child variant="link"><RouterLink to="/strategist">前往策略师</RouterLink></Button></AlertDescription></Alert>

    <div class="grid min-w-0 gap-4 lg:grid-cols-[18rem_minmax(0,1fr)] xl:grid-cols-[19rem_minmax(0,1fr)]">
      <AnalysisHistoryPanel
        :items="workspace.analyses.value"
        :strategies="workspace.historyStrategies.value"
        :selected-id="selectedId"
        :loading="workspace.loadingList.value"
        :refreshing="workspace.refreshing.value"
        :error="workspace.listError.value"
        @select="selectAnalysis"
      />

      <section class="min-w-0" aria-label="分析详情" :aria-busy="workspace.loadingDetail.value">
        <div v-if="workspace.loadingDetail.value && (!workspace.detail.value || workspace.detail.value.summary.analysisId !== selectedId)" class="grid gap-4"><Skeleton class="h-48" /><Skeleton class="h-64" /><Skeleton class="h-80" /></div>
        <Alert v-else-if="workspace.detailError.value" variant="destructive"><AlertCircle /><AlertTitle>完整推理读取失败</AlertTitle><AlertDescription>{{ workspace.detailError.value }}<Button variant="outline" @click="workspace.retryDetail()">重试</Button></AlertDescription></Alert>
        <AnalysisDetailPanel v-else-if="workspace.detail.value" :detail="workspace.detail.value" :strategies="workspace.historyStrategies.value" />
        <Empty v-else class="min-h-[30rem]">
          <EmptyHeader><EmptyMedia variant="icon"><RadioTower /></EmptyMedia><EmptyTitle>选择一条分析记录</EmptyTitle><EmptyDescription>左侧记录只显示品种、策略、信号类型和时间；完整结论与推理在这里展示。</EmptyDescription></EmptyHeader>
        </Empty>
      </section>
    </div>

    <ManualAnalysisSheet
      v-model:open="manualOpen"
      :strategies="workspace.strategies.value"
      :default-symbol="activeMarketSymbol"
      :pending="workspace.manualPending.value"
      :cooling-down="workspace.manualCoolingDown.value"
      :job="workspace.currentJob.value"
      :error="workspace.manualError.value"
      @submit="runManual"
    />
  </div>
</template>
