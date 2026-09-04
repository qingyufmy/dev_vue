<script setup lang="ts">
import { AlertCircle, FilePenLine } from '@lucide/vue'
import { Alert, AlertDescription, AlertTitle } from '@aurum/ui/alert'
import { Button } from '@aurum/ui/button'
import { Field, FieldDescription, FieldGroup, FieldLabel } from '@aurum/ui/field'
import { Sheet, SheetContent, SheetDescription, SheetFooter, SheetHeader, SheetTitle } from '@aurum/ui/sheet'
import { Textarea } from '@aurum/ui/textarea'
import { ref, watch } from 'vue'
import type { ReviewCaseDetail } from '../model/reviewer-presentation'

const props = defineProps<{
  open: boolean
  detail: ReviewCaseDetail | null
  submitting?: boolean
  error?: string
}>()

const emit = defineEmits<{
  'update:open': [value: boolean]
  submit: [content: string, changeNote: string]
}>()

const content = ref('')
const changeNote = ref('')

watch(() => props.open, (open) => {
  if (!open) return
  content.value = props.detail?.fullText ?? props.detail?.conclusion ?? ''
  changeNote.value = ''
})

function submit() {
  const value = content.value.trim()
  if (!value || props.submitting) return
  emit('submit', value, changeNote.value.trim())
}
</script>

<template>
  <Sheet :open="open" @update:open="emit('update:open', $event)">
    <SheetContent class="w-full gap-0 p-0 sm:max-w-xl" side="right">
      <SheetHeader class="border-b pr-16 text-left"><div class="flex items-center gap-2 text-xs font-medium text-primary"><FilePenLine aria-hidden="true" />人工修订</div><SheetTitle>保存复盘新版本</SheetTitle><SheetDescription>只创建新的复盘版本，不会覆盖当前版本，也不会自动修改策略或风控。</SheetDescription></SheetHeader>
      <form class="grid flex-1 content-start gap-5 overflow-y-auto p-4 sm:p-6" @submit.prevent="submit">
        <Alert v-if="error" variant="destructive"><AlertCircle aria-hidden="true" /><AlertTitle>保存失败</AlertTitle><AlertDescription>{{ error }}</AlertDescription></Alert>
        <FieldGroup>
          <Field>
            <FieldLabel for="review-version-content">复盘正文</FieldLabel>
            <Textarea id="review-version-content" v-model="content" rows="12" maxlength="50000" placeholder="填写需要保留的复盘正文" />
            <FieldDescription>正文会作为新版本保存，原始 AI 正文与证据链仍保持可追溯。</FieldDescription>
          </Field>
          <Field>
            <FieldLabel for="review-version-note">修订说明（可选）</FieldLabel>
            <Textarea id="review-version-note" v-model="changeNote" rows="3" maxlength="500" placeholder="例如：补充了终端执行层的证据说明" />
          </Field>
        </FieldGroup>
      </form>
      <SheetFooter class="border-t"><Button type="button" variant="outline" class="min-h-11" :disabled="submitting" @click="emit('update:open', false)">取消</Button><Button type="button" class="min-h-11" :disabled="submitting || !content.trim()" @click="submit">{{ submitting ? '正在保存…' : '保存新版本' }}</Button></SheetFooter>
    </SheetContent>
  </Sheet>
</template>
