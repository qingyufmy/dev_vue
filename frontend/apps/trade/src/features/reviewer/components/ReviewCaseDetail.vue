<script setup lang="ts">
import { AlertCircle, ArrowDownToLine, ArrowUpRight, Bot, CheckCircle2, CircleHelp, FileSearch, GitCompareArrows, History, ShieldCheck, Sparkles, Terminal, Undo2 } from '@lucide/vue'
import { Badge } from '@aurum/ui/badge'
import { Button } from '@aurum/ui/button'
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from '@aurum/ui/card'
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from '@aurum/ui/empty'
import { Progress } from '@aurum/ui/progress'
import { Separator } from '@aurum/ui/separator'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@aurum/ui/table'
import { caseKindLabel, formatReviewTime, metricTone, statusLabel, type ReviewCaseDetail as CaseDetail, type ReviewLayer } from '../model/reviewer-presentation'

const props = defineProps<{
  detail: CaseDetail
  action?: string
  canEdit?: boolean
}>()

const emit = defineEmits<{
  confirm: []
  return: []
  edit: []
  openMemory: [id: string]
}>()

function layerIcon(layer: ReviewLayer) {
  if (layer.key.includes('analyst')) return Bot
  if (layer.key.includes('risk')) return ShieldCheck
  if (layer.key.includes('execution')) return Terminal
  return GitCompareArrows
}

function layerTone(layer: ReviewLayer) {
  const normalized = `${layer.status} ${layer.summary}`
  return metricTone(normalized)
}

function toneClass(value: string) {
  return metricTone(value) === 'positive' ? 'text-trade-up' : metricTone(value) === 'negative' ? 'text-trade-down' : 'text-foreground'
}
</script>

