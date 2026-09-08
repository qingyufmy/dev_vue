<script setup lang="ts">
import type { DeepReadonly } from 'vue'
import type { MacroSnapshotDetail } from '@aurum/contracts'
import { Button } from '@aurum/ui/button'
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@aurum/ui/sheet'
import { formatBeijingTime } from '@aurum/ui/lib/time'
defineProps<{ open: boolean; loading: boolean; error: string; detail: DeepReadonly<MacroSnapshotDetail> | null }>()
defineEmits<{ 'update:open': [value: boolean]; retry: [] }>()
const freshness = { fresh: '数据新鲜', stale: '数据已过期', missing: '数据缺失', disabled: '未启用', invalid: '状态未确认' }
const relation = { supportive: '偏支持黄金', adverse: '偏压制黄金', neutral: '中性', uncertain: '方向不明确' }
</script>

<template>
  <Sheet :open="open" @update:open="$emit('update:open', $event)">
    <SheetContent class="w-full overflow-y-auto sm:max-w-xl">
      <SheetHeader class="pr-12"><SheetTitle>宏观研究详情</SheetTitle><SheetDescription>查看中期研究背景与因子，时间均为北京时间。</SheetDescription></SheetHeader>
      <div class="grid gap-5 p-4 sm:p-6" :aria-busy="loading">
        <p v-if="loading" role="status" class="text-sm text-muted-foreground">正在加载研究…</p>
        <div v-else-if="error" role="alert"><p class="text-sm">{{ error }}</p><Button class="mt-3" variant="outline" @click="$emit('retry')">重新加载</Button></div>
        <template v-else-if="detail">
          <p class="whitespace-pre-wrap break-words text-sm leading-7">{{ detail.summary }}</p>
          <p class="text-xs text-muted-foreground">发布时间：{{ formatBeijingTime(detail.publishedAt) }}<br>数据截止：{{ formatBeijingTime(detail.dataCutoffAt) }}</p>
          <section aria-label="研究因子" class="grid gap-3">
            <p v-if="!detail.factors.length" class="text-sm text-muted-foreground">这份研究暂无可展示的因子。</p>
            <article v-for="factor in detail.factors" :key="factor.code" class="min-w-0 rounded-lg border p-4">
              <h3 class="break-words font-medium">{{ factor.label }}</h3><p class="mt-2 break-all text-lg tabular-nums">{{ factor.value ?? '—' }} <span class="text-sm text-muted-foreground">{{ factor.unit }}</span></p>
              <p class="mt-2 text-xs">{{ freshness[factor.freshness] }} · {{ relation[factor.goldRelation] }}</p>
              <p class="mt-2 text-xs text-muted-foreground">观测：{{ formatBeijingTime(factor.observationAt) }}</p>
            </article>
          </section>
        </template>
      </div>
    </SheetContent>
  </Sheet>
</template>
