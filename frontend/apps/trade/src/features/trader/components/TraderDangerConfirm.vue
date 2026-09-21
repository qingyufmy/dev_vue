<script setup lang="ts">
import { computed } from 'vue'
import type { AccountSnapshot, TradingAccount } from '@aurum/contracts'
import { Alert, AlertDescription, AlertTitle } from '@aurum/ui/alert'
import { AlertDialog, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from '@aurum/ui/alert-dialog'
import { Button } from '@aurum/ui/button'
import { Badge } from '@aurum/ui/badge'
import { CircleAlert, ShieldAlert } from '@lucide/vue'

type Account = TradingAccount | AccountSnapshot

const props = withDefaults(defineProps<{
  open: boolean
  account?: Account | string | null
  command?: string | null
  symbol?: string | null
  ticket?: string | null
  volume?: string | number | null
  price?: string | number | null
  stopLoss?: string | number | null
  takeProfit?: string | number | null
  scope?: string | null
  detail?: string | null
  destructive?: boolean
  submitting?: boolean
  error?: string
  confirmLabel?: string
}>(), {
  account: null,
  command: null,
  symbol: null,
  ticket: null,
  volume: null,
  price: null,
  stopLoss: null,
  takeProfit: null,
  scope: null,
  detail: null,
  destructive: undefined,
  submitting: false,
  confirmLabel: '',
  error: '',
})

const emit = defineEmits<{
  'update:open': [value: boolean]
  confirm: []
}>()

const destructiveCommands = new Set(['close_position', 'cancel_order', 'distribution_close', '分发平仓', '平仓', '撤单'])
const isDestructive = computed(() => props.destructive ?? destructiveCommands.has(props.command ?? ''))
const commandText = computed(() => ({
  market_order: '提交市价单', pending_order: '提交挂单', modify_position: '修改止盈止损', close_position: '平仓',
  modify_order: '修改挂单', cancel_order: '撤单', distribution_close: '分发平仓',
}[props.command ?? ''] ?? props.command ?? '交易操作'))
const title = computed(() => `确认${commandText.value}`)
const confirmText = computed(() => props.submitting ? '正在提交…' : props.confirmLabel || (isDestructive.value ? `确认${commandText.value}` : '确认提交'))
const accountText = computed(() => {
  if (!props.account) return '--'
  if (typeof props.account === 'string') return props.account
  return `${props.account.platform.toUpperCase()} · ${props.account.login} · ${props.account.server}`
})

function display(value: string | number | null | undefined) {
  return value === null || value === undefined || value === '' ? '--' : String(value)
}
</script>

<template>
  <AlertDialog :open="open" @update:open="emit('update:open', $event)">
    <AlertDialogContent class="max-h-[min(90svh,44rem)] overflow-y-auto sm:max-w-xl">
      <AlertDialogHeader>
        <div class="flex items-center gap-2 text-xs font-medium text-destructive">
          <ShieldAlert aria-hidden="true" />交易操作确认
        </div>
        <AlertDialogTitle>{{ title }}</AlertDialogTitle>
        <AlertDialogDescription>
          请核对账户、订单及本次参数，确认后将发送至交易终端。
        </AlertDialogDescription>
      </AlertDialogHeader>

      <div class="grid gap-3 rounded-xl border bg-muted/20 p-4" aria-label="交易操作摘要">
        <div class="grid gap-3 sm:grid-cols-2">
          <div><p class="text-xs text-muted-foreground">执行账户</p><p class="mt-1 break-all font-medium">{{ accountText }}</p></div>
          <div><p class="text-xs text-muted-foreground">指令</p><p class="mt-1 font-medium">{{ commandText }}</p></div>
          <div><p class="text-xs text-muted-foreground">品种</p><p class="mt-1 font-mono tabular-nums">{{ display(symbol) }}</p></div>
          <div><p class="text-xs text-muted-foreground">订单号 / Ticket</p><p class="mt-1 font-mono tabular-nums">{{ display(ticket) }}</p></div>
          <div v-if="volume !== null && volume !== undefined && volume !== ''"><p class="text-xs text-muted-foreground">手数</p><p class="mt-1 font-mono tabular-nums">{{ display(volume) }}</p></div>
          <div v-if="price !== null && price !== undefined && price !== ''"><p class="text-xs text-muted-foreground">价格</p><p class="mt-1 font-mono tabular-nums">{{ display(price) }}</p></div>
          <div><p class="text-xs text-muted-foreground">止损 / SL</p><p class="mt-1 font-mono tabular-nums">{{ display(stopLoss) }}</p></div>
          <div><p class="text-xs text-muted-foreground">止盈 / TP</p><p class="mt-1 font-mono tabular-nums">{{ display(takeProfit) }}</p></div>
        </div>
        <div class="border-t pt-3">
          <p class="text-xs text-muted-foreground">影响范围</p>
          <p class="mt-1 text-sm leading-6">{{ scope || '仅作用于当前账户的这一笔交易资源' }}</p>
        </div>
      </div>

      <Alert :variant="isDestructive ? 'destructive' : 'default'">
        <CircleAlert aria-hidden="true" />
        <AlertTitle>{{ isDestructive ? '这是不可逆或有资金影响的操作' : '请确认交易参数' }}</AlertTitle>
        <AlertDescription>
          {{ detail || '提交后会在当前页面提示受理结果，并以终端成交及持仓更新为准。' }}
          <Badge v-if="isDestructive" variant="destructive" class="ml-1 align-middle">需要确认</Badge>
        </AlertDescription>
      </Alert>

      <Alert v-if="error" variant="destructive" role="alert">
        <CircleAlert aria-hidden="true" />
        <AlertTitle>提交未完成</AlertTitle>
        <AlertDescription>{{ error }}</AlertDescription>
      </Alert>

      <AlertDialogFooter>
        <AlertDialogCancel class="min-h-11" :disabled="submitting">取消</AlertDialogCancel>
        <Button type="button" class="min-h-11" :variant="isDestructive ? 'destructive' : 'default'" :disabled="submitting" :aria-busy="submitting" @click="emit('confirm')">{{ confirmText }}</Button>
      </AlertDialogFooter>
    </AlertDialogContent>
  </AlertDialog>
</template>