<template>
  <article class="grid min-w-0 gap-4">
    <Card class="overflow-hidden shadow-none">
      <CardHeader class="border-b bg-muted/20">
        <div class="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
          <div class="min-w-0">
            <div class="flex flex-wrap items-center gap-2">
              <Badge variant="outline">{{ caseKindLabel(detail.kind) }}</Badge>
              <Badge variant="outline">{{ detail.terminalPeriod }}</Badge>
              <Badge :variant="detail.status === 'confirmed' ? 'default' : detail.status === 'failed' ? 'destructive' : 'secondary'">{{ statusLabel(detail.status) }}</Badge>
            </div>
            <CardTitle class="mt-3 text-xl sm:text-2xl">{{ detail.title }}</CardTitle>
            <CardDescription class="mt-2 flex flex-wrap gap-x-2 gap-y-1">
              <span>{{ detail.accountLabel }}</span><span aria-hidden="true">·</span><span class="font-mono">{{ detail.symbol }}</span><span aria-hidden="true">·</span><span>{{ detail.strategyLabel }}</span><template v-if="detail.subscriptionId"><span aria-hidden="true">·</span><span>订阅 {{ detail.subscriptionId }}<template v-if="detail.subscriptionRevision !== null"> · v{{ detail.subscriptionRevision }}</template></span></template>
            </CardDescription>
          </div>
          <div v-if="detail.confidence !== null" class="w-full shrink-0 lg:w-48">
            <div class="mb-2 flex items-center justify-between gap-3 text-xs text-muted-foreground"><span>复盘置信度</span><strong class="font-mono text-sm text-foreground">{{ detail.confidence }}%</strong></div>
            <Progress :model-value="detail.confidence" aria-label="复盘置信度" />
          </div>
        </div>
        <div class="mt-4 rounded-lg border bg-background p-4">
          <p v-if="detail.legacy" class="text-sm leading-6">历史原文：保留旧版正文供查阅，暂不支持修订、确认或写入新版记忆。</p>
          <p v-else class="text-xs font-medium text-muted-foreground">复盘结论</p>
          <p class="mt-2 text-base font-medium leading-7">{{ detail.conclusion || '暂无结构化结论。' }}</p>
        </div>
      </CardHeader>
      <CardFooter class="flex flex-wrap items-center justify-between gap-3 px-5 py-4">
        <p class="text-xs text-muted-foreground">证据修订 {{ detail.evidenceRevision }} · {{ detail.evidenceHash ? `输入 ${detail.evidenceHash.slice(0, 12)}…` : '未提供输入哈希' }}</p>
        <div class="flex flex-wrap gap-2">
          <Button v-if="!detail.legacy && canEdit && detail.currentVersionId && ['awaiting_confirmation', 'needs_changes'].includes(detail.status)" variant="outline" class="min-h-11" :disabled="Boolean(action)" @click="emit('edit')"><Undo2 data-icon="inline-start" />修订复盘</Button>
          <Button v-if="!detail.legacy && detail.status === 'awaiting_confirmation' && detail.currentVersionId" variant="outline" class="min-h-11" :disabled="Boolean(action)" @click="emit('return')"><ArrowDownToLine data-icon="inline-start" />退回复核</Button>
          <Button v-if="!detail.legacy && detail.status === 'awaiting_confirmation' && detail.currentVersionId" class="min-h-11" :disabled="Boolean(action)" @click="emit('confirm')"><CheckCircle2 data-icon="inline-start" />确认复盘</Button>
        </div>
      </CardFooter>
    </Card>

    <div v-if="detail.keyFindings.length" class="grid gap-3 sm:grid-cols-2">
      <Card v-for="(finding, index) in detail.keyFindings" :key="`${finding}-${index}`" size="sm" class="shadow-none">
        <CardContent class="flex gap-3 p-4"><span class="grid size-7 shrink-0 place-items-center rounded-full bg-primary/10 text-xs font-semibold text-primary">{{ index + 1 }}</span><p class="text-sm leading-6">{{ finding }}</p></CardContent>
      </Card>
    </div>

    <Card class="shadow-none">
      <CardHeader>
        <CardTitle class="flex items-center gap-2 text-base"><CircleHelp aria-hidden="true" />核心指标</CardTitle>
        <CardDescription>将结果与证据完整度分开查看，不从盈亏单独推断交易正确性。</CardDescription>
      </CardHeader>
      <CardContent>
        <div v-if="detail.metrics.length" class="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
          <div v-for="metric in detail.metrics" :key="metric.label" class="rounded-lg border bg-muted/20 p-4">
            <p class="text-xs text-muted-foreground">{{ metric.label }}</p>
            <p class="mt-2 font-mono text-lg font-semibold tabular-nums" :class="toneClass(metric.value)">{{ metric.value }}</p>
            <p v-if="metric.hint" class="mt-1 text-xs leading-5 text-muted-foreground">{{ metric.hint }}</p>
          </div>
        </div>
        <p v-else class="text-sm text-muted-foreground">本次复盘尚未返回结构化指标。</p>
      </CardContent>
    </Card>

    <Card class="shadow-none">
      <CardHeader>
        <CardTitle class="flex items-center gap-2 text-base"><GitCompareArrows aria-hidden="true" />四层评价</CardTitle>
        <CardDescription>行情分析、账户交易员判断、硬风控和终端执行分别评价，避免把某一层结果混为模型准确率。</CardDescription>
      </CardHeader>
      <CardContent class="grid gap-3 md:grid-cols-2">
        <section v-for="layer in detail.layers" :key="layer.key" class="rounded-xl border p-4">
          <div class="flex items-start justify-between gap-3">
            <div class="flex min-w-0 items-center gap-2"><component :is="layerIcon(layer)" class="text-primary" aria-hidden="true" /><h3 class="truncate font-medium">{{ layer.label }}</h3></div>
            <Badge :variant="layerTone(layer) === 'negative' ? 'destructive' : layerTone(layer) === 'positive' ? 'default' : 'outline'">{{ layer.status }}</Badge>
          </div>
          <p class="mt-3 text-sm leading-6 text-muted-foreground">{{ layer.summary }}</p>
          <div v-if="layer.score !== null" class="mt-4">
            <div class="mb-2 flex items-center justify-between text-xs text-muted-foreground"><span>分层评分</span><span class="font-mono tabular-nums">{{ layer.score }}%</span></div>
            <Progress :model-value="layer.score" :aria-label="`${layer.label}分层评分`" />
          </div>
          <ul v-if="layer.details.length" class="mt-3 grid gap-2 border-t pt-3 text-xs leading-5 text-muted-foreground"><li v-for="item in layer.details" :key="item">{{ item }}</li></ul>
        </section>
        <Empty v-if="!detail.layers.length" class="col-span-full min-h-32 border-0"><EmptyHeader><EmptyMedia variant="icon"><GitCompareArrows /></EmptyMedia><EmptyTitle>尚无分层评价</EmptyTitle></EmptyHeader></Empty>
      </CardContent>
    </Card>

    <Card class="shadow-none">
      <CardHeader>
        <CardTitle class="flex items-center gap-2 text-base"><History aria-hidden="true" />交易事件</CardTitle>
        <CardDescription>完整交易闭环按事件展示；未闭合或无法精确归因的样本不会生成最终评价。</CardDescription>
      </CardHeader>
      <CardContent class="p-0">
        <div v-if="detail.episodes.length" class="overflow-x-auto">
          <Table>
            <TableHeader><TableRow><TableHead>品种 / 方向</TableHead><TableHead>进出场</TableHead><TableHead>来源</TableHead><TableHead>结果</TableHead><TableHead class="text-right">净盈亏</TableHead></TableRow></TableHeader>
            <TableBody>
              <TableRow v-for="episode in detail.episodes" :key="episode.id">
                <TableCell><div class="grid gap-1"><span class="font-medium">{{ episode.symbol }}</span><span class="text-xs text-muted-foreground">{{ episode.direction }}</span></div></TableCell>
                <TableCell><div class="grid gap-1 text-xs tabular-nums"><span>{{ formatReviewTime(episode.entryAt, detail.terminalTimezoneOffsetMinutes) }}</span><span class="text-muted-foreground">→ {{ formatReviewTime(episode.exitAt, detail.terminalTimezoneOffsetMinutes) }}</span></div></TableCell>
                <TableCell><div class="grid gap-1 text-xs"><span>{{ episode.source }}</span><span v-if="episode.orderId" class="font-mono text-muted-foreground">#{{ episode.orderId }}</span></div></TableCell>
                <TableCell>{{ episode.outcome }}</TableCell>
                <TableCell class="text-right font-mono tabular-nums" :class="toneClass(episode.profit)">{{ episode.profit }}</TableCell>
              </TableRow>
            </TableBody>
          </Table>
        </div>
        <Empty v-else class="min-h-36 border-0"><EmptyHeader><EmptyMedia variant="icon"><History /></EmptyMedia><EmptyTitle>没有可评价的交易事件</EmptyTitle><EmptyDescription>未闭合交易、挂单或证据不完整的记录不会被强行纳入结果。</EmptyDescription></EmptyHeader></Empty>
      </CardContent>
    </Card>

    <div class="grid gap-4 xl:grid-cols-2">
      <Card class="shadow-none">
        <CardHeader><CardTitle class="flex items-center gap-2 text-base"><ArrowUpRight aria-hidden="true" />机会候选</CardTitle><CardDescription>只作为后续研究候选，不代表事后一定可以交易。</CardDescription></CardHeader>
        <CardContent class="grid gap-3">
          <section v-for="candidate in detail.missedOpportunityCandidates" :key="candidate.id" class="rounded-lg border border-primary/30 bg-primary/5 p-4"><div class="flex items-center justify-between gap-3"><h3 class="font-medium">{{ candidate.title }}</h3><Badge variant="outline">漏判候选</Badge></div><p class="mt-2 text-sm leading-6 text-muted-foreground">{{ candidate.summary }}</p><ul v-if="candidate.evidence.length" class="mt-3 grid gap-1 text-xs text-muted-foreground"><li v-for="item in candidate.evidence" :key="item">{{ item }}</li></ul></section>
          <p v-if="!detail.missedOpportunityCandidates.length" class="text-sm text-muted-foreground">暂无漏判候选。</p>
        </CardContent>
      </Card>
      <Card class="shadow-none">
        <CardHeader><CardTitle class="flex items-center gap-2 text-base"><AlertCircle aria-hidden="true" />反向候选</CardTitle><CardDescription>需要和反例、策略版本、数据缺口一起复核。</CardDescription></CardHeader>
        <CardContent class="grid gap-3">
          <section v-for="candidate in detail.falsePositiveCandidates" :key="candidate.id" class="rounded-lg border border-destructive/30 bg-destructive/5 p-4"><div class="flex items-center justify-between gap-3"><h3 class="font-medium">{{ candidate.title }}</h3><Badge variant="destructive">误判候选</Badge></div><p class="mt-2 text-sm leading-6 text-muted-foreground">{{ candidate.summary }}</p><ul v-if="candidate.evidence.length" class="mt-3 grid gap-1 text-xs text-muted-foreground"><li v-for="item in candidate.evidence" :key="item">{{ item }}</li></ul></section>
          <p v-if="!detail.falsePositiveCandidates.length" class="text-sm text-muted-foreground">暂无误判候选。</p>
        </CardContent>
      </Card>
    </div>

    <Card class="shadow-none">
      <CardHeader><CardTitle class="flex items-center gap-2 text-base"><Sparkles aria-hidden="true" />记忆候选</CardTitle><CardDescription>确认复盘不会自动修改策略；经验进入对应策略记忆库前仍需单独确认。</CardDescription></CardHeader>
      <CardContent class="grid gap-3">
        <section v-for="candidate in detail.memoryCandidates" :key="candidate.id" class="rounded-lg border bg-muted/20 p-4"><div class="flex items-center justify-between gap-3"><h3 class="font-medium">{{ candidate.title }}</h3><Badge variant="outline">待单独确认</Badge></div><p class="mt-2 text-sm leading-6 text-muted-foreground">{{ candidate.summary }}</p><div v-if="candidate.confidence !== null" class="mt-3 flex items-center gap-2 text-xs text-muted-foreground"><span>候选置信度</span><Progress :model-value="candidate.confidence" class="max-w-40" /><span class="font-mono">{{ candidate.confidence }}%</span></div></section>
        <p v-if="!detail.memoryCandidates.length" class="text-sm text-muted-foreground">本次没有生成记忆候选。</p>
      </CardContent>
    </Card>

    <Card class="shadow-none">
      <CardHeader><CardTitle class="flex items-center gap-2 text-base"><FileSearch aria-hidden="true" />证据链</CardTitle><CardDescription>来源 ID、时间与完整状态用于回到服务端事实，不以模型推测替代原始证据。</CardDescription></CardHeader>
      <CardContent class="grid gap-3 sm:grid-cols-2">
        <div v-for="evidence in detail.evidence" :key="evidence.id" class="rounded-lg border p-4"><div class="flex items-start justify-between gap-3"><div class="min-w-0"><p class="font-medium">{{ evidence.label }}</p><p class="mt-1 break-all font-mono text-xs text-muted-foreground">{{ evidence.sourceId }}</p></div><Badge :variant="evidence.complete ? 'default' : 'destructive'">{{ evidence.complete ? '完整' : '缺失' }}</Badge></div><p class="mt-3 text-sm leading-6 text-muted-foreground">{{ evidence.summary }}</p><p class="mt-2 text-xs tabular-nums text-muted-foreground">{{ formatReviewTime(evidence.occurredAt, detail.terminalTimezoneOffsetMinutes) }}</p></div>
        <Empty v-if="!detail.evidence.length" class="col-span-full min-h-32 border-0"><EmptyHeader><EmptyMedia variant="icon"><FileSearch /></EmptyMedia><EmptyTitle>暂无证据链</EmptyTitle><EmptyDescription>系统不会在没有证据时生成看似完整的复盘。</EmptyDescription></EmptyHeader></Empty>
      </CardContent>
    </Card>

    <Separator />

    <Card class="shadow-none">
      <CardHeader><CardTitle class="text-base">完整 AI 正文</CardTitle><CardDescription>结构化结论、分层评价和证据链之后，保留模型原始输出供审计。</CardDescription></CardHeader>
      <CardContent><div v-if="detail.fullText" class="max-w-3xl whitespace-pre-wrap break-words text-sm leading-7 text-foreground/90">{{ detail.fullText }}</div><p v-else class="text-sm text-muted-foreground">本次复盘没有保存完整正文。</p></CardContent>
    </Card>
  </article>
</template>
