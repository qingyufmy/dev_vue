<script setup lang="ts">
import { AlertCircle, BookOpenCheck, BrainCircuit, ClipboardPenLine, FileClock, RefreshCw, Sparkles } from '@lucide/vue'
import { computed, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { Alert, AlertDescription, AlertTitle } from '@aurum/ui/alert'
import { Badge } from '@aurum/ui/badge'
import { Button } from '@aurum/ui/button'
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from '@aurum/ui/empty'
import { Skeleton } from '@aurum/ui/skeleton'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@aurum/ui/tabs'
import ManualReviewPanel from '../components/ManualReviewPanel.vue'
import MemoryDetailSheet from '../components/MemoryDetailSheet.vue'
import ReviewActionDialog from '../components/ReviewActionDialog.vue'
import ReviewCaseDetail from '../components/ReviewCaseDetail.vue'
import ReviewCaseList from '../components/ReviewCaseList.vue'
import ReviewVersionSheet from '../components/ReviewVersionSheet.vue'
import StrategyMemoryPanel from '../components/StrategyMemoryPanel.vue'
import { useReviewerWorkspace } from '../composables/use-reviewer-workspace'
import type { MemoryUpdate, ReviewerSection } from '../model/reviewer-presentation'

const route = useRoute()
const router = useRouter()

function routeSection(value: unknown): ReviewerSection {
  return value === 'manual' || value === 'memory' ? value : 'period'
}

const section = ref<ReviewerSection>(routeSection(route.query.section))
const selectedCaseId = computed(() => typeof route.query.case_id === 'string' ? route.query.case_id : '')
const selectedMemoryId = computed(() => typeof route.query.memory_id === 'string' ? route.query.memory_id : '')
const workspace = useReviewerWorkspace({ section, selectedCaseId, selectedMemoryId })
const caseActionOpen = ref(false)
const caseActionMode = ref<'confirm' | 'return'>('confirm')
const versionSheetOpen = ref(false)
const memorySheetOpen = ref(false)
let preserveMemorySelection = false

const currentCaseError = computed(() => section.value === 'manual' ? workspace.manualError.value : workspace.periodError.value)
const realtimeLabel = computed(() => ({
  idle: workspace.loading.value ? '读取快照' : '快照模式',
  connecting: '连接中',
  live: '实时同步',
  recovering: '恢复中',
  offline: '快照模式',
}[workspace.realtime.value]))
const realtimeDotClass = computed(() => ({
  idle: 'bg-muted-foreground',
  connecting: 'bg-primary',
  live: 'bg-system-ok',
  recovering: 'bg-primary',
  offline: 'bg-trade-down',
}[workspace.realtime.value]))

watch(() => route.query.section, (value) => {
  const next = routeSection(value)
  if (next !== section.value) section.value = next
})

watch(section, (value) => {
  const query = { ...route.query } as Record<string, string | string[] | undefined>
  query.section = value
  delete query.case_id
  if (value !== 'memory' || !preserveMemorySelection) delete query.memory_id
  preserveMemorySelection = false
  void router.replace({ path: '/reviewer', query })
})

function selectCase(id: string) {
  void router.replace({ path: '/reviewer', query: { ...route.query, section: section.value, case_id: id } })
}

function selectMemory(id: string) {
  if (!id) return
  memorySheetOpen.value = true
  preserveMemorySelection = true
  void router.replace({ path: '/reviewer', query: { ...route.query, section: 'memory', memory_id: id } })
}

function closeMemory() {
  memorySheetOpen.value = false
  const query = { ...route.query }
  delete query.memory_id
  void router.replace({ path: '/reviewer', query })
}

watch(selectedMemoryId, (id) => {
  memorySheetOpen.value = Boolean(id)
}, { immediate: true })

function requestCaseAction(mode: 'confirm' | 'return') {
  caseActionMode.value = mode
  caseActionOpen.value = true
}

async function submitCaseAction(reason: string) {
  const ok = caseActionMode.value === 'confirm' ? await workspace.confirmCase() : await workspace.returnCase(reason)
  if (ok) caseActionOpen.value = false
}

async function submitVersion(content: string, changeNote: string) {
  if (await workspace.createVersion(content, changeNote)) versionSheetOpen.value = false
}

async function createManual(ids: string[], strategyId: string, tradingIdea: string) {
  const items = workspace.manualCandidates.value.filter((item) => ids.includes(item.id))
  const id = await workspace.createManualReview(items, strategyId, tradingIdea)
  if (id) selectCase(id)
}

function decideMemory(update: MemoryUpdate, decision: 'confirm' | 'reject' | 'revoke') {
  void workspace.decideMemoryUpdate(update, decision)
}
</script>

<template>
  <div class="mx-auto grid w-full max-w-[1680px] gap-5 p-4 sm:p-6 lg:p-8">
    <header class="flex flex-col gap-5 lg:flex-row lg:items-end lg:justify-between">
      <div class="min-w-0">
        <div class="flex items-center gap-2 text-xs font-medium text-primary"><BookOpenCheck aria-hidden="true" />AI 交易团队 · 证据复盘</div>
        <h1 class="mt-2 text-3xl font-semibold tracking-tight sm:text-4xl">AI 复盘师</h1>
        <p class="mt-2 max-w-3xl text-sm leading-6 text-muted-foreground">把行情判断、账户决策、硬风控和终端结果拆开复核。复盘只基于冻结证据，不会因为一次盈亏自动改策略。</p>
      </div>
      <div class="flex flex-wrap items-center gap-2">
        <Badge variant="outline"><span :class="['size-1.5 rounded-full', realtimeDotClass]" aria-hidden="true" />{{ realtimeLabel }}</Badge>
        <Button variant="outline" class="min-h-11" :disabled="workspace.refreshing.value" @click="workspace.refresh()"><RefreshCw data-icon="inline-start" :class="workspace.refreshing.value ? 'animate-spin motion-reduce:animate-none' : ''" />刷新</Button>
      </div>
    </header>

    <Alert v-if="workspace.error.value" variant="destructive" role="alert"><AlertCircle aria-hidden="true" /><AlertTitle>复盘工作区暂时不可用</AlertTitle><AlertDescription>{{ workspace.error.value }}。页面不会使用本地假数据替代服务端结果。</AlertDescription></Alert>
    <Alert v-else-if="workspace.notice.value" role="status"><Sparkles aria-hidden="true" /><AlertTitle>操作已受理</AlertTitle><AlertDescription>{{ workspace.notice.value }}</AlertDescription></Alert>

    <Tabs v-model="section" class="min-w-0">
      <TabsList variant="line" class="w-full justify-start overflow-x-auto border-b pb-0 sm:w-fit">
        <TabsTrigger value="period" class="min-h-11 gap-2 px-3 sm:px-4"><FileClock data-icon="inline-start" />周期复盘</TabsTrigger>
        <TabsTrigger value="manual" class="min-h-11 gap-2 px-3 sm:px-4"><ClipboardPenLine data-icon="inline-start" />手动交易复盘</TabsTrigger>
        <TabsTrigger value="memory" class="min-h-11 gap-2 px-3 sm:px-4"><BrainCircuit data-icon="inline-start" />策略记忆</TabsTrigger>
      </TabsList>

      <TabsContent value="period" class="grid min-w-0 gap-5 pt-1">
        <div class="grid min-w-0 gap-5 xl:grid-cols-[minmax(19rem,0.82fr)_minmax(0,1.55fr)]">
          <ReviewCaseList
            :items="workspace.periodCases.value"
            :selected-id="selectedCaseId"
            :loading="workspace.loading.value && !workspace.periodCases.value.length"
            :refreshing="workspace.refreshing.value"
            :error="currentCaseError"
            kind="period"
            title="周期复盘"
            description="按系统账号归档；账户和终端业务日期只定义证据范围。"
            empty-title="还没有周期复盘"
            empty-description="日复盘与月复盘在可信终端时间窗口内异步生成。"
            @select="selectCase"
          />
          <section class="min-w-0">
            <div v-if="workspace.detailLoading.value && !workspace.caseDetail.value" class="grid gap-4"><Skeleton class="h-48 w-full" /><Skeleton class="h-72 w-full" /><Skeleton class="h-48 w-full" /></div>
            <Alert v-else-if="workspace.detailError.value" variant="destructive"><AlertCircle aria-hidden="true" /><AlertTitle>复盘详情读取失败</AlertTitle><AlertDescription>{{ workspace.detailError.value }}</AlertDescription></Alert>
            <ReviewCaseDetail v-else-if="workspace.caseDetail.value" :detail="workspace.caseDetail.value" :action="workspace.action.value" can-edit @confirm="requestCaseAction('confirm')" @return="requestCaseAction('return')" @edit="versionSheetOpen = true" />
            <Empty v-else class="min-h-[28rem] border"><EmptyHeader><EmptyMedia variant="icon"><FileClock /></EmptyMedia><EmptyTitle>选择一份周期复盘</EmptyTitle><EmptyDescription>左侧列表保持轻量；选中后在这里查看完整分层评价、证据链和正文。</EmptyDescription></EmptyHeader></Empty>
          </section>
        </div>
      </TabsContent>

      <TabsContent value="manual" class="grid min-w-0 gap-5 pt-1">
        <ManualReviewPanel :candidates="workspace.manualCandidates.value" :strategies="workspace.analysisStrategies.value" :loading="workspace.loading.value && !workspace.manualCandidates.value.length" :error="workspace.manualError.value" :action="workspace.action.value" :refreshing="workspace.refreshing.value" @refresh="workspace.refresh" @create="createManual" />
        <div class="grid min-w-0 gap-5 xl:grid-cols-[minmax(19rem,0.82fr)_minmax(0,1.55fr)]">
          <ReviewCaseList
            :items="workspace.manualCases.value"
            :selected-id="selectedCaseId"
            :loading="workspace.loading.value && !workspace.manualCases.value.length"
            :refreshing="workspace.refreshing.value"
            :error="workspace.manualError.value"
            kind="manual"
            title="已创建的手动复盘"
            description="按系统账号和交易账户分别归档，不和自动信号混在一起。"
            empty-title="还没有手动复盘"
            empty-description="从上方选择一笔或多笔人工交易并填写可选下单思路。"
            @select="selectCase"
          />
          <section class="min-w-0">
            <ReviewCaseDetail v-if="workspace.caseDetail.value" :detail="workspace.caseDetail.value" :action="workspace.action.value" can-edit @confirm="requestCaseAction('confirm')" @return="requestCaseAction('return')" @edit="versionSheetOpen = true" />
            <Alert v-else-if="workspace.detailError.value" variant="destructive"><AlertCircle aria-hidden="true" /><AlertTitle>手动复盘详情读取失败</AlertTitle><AlertDescription>{{ workspace.detailError.value }}</AlertDescription></Alert>
            <Empty v-else class="min-h-[20rem] border"><EmptyHeader><EmptyMedia variant="icon"><ClipboardPenLine /></EmptyMedia><EmptyTitle>选择一份手动复盘</EmptyTitle><EmptyDescription>查看交易事件、当时思路与模型给出的策略优化候选。</EmptyDescription></EmptyHeader></Empty>
          </section>
        </div>
      </TabsContent>

      <TabsContent value="memory" class="min-w-0 pt-1">
        <StrategyMemoryPanel :memories="workspace.memories.value" :updates="workspace.memoryUpdates.value" :selected-id="selectedMemoryId" :loading="workspace.loading.value && !workspace.memories.value.length" :error="workspace.memoryError.value" :refreshing="workspace.refreshing.value" @refresh="workspace.refresh" @select="selectMemory" />
      </TabsContent>
    </Tabs>

    <ReviewActionDialog v-model:open="caseActionOpen" :mode="caseActionMode" :submitting="workspace.action.value === 'confirm-case' || workspace.action.value === 'return-case'" @submit="submitCaseAction" />
    <ReviewVersionSheet v-model:open="versionSheetOpen" :detail="workspace.caseDetail.value" :submitting="workspace.action.value === 'version'" :error="workspace.error.value" @submit="submitVersion" />
    <MemoryDetailSheet v-model:open="memorySheetOpen" :detail="workspace.memoryDetail.value" :loading="workspace.memoryDetailLoading.value" :error="workspace.memoryDetailError.value" :action="workspace.action.value" @update:open="(open) => { if (!open) closeMemory() }" @decide="decideMemory" />
  </div>
</template>
