<script setup lang="ts">
import { ArrowRight, Ban, Bot, ChartNoAxesCombined, CircleAlert, FileText, Pencil, ShieldCheck } from '@lucide/vue'
import type { OpenPosition, PendingOrder, TraderDecisionSummary } from '@aurum/contracts'
import { computed } from 'vue'
import { RouterLink } from 'vue-router'
import { Alert, AlertDescription, AlertTitle } from '@aurum/ui/alert'
import { Badge } from '@aurum/ui/badge'
import { Button } from '@aurum/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@aurum/ui/card'
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from '@aurum/ui/empty'
import { ScrollArea } from '@aurum/ui/scroll-area'
import { Separator } from '@aurum/ui/separator'
import { Sheet, SheetContent, SheetDescription, SheetFooter, SheetHeader, SheetTitle } from '@aurum/ui/sheet'
import {
  actionLabel,
  decisionStatusLabel,
  formatDateTime,
  formatDecimal,
  formatPrice,
  formatVolume,
  isPosition,
  orderTypeLabel,
  profitClass,
  resourceActionHint,
  resourceKind,
  sideLabel,
  sourceLabel,
} from '../model/trader-presentation'

const props = withDefaults(defineProps<{
  open: boolean
  resource: OpenPosition | PendingOrder | null
  decision?: TraderDecisionSummary | null
  readOnly?: boolean
  timezoneOffsetMinutes?: number | null
}>(), {
  decision: null,
  readOnly: false,
  timezoneOffsetMinutes: null,
})

const emit = defineEmits<{
  'update:open': [value: boolean]
  'modify-position': [resource: OpenPosition]
  'close-position': [resource: OpenPosition]
  'modify-order': [resource: PendingOrder]
  'cancel-order': [resource: PendingOrder]
}>()

const title = computed(() => props.resource ? `${resourceKind(props.resource)} · ${props.resource.symbol}` : '交易资源详情')
const description = computed(() => props.resource ? `订单号 #${props.resource.ticket} · ${props.resource.accountId}` : '选择持仓或挂单查看完整参数')
const tradingTime = (value: string | null) => formatDateTime(value, props.timezoneOffsetMinutes)

function requestModifyPosition() {
  if (props.readOnly || !props.resource || !isPosition(props.resource)) return
  emit('modify-position', props.resource)
}

function requestClosePosition() {
  if (props.readOnly || !props.resource || !isPosition(props.resource)) return
  emit('close-position', props.resource)
}

function requestModifyOrder() {
  if (props.readOnly || !props.resource || isPosition(props.resource)) return
  emit('modify-order', props.resource)
}

function requestCancelOrder() {
  if (props.readOnly || !props.resource || isPosition(props.resource)) return
  emit('cancel-order', props.resource)
}
</script>

