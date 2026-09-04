<script setup lang="ts">
import { AlertCircle, ArrowUpRight, CircleDot, FileClock, Link2 } from '@lucide/vue'
import { computed } from 'vue'
import { RouterLink } from 'vue-router'
import type { TradingAccount } from '@aurum/contracts'
import { Alert, AlertDescription, AlertTitle } from '@aurum/ui/alert'
import { Badge } from '@aurum/ui/badge'
import { Button } from '@aurum/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@aurum/ui/card'
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from '@aurum/ui/empty'
import { ScrollArea } from '@aurum/ui/scroll-area'
import { Separator } from '@aurum/ui/separator'
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@aurum/ui/sheet'
import { Skeleton } from '@aurum/ui/skeleton'
import {
  accountLabel, actorLabel, auditLinkTarget, categoryLabel, formatAuditTimestamp, sourceLabel, stageLabel, statusLabel, statusVariant,
  type AuditDetail,
} from '../model/audit-presentation'

const props = defineProps<{
  open: boolean
  detail: AuditDetail | null
  loading: boolean
  error: string
  accounts: TradingAccount[]
}>()

const emit = defineEmits<{ 'update:open': [value: boolean] }>()

const event = computed(() => props.detail?.event ?? null)
const accountName = computed(() => accountLabel(props.accounts.find((account) => account.id === event.value?.accountId)))
</script>

