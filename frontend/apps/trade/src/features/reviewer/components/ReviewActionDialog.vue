<script setup lang="ts">
import { AlertTriangle, CheckCircle2 } from '@lucide/vue'
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from '@aurum/ui/alert-dialog'
import { Field, FieldDescription, FieldLabel } from '@aurum/ui/field'
import { Textarea } from '@aurum/ui/textarea'
import { ref, watch } from 'vue'

const props = defineProps<{
  open: boolean
  mode: 'confirm' | 'return'
  submitting?: boolean
  title?: string
}>()

const emit = defineEmits<{ 'update:open': [value: boolean]; submit: [reason: string] }>()
const reason = ref('')

watch(() => props.open, (open) => { if (open) reason.value = '' })

function submit() {
  if (props.submitting || (props.mode === 'return' && reason.value.trim().length < 3)) return
  emit('submit', reason.value.trim())
}
</script>

<template>
  <AlertDialog :open="open" @update:open="emit('update:open', $event)">
    <AlertDialogContent class="max-w-lg">
      <AlertDialogHeader>
        <AlertDialogTitle>{{ title || (mode === 'confirm' ? '确认这份复盘？' : '退回这份复盘？') }}</AlertDialogTitle>
        <AlertDialogDescription>{{ mode === 'confirm' ? '确认当前版本后，结构化结果和证据链会进入已确认状态；记忆候选仍需单独处理。' : '退回后会保留当前版本和证据链，系统不会把它当作已确认经验。' }}</AlertDialogDescription>
      </AlertDialogHeader>
      <div class="grid gap-4">
        <div class="flex items-start gap-3 rounded-lg border bg-muted/20 p-4 text-sm leading-6"><CheckCircle2 v-if="mode === 'confirm'" class="mt-0.5 shrink-0 text-system-ok" aria-hidden="true" /><AlertTriangle v-else class="mt-0.5 shrink-0 text-system-warn" aria-hidden="true" /><p>{{ mode === 'confirm' ? '确认动作会记录当前账号、版本和证据修订号，方便之后追溯。' : '请说明需要补充或修改的原因，原有内容不会被覆盖。' }}</p></div>
        <Field v-if="mode === 'return'">
          <FieldLabel for="review-return-reason">退回原因</FieldLabel>
          <Textarea id="review-return-reason" v-model="reason" rows="3" maxlength="500" placeholder="例如：终端执行证据尚不完整，需要重新核对" />
          <FieldDescription>至少填写 3 个字符。</FieldDescription>
        </Field>
      </div>
      <AlertDialogFooter><AlertDialogCancel class="min-h-11" :disabled="submitting">取消</AlertDialogCancel><AlertDialogAction class="min-h-11" :destructive="mode === 'return'" :disabled="submitting || mode === 'return' && reason.trim().length < 3" @click="submit">{{ submitting ? '正在提交…' : mode === 'confirm' ? '确认复盘' : '确认退回' }}</AlertDialogAction></AlertDialogFooter>
    </AlertDialogContent>
  </AlertDialog>
</template>
