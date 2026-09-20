<script setup lang="ts">
import { BrainCircuit, Link2, Plus, Search } from '@lucide/vue'
import type { StrategySummary } from '@aurum/contracts'
import { computed, ref } from 'vue'
import { Badge } from '@aurum/ui/badge'
import { Button } from '@aurum/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@aurum/ui/card'
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from '@aurum/ui/empty'
import { Input } from '@aurum/ui/input'
import { strategyStatusLabel } from '../model/strategy-presentation'

const props = withDefaults(defineProps<{
  items: StrategySummary[]
  selectedId: string
  loading?: boolean
}>(), { loading: false })

const emit = defineEmits<{
  select: [id: string]
  create: []
}>()

const keyword = ref('')
const filtered = computed(() => {
  const value = keyword.value.trim().toLocaleLowerCase()
  return props.items.filter((item) => item.kind === 'analysis' && (!value || `${item.name} ${item.description} ${item.pairedTraderStrategy?.name ?? ''}`.toLocaleLowerCase().includes(value)))
})
</script>

<template>
  <Card class="min-w-0 self-start shadow-none">
    <CardHeader class="gap-4 border-b">
      <div class="flex items-start justify-between gap-3">
        <div>
          <CardTitle>策略组合</CardTitle>
          <CardDescription class="mt-1">一次选择，同时使用分析与执行策略。</CardDescription>
        </div>
        <Button size="sm" class="min-h-11 shrink-0" aria-label="新增策略组合" @click="emit('create')"><Plus data-icon="inline-start" />新建</Button>
      </div>
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
          <EmptyTitle>{{ keyword ? '没有找到匹配的策略' : '暂无策略组合' }}</EmptyTitle>
          <EmptyDescription>{{ keyword ? '试试其他关键词。' : '创建个人策略，发布后即可使用。' }}</EmptyDescription>
        </EmptyHeader>
      </Empty>
      <div v-else class="max-h-[34rem] overflow-y-auto">
        <div class="grid gap-2 p-3">
          <Button
            v-for="item in filtered"
            :key="item.id"
            variant="ghost"
            class="grid h-auto whitespace-normal min-h-24 w-full justify-stretch gap-2 rounded-xl border p-3 text-left font-normal hover:bg-muted/50"
            :aria-pressed="item.id === selectedId"
            :class="item.id === selectedId ? 'border-primary bg-primary/5' : ''"
            @click="emit('select', item.id)"
          >
            <div class="flex min-w-0 items-center gap-2">
              <BrainCircuit class="size-4 shrink-0 text-primary" aria-hidden="true" />
              <strong class="truncate text-sm">{{ item.name }}</strong>
              <Badge class="ml-auto shrink-0" :variant="item.status === 'active' ? 'default' : 'secondary'">{{ strategyStatusLabel[item.status] }}</Badge>
            </div>
            <p class="line-clamp-2 text-xs leading-5 text-muted-foreground">{{ item.description || '暂无策略说明' }}</p>
            <span class="flex items-center gap-1 text-xs text-muted-foreground"><Link2 class="size-3.5" />{{ item.pairedTraderStrategy?.name ?? '待绑定交易策略' }}</span>
          </Button>
        </div>
      </div>
    </CardContent>
  </Card>
</template>
