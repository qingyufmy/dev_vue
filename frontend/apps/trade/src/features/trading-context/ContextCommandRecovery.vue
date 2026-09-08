<script setup lang="ts">
import { ref, watch } from 'vue'
import { Button } from '@aurum/ui/button'
import { useTradeSession } from '~/features/auth'
import { bindContextCommandSession, contextCommandState, recoverContextCommand, retryContextCommand } from './context-command-session'

const { session } = useTradeSession()
const error = ref('')
watch(() => session.value, value => {
  error.value = ''
  try { bindContextCommandSession(value) }
  catch { error.value = '无法清理旧会话的切换请求，请检查浏览器存储' }
}, { immediate: true, flush: 'sync' })

async function confirm(retry = false) {
  if (!session.value || contextCommandState.value.busy) return
  error.value = ''
  try {
    const result = retry ? await retryContextCommand(session.value) : await recoverContextCommand(session.value)
    if (result) window.location.reload()
  } catch { error.value = '结果仍待确认。可以再次查询，或使用原请求重试；请勿重新发起另一笔账户切换。' }
}
</script>

<template>
  <section v-if="contextCommandState.intent || error" class="border-b bg-muted/40 px-4 py-3 text-sm" aria-label="账户切换确认" :aria-busy="contextCommandState.busy">
    <p role="status" aria-live="polite">{{ !contextCommandState.intent ? '账户切换请求暂不可用' : contextCommandState.busy ? '正在确认账户切换结果…' : '上一次账户切换结果待确认。确认成功后将刷新工作区。' }}</p>
    <p v-if="error" role="alert" class="mt-1 text-destructive">{{ error }}</p>
    <div v-if="contextCommandState.intent" class="mt-2 flex flex-wrap gap-2">
      <Button variant="outline" class="min-h-11" :aria-disabled="contextCommandState.busy" @click="confirm()">查询结果</Button>
      <Button variant="outline" class="min-h-11" :aria-disabled="contextCommandState.busy" @click="confirm(true)">使用原请求重试</Button>
    </div>
  </section>
</template>
