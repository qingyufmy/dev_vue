<script setup lang="ts">
import { ArrowRight, Bot, CheckCircle2, CircleAlert, FileCheck2, FileText } from '@lucide/vue'
import type { StrategySummary, TraderDecisionDetail as TraderDecisionDetailType } from '@aurum/contracts'
import { computed } from 'vue'
import { RouterLink } from 'vue-router'
import { Alert, AlertDescription, AlertTitle } from '@aurum/ui/alert'
import { Badge } from '@aurum/ui/badge'
import { Button } from '@aurum/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@aurum/ui/card'
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from '@aurum/ui/empty'
import { Progress } from '@aurum/ui/progress'
import { Separator } from '@aurum/ui/separator'
import { Skeleton } from '@aurum/ui/skeleton'
import {
  actionLabel,
  actionParameterRecords,
  decisionStatusLabel,
  expectedStateRecords,
  formatDateTime,
  sideLabel,
  strategyName,
} from '../model/trader-presentation'

const props = withDefaults(defineProps<{
  detail: TraderDecisionDetailType | null
  strategies?: StrategySummary[]
  loading?: boolean
  error?: string
  timezoneOffsetMinutes?: number | null
}>(), {
  strategies: () => [],
  loading: false,
  error: '',
  timezoneOffsetMinutes: null,
})

const summary = computed(() => props.detail?.summary ?? null)
const decisionTime = computed(() => summary.value ? formatDateTime(summary.value.createdAt, props.timezoneOffsetMinutes) : '--')

function statusVariant(status: TraderDecisionDetailType['summary']['status']) {
  if (status === 'accepted') return 'default'
  if (status === 'risk_rejected') return 'destructive'
  if (status === 'stale') return 'secondary'
  return 'outline'
}

function actionVariant(kind: TraderDecisionDetailType['actions'][number]['kind']) {
  if (kind === 'close_position' || kind === 'cancel_order') return 'destructive'
  if (kind === 'market_order' || kind === 'pending_order') return 'default'
  return 'outline'
}
</script>