<template>
  <Sheet :open="open" @update:open="emit('update:open', $event)">
    <SheetContent class="w-full gap-0 p-0 sm:max-w-xl" side="right">
      <SheetHeader class="border-b pr-16 text-left">
        <div class="flex flex-wrap items-center gap-2">
          <Badge variant="outline">{{ resourceKind(resource) }}</Badge>
          <Badge v-if="resource && isPosition(resource)" variant="outline">{{ sideLabel(resource.side) }}</Badge>
          <Badge v-else-if="resource" variant="outline">{{ orderTypeLabel(resource.type) }}</Badge>
        </div>
        <SheetTitle>{{ title }}</SheetTitle>
        <SheetDescription>{{ description }}</SheetDescription>
      </SheetHeader>

      <ScrollArea class="min-h-0 flex-1">
        <div v-if="!resource" class="p-4 sm:p-6">
          <Empty class="min-h-64 border-0">
            <EmptyHeader>
              <EmptyMedia variant="icon"><ChartNoAxesCombined /></EmptyMedia>
              <EmptyTitle>没有选中的交易资源</EmptyTitle>
              <EmptyDescription>从持仓或挂单列表选择一项，查看其全部参数和来源。</EmptyDescription>
            </EmptyHeader>
          </Empty>
        </div>

        <div v-else class="grid gap-4 p-4 sm:p-6">
          <Alert>
            <CircleAlert aria-hidden="true" />
            <AlertTitle>{{ readOnly ? '当前为只读视图' : '交易操作需服务端确认' }}</AlertTitle>
            <AlertDescription>{{ readOnly ? '观摩模式只允许查看数据，不会修改终端资源。' : resourceActionHint(resource) }}</AlertDescription>
          </Alert>

          <Card size="sm" class="shadow-none">
            <CardHeader>
              <CardTitle class="flex items-center gap-2 text-base"><FileText aria-hidden="true" />订单参数</CardTitle>
              <CardDescription>来自当前账户终端的最新资源快照</CardDescription>
            </CardHeader>
            <CardContent>
              <dl class="grid gap-x-4 gap-y-4 sm:grid-cols-2">
                <div><dt class="text-xs text-muted-foreground">品种</dt><dd class="mt-1 font-medium">{{ resource.symbol }}</dd></div>
                <div><dt class="text-xs text-muted-foreground">订单号</dt><dd class="mt-1 font-mono tabular-nums">#{{ resource.ticket }}</dd></div>
                <div v-if="isPosition(resource)"><dt class="text-xs text-muted-foreground">方向</dt><dd class="mt-1"><Badge variant="outline">{{ sideLabel(resource.side) }}</Badge></dd></div>
                <div v-else><dt class="text-xs text-muted-foreground">挂单类型</dt><dd class="mt-1"><Badge variant="outline">{{ orderTypeLabel(resource.type) }}</Badge></dd></div>
                <div><dt class="text-xs text-muted-foreground">手数</dt><dd class="mt-1 font-mono tabular-nums">{{ formatVolume(resource.volume) }}</dd></div>
                <div v-if="isPosition(resource)"><dt class="text-xs text-muted-foreground">开仓价</dt><dd class="mt-1 font-mono tabular-nums">{{ formatPrice(resource.openPrice) }}</dd></div>
                <div v-else><dt class="text-xs text-muted-foreground">触发价</dt><dd class="mt-1 font-mono tabular-nums">{{ formatPrice(resource.price) }}</dd></div>
                <div v-if="isPosition(resource)"><dt class="text-xs text-muted-foreground">当前价</dt><dd class="mt-1 font-mono tabular-nums">{{ formatPrice(resource.currentPrice) }}</dd></div>
                <div><dt class="text-xs text-muted-foreground">止损价</dt><dd class="mt-1 font-mono tabular-nums">{{ formatPrice(resource.stopLoss) }}</dd></div>
                <div><dt class="text-xs text-muted-foreground">止盈价</dt><dd class="mt-1 font-mono tabular-nums">{{ formatPrice(resource.takeProfit) }}</dd></div>
                <div v-if="isPosition(resource)"><dt class="text-xs text-muted-foreground">浮动盈亏</dt><dd class="mt-1 font-mono font-semibold tabular-nums" :class="profitClass(resource.floatingProfit)">{{ formatDecimal(resource.floatingProfit, 2) }}</dd></div>
                <div><dt class="text-xs text-muted-foreground">来源</dt><dd class="mt-1">{{ sourceLabel(resource.source) }}</dd></div>
                <div v-if="isPosition(resource)"><dt class="text-xs text-muted-foreground">开仓时间</dt><dd class="mt-1 text-sm tabular-nums">{{ tradingTime(resource.openedAt) }}</dd></div>
                <div v-else><dt class="text-xs text-muted-foreground">创建时间</dt><dd class="mt-1 text-sm tabular-nums">{{ tradingTime(resource.createdAt) }}</dd></div>
                <div v-if="!isPosition(resource)"><dt class="text-xs text-muted-foreground">到期时间</dt><dd class="mt-1 text-sm tabular-nums">{{ tradingTime(resource.expiresAt) }}</dd></div>
                <div><dt class="text-xs text-muted-foreground">资源版本</dt><dd class="mt-1 font-mono tabular-nums">{{ resource.revision }}</dd></div>
              </dl>
            </CardContent>
          </Card>

          <Card v-if="decision" size="sm" class="shadow-none">
            <CardHeader>
              <CardTitle class="flex items-center gap-2 text-base"><Bot aria-hidden="true" />关联 AI 交易员决定</CardTitle>
              <CardDescription>AI 决策仅代表建议，是否执行以服务端操作状态和终端复核为准</CardDescription>
            </CardHeader>
            <CardContent class="grid gap-3">
              <div class="flex flex-wrap items-center gap-2"><Badge variant="secondary">{{ actionLabel(decision.action) }}</Badge><Badge variant="outline">{{ decisionStatusLabel(decision.status) }}</Badge><span v-if="decision.side" class="text-sm text-muted-foreground">{{ sideLabel(decision.side) }}</span></div>
              <p class="text-sm leading-6">{{ decision.summary }}</p>
              <Button v-if="decision.analysisId" variant="outline" size="lg" as-child class="w-full sm:w-fit"><RouterLink :to="{ path: '/analyst', query: { analysis_id: decision.analysisId } }">查看关联行情分析<ArrowRight data-icon="inline-end" /></RouterLink></Button>
            </CardContent>
          </Card>

          <Card v-else-if="resource.signalId" size="sm" class="shadow-none">
            <CardHeader><CardTitle class="flex items-center gap-2 text-base"><Bot aria-hidden="true" />来源信号</CardTitle><CardDescription>交易资源保留了信号来源标记</CardDescription></CardHeader>
            <CardContent class="grid gap-2"><p class="font-mono text-sm break-all">{{ resource.signalId }}</p><p class="text-xs leading-5 text-muted-foreground">该来源编号目前不能直接定位完整推理；系统不会根据相似编号猜测关联记录。</p></CardContent>
          </Card>

          <Card size="sm" class="border-primary/25 shadow-none">
            <CardHeader>
              <CardTitle class="flex items-center gap-2 text-base"><ShieldCheck aria-hidden="true" />交易操作</CardTitle>
              <CardDescription>操作会先交给父页面确认，再由服务端异步受理。</CardDescription>
            </CardHeader>
            <CardContent class="grid gap-3">
              <div v-if="isPosition(resource)" class="grid gap-2 sm:grid-cols-2">
                <Button variant="outline" size="lg" class="min-h-11" :disabled="readOnly" @click="requestModifyPosition"><Pencil data-icon="inline-start" />修改止盈止损</Button>
                <Button variant="destructive" size="lg" class="min-h-11" :disabled="readOnly" @click="requestClosePosition"><Ban data-icon="inline-start" />平仓</Button>
              </div>
              <div v-else class="grid gap-2 sm:grid-cols-2">
                <Button variant="outline" size="lg" class="min-h-11" :disabled="readOnly" @click="requestModifyOrder"><Pencil data-icon="inline-start" />修改挂单</Button>
                <Button variant="destructive" size="lg" class="min-h-11" :disabled="readOnly" @click="requestCancelOrder"><Ban data-icon="inline-start" />撤单</Button>
              </div>
              <p v-if="readOnly" class="text-xs leading-5 text-muted-foreground">当前为观摩或只读模式，写操作已禁用；如需操作，请切换到本人且有交易权限的账户。</p>
              <p v-else class="text-xs leading-5 text-muted-foreground">不会根据按钮点击直接推断成功；提交后请在操作中心等待最终状态和终端资源复核。</p>
            </CardContent>
          </Card>

          <Separator />
          <p class="text-xs leading-5 text-muted-foreground">当前资源来自服务端账户快照。页面不会根据超时、连接状态或 AI 决定自行推断交易是否完成。</p>
        </div>
      </ScrollArea>

      <SheetFooter class="border-t sm:flex-row sm:justify-end">
        <Button variant="outline" size="lg" @click="emit('update:open', false)">关闭</Button>
      </SheetFooter>
    </SheetContent>
  </Sheet>
</template>
