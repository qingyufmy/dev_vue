<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import { LoaderCircle, TriangleAlert } from '@lucide/vue'
import { Button } from '@aurum/ui/button'
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetDescription } from '@aurum/ui/sheet'
import SubscriptionEditorSheet from './SubscriptionEditorSheet.vue'
import { useStrategistWorkspace } from '../composables/use-strategist-workspace'
import type { SubscriptionDraft } from '../model/strategy-presentation'
const props = defineProps<{ open: boolean; accountId: string; subscriptionId: string | null; focus?: 'analysis' | 'trader' }>()
const emit = defineEmits<{ 'update:open': [value: boolean]; saved: [] }>()
const workspace = useStrategistWorkspace({ autoLoad: false }), ready = ref(false)
const selectedId = ref(props.subscriptionId)
const current = computed(() => workspace.subscriptions.value.find(item => item.id === selectedId.value) ?? null)
let generation = 0
const loadError = ref('')
async function load() {
  const version = ++generation; ready.value = false; loadError.value = ''; selectedId.value = props.subscriptionId
  if (!props.open) return
  await Promise.all([workspace.load(), workspace.loadSubscriptions(props.accountId)])
  if (generation !== version) return
  loadError.value = workspace.actionError.value || workspace.error.value
  if (!loadError.value && selectedId.value && !current.value) loadError.value = '这条订阅已不可用，请关闭后重新选择。'
  ready.value = !loadError.value
}
watch(() => [props.open, props.accountId, props.subscriptionId], load, { immediate: true })
onBeforeUnmount(() => { generation++ })
async function save(draft: SubscriptionDraft) {
  if (!ready.value || draft.accountId !== props.accountId || selectedId.value && !current.value) return
  const version = generation, selected = selectedId.value
  if (await workspace.saveSubscription(draft, current.value)) {
    if (version !== generation || selected !== selectedId.value || !props.open) return
    emit('saved'); emit('update:open', false)
  }
}
</script>
<template>
  <SubscriptionEditorSheet v-if="ready" :focus="focus" lock-account :open="open" :account-id="accountId" :accounts="workspace.accounts.value" :strategies="workspace.strategies.value" :subscription="current" :subscriptions="workspace.subscriptions.value.filter(item => item.status !== 'ended')" @select="selectedId = $event" :symbols="workspace.symbols.value" :submitting="workspace.submitting.value" :error="workspace.actionError.value || workspace.error.value" @update:open="emit('update:open', $event)" @submit="save" />
  <Sheet v-else :open="open" @update:open="emit('update:open', $event)">
    <SheetContent class="sm:max-w-2xl">
      <SheetHeader><SheetTitle>{{ focus === 'trader' ? '自动交易设置' : '自动分析设置' }}</SheetTitle><SheetDescription>配置当前账户的策略和接收时段。</SheetDescription></SheetHeader>
      <div v-if="loadError" role="alert" class="grid gap-4 rounded-xl border border-destructive/30 bg-destructive/5 p-5">
        <p class="flex items-center gap-2 text-sm text-destructive"><TriangleAlert class="size-4 shrink-0" />{{ loadError }}</p>
        <Button variant="outline" class="justify-self-start" @click="load">重新读取</Button>
      </div>
      <p v-else role="status" class="flex items-center gap-2 py-6 text-sm text-muted-foreground"><LoaderCircle class="size-4 animate-spin" />正在读取订阅…</p>
    </SheetContent>
  </Sheet>
</template>
