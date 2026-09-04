<script setup lang="ts">
import { AlertTriangle, BrainCircuit, CheckCircle2, Clock3, FileText, XCircle } from '@lucide/vue'
import { Alert, AlertDescription, AlertTitle } from '@aurum/ui/alert'
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from '@aurum/ui/alert-dialog'
import { Badge } from '@aurum/ui/badge'
import { Button } from '@aurum/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@aurum/ui/card'
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from '@aurum/ui/empty'
import { ScrollArea } from '@aurum/ui/scroll-area'
import { Sheet, SheetContent, SheetDescription, SheetFooter, SheetHeader, SheetTitle } from '@aurum/ui/sheet'
import { Skeleton } from '@aurum/ui/skeleton'
import { ref } from 'vue'
import { formatReviewTime, memoryUpdateStatusLabel, type MemoryUpdate, type StrategyMemoryDetail } from '../model/reviewer-presentation'

const props = defineProps<{
  open: boolean
  detail: StrategyMemoryDetail | null
  loading: boolean
  error?: string
  action?: string
}>()

const emit = defineEmits<{
  'update:open': [value: boolean]
  decide: [update: MemoryUpdate, decision: 'confirm' | 'reject' | 'revoke']
}>()

const pending = ref<{ update: MemoryUpdate; decision: 'confirm' | 'reject' | 'revoke' } | null>(null)

function requestDecision(update: MemoryUpdate, decision: 'confirm' | 'reject' | 'revoke') {
  pending.value = { update, decision }
}

function completeDecision() {
  if (!pending.value) return
  emit('decide', pending.value.update, pending.value.decision)
  pending.value = null
}

function closePending(value: boolean) {
  if (!value) pending.value = null
}
</script>

