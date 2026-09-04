<script setup lang="ts">
import { AlertCircle, CheckCircle2, Search, ShieldX } from '@lucide/vue'
import type { RiskDecisionSummary } from '@aurum/contracts'
import { Alert, AlertDescription, AlertTitle } from '@aurum/ui/alert'
import { Badge } from '@aurum/ui/badge'
import { Button } from '@aurum/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@aurum/ui/card'
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from '@aurum/ui/empty'
import { Skeleton } from '@aurum/ui/skeleton'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@aurum/ui/table'
import { formatDateTime, rejectCodeLabel } from '../model/risk-presentation'

const props = withDefaults(defineProps<{ items: RiskDecisionSummary[]; loading?: boolean; error?: string; timezoneOffsetMinutes?: number | null }>(), { loading: false, error: '', timezoneOffsetMinutes: null })
const emit = defineEmits<{ inspect: [decisionId: string] }>()
</script>

<template>
  <Card class="shadow-none">
    <CardHeader class="flex-row items-start justify-between gap-4 space-y-0 border-b">
      <div><CardTitle>最近风控评审</CardTitle><CardDescription>每条 AI 交易决定在发送终端前的确定性风控结果</CardDescription></div>
      <Badge variant="outline">{{ items.length }} 条</Badge>
    </CardHeader>
    <CardContent class="p-0">
      <div v-if="loading" class="grid gap-2 p-4"><Skeleton v-for="index in 5" :key="index" class="h-14 w-full" /></div>
      <Alert v-else-if="error" variant="destructive" class="m-4"><AlertCircle /><AlertTitle>风控记录读取失败</AlertTitle><AlertDescription>{{ error }}</AlertDescription></Alert>
      <Empty v-else-if="!items.length" class="min-h-72 border-0"><EmptyHeader><EmptyMedia variant="icon"><Search /></EmptyMedia><EmptyTitle>还没有风控评审记录</EmptyTitle><EmptyDescription>当 AI 交易员形成账户动作后，服务端风控结果会显示在这里。</EmptyDescription></EmptyHeader></Empty>
      <template v-else>
        <div class="hidden overflow-x-auto md:block">
          <Table>
            <TableHeader><TableRow><TableHead>结果</TableHead><TableHead>主要结论</TableHead><TableHead>交易决定</TableHead><TableHead>时间</TableHead><TableHead class="text-right">详情</TableHead></TableRow></TableHeader>
            <TableBody>
              <TableRow v-for="item in items" :key="item.riskDecisionId">
                <TableCell><Badge :variant="item.status === 'approved' ? 'default' : 'destructive'"><CheckCircle2 v-if="item.status === 'approved'" /><ShieldX v-else />{{ item.status === 'approved' ? '通过' : '拒绝' }}</Badge></TableCell>
                <TableCell class="max-w-80"><span class="block truncate text-sm font-medium">{{ rejectCodeLabel(item.rejectCode) }}</span><span class="mt-0.5 block text-xs text-muted-foreground">风险版本 {{ item.accountRiskRevision }}</span></TableCell>
                <TableCell class="font-mono text-xs">{{ item.tradeDecisionId }}</TableCell>
                <TableCell class="whitespace-nowrap text-xs text-muted-foreground">{{ formatDateTime(item.createdAt, timezoneOffsetMinutes) }}</TableCell>
                <TableCell class="text-right"><Button variant="ghost" size="sm" class="min-h-11" @click="emit('inspect', item.riskDecisionId)">查看规则</Button></TableCell>
              </TableRow>
            </TableBody>
          </Table>
        </div>
        <div class="grid gap-2 p-3 md:hidden">
          <Button v-for="item in items" :key="item.riskDecisionId" variant="ghost" class="h-auto min-h-20 justify-start whitespace-normal border px-3 py-3 text-left" @click="emit('inspect', item.riskDecisionId)">
            <span class="grid w-full gap-2"><span class="flex items-center justify-between gap-2"><Badge :variant="item.status === 'approved' ? 'default' : 'destructive'">{{ item.status === 'approved' ? '通过' : '拒绝' }}</Badge><span class="text-xs font-normal text-muted-foreground">{{ formatDateTime(item.createdAt, timezoneOffsetMinutes) }}</span></span><strong class="text-sm">{{ rejectCodeLabel(item.rejectCode) }}</strong></span>
          </Button>
        </div>
      </template>
    </CardContent>
  </Card>
</template>
