<script setup lang="ts">
import { Activity, Bot, BrainCircuit, CheckCircle2, CircleDollarSign, Edit3, FilePlus2, Link2, Percent, Rocket, ScrollText, Scale, Trash2, TrendingDown } from '@lucide/vue'
import type { StrategySummary } from '@aurum/contracts'
import { computed, ref, watch } from 'vue'
import { useTradeSession } from '~/features/auth'
import { Badge } from '@aurum/ui/badge'
import { Button } from '@aurum/ui/button'
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from '@aurum/ui/card'
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from '@aurum/ui/empty'
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@aurum/ui/sheet'
import type { StrategyDetailView } from '../model/strategy-presentation'
import { formatDateTime, strategyStatusLabel, versionLabel } from '../model/strategy-presentation'

const props = withDefaults(defineProps<{
  detail: StrategyDetailView | null
  loading?: boolean
  busy?: boolean
}>(), { loading: false, busy: false })

const emit = defineEmits<{
  'edit-meta': [strategy: StrategySummary]
  'new-version': [detail: StrategyDetailView]
  publish: [versionId: string]
  retire: []
  subscriptions: []
}>()

const { session } = useTradeSession()
const activeVersion = computed(() => props.detail?.versions.find((item) => item.id === props.detail?.strategy.activeVersionId))
const metrics = computed(() => {
  const value = props.detail?.performance
  const currency = value?.currency ?? ''
  const amount = (raw: string | null | undefined) => raw === null || raw === undefined ? '—' : `${Number(raw).toLocaleString('zh-CN', { maximumFractionDigits: 2 })} ${currency}`.trim()
  return [
    { label: '净收益', value: amount(value?.netProfit), icon: CircleDollarSign },
    { label: '最大回撤', value: amount(value?.maxDrawdown), icon: TrendingDown },
    { label: '已平仓做单', value: value?.status === 'available' ? String(value.tradeCount) : '—', icon: Activity },
    { label: '盈亏比', value: value?.profitFactor ? Number(value.profitFactor).toFixed(2) : '—', icon: Scale },
    { label: '胜率', value: value?.winRatePercent ? `${Number(value.winRatePercent).toFixed(1)}%` : '—', icon: Percent },
  ]
})
const viewingVersionId = ref<string | null>(null)
const viewingVersion = computed(() => props.detail?.versions.find((item) => item.id === viewingVersionId.value))
watch(() => props.detail?.strategy.id, () => { viewingVersionId.value = null })
</script>

