<script setup lang="ts">
import { computed, ref } from 'vue'
import { Input } from '@aurum/ui/input'
import { AlertCircle, Clock3, RadioTower } from '@lucide/vue'
import type { MarketAnalysisSummary, StrategySummary } from '@aurum/contracts'
import { Alert, AlertDescription, AlertTitle } from '@aurum/ui/alert'
import { Badge } from '@aurum/ui/badge'
import { Button } from '@aurum/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@aurum/ui/card'
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from '@aurum/ui/empty'
import { ScrollArea } from '@aurum/ui/scroll-area'
import { Skeleton } from '@aurum/ui/skeleton'
import { analysisTime, biasLabel, opportunityLabel } from '../model/analysis-presentation'

const props = defineProps<{
  items: MarketAnalysisSummary[]
  strategies: StrategySummary[]
  selectedId: string
  loading: boolean
  refreshing: boolean
  error: string
}>()

const search = ref('')
const opportunity = ref('all')
const filters = [{value:'all',label:'全部'},{value:'setup',label:'有机会'},{value:'none',label:'观望'}]
function clearFilters() { search.value=''; opportunity.value='all' }
const filteredItems = computed(() => {
  const query = search.value.trim().toLocaleLowerCase()
  return props.items.filter(item => (opportunity.value === 'all' || (opportunity.value === 'setup' ? item.opportunity !== 'none' : item.opportunity === 'none')) && (!query || `${item.symbol} ${strategyName(item.strategyId)}`.toLocaleLowerCase().includes(query)))
})

const emit = defineEmits<{ select: [id: string] }>()

function strategyName(id: string) {
  return props.strategies.find((item) => item.id === id)?.name ?? '历史策略'
}
</script>

<template>
  <Card class="min-h-0 shadow-none lg:sticky lg:top-4 lg:self-start">
    <CardHeader class="gap-2 border-b">
      <div class="flex items-start justify-between gap-3">
        <div class="min-w-0">
          <CardTitle class="flex items-center gap-2 text-sm"><RadioTower class="size-4 text-primary" aria-hidden="true" />分析记录</CardTitle>
          <CardDescription class="mt-1 text-xs">按品种、策略与交易机会查找</CardDescription>
        </div>
        <Badge variant="outline">{{ refreshing ? '同步中' : `${filteredItems.length} / ${items.length} 条` }}</Badge>
      </div>
      <Input v-model="search" class="mt-3" aria-label="搜索分析记录" placeholder="搜索品种或策略名称" />
    <div role="group" aria-label="按交易机会筛选" class="mt-3 flex gap-1 rounded-lg bg-muted/40 p-1"><Button v-for="filter in filters" :key="filter.value" type="button" size="sm" :variant="opportunity===filter.value?'secondary':'ghost'" :aria-pressed="opportunity===filter.value" class="flex-1" @click="opportunity=filter.value">{{filter.label}}</Button></div></CardHeader>
    <CardContent class="min-h-0 p-2">
      <div v-if="loading" class="grid gap-2 p-1">
        <Skeleton v-for="index in 7" :key="index" class="h-24 w-full" />
      </div>
      <Alert v-else-if="error" variant="destructive">
        <AlertCircle />
        <AlertTitle>分析记录读取失败</AlertTitle>
        <AlertDescription>{{ error }}</AlertDescription>
      </Alert>
      <Empty v-else-if="!items.length" class="min-h-72 border-0">
        <EmptyHeader>
          <EmptyMedia variant="icon"><RadioTower /></EmptyMedia>
          <EmptyTitle>还没有分析记录</EmptyTitle>
          <EmptyDescription>自动分析完成后会出现在这里，也可以手动发起一次分析。</EmptyDescription>
        </EmptyHeader>
      </Empty>
      <div v-else-if="!filteredItems.length" class="px-3 py-10 text-center"><p class="text-sm text-muted-foreground">没有匹配的分析记录</p><Button variant="link" class="mt-2" @click="clearFilters">清除筛选</Button></div>
      <ScrollArea v-else class="h-[24rem] lg:h-[max(16rem,calc(100svh-23rem))]">
        <div class="grid gap-1 pr-2">
          <Button
            v-for="item in filteredItems"
            :key="item.analysisId"
            type="button"
            :aria-current="selectedId === item.analysisId ? 'true' : undefined" :variant="selectedId === item.analysisId ? 'secondary' : 'ghost'"
            class="h-auto min-h-24 w-full items-start justify-start whitespace-normal rounded-lg border border-transparent px-3 py-3 text-left transition-colors aria-[current=true]:border-primary/35 aria-[current=true]:bg-primary/8 aria-[current=true]:shadow-[inset_3px_0_0_var(--primary)]"
            @click="emit('select', item.analysisId)"
          >
            <span class="grid w-full min-w-0 gap-2">
              <span class="flex items-center justify-between gap-3">
                <strong class="truncate text-sm">{{ item.symbol }}</strong>
                <Badge :variant="item.opportunity === 'none' ? 'outline' : 'default'">{{ opportunityLabel(item.opportunity) }}</Badge>
              </span>
              <span class="truncate text-xs font-normal text-muted-foreground">{{ strategyName(item.strategyId) }}</span>
              <span class="flex items-center justify-between gap-2 text-xs font-normal text-muted-foreground">
                <span>{{ biasLabel(item.marketBias) }}</span>
                <span class="inline-flex items-center gap-1 tabular-nums"><Clock3 data-icon="inline-start" />{{ analysisTime(item.analyzedAt) }}</span>
              </span>
            </span>
          </Button>
        </div>
      </ScrollArea>
    </CardContent>
  </Card>
</template>