<template>
  <Sheet :open="open" @update:open="emit('update:open', $event)">
    <SheetContent class="w-full gap-0 p-0 sm:max-w-xl" side="right">
      <SheetHeader class="border-b pr-16 text-left">
        <div class="flex items-center gap-2 text-xs font-medium text-primary"><BrainCircuit aria-hidden="true" />策略记忆库</div>
        <SheetTitle>{{ detail?.strategyLabel ?? '策略记忆详情' }}</SheetTitle>
        <SheetDescription>{{ detail ? `当前版本 v${detail.version || '--'} · ${detail.status}` : '查看当前版本与待确认经验候选。' }}</SheetDescription>
      </SheetHeader>

      <ScrollArea class="min-h-0 flex-1">
        <div class="grid gap-4 p-4 sm:p-6">
          <Alert v-if="error" variant="destructive"><AlertTriangle aria-hidden="true" /><AlertTitle>记忆详情读取失败</AlertTitle><AlertDescription>{{ error }}</AlertDescription></Alert>
          <div v-if="loading" class="grid gap-3"><Skeleton class="h-20 w-full" /><Skeleton class="h-40 w-full" /></div>
          <Empty v-else-if="!detail" class="min-h-56 border-0"><EmptyHeader><EmptyMedia variant="icon"><BrainCircuit /></EmptyMedia><EmptyTitle>没有选中的记忆库</EmptyTitle><EmptyDescription>从策略列表中选择一个记忆库查看版本和候选更新。</EmptyDescription></EmptyHeader></Empty>
          <template v-else>
            <Card size="sm" class="shadow-none">
              <CardHeader><CardTitle class="text-base">当前版本 v{{ detail.version || '--' }}</CardTitle><CardDescription>{{ detail.summary || '暂无记忆摘要。' }}</CardDescription></CardHeader>
              <CardContent><div v-if="detail.content" class="whitespace-pre-wrap break-words text-sm leading-7">{{ detail.content }}</div><p v-else class="text-sm text-muted-foreground">当前版本尚未保存正文。</p></CardContent>
            </Card>

            <Card class="shadow-none">
              <CardHeader><CardTitle class="flex items-center gap-2 text-base"><Clock3 aria-hidden="true" />记忆候选</CardTitle><CardDescription>累计证据中的候选不可操作；待确认候选可接受或驳回，已合并候选可申请撤销。</CardDescription></CardHeader>
              <CardContent class="grid gap-3">
                <Empty v-if="!detail.updates.length" class="min-h-32 border-0"><EmptyHeader><EmptyMedia variant="icon"><CheckCircle2 /></EmptyMedia><EmptyTitle>暂无候选变更</EmptyTitle></EmptyHeader></Empty>
                <section v-for="update in detail.updates" :key="update.id" class="rounded-xl border p-4">
                  <div class="flex items-start justify-between gap-3"><div class="min-w-0"><h3 class="font-medium">{{ update.title }}</h3><p class="mt-1 text-xs text-muted-foreground">{{ update.kind }} · {{ formatReviewTime(update.createdAt) }}</p></div><Badge :variant="update.conflict ? 'destructive' : update.status === 'merged' ? 'default' : 'secondary'">{{ update.conflict ? '存在冲突' : memoryUpdateStatusLabel(update.status) }}</Badge></div>
                  <p class="mt-3 text-sm leading-6 text-muted-foreground">{{ update.summary }}</p>
                  <p v-if="update.status === 'collecting_evidence'" class="mt-3 rounded-lg border border-dashed bg-muted/20 px-3 py-2 text-xs leading-5 text-muted-foreground">当前状态：累计证据中。系统正在等待至少三个不同且已确认的复盘证据；完成前不能确认或驳回。</p>
                  <Alert v-if="update.conflict" variant="destructive" class="mt-3"><AlertTriangle aria-hidden="true" /><AlertTitle>检测到候选冲突</AlertTitle><AlertDescription>{{ update.conflict }}</AlertDescription></Alert>
                  <ul v-if="update.evidence.length" class="mt-3 grid gap-1 border-t pt-3 text-xs leading-5 text-muted-foreground"><li v-for="item in update.evidence" :key="item">{{ item }}</li></ul>
                  <div v-if="update.status === 'awaiting_confirmation'" class="mt-4 flex flex-wrap gap-2"><Button variant="outline" class="min-h-11" :disabled="Boolean(action)" @click="requestDecision(update, 'reject')"><XCircle data-icon="inline-start" />驳回候选</Button><Button class="min-h-11" :disabled="Boolean(action)" @click="requestDecision(update, 'confirm')"><CheckCircle2 data-icon="inline-start" />确认并创建新版本</Button></div>
                  <div v-else-if="update.status === 'merged'" class="mt-4 flex flex-wrap gap-2"><Button variant="outline" class="min-h-11" :disabled="Boolean(action)" @click="requestDecision(update, 'revoke')"><XCircle data-icon="inline-start" />撤销合并</Button></div>
                </section>
              </CardContent>
            </Card>

            <Card v-if="detail.revisions.length" class="shadow-none">
              <CardHeader><CardTitle class="flex items-center gap-2 text-base"><FileText aria-hidden="true" />版本记录</CardTitle><CardDescription>历史版本不可覆盖，便于追溯每次确认。</CardDescription></CardHeader>
              <CardContent class="grid gap-2"><div v-for="revision in detail.revisions" :key="revision.id" class="flex items-center justify-between gap-3 rounded-lg border px-3 py-3 text-sm"><span>v{{ revision.version }} · {{ revision.status }}</span><span class="text-xs tabular-nums text-muted-foreground">{{ formatReviewTime(revision.createdAt) }}</span></div></CardContent>
            </Card>
          </template>
        </div>
      </ScrollArea>

      <SheetFooter class="border-t sm:flex-row sm:justify-end"><Button variant="outline" class="min-h-11" @click="emit('update:open', false)">关闭</Button></SheetFooter>
    </SheetContent>
  </Sheet>

  <AlertDialog :open="Boolean(pending)" @update:open="closePending">
    <AlertDialogContent class="max-w-lg">
      <AlertDialogHeader>
        <AlertDialogTitle>{{ pending?.decision === 'confirm' ? '确认这条记忆候选？' : pending?.decision === 'revoke' ? '撤销这次记忆合并？' : '驳回这条记忆候选？' }}</AlertDialogTitle>
        <AlertDialogDescription>{{ pending?.decision === 'confirm' ? '系统会基于当前策略记忆版本创建一个新的不可变版本，原版本仍保留。' : pending?.decision === 'revoke' ? '系统会按当前版本校验撤销合并操作，并保留完整审计记录。' : '候选会被记录为驳回，当前策略记忆版本不会改变。' }}</AlertDialogDescription>
      </AlertDialogHeader>
      <div v-if="pending" class="rounded-lg border bg-muted/20 p-4 text-sm leading-6"><p class="font-medium">{{ pending.update.title }}</p><p class="mt-1 text-muted-foreground">{{ pending.update.summary }}</p></div>
      <AlertDialogFooter><AlertDialogCancel class="min-h-11" :disabled="Boolean(action)">取消</AlertDialogCancel><AlertDialogAction class="min-h-11" :destructive="pending?.decision === 'reject' || pending?.decision === 'revoke'" :disabled="Boolean(action)" @click="completeDecision">{{ action ? '正在提交…' : pending?.decision === 'confirm' ? '确认并创建版本' : pending?.decision === 'revoke' ? '确认撤销合并' : '确认驳回' }}</AlertDialogAction></AlertDialogFooter>
    </AlertDialogContent>
  </AlertDialog>
</template>