<template>
  <Card class="min-w-0 shadow-none">
    <div v-if="loading" class="grid min-h-[34rem] place-items-center" aria-busy="true">
      <div class="grid w-full max-w-xl gap-4 px-6"><div class="h-8 animate-pulse rounded bg-muted motion-reduce:animate-none" /><div class="h-28 animate-pulse rounded bg-muted motion-reduce:animate-none" /><div class="h-48 animate-pulse rounded bg-muted motion-reduce:animate-none" /></div>
    </div>
    <Empty v-else-if="!detail" class="min-h-[34rem]">
      <EmptyHeader><EmptyMedia variant="icon"><ScrollText /></EmptyMedia><EmptyTitle>选择一套策略组合</EmptyTitle><EmptyDescription>查看组合说明、实盘效果与内部版本。</EmptyDescription></EmptyHeader>
    </Empty>
    <template v-else>
      <CardHeader class="flex flex-col gap-4 border-b bg-muted/15">
        <div class="flex flex-wrap items-center gap-2">
          <Badge variant="outline">策略组合</Badge>
          <Badge :variant="detail.strategy.status === 'active' ? 'default' : 'secondary'">{{ strategyStatusLabel[detail.strategy.status] }}</Badge>
          <Badge variant="outline">{{ detail.strategy.scope === 'platform' ? '平台共享' : '我的策略' }}</Badge>
        </div>
        <CardTitle class="text-2xl">{{ detail.strategy.name }}</CardTitle>
        <Button v-if="detail.strategy.scope === 'platform' && detail.strategy.status !== 'retired' && session?.permissions.includes('admin')" class="min-h-11 self-start" :disabled="busy" @click="emit('new-version', detail)"><Edit3 />编辑策略</Button>
        <CardDescription class="max-w-3xl text-sm leading-6">{{ detail.strategy.description || '暂无策略说明' }}</CardDescription>
        <div v-if="detail.strategy.scope === 'user' && detail.strategy.status !== 'retired'" class="flex flex-wrap gap-2">
          <Button variant="outline" size="sm" :disabled="busy" @click="emit('new-version', detail)"><Edit3 />编辑策略</Button>
          <Button size="sm" :disabled="busy" @click="emit('new-version', detail)"><FilePlus2 />新建版本</Button>
        </div>
      </CardHeader>

      <CardContent class="grid gap-6 pt-6">
        <section aria-labelledby="performance-title">
          <div class="flex flex-wrap items-end justify-between gap-3">
            <div><h3 id="performance-title" class="font-semibold">我的实盘效果</h3><p class="mt-1 text-xs text-muted-foreground">仅统计当前用户已平仓、终端证据完整且精确归因的交易。</p></div>
            <Badge variant="outline">{{ detail.performance.status === 'available' ? `${detail.performance.currency} · ${formatDateTime(detail.performance.periodStart)} 至 ${formatDateTime(detail.performance.periodEnd)}` : detail.performance.status === 'mixed_currency' ? '多币种暂不合并' : '精确样本不足' }}</Badge>
          </div>
          <div class="mt-3 grid grid-cols-2 gap-3 xl:grid-cols-5">
            <div v-for="metric in metrics" :key="metric.label" class="rounded-xl border bg-card p-4">
              <component :is="metric.icon" class="size-4 text-muted-foreground" aria-hidden="true" />
              <p class="mt-4 text-xs text-muted-foreground">{{ metric.label }}</p><strong class="mt-1 block text-lg tabular-nums">{{ metric.value }}</strong>
            </div>
          </div>
          <p v-if="detail.performance.status !== 'available'" class="mt-3 rounded-lg bg-muted/40 px-3 py-2 text-xs leading-5 text-muted-foreground">{{ detail.performance.status === 'mixed_currency' ? `检测到 ${detail.performance.currencies.join('、')}，金额和比例不做跨币种合并。` : '当前还没有足够的精确归因实盘记录；这里不会使用账户总收益或估算值代替。' }}</p>
        </section>

        <section class="grid gap-3 rounded-xl border p-4" aria-labelledby="strategy-pair-title">
          <div><p class="text-xs font-medium text-primary">协同策略</p><h3 id="strategy-pair-title" class="mt-1 font-semibold">分析与执行，各自独立版本</h3></div>
          <div class="grid gap-3 sm:grid-cols-[1fr_auto_1fr] sm:items-center">
            <div class="rounded-lg bg-muted/35 p-3"><BrainCircuit class="size-4 text-primary" /><p class="mt-2 text-xs text-muted-foreground">行情分析引擎</p><strong class="mt-1 block text-sm">{{ detail.strategy.name }}</strong></div>
            <Link2 class="mx-auto size-4 text-muted-foreground" aria-hidden="true" />
            <div class="rounded-lg bg-muted/35 p-3"><Bot class="size-4 text-primary" /><p class="mt-2 text-xs text-muted-foreground">交易执行引擎</p><strong class="mt-1 block text-sm">{{ detail.strategy.pairedTraderStrategy?.name ?? '待绑定' }}</strong><p class="mt-1 text-xs text-muted-foreground">{{ detail.strategy.pairedTraderStrategy?.activeVersionId ? '已发布可用' : '尚未发布可用版本' }}</p></div>
          </div>
        </section>

        <section class="grid gap-3 rounded-xl border bg-muted/25 p-4" aria-labelledby="active-version-title">
          <div class="flex flex-wrap items-center justify-between gap-3">
            <div>
              <p class="text-xs font-medium text-muted-foreground">当前分析版本</p>
              <h3 id="active-version-title" class="mt-1 text-lg font-semibold">{{ versionLabel(activeVersion) }}</h3>
            </div>
            <Button v-if="activeVersion && detail.strategy.status === 'active'" variant="outline" class="min-h-11" @click="emit('subscriptions')">管理账户订阅</Button>
          </div>
          <p v-if="activeVersion" class="line-clamp-3 whitespace-pre-wrap text-sm leading-6 text-muted-foreground">{{ activeVersion.promptText }}</p>
          <p v-else class="text-sm text-muted-foreground">{{ detail.strategy.scope === 'platform' ? '此平台策略尚未发布，发布后即可订阅。' : '发布一个版本后，即可在账户中订阅使用。' }}</p>
        </section>

        <section aria-labelledby="version-history-title">
          <div class="flex items-end justify-between gap-3">
            <div><h3 id="version-history-title" class="font-semibold">版本记录</h3><p class="mt-1 text-xs text-muted-foreground">历史版本不可覆盖；修改会生成新版本。</p></div>
            <Badge variant="secondary">{{ detail.versions.length }} 个版本</Badge>
          </div>
          <div class="mt-3 divide-y rounded-xl border">
            <article v-for="version in detail.versions" :key="version.id" class="grid gap-3 p-4 sm:grid-cols-[auto_minmax(0,1fr)_auto] sm:items-center">
              <span class="flex size-10 items-center justify-center rounded-lg bg-muted font-mono text-sm font-semibold">v{{ version.versionNumber }}</span>
              <div class="min-w-0">
                <div class="flex flex-wrap items-center gap-2"><strong class="text-sm">{{ version.id === detail.strategy.activeVersionId ? '当前生效' : !activeVersion || version.versionNumber > activeVersion.versionNumber ? '待发布版本' : '历史版本' }}</strong><Badge v-if="version.id === detail.strategy.activeVersionId" variant="default"><CheckCircle2 />已发布</Badge></div>
                <p class="mt-1 truncate text-xs text-muted-foreground">{{ formatDateTime(version.createdAt) }}</p>
              </div>
              <div class="flex flex-wrap gap-2"><Button variant="ghost" size="sm" class="min-h-11" @click="viewingVersionId = version.id">查看版本</Button>
              <Button v-if="(detail.strategy.scope === 'user' || session?.permissions.includes('admin')) && version.id !== detail.strategy.activeVersionId && detail.strategy.status !== 'retired'" variant="outline" size="sm" :disabled="busy" @click="emit('publish', version.id)"><Rocket />发布此版</Button></div>
            </article>
          </div>
        </section>

        <p v-if="detail.strategy.scope === 'platform'" class="text-xs leading-5 text-muted-foreground">平台策略由管理员维护，您可以查看版本并管理自己的账户订阅。</p>
      </CardContent>
      <CardFooter v-if="detail.strategy.scope === 'user' && detail.strategy.status !== 'retired'" class="justify-end border-t">
        <Button variant="destructive" :disabled="busy" @click="emit('retire')"><Trash2 />退役策略</Button>
      </CardFooter>
    </template>
  </Card>
  <Sheet :open="!!viewingVersion" @update:open="!$event && (viewingVersionId = null)">
    <SheetContent class="w-full gap-0 overflow-hidden p-0 data-[side=right]:w-full sm:data-[side=right]:max-w-3xl">
      <SheetHeader class="border-b pr-16 text-left">
        <SheetTitle>{{ detail?.strategy.name }} · {{ versionLabel(viewingVersion) }}</SheetTitle>
        <SheetDescription>查看此版本的完整提示词与配置。</SheetDescription>
      </SheetHeader>
      <div v-if="viewingVersion" class="min-h-0 flex-1 space-y-6 overflow-y-auto p-6">
        <p class="text-xs text-muted-foreground">创建于 {{ formatDateTime(viewingVersion.createdAt) }}</p>
        <section><h3 class="mb-3 font-semibold">提示词</h3><pre class="whitespace-pre-wrap break-words rounded-lg border bg-muted/25 p-4 font-sans text-sm leading-7">{{ viewingVersion.promptText }}</pre></section>
        <details class="rounded-lg border p-4"><summary class="cursor-pointer text-sm font-medium">数据与版本配置</summary>
          <pre class="mt-4 overflow-x-auto whitespace-pre-wrap break-all text-xs leading-6">{{ JSON.stringify(viewingVersion.config, null, 2) }}</pre>
          <p class="mt-4 break-all text-xs leading-6 text-muted-foreground">输入契约：{{ viewingVersion.inputContractVersion }} · 输出契约：{{ viewingVersion.outputContractVersion }}<br>SHA256：{{ viewingVersion.promptSha256 }}</p>
        </details>
      </div>
    </SheetContent>
  </Sheet>
</template>
