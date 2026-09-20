<script setup lang="ts">
import { computed, ref, watch, onBeforeUnmount } from 'vue'
import type { AuditEvent, AuditEventDetail, AuditStatus } from '@aurum/contracts'
import { Badge } from '@aurum/ui/badge'
import { ChevronRight, Clock3 } from '@lucide/vue'
import { Button } from '@aurum/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@aurum/ui/card'
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetDescription } from '@aurum/ui/sheet'
import { auditApi } from '../api/audit-api'
import { formatLaboratoryTime } from '~/lib/laboratory-display-time'
import { executionActionGroups } from '../model/execution-action-groups'
import { executionExplanation } from '../model/execution-explanation'
const props = defineProps<{ accountId: string | null; readOnly?: boolean; decisionId?: string; refreshVersion?: number }>()
const emit = defineEmits<{ 'detail-close': [] }>()
const items = ref<AuditEvent[]>([]), cursor = ref<string | null>(null), loading = ref(false), error = ref('')
const actionGroups = computed(() => executionActionGroups(detail.value?.trace ?? []))
const open = ref(false), detail = ref<AuditEventDetail | null>(null), detailLoading = ref(false), detailError = ref('')
const filter = ref('all')
const filters = [{ value: 'all', label: '全部' }, { value: 'pending', label: '处理中' }, { value: 'attention', label: '需关注' }, { value: 'finished', label: '已结束' }]
const selected = ref<Pick<AuditEvent, 'sourceKind' | 'sourceId'> | null>(null)
const visibleItems = computed(() => items.value.filter(item => filter.value === 'all' ||
  (filter.value === 'pending' ? ['queued', 'running'].includes(item.status) : filter.value === 'attention' ? ['uncertain', 'failed', 'rejected', 'partially_succeeded'].includes(item.status) : ['succeeded', 'cancelled'].includes(item.status))))
