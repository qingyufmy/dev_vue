<script setup lang="ts">
import { AlertTriangle, CircleCheck, CircleX, ListChecks } from '@lucide/vue'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@aurum/ui/card'
import { Skeleton } from '@aurum/ui/skeleton'
import { formatCount, type AuditSummary } from '../model/audit-presentation'

defineProps<{
  summary: AuditSummary
  loading: boolean
}>()
</script>

<template>
  <section aria-labelledby="audit-summary-title" class="grid gap-3">
    <div class="flex items-end justify-between gap-3">
      <div>
        <h2 id="audit-summary-title" class="text-sm font-semibold">审计概览</h2>
        <p class="mt-1 text-xs text-muted-foreground">当前筛选范围内可核实的系统事件</p>
      </div>
      <p class="hidden text-xs text-muted-foreground sm:block">只读 · 以服务端记录为准</p>
    </div>

    <div class="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
      <Card class="shadow-none">
        <CardHeader class="flex-row items-center justify-between gap-3 pb-2">
          <CardTitle class="text-sm font-medium">全部事件</CardTitle>
          <ListChecks class="text-primary" aria-hidden="true" />
        </CardHeader>
        <CardContent>
          <Skeleton v-if="loading" class="h-8 w-20" />
          <p v-else class="aurum-number text-2xl font-semibold">{{ formatCount(summary.total) }}</p>
          <CardDescription class="mt-1">时间范围内的审计记录</CardDescription>
        </CardContent>
      </Card>

      <Card class="shadow-none">
        <CardHeader class="flex-row items-center justify-between gap-3 pb-2">
          <CardTitle class="text-sm font-medium">已完成</CardTitle>
          <CircleCheck class="text-system-ok" aria-hidden="true" />
        </CardHeader>
        <CardContent>
          <Skeleton v-if="loading" class="h-8 w-20" />
          <p v-else class="aurum-number text-2xl font-semibold">{{ formatCount(summary.succeeded) }}</p>
          <CardDescription class="mt-1">执行链路完成或已确认</CardDescription>
        </CardContent>
      </Card>

      <Card class="shadow-none">
        <CardHeader class="flex-row items-center justify-between gap-3 pb-2">
          <CardTitle class="text-sm font-medium">已拒绝</CardTitle>
          <CircleX class="text-destructive" aria-hidden="true" />
        </CardHeader>
        <CardContent>
          <Skeleton v-if="loading" class="h-8 w-20" />
          <p v-else class="aurum-number text-2xl font-semibold">{{ formatCount(summary.rejected) }}</p>
          <CardDescription class="mt-1">服务端规则拒绝的动作</CardDescription>
        </CardContent>
      </Card>

      <Card class="shadow-none">
        <CardHeader class="flex-row items-center justify-between gap-3 pb-2">
          <CardTitle class="text-sm font-medium">异常 / 待核实</CardTitle>
          <AlertTriangle class="text-system-warn" aria-hidden="true" />
        </CardHeader>
        <CardContent>
          <Skeleton v-if="loading" class="h-8 w-20" />
          <p v-else class="aurum-number text-2xl font-semibold">{{ formatCount(summary.failed + summary.uncertain) }}</p>
          <CardDescription class="mt-1">失败与结果不确定事件</CardDescription>
        </CardContent>
      </Card>
    </div>
  </section>
</template>

