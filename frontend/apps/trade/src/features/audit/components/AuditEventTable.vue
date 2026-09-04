<script setup lang="ts">
import { ChevronRight, FileSearch } from '@lucide/vue'
import type { TradingAccount } from '@aurum/contracts'
import { Badge } from '@aurum/ui/badge'
import { Button } from '@aurum/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@aurum/ui/card'
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from '@aurum/ui/empty'
import { Skeleton } from '@aurum/ui/skeleton'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@aurum/ui/table'
import {
  accountLabel, actorLabel, categoryLabel, formatAuditTimestamp, sourceLabel, statusLabel, statusVariant,
  type AuditEvent,
} from '../model/audit-presentation'

const props = defineProps<{
  items: AuditEvent[]
  accounts: TradingAccount[]
  loading: boolean
  loadingMore: boolean
  hasMore: boolean
}>()

const emit = defineEmits<{ select: [event: AuditEvent]; more: [] }>()

function accountName(id: string | null) {
  if (!id) return '全部账户'
  return accountLabel(props.accounts.find((account) => account.id === id))
}
</script>

<template>
  <Card class="min-w-0 shadow-none">
    <CardHeader class="flex-row items-start justify-between gap-4">
      <div>
        <CardTitle>事件记录</CardTitle>
        <CardDescription class="mt-1">按时间倒序展示操作与执行链路，点击事件查看精确证据。</CardDescription>
      </div>
      <Badge variant="outline">{{ items.length }} 条</Badge>
    </CardHeader>
    <CardContent class="p-0">
      <div v-if="loading && !items.length" class="grid gap-2 p-5">
        <Skeleton v-for="index in 6" :key="index" class="h-16 w-full" />
      </div>

      <Empty v-else-if="!items.length" class="min-h-72 rounded-none border-0 border-t">
        <EmptyHeader>
          <EmptyMedia variant="icon"><FileSearch /></EmptyMedia>
          <EmptyTitle>当前范围没有审计事件</EmptyTitle>
          <EmptyDescription>可以调整账户、状态或日期范围。页面不会用本地模拟数据填充记录。</EmptyDescription>
        </EmptyHeader>
      </Empty>

      <template v-else>
        <div class="hidden lg:block">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead class="min-w-64">事件</TableHead>
                <TableHead>分类</TableHead>
                <TableHead>来源 / 主体</TableHead>
                <TableHead>状态</TableHead>
                <TableHead>账户</TableHead>
                <TableHead>发生时间</TableHead>
                <TableHead class="w-12"><span class="sr-only">查看详情</span></TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              <TableRow
                v-for="item in items"
                :key="`${item.sourceKind}:${item.sourceId}`"
                class="cursor-pointer"
                role="button"
                tabindex="0"
                @click="emit('select', item)"
                @keydown.enter="emit('select', item)"
                @keydown.space.prevent="emit('select', item)"
              >
                <TableCell>
                  <div class="min-w-0">
                    <p class="truncate font-medium">{{ item.title }}</p>
                    <p class="mt-1 max-w-80 truncate text-xs text-muted-foreground">{{ item.summary }}</p>
                    <p v-if="item.reasonCode" class="mt-1 font-mono text-[11px] text-muted-foreground">原因 · {{ item.reasonCode }}</p>
                  </div>
                </TableCell>
                <TableCell><Badge variant="secondary">{{ categoryLabel(item.category) }}</Badge></TableCell>
                <TableCell>
                  <p class="text-sm">{{ sourceLabel(item.sourceKind) }}</p>
                  <p class="mt-1 text-xs text-muted-foreground">{{ actorLabel(item.actor) }} · {{ item.action }}</p>
                </TableCell>
                <TableCell><Badge :variant="statusVariant(item.status)">{{ statusLabel(item.status) }}</Badge></TableCell>
                <TableCell class="max-w-48 truncate text-xs text-muted-foreground">{{ accountName(item.accountId) }}</TableCell>
                <TableCell class="whitespace-nowrap font-mono text-xs tabular-nums">{{ formatAuditTimestamp(item.occurredAt, item.terminalTimezoneOffsetMinutes) }}</TableCell>
                <TableCell><ChevronRight class="text-muted-foreground" aria-hidden="true" /></TableCell>
              </TableRow>
            </TableBody>
          </Table>
        </div>

        <div class="grid gap-2 border-t p-3 lg:hidden">
          <Button
            v-for="item in items"
            :key="`${item.sourceKind}:${item.sourceId}`"
            type="button"
            variant="outline"
            class="h-auto min-h-28 w-full items-stretch justify-start whitespace-normal p-4 text-left"
            @click="emit('select', item)"
          >
            <span class="flex min-w-0 flex-1 flex-col gap-3">
              <span class="flex min-w-0 items-start justify-between gap-3">
                <span class="min-w-0">
                  <strong class="block truncate">{{ item.title }}</strong>
                  <span class="mt-1 block truncate text-xs text-muted-foreground">{{ sourceLabel(item.sourceKind) }} · {{ actorLabel(item.actor) }}</span>
                </span>
                <Badge class="shrink-0" :variant="statusVariant(item.status)">{{ statusLabel(item.status) }}</Badge>
              </span>
              <span class="flex min-w-0 items-end justify-between gap-3 text-xs text-muted-foreground">
                <span class="truncate">{{ categoryLabel(item.category) }} · {{ accountName(item.accountId) }}</span>
                <span class="shrink-0 font-mono tabular-nums">{{ formatAuditTimestamp(item.occurredAt, item.terminalTimezoneOffsetMinutes).slice(0, 16) }}</span>
              </span>
            </span>
            <ChevronRight data-icon="inline-end" aria-hidden="true" />
          </Button>
        </div>

        <div v-if="hasMore" class="flex justify-center border-t p-4">
          <Button variant="outline" class="min-h-11 min-w-32" :disabled="loadingMore" @click="emit('more')">
            {{ loadingMore ? '正在读取…' : '加载更多' }}
          </Button>
        </div>
      </template>
    </CardContent>
  </Card>
</template>

