<script setup lang="ts">
import { AlertCircle } from '@lucide/vue'
import { useQuery } from '@tanstack/vue-query'
import { computed } from 'vue'
import { Alert, AlertDescription, AlertTitle } from '@aurum/ui/alert'
import { ScrollArea } from '@aurum/ui/scroll-area'
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@aurum/ui/sheet'
import { Skeleton } from '@aurum/ui/skeleton'
import type { StrategySummary } from '@aurum/contracts'
import { analystApi } from '../api/analyst-api'
import AnalysisDetailPanel from './AnalysisDetailPanel.vue'

const props = defineProps<{ open: boolean; analysisId: string; strategies?: StrategySummary[] }>()
const emit = defineEmits<{ 'update:open': [value: boolean] }>()

const detailQuery = useQuery({
  queryKey: computed(() => ['trade', 'analyst', 'detail', props.analysisId]),
  queryFn: async () => (await analystApi.getAnalysis(props.analysisId)).data,
  enabled: computed(() => props.open && Boolean(props.analysisId)),
  staleTime: 60_000,
})
</script>

<template>
  <Sheet :open="open" @update:open="emit('update:open', $event)">
    <SheetContent class="h-svh w-screen max-w-none gap-0 p-0 sm:max-w-none" side="right">
      <SheetHeader class="border-b px-5 py-4 pr-16 text-left">
        <SheetTitle>完整 AI 分析</SheetTitle>
        <SheetDescription>查看本次行情判断的结构化结论、证据和完整正文</SheetDescription>
      </SheetHeader>
      <ScrollArea class="min-h-0 flex-1">
        <div class="mx-auto w-full max-w-6xl p-4 sm:p-6">
          <div v-if="detailQuery.isPending.value" class="grid gap-4"><Skeleton class="h-48" /><Skeleton class="h-72" /><Skeleton class="h-80" /></div>
          <Alert v-else-if="detailQuery.error.value" variant="destructive"><AlertCircle /><AlertTitle>完整分析读取失败</AlertTitle><AlertDescription>{{ detailQuery.error.value instanceof Error ? detailQuery.error.value.message : '请稍后重试' }}</AlertDescription></Alert>
          <AnalysisDetailPanel v-else-if="detailQuery.data.value" :detail="detailQuery.data.value" :strategies="strategies ?? []" />
        </div>
      </ScrollArea>
    </SheetContent>
  </Sheet>
</template>