<template>
  <div v-if="loading && !detail" class="grid gap-4"><Skeleton class="h-56 w-full" /><Skeleton class="h-72 w-full" /><Skeleton class="h-96 w-full" /></div>
  <Alert v-else-if="error" variant="destructive">
    <CircleAlert aria-hidden="true" />
    <AlertTitle>交易员决定读取失败</AlertTitle>
    <AlertDescription>{{ error }}</AlertDescription>
  </Alert>
  <Empty v-else-if="!detail || !summary" class="min-h-[30rem]">
    <EmptyHeader>
      <EmptyMedia variant="icon"><Bot /></EmptyMedia>
      <EmptyTitle>选择一条交易员决定</EmptyTitle>
      <EmptyDescription>这里会展示账户级判断、拟执行动作和完整推理。</EmptyDescription>
    </EmptyHeader>
  </Empty>
  <article v-else class="grid gap-4">
    <Card class="shadow-none">
      <CardHeader class="gap-4 border-b">
        <div class="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
          <div class="min-w-0">
            <div class="mb-2 flex flex-wrap items-center gap-2">
              <Badge variant="outline">AI 交易员</Badge>
              <Badge :variant="statusVariant(summary.status)">{{ decisionStatusLabel(summary.status) }}</Badge>
              <Badge v-if="summary.side" variant="secondary">{{ sideLabel(summary.side) }}</Badge>
            </div>
            <CardTitle class="text-xl sm:text-2xl">{{ summary.summary }}</CardTitle>
            <CardDescription class="mt-2">{{ strategyName(strategies, summary.strategyId) }} · {{ decisionTime }} · 决定 #{{ summary.decisionId }}</CardDescription>
          </div>
          <div class="shrink-0 sm:w-52">
            <div class="mb-2 flex items-end justify-between gap-3"><span class="text-xs text-muted-foreground">决定置信度</span><strong class="font-mono text-lg tabular-nums">{{ summary.confidence }}%</strong></div>
            <Progress :model-value="summary.confidence" aria-label="决定置信度" />
          </div>
        </div>
      </CardHeader>
      <CardContent class="grid gap-4 pt-5 sm:grid-cols-3">
        <div><p class="text-xs text-muted-foreground">交易动作</p><p class="mt-1 text-lg font-semibold">{{ actionLabel(summary.action) }}</p></div>
        <div><p class="text-xs text-muted-foreground">关联分析</p><Button v-if="summary.analysisId" variant="link" size="lg" as-child class="mt-0 px-0"><RouterLink :to="{ path: '/analyst', query: { analysis_id: summary.analysisId } }">查看行情分析<ArrowRight data-icon="inline-end" /></RouterLink></Button><p v-else class="mt-1 text-sm">--</p></div>
        <div><p class="text-xs text-muted-foreground">策略版本</p><p class="mt-1 font-mono text-sm tabular-nums">{{ summary.strategyVersionId }}</p></div>
      </CardContent>
    </Card>

    <Alert>
      <CircleAlert aria-hidden="true" />
      <AlertTitle>决定与成交是两件事</AlertTitle>
      <AlertDescription>本页展示 AI 交易员的账户级判断。只有服务端风控通过、操作进入执行链并完成终端资源复核后，才可确认交易结果。</AlertDescription>
    </Alert>

    <Alert v-if="summary.status === 'stale'">
      <CircleAlert aria-hidden="true" />
      <AlertTitle>这条决定已失效</AlertTitle>
      <AlertDescription>账户或行情快照在进入执行链前发生变化，本条决定不会继续执行，请以最新记录为准。</AlertDescription>
    </Alert>

    <Alert v-else-if="summary.status === 'risk_rejected'" variant="destructive">
      <CircleAlert aria-hidden="true" />
      <AlertTitle>服务端风控未通过</AlertTitle>
      <AlertDescription>这条 AI 建议没有进入终端执行；具体限制与解除状态将在 AI 风控师页面中查看。</AlertDescription>
    </Alert>

    <Card class="shadow-none">
      <CardHeader><CardTitle class="flex items-center gap-2 text-base"><FileCheck2 aria-hidden="true" />拟执行动作</CardTitle><CardDescription>动作参数与执行前预期状态按原始合同展示</CardDescription></CardHeader>
      <CardContent class="grid gap-3">
        <Empty v-if="!detail.actions.length" class="min-h-40 border-0">
          <EmptyHeader><EmptyMedia variant="icon"><CheckCircle2 /></EmptyMedia><EmptyTitle>本次决定没有交易动作</EmptyTitle><EmptyDescription>AI 交易员建议观望，当前不会进入交易执行流程。</EmptyDescription></EmptyHeader>
        </Empty>
        <section v-for="(item, index) in detail.actions" :key="item.action_id" class="grid gap-4 rounded-xl border p-4">
          <div class="flex flex-wrap items-center justify-between gap-3"><div class="flex items-center gap-2"><Badge variant="outline">动作 {{ index + 1 }}</Badge><Badge :variant="actionVariant(item.kind)">{{ actionLabel(item.kind) }}</Badge></div><span class="font-mono text-xs text-muted-foreground">#{{ item.action_id }}</span></div>
          <div class="grid gap-4 md:grid-cols-2">
            <div><p class="mb-2 text-xs font-medium text-muted-foreground">动作参数</p><dl v-if="actionParameterRecords(item).length" class="grid gap-2"> <div v-for="field in actionParameterRecords(item)" :key="field.key" class="flex items-start justify-between gap-3 border-b pb-2 text-sm last:border-0"><dt class="text-muted-foreground">{{ field.label }}</dt><dd class="max-w-[65%] break-words text-right font-mono tabular-nums">{{ field.value }}</dd></div></dl><p v-else class="text-sm text-muted-foreground">--</p></div>
            <div><p class="mb-2 text-xs font-medium text-muted-foreground">预期状态</p><dl v-if="expectedStateRecords(item).length" class="grid gap-2"> <div v-for="field in expectedStateRecords(item)" :key="field.key" class="flex items-start justify-between gap-3 border-b pb-2 text-sm last:border-0"><dt class="text-muted-foreground">{{ field.label }}</dt><dd class="max-w-[65%] break-words text-right font-mono tabular-nums">{{ field.value }}</dd></div></dl><p v-else class="text-sm text-muted-foreground">--</p></div>
          </div>
        </section>
      </CardContent>
    </Card>

    <Separator />

    <Card class="shadow-none">
      <CardHeader><CardTitle class="flex items-center gap-2 text-base"><FileText aria-hidden="true" />完整推理</CardTitle><CardDescription>模型保存的账户判断依据，位于结构化动作之后</CardDescription></CardHeader>
      <CardContent><div class="whitespace-pre-wrap break-words text-sm leading-7 text-foreground/90">{{ detail.reasoning || '本次决定没有保存推理正文。' }}</div><p class="mt-5 break-all font-mono text-xs text-muted-foreground">输入快照：{{ detail.input_snapshot_hash }}</p></CardContent>
    </Card>
  </article>
</template>
