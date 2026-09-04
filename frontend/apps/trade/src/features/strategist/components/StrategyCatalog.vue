<script setup lang="ts">
import { Bot, BrainCircuit, Plus, Search } from '@lucide/vue'
import type { StrategyKind, StrategySummary } from '@aurum/contracts'
import { computed, ref } from 'vue'
import { Badge } from '@aurum/ui/badge'
import { Button } from '@aurum/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@aurum/ui/card'
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from '@aurum/ui/empty'
import { Input } from '@aurum/ui/input'
import { ScrollArea } from '@aurum/ui/scroll-area'
import { Tabs, TabsList, TabsTrigger } from '@aurum/ui/tabs'
import { strategyKindLabel, strategyStatusLabel } from '../model/strategy-presentation'

const props = withDefaults(defineProps<{
  items: StrategySummary[]
  selectedId: string
  loading?: boolean
  kind: StrategyKind
}>(), { loading: false })

const emit = defineEmits<{
  select: [id: string]
  create: [kind: StrategyKind]
  'kind-change': [kind: StrategyKind]
}>()

const keyword = ref('')
const filtered = computed(() => {
  const value = keyword.value.trim().toLocaleLowerCase()
  return props.items.filter((item) => item.kind === props.kind && (!value || `${item.name} ${item.description}`.toLocaleLowerCase().includes(value)))
})

function changeKind(value: string | number) {
  if (value === 'analysis' || value === 'trader') emit('kind-change', value)
}
</script>

<template>
  <Card class="min-w-0 shadow-none">
    <CardHeader class="gap-4 border-b">
      <div class="flex items-start justify-between gap-3">
        <div>
          <CardTitle>策略库</CardTitle>
          <CardDescription class="mt-1">平台策略可直接使用，个人策略可持续迭代。</CardDescription>
        </div>
        <Button size="icon-lg" aria-label="新增策略" @click="emit('create', kind)"><Plus data-icon="inline-start" /></Button>
      </div>
      <Tabs :model-value="kind" @update:model-value="changeKind">
        <TabsList class="grid h-auto w-full grid-cols-2">
          <TabsTrigger value="analysis" class="min-h-11">行情分析</TabsTrigger>
          <TabsTrigger value="trader" class="min-h-11">交易执行</TabsTrigger>
        </TabsList>
      </Tabs>
      <div class="relative">
        <Search class="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden="true" />
        <Input v-model="keyword" class="pl-9" placeholder="搜索策略" aria-label="搜索策略" />
      </div>
    </CardHeader>

    <CardContent class="p-0">
      <div v-if="loading" class="grid gap-2 p-3" aria-busy="true">
        <div v-for="index in 4" :key="index" class="h-24 animate-pulse rounded-lg bg-muted motion-reduce:animate-none" />
      </div>
      <Empty v-else-if="!filtered.length" class="min-h-72">
        <EmptyHeader>
          <EmptyMedia variant="icon"><BrainCircuit /></EmptyMedia>
          <EmptyTitle>暂无{{ strategyKindLabel[kind] }}策略</EmptyTitle>
          <EmptyDescription>可以新建个人策略，发布后再分配给交易账户。</EmptyDescription>
        </EmptyHeader>
      </Empty>
      <ScrollArea v-else class="h-[34rem]">
        <div class="grid gap-2 p-3">
          <Button
            v-for="item in filtered"
            :key="item.id"
            variant="ghost"
            class="grid h-auto min-h-24 w-full justify-stretch gap-2 rounded-xl border p-3 text-left font-normal hover:bg-muted/50"
            :class="item.id === selectedId ? 'border-primary bg-primary/5' : ''"
            @click="emit('select', item.id)"
          >
            <div class="flex min-w-0 items-center gap-2">
              <Bot v-if="item.kind === 'trader'" class="size-4 shrink-0 text-primary" aria-hidden="true" />
              <BrainCircuit v-else class="size-4 shrink-0 text-primary" aria-hidden="true" />
              <strong class="truncate text-sm">{{ item.name }}</strong>
              <Badge class="ml-auto shrink-0" :variant="item.status === 'active' ? 'default' : 'secondary'">{{ strategyStatusLabel[item.status] }}</Badge>
            </div>
            <p class="line-clamp-2 text-xs leading-5 text-muted-foreground">{{ item.description || '暂无策略说明' }}</p>
            <span class="text-xs text-muted-foreground">{{ item.scope === 'platform' ? '平台共享' : '我的策略' }}</span>
          </Button>
        </div>
      </ScrollArea>
    </CardContent>
  </Card>
</template>
