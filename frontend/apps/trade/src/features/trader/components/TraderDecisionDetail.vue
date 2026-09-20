<script setup lang="ts">
import ReasoningText from '~/components/ReasoningText.vue'
import { ArrowRight, Bot, CheckCircle2, CircleAlert, FileCheck2, FileText } from '@lucide/vue'
import type { StrategySummary, TraderDecisionDetail as TraderDecisionDetailType } from '@aurum/contracts'
import { computed } from 'vue'
import { RouterLink } from 'vue-router'
import { Alert, AlertDescription, AlertTitle } from '@aurum/ui/alert'
import { Badge } from '@aurum/ui/badge'
import { Button } from '@aurum/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@aurum/ui/card'
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from '@aurum/ui/empty'
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

const emit = defineEmits<{ navigate: [tab: 'operations' | 'inventory'] }>()
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
      <CardHeader class="gap-4">
        <div class="flex flex-wrap items-center justify-between gap-3">
          <p class="text-xs font-medium text-muted-foreground">账户交易决策</p>
          <p class="text-xs tabular-nums text-muted-foreground">判断置信度 <strong class="ml-1 text-foreground">{{ summary.confidence }}%</strong></p>
        </div>
        <div class="flex flex-wrap items-center gap-3">
          <span class="flex size-10 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary"><Bot class="size-5" aria-hidden="true" /></span>
          <CardTitle class="text-2xl font-semibold">{{ actionLabel(summary.action) }}</CardTitle>
          <Badge v-if="summary.side" variant="secondary">{{ sideLabel(summary.side) }}</Badge>
          <span v-if="detail.actions.length" class="text-xs text-muted-foreground">{{ detail.actions.length }} 项建议动作</span>
        </div>
        <ReasoningText class="rounded-lg bg-muted/25 p-4 text-sm leading-7" :text="summary.summary" />
        <div class="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
          <CardDescription class="min-w-0 break-words">{{ strategyName(strategies, summary.strategyId) }} · {{ decisionTime }}</CardDescription>
          <Button v-if="summary.analysisId" variant="link" size="sm" as-child class="h-auto px-0"><RouterLink :to="{ path: '/analyst', query: { analysis_id: summary.analysisId } }">查看行情依据<ArrowRight class="size-3.5" /></RouterLink></Button>
        </div>
      </CardHeader>
      <CardContent class="flex flex-col gap-4 border-t pt-4 sm:flex-row sm:items-center sm:justify-between">
        <div class="min-w-0">
          <div class="mb-2 flex flex-wrap items-center gap-2"><span class="text-xs text-muted-foreground">风控审核</span><Badge :variant="statusVariant(summary.status)">{{ decisionStatusLabel(summary.status) }}</Badge></div>
          <p class="text-sm font-semibold">{{ summary.status === 'stale' ? '建议已失效' : summary.status === 'risk_rejected' ? '风控未通过' : summary.action === 'hold' ? '本次不发送交易指令' : summary.status === 'proposed' ? '等待风控审核' : '查看实际执行结果' }}</p>
          <p class="mt-1 text-sm leading-6 text-muted-foreground">{{ summary.status === 'stale' ? '账户、行情或设置已变化，请以最新建议为准。' : summary.status === 'risk_rejected' ? '当前建议未通过风控，可前往 AI 风控师查看账户限制。' : summary.action === 'hold' ? '本次没有需要执行的交易动作。' : summary.status === 'proposed' ? '审核通过后才会进入执行流程。' : '建议已生成，实际执行结果请查看账户执行记录。建议受理不代表成交。' }}</p>
        </div>
        <div class="flex shrink-0 flex-wrap gap-2">
          <Button v-if="summary.status === 'risk_rejected'" variant="outline" as-child><RouterLink to="/risk">查看风控</RouterLink></Button>
          <Button variant="outline" @click="emit('navigate', 'operations')">本次处理过程<ArrowRight class="size-4" /></Button>
          <Button variant="ghost" @click="emit('navigate', 'inventory')">持仓挂单</Button>
        </div>
      </CardContent>
    </Card>

    <Card v-if="detail.actions.length || summary.action !== 'hold'" class="shadow-none">
      <CardHeader><CardTitle class="flex items-center gap-2 text-base"><FileCheck2 aria-hidden="true" />动作明细</CardTitle><CardDescription>按每项动作核对交易对象、价格和原因</CardDescription></CardHeader>
      <CardContent class="grid gap-3">
        <Empty v-if="!detail.actions.length" class="min-h-40 border-0">
          <EmptyHeader><EmptyMedia variant="icon"><CheckCircle2 /></EmptyMedia><EmptyTitle>{{ summary.action === 'hold' ? '本次没有交易动作' : '暂无动作详情' }}</EmptyTitle><EmptyDescription>{{ summary.action === 'hold' ? 'AI 交易员本次建议观望。' : '当前记录没有可展示的动作参数，实际结果请查看执行记录。' }}</EmptyDescription></EmptyHeader>
        </Empty>
        <section v-for="(item, index) in detail.actions" :key="item.action_id" class="grid min-w-0 gap-4 rounded-xl border bg-muted/10 p-4">
          <div class="flex flex-wrap items-center justify-between gap-3"><div class="flex items-center gap-2"><Badge variant="outline">动作 {{ index + 1 }}</Badge><Badge :variant="actionVariant(item.kind)">{{ actionLabel(item.kind) }}</Badge></div></div>
          <dl v-if="actionParameterRecords(item).length" class="grid grid-cols-2 gap-x-5 gap-y-4 sm:grid-cols-3">
            <div v-for="field in actionParameterRecords(item)" :key="field.key" :class="field.key === 'reason' ? 'col-span-full border-t pt-3' : ''">
              <dt class="text-xs text-muted-foreground">{{ field.label }}</dt>
              <dd :class="['mt-1 break-words', field.key === 'reason' ? 'text-sm leading-7' : 'font-mono text-base font-semibold tabular-nums [overflow-wrap:anywhere]']">{{ field.value }}</dd>
            </div>
          </dl>
          <details v-if="expectedStateRecords(item).length" class="border-t pt-3">
            <summary class="cursor-pointer rounded text-xs text-muted-foreground focus-visible:outline-2 focus-visible:outline-ring">查看执行前核对条件</summary>
            <dl class="mt-3 grid gap-2">
              <div v-for="field in expectedStateRecords(item)" :key="field.key" class="flex justify-between gap-4 text-sm"><dt class="text-muted-foreground">{{ field.label }}</dt><dd class="break-words text-right">{{ field.value }}</dd></div>
            </dl>
          </details>
        </section>
      </CardContent>
    </Card>

    <details :key="summary.decisionId" open class="group rounded-xl border bg-card p-5">
      <summary class="flex cursor-pointer items-center gap-2 text-sm font-semibold"><FileText class="size-4" aria-hidden="true" />判断依据<span class="ml-auto text-xs font-normal text-muted-foreground"><span class="group-open:hidden">展开</span><span class="hidden group-open:inline">收起</span></span></summary>
      <ReasoningText class="mt-4" :text="detail.reasoning || '本次没有保存完整判断依据。'" />
    </details>
  </article>
</template>
