<script setup lang="ts">
import { BrainCircuit, CircleAlert, Clock3, RefreshCw, Sparkles } from '@lucide/vue'
import { Alert, AlertDescription, AlertTitle } from '@aurum/ui/alert'
import { Badge } from '@aurum/ui/badge'
import { Button } from '@aurum/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@aurum/ui/card'
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from '@aurum/ui/empty'
import { Skeleton } from '@aurum/ui/skeleton'
import { memoryUpdateStatusLabel, statusLabel, type MemoryUpdate, type StrategyMemorySummary } from '../model/reviewer-presentation'

const props = defineProps<{
  memories: StrategyMemorySummary[]
  updates: MemoryUpdate[]
  selectedId: string
  loading: boolean
  error?: string
  refreshing?: boolean
}>()

const emit = defineEmits<{ refresh: []; select: [id: string] }>()

function choose(id: string) { if (id) emit('select', id) }
</script>

<template>
  <div class="grid min-w-0 gap-4">
    <Card class="shadow-none">
      <CardHeader class="border-b">
        <div class="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
          <div class="min-w-0">
            <CardTitle class="flex items-center gap-2 text-base"><BrainCircuit aria-hidden="true" />策略记忆库</CardTitle>
            <CardDescription>每条策略只有一个统一记忆库；确认后的候选会创建不可变新版本，不会直接改写策略提示词。</CardDescription>
          </div>
          <Button variant="outline" class="min-h-11 shrink-0" :disabled="loading || refreshing" @click="emit('refresh')"><RefreshCw data-icon="inline-start" :class="refreshing ? 'animate-spin motion-reduce:animate-none' : ''" />刷新记忆</Button>
        </div>
      </CardHeader>
      <CardContent class="grid gap-3 p-4 sm:p-5">
        <Alert v-if="error" variant="destructive"><CircleAlert aria-hidden="true" /><AlertTitle>策略记忆读取失败</AlertTitle><AlertDescription>{{ error }}</AlertDescription></Alert>
        <div v-if="loading" class="grid gap-2 sm:grid-cols-2"><Skeleton v-for="index in 4" :key="index" class="h-28 w-full" /></div>
        <Empty v-else-if="!memories.length" class="min-h-56 border-0"><EmptyHeader><EmptyMedia variant="icon"><BrainCircuit /></EmptyMedia><EmptyTitle>还没有策略记忆库</EmptyTitle><EmptyDescription>确认复盘中的记忆候选后，系统会按策略建立第一版记忆。</EmptyDescription></EmptyHeader></Empty>
        <div v-else class="grid gap-3 sm:grid-cols-2">
          <Button v-for="memory in memories" :key="memory.id" type="button" variant="outline" class="h-auto min-h-32 w-full justify-start whitespace-normal p-4 text-left" :data-selected="selectedId === memory.id ? 'true' : undefined" @click="choose(memory.id)">
            <span class="grid w-full min-w-0 gap-3">
              <span class="flex items-start justify-between gap-3"><span class="min-w-0"><span class="block truncate font-medium">{{ memory.strategyLabel }}</span><span class="mt-1 block text-xs text-muted-foreground">统一策略记忆库</span></span><Badge variant="outline">v{{ memory.version || '--' }}</Badge></span>
              <span class="line-clamp-2 text-sm leading-6 text-muted-foreground">{{ memory.summary }}</span>
              <span class="flex items-center justify-between gap-2 text-xs text-muted-foreground"><span>{{ statusLabel(memory.status) }}</span><span class="inline-flex items-center gap-1"><Sparkles data-icon="inline-start" />{{ memory.pendingCount }} 个待确认</span></span>
            </span>
          </Button>
        </div>
      </CardContent>
    </Card>

    <Card class="shadow-none">
      <CardHeader><CardTitle class="flex items-center gap-2 text-base"><Sparkles aria-hidden="true" />待确认候选</CardTitle><CardDescription>确认或驳回都保留审计记录；冲突候选不会被静默合并。</CardDescription></CardHeader>
      <CardContent class="grid gap-2">
        <Empty v-if="!updates.length" class="min-h-32 border-0"><EmptyHeader><EmptyMedia variant="icon"><Clock3 /></EmptyMedia><EmptyTitle>{{ selectedId ? '当前记忆库暂无待确认候选' : '选择策略查看待确认候选' }}</EmptyTitle><EmptyDescription>{{ selectedId ? '已确认或已驳回的候选会保留在审计记录中。' : '点击上方策略记忆库后，在详情窗口中查看候选。' }}</EmptyDescription></EmptyHeader></Empty>
        <Button v-for="update in updates" :key="update.id" type="button" variant="ghost" class="h-auto min-h-16 w-full justify-start whitespace-normal border px-3 py-3 text-left" @click="choose(update.strategyMemoryId)">
          <span class="grid w-full min-w-0 gap-1"><span class="flex items-center justify-between gap-2"><span class="truncate font-medium">{{ update.title }}</span><Badge :variant="update.conflict ? 'destructive' : update.status === 'merged' ? 'default' : 'secondary'">{{ update.conflict ? '有冲突' : memoryUpdateStatusLabel(update.status) }}</Badge></span><span class="truncate text-xs text-muted-foreground">{{ update.summary }}</span></span>
        </Button>
      </CardContent>
    </Card>
  </div>
</template>