<template>
  <Sheet :open="open" @update:open="emit('update:open', Boolean($event))">
    <SheetContent class="w-full gap-0 p-0 sm:max-w-2xl">
      <SheetHeader class="border-b p-5 pr-16">
        <div class="flex items-center gap-2 text-xs text-primary"><FileClock aria-hidden="true" />系统审计 · 事件详情</div>
        <SheetTitle>{{ event?.title ?? (loading ? '正在读取审计详情' : '审计详情') }}</SheetTitle>
        <SheetDescription>{{ event ? `${sourceLabel(event.sourceKind)} · ${formatAuditTimestamp(event.occurredAt, event.terminalTimezoneOffsetMinutes)}` : '详情只展示可核实的摘要和证据。' }}</SheetDescription>
      </SheetHeader>

      <ScrollArea class="min-h-0 flex-1">
        <div class="grid gap-5 p-5">
          <div v-if="loading" class="grid gap-3">
            <Skeleton class="h-36 w-full" />
            <Skeleton class="h-64 w-full" />
          </div>

          <Alert v-else-if="error" variant="destructive" role="alert">
            <AlertCircle aria-hidden="true" />
            <AlertTitle>审计详情暂时不可用</AlertTitle>
            <AlertDescription>{{ error }}。可以关闭窗口后重新打开该事件。</AlertDescription>
          </Alert>

          <template v-else-if="detail && event">
            <Card class="shadow-none">
              <CardHeader class="gap-3">
                <div class="flex flex-wrap items-center gap-2">
                  <Badge :variant="statusVariant(event.status)">{{ statusLabel(event.status) }}</Badge>
                  <Badge variant="secondary">{{ categoryLabel(event.category) }}</Badge>
                  <Badge variant="outline">{{ actorLabel(event.actor) }}</Badge>
                </div>
                <div>
                  <CardTitle class="text-xl">{{ event.title }}</CardTitle>
                  <CardDescription class="mt-2 leading-6">{{ event.summary }}</CardDescription>
                </div>
              </CardHeader>
              <CardContent class="grid gap-3 border-t pt-4 sm:grid-cols-2">
                <div><p class="text-xs text-muted-foreground">事件动作</p><p class="mt-1 text-sm font-medium">{{ event.action }}</p></div>
                <div><p class="text-xs text-muted-foreground">关联账户</p><p class="mt-1 truncate text-sm font-medium">{{ event.accountId ? accountName : '全部账户' }}</p></div>
                <div><p class="text-xs text-muted-foreground">事件来源</p><p class="mt-1 text-sm font-medium">{{ sourceLabel(event.sourceKind) }}</p></div>
                <div><p class="text-xs text-muted-foreground">发生时间</p><p class="mt-1 font-mono text-xs tabular-nums">{{ formatAuditTimestamp(event.occurredAt, event.terminalTimezoneOffsetMinutes) }}</p></div>
                <div><p class="text-xs text-muted-foreground">来源 ID</p><p class="mt-1 break-all font-mono text-xs">{{ event.sourceId }}</p></div>
                <div><p class="text-xs text-muted-foreground">原因代码</p><p class="mt-1 break-all font-mono text-xs">{{ event.reasonCode ?? '--' }}</p></div>
                <div class="sm:col-span-2"><p class="text-xs text-muted-foreground">关联请求</p><p class="mt-1 break-all font-mono text-xs">{{ event.correlationId ?? '--' }}</p></div>
              </CardContent>
            </Card>

            <section aria-labelledby="audit-trace-title" class="grid gap-3">
              <div class="flex items-start gap-2"><Link2 class="mt-0.5 text-primary" aria-hidden="true" /><div><h2 id="audit-trace-title" class="text-base font-semibold">执行链路</h2><p class="mt-1 text-xs text-muted-foreground">从分析、交易判断到终端事实的顺序证据。</p></div></div>
              <Card class="shadow-none">
                <CardContent class="p-4">
                  <Empty v-if="!detail.trace.length" class="min-h-32 border-0 p-3">
                    <EmptyHeader><EmptyMedia variant="icon"><CircleDot /></EmptyMedia><EmptyTitle>暂无完整链路</EmptyTitle><EmptyDescription>当前事件没有返回可核实的上下游节点。</EmptyDescription></EmptyHeader>
                  </Empty>
                  <ol v-else class="grid gap-0">
                    <li v-for="(node, index) in detail.trace" :key="`${node.stage}:${node.sourceId}:${index}`" class="relative grid grid-cols-[1.25rem_minmax(0,1fr)] gap-3 pb-5 last:pb-0">
                      <div class="relative flex justify-center"><span class="z-10 mt-1 flex size-5 items-center justify-center rounded-full border bg-card text-primary"><CircleDot aria-hidden="true" /></span><Separator v-if="index < detail.trace.length - 1" orientation="vertical" class="absolute top-6 h-full" /></div>
                      <div class="min-w-0"><div class="flex flex-wrap items-center gap-2"><h3 class="text-sm font-semibold">{{ stageLabel(node.stage) }}</h3><Badge :variant="statusVariant(node.status)">{{ statusLabel(node.status) }}</Badge></div><p class="mt-1 text-sm leading-6">{{ node.title }}</p><p v-if="node.detail" class="mt-1 text-xs leading-5 text-muted-foreground">{{ node.detail }}</p><div class="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-muted-foreground"><span class="font-mono">{{ node.sourceKind }} · {{ node.sourceId }}</span><span class="font-mono tabular-nums">{{ formatAuditTimestamp(node.occurredAt, event.terminalTimezoneOffsetMinutes) }}</span><span v-if="node.reasonCode" class="font-mono">{{ node.reasonCode }}</span></div></div>
                    </li>
                  </ol>
                </CardContent>
              </Card>
            </section>

            <section aria-labelledby="audit-evidence-title" class="grid gap-3">
              <div><h2 id="audit-evidence-title" class="text-base font-semibold">关键证据</h2><p class="mt-1 text-xs text-muted-foreground">只列出服务端确认的字段，不展示完整原始日志或内部堆栈。</p></div>
              <Card class="shadow-none">
                <CardContent class="p-0">
                  <Empty v-if="!detail.evidence.length" class="min-h-32 border-0 p-3"><EmptyHeader><EmptyMedia variant="icon"><FileClock /></EmptyMedia><EmptyTitle>暂无额外证据</EmptyTitle><EmptyDescription>事件摘要仍以服务端记录为准。</EmptyDescription></EmptyHeader></Empty>
                  <dl v-else class="grid divide-y">
                    <div v-for="item in detail.evidence" :key="item.label" class="grid gap-1 p-4 sm:grid-cols-[10rem_minmax(0,1fr)] sm:gap-4"><dt class="text-xs text-muted-foreground">{{ item.label }}</dt><dd class="break-words text-sm leading-6">{{ item.value }}</dd></div>
                  </dl>
                </CardContent>
              </Card>
            </section>

            <section v-if="detail.links.length" aria-labelledby="audit-links-title" class="grid gap-3">
              <div><h2 id="audit-links-title" class="text-base font-semibold">相关记录</h2><p class="mt-1 text-xs text-muted-foreground">跳转到对应模块查看业务详情。</p></div>
              <div class="grid gap-2 sm:grid-cols-2">
                <Button v-for="link in detail.links" :key="`${link.kind}:${link.id}`" as-child variant="outline" class="min-h-11 justify-between"><RouterLink :to="auditLinkTarget(link)"><span class="truncate">{{ link.label }}</span><ArrowUpRight data-icon="inline-end" aria-hidden="true" /></RouterLink></Button>
              </div>
            </section>
          </template>
        </div>
      </ScrollArea>
    </SheetContent>
  </Sheet>
</template>
