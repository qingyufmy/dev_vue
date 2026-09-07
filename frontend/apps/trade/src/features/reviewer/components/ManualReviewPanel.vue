<script setup lang="ts">
import { Check, CircleAlert, ClipboardPenLine, FileText, RefreshCw } from '@lucide/vue'
import { Alert, AlertDescription, AlertTitle } from '@aurum/ui/alert'
import { Button } from '@aurum/ui/button'
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from '@aurum/ui/card'
import { Checkbox } from '@aurum/ui/checkbox'
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from '@aurum/ui/empty'
import { Field, FieldDescription, FieldGroup, FieldLabel } from '@aurum/ui/field'
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from '@aurum/ui/select'
import { Skeleton } from '@aurum/ui/skeleton'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@aurum/ui/table'
import { Textarea } from '@aurum/ui/textarea'
import { computed, ref } from 'vue'
import { formatReviewTime, formatTerminalTimezoneOffset, metricTone, type ManualReviewCandidate } from '../model/reviewer-presentation'

const props = defineProps<{
  candidates: ManualReviewCandidate[]
  loading: boolean
  error?: string
  action?: string
  refreshing?: boolean
  strategies: Array<{ id: string; name: string }>
}>()

const emit = defineEmits<{ refresh: []; create: [ids: string[], strategyId: string, tradingIdea: string] }>()
const selectedIds = ref<string[]>([])
const tradingIdea = ref('')
const strategyId = ref('')
const selectedCount = computed(() => selectedIds.value.length)
const canCreate = computed(() => selectedCount.value > 0 && selectedCount.value <= 10 && Boolean(strategyId.value) && !props.action)

function isSelected(id: string) { return selectedIds.value.includes(id) }

function toggle(id: string, checked: boolean | 'indeterminate') {
  if (checked === 'indeterminate') return
  if (checked) {
    if (selectedIds.value.length >= 10) return
    selectedIds.value = [...selectedIds.value, id]
  } else selectedIds.value = selectedIds.value.filter((item) => item !== id)
}

function create() {
  if (!canCreate.value) return
  emit('create', [...selectedIds.value], strategyId.value, tradingIdea.value.trim())
}

function toneClass(value: string) {
  return metricTone(value) === 'positive' ? 'text-trade-up' : metricTone(value) === 'negative' ? 'text-trade-down' : 'text-foreground'
}
</script>

