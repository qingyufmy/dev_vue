<script setup lang="ts">
import { ShieldAlert } from '@lucide/vue'
import type { ManualReleaseAvailability } from '@aurum/contracts'
import { ref, watch } from 'vue'
import { Alert, AlertDescription, AlertTitle } from '@aurum/ui/alert'
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from '@aurum/ui/alert-dialog'
import { Checkbox } from '@aurum/ui/checkbox'
import { Field, FieldContent, FieldDescription, FieldError, FieldLabel } from '@aurum/ui/field'
import { Input } from '@aurum/ui/input'
import { releaseRuleLabel } from '../model/risk-presentation'

const props = withDefaults(defineProps<{ open: boolean; availability: ManualReleaseAvailability | null; submitting?: boolean; error?: string }>(), { submitting: false, error: '' })
const emit = defineEmits<{ 'update:open': [value: boolean]; submit: [reason: string] }>()
const reason = ref('')
const acknowledged = ref(false)
const localError = ref('')

function submit(event: Event) {
  event.preventDefault()
  if (props.submitting || !props.availability?.available) return
  if (!acknowledged.value) return fail('请确认已理解手动解除的风险')
  if (reason.value.trim().length < 3 || reason.value.trim().length > 500) return fail('解除原因需填写 3 至 500 个字符')
  localError.value = ''
  emit('submit', reason.value.trim())
}

function fail(message: string) { localError.value = message }
watch(() => props.open, (open) => { if (open) { reason.value = ''; acknowledged.value = false; localError.value = '' } })
</script>

<template>
  <AlertDialog :open="open" @update:open="emit('update:open', $event)">
    <AlertDialogContent class="max-w-lg">
      <AlertDialogHeader>
        <AlertDialogTitle>确认手动解除账户限制</AlertDialogTitle>
        <AlertDialogDescription>只解除当前已经触发且平台允许恢复的规则，不会关闭风控，也不会绕过平台硬限制。</AlertDialogDescription>
      </AlertDialogHeader>

      <div class="grid gap-4 py-1">
        <Alert variant="destructive">
          <ShieldAlert aria-hidden="true" />
          <AlertTitle>风险继续恶化会自动失效</AlertTitle>
          <AlertDescription>解除记录按交易日和当前风险基线生效。亏损、回撤或连续亏损进一步增加时，服务端会再次限制交易。</AlertDescription>
        </Alert>
        <div v-if="availability?.available" class="rounded-xl border p-4">
          <p class="text-sm font-medium">本次可解除</p>
          <ul class="mt-2 grid gap-1 text-sm text-muted-foreground"><li v-for="rule in availability.rules" :key="rule">· {{ releaseRuleLabel(rule) }}</li></ul>
        </div>
        <Field :data-invalid="Boolean(localError || error)">
          <FieldLabel for="manual-release-reason">解除原因</FieldLabel>
          <Input id="manual-release-reason" v-model="reason" maxlength="500" placeholder="例如：已人工复核账户和行情，确认临时恢复" :aria-invalid="Boolean(localError || error)" />
          <FieldError :errors="localError || error ? [localError || error] : []" />
        </Field>
        <Field orientation="horizontal" class="rounded-xl border p-4">
          <Checkbox id="manual-release-ack" v-model="acknowledged" />
          <FieldContent><FieldLabel for="manual-release-ack">我已核对当前账户风险并承担继续交易的风险</FieldLabel><FieldDescription>此确认会与解除原因一起写入审计记录。</FieldDescription></FieldContent>
        </Field>
      </div>

      <AlertDialogFooter>
        <AlertDialogCancel class="min-h-11" :disabled="submitting">取消</AlertDialogCancel>
        <AlertDialogAction :disabled="submitting || !availability?.available" class="min-h-11 bg-destructive text-destructive-foreground hover:bg-destructive/90" @click="submit">{{ submitting ? '正在提交…' : '确认解除限制' }}</AlertDialogAction>
      </AlertDialogFooter>
    </AlertDialogContent>
  </AlertDialog>
</template>
