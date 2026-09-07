<script setup lang="ts">
import { BookOpenCheck, CircleAlert, Clock3, FileClock } from '@lucide/vue'
import { Alert, AlertDescription, AlertTitle } from '@aurum/ui/alert'
import { Badge } from '@aurum/ui/badge'
import { Button } from '@aurum/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@aurum/ui/card'
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from '@aurum/ui/empty'
import { Skeleton } from '@aurum/ui/skeleton'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@aurum/ui/table'
import { caseKindLabel, formatReviewTime, statusLabel, type ReviewCaseKind, type ReviewCaseSummary } from '../model/reviewer-presentation'

const props = defineProps<{
  items: ReviewCaseSummary[]
  selectedId: string
  loading: boolean
  refreshing?: boolean
  error?: string
  title: string
  description: string
  emptyTitle: string
  emptyDescription: string
  kind?: ReviewCaseKind | 'period'
}>()

const emit = defineEmits<{ select: [id: string] }>()

function statusVariant(status: ReviewCaseSummary['status']): 'default' | 'secondary' | 'outline' | 'destructive' {
  if (status === 'confirmed') return 'default'
  if (status === 'failed' || status === 'awaiting_evidence' || status === 'needs_changes') return 'destructive'
  if (status === 'awaiting_confirmation') return 'secondary'
  return 'outline'
}

function choose(id: string) {
  if (id) emit('select', id)
}
</script>

<template>
  <Card class="min-w-0 shadow-none">
    <CardHeader class="border-b">
      <div class="flex items-start justify-between gap-3">
        <div class="min-w-0">
          <CardTitle class="flex items-center gap-2 text-base"><BookOpenCheck aria-hidden="true" />{{ title }}</CardTitle>
          <CardDescription>{{ description }}</CardDescription>
        </div>
        <Badge variant="outline" class="shrink-0">{{ refreshing ? '同步中' : `${items.length} 条` }}</Badge>
      </div>
    </CardHeader>

    <CardContent class="p-0">
      <div v-if="loading" class="grid gap-2 p-4">
        <Skeleton v-for="index in 5" :key="index" class="h-16 w-full" />
      </div>
      <Alert v-else-if="error" variant="destructive" class="m-4">
        <CircleAlert aria-hidden="true" />
        <AlertTitle>复盘列表读取失败</AlertTitle>
        <AlertDescription>{{ error }}</AlertDescription>
      </Alert>
      <Empty v-else-if="!items.length" class="min-h-64 border-0 px-5 py-8">
        <EmptyHeader>
          <EmptyMedia variant="icon"><FileClock aria-hidden="true" /></EmptyMedia>
          <EmptyTitle>{{ emptyTitle }}</EmptyTitle>
          <EmptyDescription>{{ emptyDescription }}</EmptyDescription>
        </EmptyHeader>
      </Empty>

      <div v-else>
        <div class="hidden overflow-x-auto md:block">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>复盘范围</TableHead>
                <TableHead>账户 / 品种</TableHead>
                <TableHead>策略</TableHead>
                <TableHead>状态</TableHead>
                <TableHead class="text-right">更新时间</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              <TableRow
                v-for="item in items"
                :key="item.id"
                class="cursor-pointer transition-colors hover:bg-muted/50 focus-visible:bg-muted/50"
                :data-selected="selectedId === item.id ? 'true' : undefined"
                tabindex="0"
                role="button"
                @click="choose(item.id)"
                @keydown.enter="choose(item.id)"
                @keydown.space.prevent="choose(item.id)"
              >
                <TableCell>
                  <div class="grid gap-1">
                    <span class="font-medium">{{ item.terminalPeriod }}</span>
                    <span class="text-xs text-muted-foreground">{{ caseKindLabel(item.kind) }} · {{ item.itemCount || '--' }} 笔</span>
                  </div>
                </TableCell>
                <TableCell>
                  <div class="grid gap-1">
                    <span class="font-medium">{{ item.accountLabel }}</span>
                    <span class="font-mono text-xs text-muted-foreground">{{ item.symbol }}</span>
                  </div>
                </TableCell>
                <TableCell class="max-w-48 truncate">{{ item.strategyLabel }}</TableCell>
                <TableCell><Badge :variant="statusVariant(item.status)">{{ statusLabel(item.status) }}</Badge></TableCell>
                <TableCell class="text-right text-xs tabular-nums text-muted-foreground">{{ formatReviewTime(item.updatedAt, item.terminalTimezoneOffsetMinutes) }}</TableCell>
              </TableRow>
            </TableBody>
          </Table>
        </div>

        <div class="grid gap-2 p-3 md:hidden">
          <Button
            v-for="item in items"
            :key="item.id"
            type="button"
            variant="outline"
            class="h-auto min-h-20 w-full justify-start whitespace-normal px-3 py-3 text-left"
            :data-selected="selectedId === item.id ? 'true' : undefined"
            @click="choose(item.id)"
          >
            <span class="grid w-full min-w-0 gap-2">
              <span class="flex items-center justify-between gap-2">
                <span class="truncate font-medium">{{ item.terminalPeriod }} · {{ item.symbol }}</span>
                <Badge :variant="statusVariant(item.status)">{{ statusLabel(item.status) }}</Badge>
              </span>
              <span class="flex items-center justify-between gap-2 text-xs text-muted-foreground">
                <span class="truncate">{{ item.strategyLabel }} · {{ item.accountLabel }}</span>
                <span class="inline-flex shrink-0 items-center gap-1 tabular-nums"><Clock3 data-icon="inline-start" />{{ formatReviewTime(item.updatedAt, item.terminalTimezoneOffsetMinutes) }}</span>
              </span>
            </span>
          </Button>
        </div>
      </div>
    </CardContent>
  </Card>
</template>
