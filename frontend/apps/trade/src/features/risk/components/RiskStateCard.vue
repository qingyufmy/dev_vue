<script setup lang="ts">
import { AlertTriangle, CheckCircle2, LockKeyhole, ShieldAlert } from '@lucide/vue'
import type { ManualReleaseState, RiskPolicy, RiskSummary } from '@aurum/contracts'
import { computed, ref, onMounted, onUnmounted } from 'vue'
import { Badge } from '@aurum/ui/badge'
import { Button } from '@aurum/ui/button'
import { Card, CardContent } from '@aurum/ui/card'
import { Separator } from '@aurum/ui/separator'
import { availabilityLabel, formatDateTime, releaseRuleLabel, riskState, riskDataReason } from '../model/risk-presentation'

const props = defineProps<{
  policy: RiskPolicy | null
  summary: RiskSummary | null
  manualRelease: ManualReleaseState | null
  readOnly: boolean
  releasing: boolean
}>()
const emit = defineEmits<{ release: [] }>()
const now = ref(Date.now())
let clock: ReturnType<typeof setInterval> | undefined
onMounted(() => { clock = setInterval(() => { now.value = Date.now() }, 1000) })
onUnmounted(() => { if (clock) clearInterval(clock) })
const state = computed(() => riskState(props.policy, props.summary, now.value))
const dataReasons = computed(() => [...new Set(props.summary?.incompleteReasons.map(riskDataReason) ?? [])])
const icon = computed(() => state.value.level === 'healthy' ? CheckCircle2 : state.value.level === 'warning' ? AlertTriangle : state.value.level === 'blocked' ? ShieldAlert : LockKeyhole)
const iconClass = computed(() => state.value.level === 'healthy' ? 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400' : state.value.level === 'warning' ? 'bg-amber-500/10 text-amber-600 dark:text-amber-400' : state.value.level === 'blocked' ? 'bg-destructive/10 text-destructive' : 'bg-muted text-muted-foreground')
const availability = computed(() => props.manualRelease?.availability ?? null)
const existing = computed(() => props.manualRelease?.release ?? null)
const activeRelease = computed(() => existing.value?.status === 'active' && Date.parse(existing.value.expiresAt) > now.value && availability.value?.code === 'risk_manual_release_already_active')
</script>

<template>
  <Card class="overflow-hidden shadow-none">
    <CardContent class="grid gap-0 p-0 lg:grid-cols-[minmax(0,1.35fr)_minmax(19rem,.65fr)]">
      <section class="flex min-w-0 flex-col gap-5 p-5 sm:p-6" aria-label="当前风险状态">
        <div class="flex items-start gap-4">
          <span class="flex size-12 shrink-0 items-center justify-center rounded-2xl" :class="iconClass"><component :is="icon" class="size-6" aria-hidden="true" /></span>
          <div class="min-w-0 flex-1">
            <p class="text-xs font-medium text-muted-foreground">账户风险概况</p>
            <h2 class="mt-1 text-xl font-semibold tracking-tight">{{ state.title }}</h2>
            <p class="mt-1 max-w-2xl text-sm leading-6 text-muted-foreground">{{ state.detail }}</p>
          </div>
          <Badge :variant="state.level === 'blocked' ? 'destructive' : state.level === 'healthy' ? 'default' : 'secondary'">{{ state.level === 'blocked' ? '已限制' : state.level === 'healthy' ? '正常' : state.level === 'warning' ? '需关注' : '待同步' }}</Badge>
        </div>

        <div v-if="state.reasons.length" class="flex flex-wrap gap-2" aria-label="限制原因">
          <Badge v-for="reason in state.reasons" :key="reason" variant="outline">{{ reason }}</Badge>
        </div>

        <p v-if="dataReasons.length" class="text-sm leading-6 text-muted-foreground">{{ dataReasons.join('；') }}</p>
        <div class="grid gap-3 text-sm sm:grid-cols-3">
          <div class="rounded-xl border bg-muted/25 p-3"><p class="text-xs text-muted-foreground">数据完整性</p><strong class="mt-1 block">{{ !summary ? '待准备' : summary.dataComplete ? '完整' : '待补齐' }}</strong></div>
          <div class="rounded-xl border bg-muted/25 p-3"><p class="text-xs text-muted-foreground">终端时钟</p><strong class="mt-1 block">{{ !summary ? '待确认' : summary.clockStatus === 'calibrated' ? '已确认' : '待确认' }}</strong></div>
          <div class="rounded-xl border bg-muted/25 p-3"><p class="text-xs text-muted-foreground">快照时间</p><strong class="mt-1 block font-mono text-xs tabular-nums">{{ formatDateTime(summary?.observedAt, summary?.terminalTimezoneOffsetMinutes) }}</strong></div>
        </div>
      </section>

      <aside class="border-t bg-muted/20 p-5 sm:p-6 lg:border-l lg:border-t-0" aria-label="手动解除状态">
        <div class="flex items-center justify-between gap-3">
          <div><p class="text-xs font-medium text-muted-foreground">手动解除限制</p><h3 class="mt-1 font-semibold">{{ activeRelease ? '解除已生效' : availability?.available ? '可以申请解除' : '当前不可解除' }}</h3></div>
          <LockKeyhole class="size-5 text-muted-foreground" aria-hidden="true" />
        </div>
        <Separator class="my-4" />
        <template v-if="activeRelease && existing">
          <p class="text-sm leading-6 text-muted-foreground">仅放开本次确认时已触发的可恢复规则；风险继续恶化、策略变化或交易日切换后会自动失效。</p>
          <div class="mt-3 flex flex-wrap gap-2"><Badge v-for="rule in existing.releasedRules" :key="rule" variant="secondary">{{ releaseRuleLabel(rule) }}</Badge></div>
          <p class="mt-4 text-xs text-muted-foreground">有效至 {{ formatDateTime(existing.expiresAt, summary?.terminalTimezoneOffsetMinutes) }}</p>
        </template>
        <template v-else>
          <p class="text-sm leading-6 text-muted-foreground">{{ availability?.available ? '解除后仍会保留平台硬限制，并在风险进一步恶化时自动失效。' : availabilityLabel(availability?.code) }}</p>
          <div v-if="availability?.available" class="mt-3 flex flex-wrap gap-2"><Badge v-for="rule in availability.rules" :key="rule" variant="outline">{{ releaseRuleLabel(rule) }}</Badge></div>
          <Button class="mt-5 w-full" size="lg" :disabled="readOnly || releasing || !availability?.available" @click="emit('release')">{{ releasing ? '正在提交…' : '确认并解除限制' }}</Button>
        </template>
      </aside>
    </CardContent>
  </Card>
</template>
