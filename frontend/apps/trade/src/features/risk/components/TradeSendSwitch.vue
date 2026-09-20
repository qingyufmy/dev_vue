<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import type { RiskPolicy } from '@aurum/contracts'
import { Switch } from '@aurum/ui/switch'
import { Button } from '@aurum/ui/button'
import { useTradeSession } from '~/features/auth'
import { currentAccount, tradingContext } from '~/features/trading-context'
import { riskApi } from '../api/risk-api'
import { usePolicyWriteRecovery } from '../composables/use-policy-write-recovery'
const { session } = useTradeSession()
const policy = ref<RiskPolicy | null>(null), loading = ref(false), error = ref('')
const scope = computed(() => `${session.value?.user.id}:${session.value?.authenticated_at}:${currentAccount.value?.id}:${tradingContext.value?.mode}`)
const readonly = computed(() => tradingContext.value?.mode !== 'full' || !policy.value?.editableFields.includes('trade_send_enabled'))
let generation = 0, request = 0
async function load() {
  const account = currentAccount.value?.id, captured = scope.value, version = ++request
  if (!account || !session.value || tradingContext.value?.mode !== 'full') return
  loading.value = true
  try {
    const result = await riskApi.getPolicy(account)
    if (scope.value === captured && request === version) { policy.value = result.data; error.value = '' }
  } catch { if (scope.value === captured && request === version) error.value = '交易发送许可读取失败' }
  finally { if (scope.value === captured && request === version) loading.value = false }
}
const recovery = usePolicyWriteRecovery(() => session.value && currentAccount.value && policy.value
  ? { userId: String(session.value.user.id), accountId: currentAccount.value.id, csrfToken: session.value.csrf_token, revision: policy.value.revision, readOnly: readonly.value, generation } : null, load)
const disabled = computed(() => readonly.value || loading.value || recovery.busy.value || !!error.value || !!recovery.pending.value)
const cursorClass = computed(() => readonly.value ? 'cursor-not-allowed' : 'cursor-pointer data-disabled:cursor-pointer disabled:cursor-pointer')
async function toggle(enabled: boolean) {
  if (readonly.value || loading.value || recovery.busy.value) return
  await recovery.run('create', { trade_send_enabled: enabled, reason: enabled ? '顶栏开启交易指令发送' : '顶栏关闭交易指令发送' })
}
watch(scope, () => { generation++; request++; policy.value = null; error.value = ''; loading.value = false; void load() }, { immediate: true })
const timer = setInterval(() => { if (!recovery.busy.value) void load() }, 30000)
onBeforeUnmount(() => { generation++; request++; clearInterval(timer) })
</script>
<template>
  <div class="flex h-11 items-center gap-2.5 whitespace-nowrap rounded-lg border border-border/70 bg-card/60 px-3" title="控制当前账户是否允许发送交易指令；不修改策略订阅">
    <label for="runtime-trade-send" class="text-xs font-medium" :class="cursorClass">交易发送</label>
    <Switch :class="cursorClass" id="runtime-trade-send" aria-label="允许发送交易指令" :model-value="policy?.tradeSendEnabled ?? false" :disabled="disabled" @update:model-value="toggle" />
  </div>
  <span v-if="error || recovery.error.value || recovery.pending.value" role="alert" class="text-xs text-destructive">
    {{ error || recovery.error.value || '发送许可保存结果待确认' }}
    <Button variant="link" size="sm" @click="recovery.pending.value ? recovery.run('query') : load()">核对状态</Button>
  </span>
</template>