<template>
  <Card class="min-w-0 shadow-none">
    <CardHeader class="border-b">
      <div class="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div class="min-w-0">
          <CardTitle class="flex items-center gap-2 text-base"><ClipboardPenLine aria-hidden="true" />选择人工交易</CardTitle>
          <CardDescription>只列出当前系统账号能明确判定为人工来源、且已完整平仓的交易；盈利、亏损和持平都可复盘。</CardDescription>
        </div>
        <Button variant="outline" class="min-h-11 shrink-0" :disabled="loading || refreshing" @click="emit('refresh')"><RefreshCw data-icon="inline-start" :class="refreshing ? 'animate-spin motion-reduce:animate-none' : ''" />刷新候选</Button>
      </div>
    </CardHeader>
    <CardContent class="grid gap-4 p-4 sm:p-5">
      <Alert v-if="error" variant="destructive"><CircleAlert aria-hidden="true" /><AlertTitle>人工交易读取失败</AlertTitle><AlertDescription>{{ error }}</AlertDescription></Alert>
      <div v-if="loading" class="grid gap-2"><Skeleton v-for="index in 5" :key="index" class="h-16 w-full" /></div>
      <Empty v-else-if="!candidates.length" class="min-h-56 border-0"><EmptyHeader><EmptyMedia variant="icon"><FileText /></EmptyMedia><EmptyTitle>暂时没有可复盘交易</EmptyTitle><EmptyDescription>系统不会把自动信号、分发单、其它 EA 或来源不明的交易伪装成人工交易。</EmptyDescription></EmptyHeader></Empty>
      <div v-else class="grid gap-3">
        <div class="flex flex-wrap items-center justify-between gap-2 rounded-lg border bg-muted/20 px-3 py-2 text-sm"><span class="text-muted-foreground">已选择 <strong class="font-mono text-foreground">{{ selectedCount }}</strong> / 10 笔</span><span class="text-xs text-muted-foreground">建议按同类行情分批复盘，避免不同逻辑相互污染。</span></div>

        <div class="hidden overflow-x-auto lg:block">
          <Table>
          <TableHeader><TableRow><TableHead class="w-12"><span class="sr-only">选择</span></TableHead><TableHead>品种 / 方向</TableHead><TableHead>进出场时间</TableHead><TableHead>手数</TableHead><TableHead class="text-right">净盈亏</TableHead><TableHead>来源</TableHead></TableRow></TableHeader>
            <TableBody>
              <TableRow v-for="item in candidates" :key="item.id">
                <TableCell><Checkbox :model-value="isSelected(item.id)" :disabled="!isSelected(item.id) && selectedCount >= 10 || !item.canReview" :aria-label="`选择 ${item.symbol} ${item.positionId ?? item.ticket}`" @update:model-value="toggle(item.id, $event)" /></TableCell>
                <TableCell><div class="grid gap-1"><span class="font-medium">{{ item.symbol }}</span><span class="text-xs text-muted-foreground">{{ item.direction }} · #{{ item.positionId ?? item.ticket }}</span><span class="truncate text-xs text-muted-foreground">{{ item.accountLabel }}<template v-if="item.terminalTimezoneOffsetMinutes !== null"> · 终端 {{ formatTerminalTimezoneOffset(item.terminalTimezoneOffsetMinutes) }}</template></span></div></TableCell>
                <TableCell><div class="grid gap-1 text-xs tabular-nums"><span>{{ formatReviewTime(item.entryAt, item.terminalTimezoneOffsetMinutes) }}</span><span class="text-muted-foreground">→ {{ formatReviewTime(item.exitAt, item.terminalTimezoneOffsetMinutes) }}</span></div></TableCell>
                <TableCell class="font-mono tabular-nums">{{ item.volume }}</TableCell>
                <TableCell class="text-right font-mono tabular-nums" :class="toneClass(item.netProfit)">{{ item.netProfit }}</TableCell>
                <TableCell><span class="text-xs text-muted-foreground">{{ item.sourceStatus }}</span></TableCell>
              </TableRow>
            </TableBody>
          </Table>
        </div>

        <div class="grid gap-2 lg:hidden">
          <Card v-for="item in candidates" :key="item.id" size="sm" class="shadow-none" :class="isSelected(item.id) ? 'border-primary/60 bg-primary/5' : ''">
              <CardContent class="grid gap-3 p-4">
                <div class="flex items-start gap-3"><Checkbox class="mt-0.5" :model-value="isSelected(item.id)" :disabled="!isSelected(item.id) && selectedCount >= 10 || !item.canReview" :aria-label="`选择 ${item.symbol} ${item.positionId ?? item.ticket}`" @update:model-value="toggle(item.id, $event)" /><div class="min-w-0 flex-1"><div class="flex items-center justify-between gap-2"><span class="font-medium">{{ item.symbol }} · {{ item.direction }}</span><span class="font-mono font-medium tabular-nums" :class="toneClass(item.netProfit)">{{ item.netProfit }}</span></div><p class="mt-1 truncate text-xs text-muted-foreground">{{ item.accountLabel }}<template v-if="item.terminalTimezoneOffsetMinutes !== null"> · 终端 {{ formatTerminalTimezoneOffset(item.terminalTimezoneOffsetMinutes) }}</template> · #{{ item.positionId ?? item.ticket }} · {{ item.sourceStatus }}</p></div></div>
              <dl class="grid grid-cols-2 gap-3 border-t pt-3 text-xs"><div><dt class="text-muted-foreground">进出场</dt><dd class="mt-1 tabular-nums">{{ formatReviewTime(item.entryAt, item.terminalTimezoneOffsetMinutes) }} → {{ formatReviewTime(item.exitAt, item.terminalTimezoneOffsetMinutes) }}</dd></div><div><dt class="text-muted-foreground">手数</dt><dd class="mt-1 font-mono tabular-nums">{{ item.volume }}</dd></div><div><dt class="text-muted-foreground">净盈亏</dt><dd class="mt-1 font-mono tabular-nums" :class="toneClass(item.netProfit)">{{ item.netProfit }}</dd></div><div><dt class="text-muted-foreground">来源</dt><dd class="mt-1 truncate">{{ item.sourceStatus }}</dd></div></dl>
            </CardContent>
          </Card>
        </div>
      </div>

      <FieldGroup v-if="candidates.length">
        <Field>
          <FieldLabel>复盘策略</FieldLabel>
          <Select v-model="strategyId">
            <SelectTrigger class="w-full"><SelectValue placeholder="选择用于复盘的策略" /></SelectTrigger>
            <SelectContent><SelectGroup><SelectItem v-for="strategy in strategies" :key="strategy.id" :value="strategy.id">{{ strategy.name }}</SelectItem></SelectGroup></SelectContent>
          </Select>
          <FieldDescription>复盘时会冻结该策略当前版本，不会跟随之后的策略修改。</FieldDescription>
        </Field>
        <Field>
          <FieldLabel for="manual-trading-idea">当时的下单思路（可选）</FieldLabel>
          <Textarea id="manual-trading-idea" v-model="tradingIdea" maxlength="2000" rows="4" placeholder="可填写当时观察到的行情结构、入场原因、止损依据和退出原因。此内容仅作为不可信参考，不覆盖终端事实。" />
          <FieldDescription>最多 2,000 字。没有把握时可以留空，系统不会根据盈亏反推你的真实意图。</FieldDescription>
        </Field>
      </FieldGroup>
    </CardContent>
    <CardFooter v-if="candidates.length" class="flex flex-col items-stretch gap-3 border-t sm:flex-row sm:items-center sm:justify-between">
      <div class="flex items-center gap-2 text-xs text-muted-foreground"><Check class="text-system-ok" aria-hidden="true" />创建前服务端会强制刷新并再次校验交易证据。</div>
      <Button class="min-h-11 sm:min-w-40" :disabled="!canCreate" @click="create">{{ action === 'create-manual' ? '正在创建…' : '创建手动复盘' }}</Button>
    </CardFooter>
  </Card>
</template>