const statusVariant = (status: AuditStatus) => ['failed', 'rejected'].includes(status) ? 'destructive' as const : status === 'succeeded' ? 'default' as const : ['uncertain', 'partially_succeeded'].includes(status) ? 'secondary' as const : 'outline' as const
let generation = 0, detailVersion = 0
const statuses: Record<AuditStatus, string> = { queued: '等待处理', running: '处理中', succeeded: '已完成', partially_succeeded: '部分完成', rejected: '未获通过', failed: '处理失败', uncertain: '结果待核实', cancelled: '已取消', info: '已记录' }
const stages: Record<string, string> = { analysis: '行情分析', trader: '交易判断', risk: '风险检查', operation: '指令处理', intent: '交易准备', bridge: '桥接处理', terminal: '终端结果' }
function stepExplanation(node: AuditEventDetail['trace'][number]) {
  if (node.stage === 'terminal' && node.status === 'succeeded') return '终端已确认本项操作完成。'
  if (node.stage === 'trader') return node.status === 'queued' ? '交易建议已生成，等待风控审核。' : node.status === 'cancelled' ? '本次建议已失效。' : '交易建议已生成；实际执行情况请查看后续步骤。'
  if (node.stage === 'risk') return node.status === 'succeeded' ? '本次建议通过风控审核。' : executionExplanation(node.reasonCode, node.status)
  return executionExplanation(node.reasonCode, node.status)
}
async function load(more = false) {
  if (!props.accountId || props.readOnly || loading.value) return
  const account = props.accountId, version = generation
  loading.value = true; error.value = ''
  try {
    const response = await auditApi.list({ accountId: account, category: 'execution', pageSize: 20, cursor: more ? cursor.value : null })
    if (generation !== version) return
    const rows = response.data.items.filter(item => item.accountId === account)
    items.value = more ? [...items.value, ...rows.filter(row => !items.value.some(old => old.sourceKind === row.sourceKind && old.sourceId === row.sourceId))] : rows
    cursor.value = response.data.hasMore ? response.data.nextCursor : null
  } catch { if (generation === version) error.value = '执行记录暂时无法读取，请重试。' }
  finally { if (generation === version) loading.value = false }
}
async function inspect(item: Pick<AuditEvent, 'sourceKind' | 'sourceId'>, background = false) {
  const version = ++detailVersion, account = props.accountId
  selected.value = item
  if (!background) { open.value = true; detail.value = null }
  detailError.value = ''; detailLoading.value = true
  try {
    const response = await auditApi.detail(item.sourceKind, item.sourceId)
    if (version !== detailVersion || account !== props.accountId) return
    if (response.data.event.accountId !== account) throw new Error('account_mismatch')
    detail.value = response.data
  } catch { if (version === detailVersion) detailError.value = '这条执行记录暂时无法读取，请重试。' }
  finally { if (version === detailVersion) detailLoading.value = false }
}
let refreshTimer: ReturnType<typeof setTimeout> | undefined
function scheduleRefresh() {
  if (refreshTimer !== undefined || !props.accountId || props.readOnly) return
  refreshTimer = setTimeout(async () => {
    refreshTimer = undefined
    if (loading.value || detailLoading.value) { scheduleRefresh(); return }
    await Promise.all([load(), open.value && selected.value ? inspect(selected.value, true) : Promise.resolve()])
  }, 350)
}
function cancelRefresh() { clearTimeout(refreshTimer); refreshTimer = undefined }
watch(() => props.refreshVersion, scheduleRefresh)
watch(open, value => { if (!value) { detailVersion++; detailLoading.value = false; emit('detail-close') } })
watch(() => [props.accountId, props.readOnly], () => { cancelRefresh(); generation++; detailVersion++; filter.value = 'all'; selected.value = null; items.value = []; cursor.value = null; loading.value = false; error.value = ''; open.value = false; detail.value = null; void load() }, { immediate: true })
watch(() => [props.decisionId, props.accountId, props.readOnly], () => {
  if (props.decisionId && props.accountId && !props.readOnly) void inspect({ sourceKind: 'trade_decision', sourceId: props.decisionId })
}, { immediate: true })
onBeforeUnmount(() => { cancelRefresh(); generation++; detailVersion++ })
</script>
<template>
  <Card class="min-w-0 shadow-none">
    <CardHeader class="flex flex-row items-center justify-between border-b"><div><CardTitle>历史执行记录</CardTitle><p class="mt-1 text-xs text-muted-foreground">当前账户最近 7 天的指令处理记录。</p></div><Button variant="outline" :disabled="loading || !accountId || readOnly" @click="load()">刷新记录</Button></CardHeader>
    <CardContent class="p-4">
      <div v-if="!readOnly && items.length" class="mb-4 flex flex-wrap items-center justify-between gap-3">
        <div role="group" aria-label="筛选执行状态" class="flex flex-wrap gap-1 rounded-lg bg-muted/40 p-1"><Button v-for="option in filters" :key="option.value" size="sm" :variant="filter === option.value ? 'secondary' : 'ghost'" :aria-pressed="filter === option.value" @click="filter = option.value">{{ option.label }}</Button></div>
        <span class="text-xs text-muted-foreground">已加载 {{ items.length }} 条 · 显示 {{ visibleItems.length }} 条</span>
      </div>
      <p v-if="readOnly" class="py-8 text-center text-sm text-muted-foreground">观摩模式不显示账户执行记录。</p>
      <p v-else-if="error" role="alert" class="py-4 text-sm text-destructive">{{ error }}</p>
      <p v-else-if="!items.length" class="py-12 text-center text-sm text-muted-foreground">{{ loading ? '正在加载执行记录…' : '当前账户最近 7 天暂无执行记录' }}</p>
      <p v-if="!readOnly && items.length && !visibleItems.length" class="py-8 text-center text-sm text-muted-foreground">已加载记录中暂无此类状态，可加载更早记录继续查看。</p>
      <ul v-if="!readOnly" class="divide-y">
        <li v-for="item in visibleItems" :key="`${item.sourceKind}:${item.sourceId}`"><button class="flex min-h-16 w-full cursor-pointer flex-wrap items-center justify-between gap-3 rounded-lg px-2 py-3 text-left hover:bg-muted/50 focus-visible:outline-2 focus-visible:outline-ring" @click="inspect(item)"><span><strong class="text-sm">{{ item.title || (item.sourceKind === 'bridge_command' ? '桥接指令' : '交易操作') }}{{ item.symbol ? ` · ${item.symbol}` : '' }}</strong><span v-if="item.summary && item.title !== '交易操作'" class="mt-1 block max-w-lg break-words text-xs text-foreground/80">{{ item.summary }}</span><span class="mt-1 block text-xs text-muted-foreground">{{ executionExplanation(item.reasonCode, item.status) }}</span></span><span class="text-right"><Badge :variant="statusVariant(item.status)">{{ statuses[item.status] }}</Badge><time class="mt-1 block text-xs text-muted-foreground">{{ formatLaboratoryTime(item.occurredAt) }}</time></span><ChevronRight class="size-4 shrink-0 text-muted-foreground" aria-hidden="true" /></button></li>
      </ul>
      <Button v-if="cursor" variant="outline" class="mt-4 w-full" :disabled="loading" @click="load(true)">{{ loading ? '正在加载…' : '加载更早记录' }}</Button>
    </CardContent>
  </Card>
  <Sheet v-model:open="open"><SheetContent class="overflow-y-auto p-5 sm:max-w-xl"><SheetHeader><SheetTitle>{{ selected?.sourceKind === 'trade_decision' ? '本次决策处理过程' : '执行过程' }}</SheetTitle><SheetDescription>按实际返回的记录展示处理步骤；缺少终端回执时不视为成交。</SheetDescription></SheetHeader><Button v-if="selected" variant="outline" class="my-4" :disabled="detailLoading" @click="inspect(selected)">刷新处理结果</Button><p v-if="detailLoading && !detail" class="py-8 text-sm">正在加载…</p><div v-if="detailError" role="alert" class="grid gap-3 rounded-xl border border-destructive/30 p-4 text-sm text-destructive"><p>{{ detailError }}</p><Button v-if="selected" variant="outline" @click="inspect(selected)">重新读取</Button></div><template v-if="detail"><div class="rounded-xl bg-muted/40 p-4"><Badge :variant="statusVariant(detail.event.status)">{{ statuses[detail.event.status] }}</Badge><p class="mt-2 text-sm leading-6">{{ detail.event.sourceKind === 'trade_decision' ? detail.event.summary : executionExplanation(detail.event.reasonCode, detail.event.status) }}</p></div><section v-if="actionGroups.length" class="mt-5 grid gap-3" aria-label="逐项执行结果"><h3 class="text-sm font-semibold">逐项执行结果 · {{ actionGroups.length }} 项</h3><article v-for="(group,index) in actionGroups" :key="group.id" class="rounded-lg border p-3"><div class="flex flex-wrap items-center justify-between gap-2"><strong class="text-sm">{{ index + 1 }}. {{ group.title }}</strong><Badge :variant="statusVariant(group.status)">{{ group.label }}</Badge></div><div v-if="group.parameters.length" class="mt-3"><p class="mb-2 text-xs text-muted-foreground">提交参数</p><dl class="grid grid-cols-2 gap-x-4 gap-y-2 text-xs"><div v-for="field in group.parameters" :key="field.key" class="min-w-0"><dt class="text-muted-foreground">{{ field.label }}</dt><dd class="mt-1 font-mono tabular-nums [overflow-wrap:anywhere]">{{ field.value }}</dd></div></dl></div><p v-if="!group.nodes.some(node => node.stage === 'terminal')" class="mt-2 text-xs text-muted-foreground">尚无终端结果记录。</p><details class="mt-3"><summary class="cursor-pointer text-xs text-muted-foreground">查看此项处理步骤</summary><ul class="mt-2 grid gap-2"><li v-for="node in group.nodes" :key="`${node.sourceKind}:${node.sourceId}`" class="text-xs leading-5"><span class="font-medium">{{ stages[node.stage] }}</span> · {{ statuses[node.status] }}<p class="text-muted-foreground">{{ stepExplanation(node) }}</p><time class="text-muted-foreground">{{ formatLaboratoryTime(node.occurredAt) }}</time></li></ul></details></article></section><details class="mt-5" :open="!actionGroups.length"><summary class="cursor-pointer text-xs text-muted-foreground">查看完整处理时间线</summary><ol class="ml-2 mt-5 space-y-5 border-l border-border"><li v-for="(node,index) in detail.trace" :key="index" class="relative ml-5 rounded-xl border p-4"><span aria-hidden="true" class="absolute -left-[1.6rem] top-5 size-2.5 rounded-full border-2 border-background bg-primary" /><div class="flex justify-between gap-3 text-sm font-medium"><span>{{ stages[node.stage] ?? '处理记录' }}</span><Badge :variant="statusVariant(node.status)">{{ statuses[node.status] }}</Badge></div><p class="mt-2 text-sm text-muted-foreground">{{ stepExplanation(node) }}</p><time class="mt-3 flex items-center gap-1.5 text-xs text-muted-foreground"><Clock3 class="size-3.5" aria-hidden="true" />{{ formatLaboratoryTime(node.occurredAt) }}</time></li></ol></details><p v-if="!detail.trace.length" class="py-6 text-sm text-muted-foreground">暂未查询到关联处理步骤。</p></template></SheetContent></Sheet>
</template>
