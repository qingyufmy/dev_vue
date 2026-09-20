<script setup lang="ts">
import { CheckCircle2, ShieldX } from '@lucide/vue'
import type { RiskDecisionDetail } from '@aurum/contracts'
import { Badge } from '@aurum/ui/badge'
import { Card, CardContent, CardHeader, CardTitle } from '@aurum/ui/card'
import { ScrollArea } from '@aurum/ui/scroll-area'
import { Separator } from '@aurum/ui/separator'
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@aurum/ui/sheet'
import { Skeleton } from '@aurum/ui/skeleton'
import { formatDateTime, rejectCodeLabel, riskActionLabel, riskDetailFields } from '../model/risk-presentation'

withDefaults(defineProps<{ open: boolean; detail: RiskDecisionDetail | null; loading?: boolean; error?: string; timezoneOffsetMinutes?: number | null }>(), { loading: false, error: '', timezoneOffsetMinutes: null })
const emit = defineEmits<{ 'update:open': [value: boolean] }>()

function outcomeLabel(outcome: string) {
  return outcome === 'passed' ? '通过' : outcome === 'rejected' ? '拒绝' : '不适用'
}

function outcomeVariant(outcome: string) {
  return outcome === 'passed' ? 'default' : outcome === 'rejected' ? 'destructive' : 'secondary'
}
</script>

<template>
  <Sheet :open="open" @update:open="emit('update:open', $event)">
    <SheetContent side="right" class="w-full gap-0 overflow-hidden p-0 sm:max-w-xl">
      <SheetHeader class="border-b pr-16 text-left">
        <SheetTitle>风控评审详情</SheetTitle>
        <SheetDescription>逐项查看服务端风控规则的输入、结论和获批动作。</SheetDescription>
      </SheetHeader>
      <ScrollArea class="min-h-0 flex-1">
        <div v-if="loading" class="grid gap-3 p-5"><Skeleton class="h-32 w-full" /><Skeleton v-for="index in 5" :key="index" class="h-20 w-full" /></div>
        <div v-else-if="error" class="p-5 text-sm text-destructive">{{ error }}</div>
        <div v-else-if="detail" class="grid gap-5 p-5 sm:p-6">
          <Card class="shadow-none">
            <CardHeader class="flex-row items-start justify-between space-y-0"><div><p class="text-xs text-muted-foreground">最终结论</p><CardTitle class="mt-1">{{ rejectCodeLabel(detail.summary.rejectCode) }}</CardTitle></div><Badge :variant="detail.summary.status === 'approved' ? 'default' : 'destructive'"><CheckCircle2 v-if="detail.summary.status === 'approved'" /><ShieldX v-else />{{ detail.summary.status === 'approved' ? '通过' : '拒绝' }}</Badge></CardHeader>
            <CardContent class="grid gap-2 text-xs text-muted-foreground"><p>评审时间 {{ formatDateTime(detail.evaluatedAt, timezoneOffsetMinutes) }}</p></CardContent>
          </Card>

          <section aria-labelledby="rules-title"><h3 id="rules-title" class="font-semibold">规则明细</h3><p class="mt-1 text-xs text-muted-foreground">规则按服务端确定性顺序评估</p>
            <div class="mt-3 grid gap-2">
              <div v-for="rule in detail.rules" :key="`${rule.code}-${rule.actionId ?? ''}`" class="rounded-xl border p-4">
                <div class="flex items-start justify-between gap-3"><div class="min-w-0"><strong class="block break-words text-sm">{{ rejectCodeLabel(rule.code) }}</strong></div><Badge :variant="outcomeVariant(rule.outcome)">{{ outcomeLabel(rule.outcome) }}</Badge></div>
                <dl v-if="rule.details" class="mt-3 grid gap-2 text-sm"><div v-for="field in riskDetailFields(rule.details)" :key="field.label" class="flex justify-between gap-4"><dt class="text-muted-foreground">{{ field.label }}</dt><dd>{{ field.value }}</dd></div></dl>
              </div>
            </div>
          </section>

          <Separator />
          <section aria-labelledby="approved-actions-title"><h3 id="approved-actions-title" class="font-semibold">获批动作</h3><p class="mt-1 text-xs text-muted-foreground">通过风控并允许进入后续执行链的动作</p>
            <p v-if="!detail.approvedActions.length" class="mt-3 rounded-xl border border-dashed p-4 text-sm text-muted-foreground">本次没有获批动作。</p>
            <div v-else class="mt-3 grid gap-2"><div v-for="action in detail.approvedActions" :key="action.actionId" class="rounded-xl border p-4"><div class="flex items-center justify-between gap-3"><strong class="text-sm">{{ riskActionLabel(action.kind) }}</strong></div><dl class="mt-3 grid gap-2 text-sm"><div v-for="field in riskDetailFields(action.parameters)" :key="field.label" class="flex justify-between gap-4"><dt class="text-muted-foreground">{{ field.label }}</dt><dd>{{ field.value }}</dd></div></dl></div></div>
          </section>
        </div>
        <p v-else class="p-5 text-sm text-muted-foreground">选择一条风控记录查看详情。</p>
      </ScrollArea>
    </SheetContent>
  </Sheet>
</template>
