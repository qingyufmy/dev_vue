<script setup lang="ts">
import { computed } from 'vue'
import { RouterLink } from 'vue-router'
import { Cable, RefreshCw, ShieldCheck } from '@lucide/vue'
import { Badge } from '@aurum/ui/badge'
import { currentAccount, realtimeState, tradingContext } from '~/features/trading-context'

const bridgeLabel = computed(() => currentAccount.value ? {
  online: '智桥已连接', offline: '智桥未连接', paused: '智桥已暂停', replaced: '连接已替换', unauthorized: '智桥未获授权',
}[currentAccount.value.bridgeState] : '智桥状态待确认')
const realtimeLabel = computed(() => ({ idle: '等待数据', connecting: '正在连接', live: '数据实时同步', recovering: '正在恢复同步', offline: '实时连接已断开' }[realtimeState.value]))
const permissionLabel = computed(() => tradingContext.value?.mode === 'observer' ? '仅供观摩'
  : !currentAccount.value ? '权限待确认' : currentAccount.value.tradePermission ? '账户允许交易' : '账户只读')
</script>

<template>
  <div class="flex flex-wrap items-center gap-2 border-b bg-background px-3 py-2 text-xs sm:px-5" aria-label="运行状态">
    <RouterLink to="/bridge" class="flex min-h-11 items-center rounded-md focus-visible:outline-2 focus-visible:outline-ring" aria-label="查看量见智桥连接状态">
      <Badge variant="outline"><Cable aria-hidden="true" />{{ bridgeLabel }}</Badge>
    </RouterLink>
    <Badge variant="outline"><RefreshCw aria-hidden="true" />{{ realtimeLabel }}</Badge>
    <Badge variant="secondary"><ShieldCheck aria-hidden="true" />{{ permissionLabel }}</Badge>
  </div>
</template>
