<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { Bot } from '@lucide/vue'
import type { StrategySubscription } from '@aurum/contracts'
import { Switch } from '@aurum/ui/switch'
import { Button } from '@aurum/ui/button'
import { useTradeSession } from '~/features/auth'
import { currentAccount } from '~/features/trading-context'
import { strategistApi } from '../api/strategist-api'
const props = defineProps<{ items: StrategySubscription[]; loading: boolean; readonly: boolean }>()
const emit = defineEmits<{ configure: []; saved: [] }>()
const { session } = useTradeSession()
const busy = ref(false), error = ref('')
const scope = computed(() => `${session.value?.user.id}:${session.value?.authenticated_at}:${currentAccount.value?.id}`)
const enabled = computed(() => props.items.some(item => item.status === 'active' && item.traderEnabled))
const pending = ref<{ account: string; enabled: boolean; expected: { id: string; revision: number }[]; key: string } | null>(null)
watch(scope, () => { pending.value = null; error.value = ''; busy.value = false })
async function toggle(value: boolean) {
  if (props.readonly || props.loading || busy.value || pending.value) return
  if (value && !props.items.some(item => item.status === 'active' && item.analysisEnabled && item.traderStrategyId)) {
    emit('configure'); return
  }
  if (!currentAccount.value) return
  pending.value = { account: currentAccount.value.id, enabled: value, expected: props.items.map(item => ({ id: item.id, revision: Number(item.revision) })), key: crypto.randomUUID() }
  await save()
}
async function save() {
  const command = pending.value, captured = scope.value
  if (!command || !session.value || busy.value || props.readonly) return
  busy.value = true; error.value = ''
  try {
    await strategistApi.setAccountTrader(session.value.csrf_token, command.account, command.enabled, command.expected, command.key)
    if (captured !== scope.value) return
    pending.value = null; emit('saved')
  } catch (cause) {
    if (captured !== scope.value) return
    const status = (cause as { status?: number }).status
    if (status && status >= 400 && status < 500) {
      pending.value = null; emit('saved')
      error.value = '订阅设置已变化或暂不可用，请核对后重试。'
    } else error.value = '保存结果待确认，请点击核对状态。'
  } finally { if (captured === scope.value) busy.value = false }
}
</script>
<template>
  <div class="flex h-11 items-center gap-2.5 whitespace-nowrap rounded-lg border border-border/70 bg-card/60 px-3" title="控制当前账户的 AI 自动评估与交易；不影响手动操作">
    <Bot class="size-4 shrink-0 text-primary" aria-hidden="true" />
    <label for="runtime-ai-trader" class="text-xs font-medium" :class="readonly ? 'cursor-not-allowed' : 'cursor-pointer'">自动交易</label>
    <Switch id="runtime-ai-trader" aria-label="自动交易" :aria-busy="busy" :model-value="enabled" :disabled="readonly || loading || busy || !!pending"
      :class="readonly ? 'cursor-not-allowed' : 'cursor-pointer data-disabled:cursor-pointer'" @update:model-value="toggle" />
  </div>
  <span v-if="error" role="alert" class="text-xs text-destructive">{{ error }}<Button v-if="pending" variant="link" size="sm" :disabled="busy" @click="save">核对状态</Button></span>
</template>
