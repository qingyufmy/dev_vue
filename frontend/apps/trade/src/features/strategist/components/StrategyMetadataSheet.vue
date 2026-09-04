<script setup lang="ts">
import { Save } from '@lucide/vue'
import type { StrategySummary } from '@aurum/contracts'
import { ref, watch } from 'vue'
import { Button } from '@aurum/ui/button'
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel } from '@aurum/ui/field'
import { Input } from '@aurum/ui/input'
import { Sheet, SheetContent, SheetDescription, SheetFooter, SheetHeader, SheetTitle } from '@aurum/ui/sheet'
import { Textarea } from '@aurum/ui/textarea'

const props = withDefaults(defineProps<{ open: boolean; strategy: StrategySummary | null; submitting?: boolean; error?: string }>(), { submitting: false, error: '' })
const emit = defineEmits<{ 'update:open': [value: boolean]; submit: [value: { name: string; description: string }] }>()
const name = ref('')
const description = ref('')
const localError = ref('')

function reset() { name.value = props.strategy?.name ?? ''; description.value = props.strategy?.description ?? ''; localError.value = '' }
function submit() {
  if (name.value.trim().length < 2 || name.value.trim().length > 191) { localError.value = '策略名称需填写 2 至 191 个字符'; return }
  if (description.value.trim().length > 2000) { localError.value = '策略说明不能超过 2000 个字符'; return }
  localError.value = ''
  emit('submit', { name: name.value.trim(), description: description.value.trim() })
}
watch(() => props.open, (open) => { if (open) reset() }, { immediate: true })
</script>

<template>
  <Sheet :open="open" @update:open="emit('update:open', $event)">
    <SheetContent side="right" class="w-full sm:max-w-xl">
      <SheetHeader><SheetTitle>编辑策略资料</SheetTitle><SheetDescription>这里只修改名称和说明，不会改动任何提示词版本。</SheetDescription></SheetHeader>
      <FieldGroup class="py-4">
        <Field :data-invalid="Boolean(localError || error)"><FieldLabel for="meta-name">策略名称</FieldLabel><Input id="meta-name" v-model="name" maxlength="191" /><FieldDescription>在策略库和订阅选择器中显示。</FieldDescription></Field>
        <Field :data-invalid="Boolean(localError || error)"><FieldLabel for="meta-description">策略说明</FieldLabel><Textarea id="meta-description" v-model="description" class="min-h-36 resize-y" maxlength="2000" /><FieldError :errors="localError || error ? [localError || error] : []" /></Field>
      </FieldGroup>
      <SheetFooter><Button variant="outline" size="lg" :disabled="submitting" @click="emit('update:open', false)">取消</Button><Button size="lg" :disabled="submitting" @click="submit"><Save />{{ submitting ? '正在保存…' : '保存资料' }}</Button></SheetFooter>
    </SheetContent>
  </Sheet>
</template>
