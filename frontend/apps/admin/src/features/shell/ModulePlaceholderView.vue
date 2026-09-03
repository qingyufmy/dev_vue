<script setup lang="ts">
import { Blocks } from '@lucide/vue'
import { computed } from 'vue'
import { useRoute } from 'vue-router'
import { Card, CardContent } from '@aurum/ui/card'
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from '@aurum/ui/empty'

const route = useRoute()
const title = computed(() => String(route.meta.title ?? '后台模块'))
const description = computed(() => String(route.meta.description ?? '该模块将在后续阶段接入。'))
</script>

<template>
  <div class="mx-auto w-full max-w-6xl p-4 sm:p-6 lg:p-8">
    <h1 class="text-2xl font-semibold tracking-tight sm:text-3xl">{{ title }}</h1>
    <p class="mt-2 text-sm text-muted-foreground">独立后台领域模块 · 写操作必须显示作用范围</p>
    <Card class="mt-6 min-h-[28rem] shadow-none">
      <CardContent class="flex min-h-[28rem] items-center justify-center">
        <Empty>
          <EmptyHeader>
            <EmptyMedia variant="icon"><Blocks /></EmptyMedia>
            <EmptyTitle>{{ title }}正在重新构建</EmptyTitle>
            <EmptyDescription>{{ description }}</EmptyDescription>
          </EmptyHeader>
        </Empty>
      </CardContent>
    </Card>
  </div>
</template>
