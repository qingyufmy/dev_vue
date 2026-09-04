<script setup lang="ts">
import { Save, ShieldAlert } from '@lucide/vue'
import type { RiskPolicy } from '@aurum/contracts'
import { computed, reactive, ref, watch } from 'vue'
import { Alert, AlertDescription, AlertTitle } from '@aurum/ui/alert'
import { Button } from '@aurum/ui/button'
import { Field, FieldContent, FieldDescription, FieldError, FieldGroup, FieldLabel } from '@aurum/ui/field'
import { Input } from '@aurum/ui/input'
import { Separator } from '@aurum/ui/separator'
import { Sheet, SheetContent, SheetDescription, SheetFooter, SheetHeader, SheetTitle } from '@aurum/ui/sheet'
import { Switch } from '@aurum/ui/switch'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@aurum/ui/tabs'
import { policyFields, type NumericPolicyKey } from '../model/risk-presentation'

const props = withDefaults(defineProps<{ open: boolean; policy: RiskPolicy | null; submitting?: boolean; error?: string }>(), { submitting: false, error: '' })
const emit = defineEmits<{
  'update:open': [value: boolean]
  submit: [value: { patch: Partial<Record<NumericPolicyKey, string>> & { tradeSendEnabled?: boolean; accountKillSwitch?: boolean }; reason: string }]
}>()

const values = reactive<Record<NumericPolicyKey, string>>(Object.fromEntries(policyFields.map((field) => [field.key, ''])) as Record<NumericPolicyKey, string>)
const tradeSendEnabled = ref(false)
const accountKillSwitch = ref(false)
const reason = ref('')
const localError = ref('')
const groups = [
  { id: 'loss', label: '亏损与回撤' },
  { id: 'exposure', label: '仓位敞口' },
  { id: 'frequency', label: '频率与冷静期' },
  { id: 'market', label: '行情条件' },
  { id: 'orders', label: '挂单保护' },
] as const
const editableFields = computed(() => new Set(props.policy?.editableFields ?? []))

function reset() {
  const policy = props.policy
  if (!policy) return
  const editable: Pick<RiskPolicy, NumericPolicyKey> = policy
  for (const field of policyFields) values[field.key] = String(editable[field.key])
  tradeSendEnabled.value = policy.tradeSendEnabled
  accountKillSwitch.value = policy.accountKillSwitch
  reason.value = ''
  localError.value = ''
}

function submit() {
  const policy = props.policy
  if (!policy || props.submitting) return
  const editables = editableFields.value
  const patch: Partial<Record<NumericPolicyKey, string>> & { tradeSendEnabled?: boolean; accountKillSwitch?: boolean } = {}
  const original: Pick<RiskPolicy, NumericPolicyKey> = policy
  for (const field of policyFields) {
    if (!editables.has(field.wire) || values[field.key] === String(original[field.key])) continue
    if (!values[field.key].trim() || !Number.isFinite(Number(values[field.key])) || Number(values[field.key]) < 0) return fail(`${field.label}必须是有效的非负数`)
    patch[field.key] = values[field.key]
  }
  if (editables.has('trade_send_enabled') && tradeSendEnabled.value !== policy.tradeSendEnabled) patch.tradeSendEnabled = tradeSendEnabled.value
  if (editables.has('account_kill_switch') && accountKillSwitch.value !== policy.accountKillSwitch) patch.accountKillSwitch = accountKillSwitch.value
  if (!Object.keys(patch).length) return fail('请至少修改一项账户风控规则')
  if (reason.value.trim().length < 3 || reason.value.trim().length > 500) return fail('修改原因需填写 3 至 500 个字符')
  localError.value = ''
  emit('submit', { patch, reason: reason.value.trim() })
}

function fail(message: string) { localError.value = message }
watch(() => props.open, (open) => { if (open) reset() }, { immediate: true })
</script>

<template>
  <Sheet :open="open" @update:open="emit('update:open', $event)">
    <SheetContent side="right" class="w-full gap-0 overflow-hidden p-0 sm:max-w-2xl">
      <SheetHeader class="border-b pr-16 text-left">
        <SheetTitle>编辑账户风控规则</SheetTitle>
        <SheetDescription>规则仅作用于当前交易账户。平台边界不会显示为可编辑项，也不能通过本页面放宽。</SheetDescription>
      </SheetHeader>

      <form class="min-h-0 flex-1 overflow-y-auto" @submit.prevent="submit">
        <div class="grid gap-5 p-4 sm:p-6">
          <Alert>
            <ShieldAlert aria-hidden="true" />
            <AlertTitle>保存后立即参与新的风控评审</AlertTitle>
            <AlertDescription>已在途或已执行的交易不会被本次修改回滚。若需要暂停新交易，请使用下方账户暂停开关。</AlertDescription>
          </Alert>

          <div class="grid gap-3 sm:grid-cols-2">
            <Field orientation="horizontal" class="rounded-xl border p-4">
              <FieldContent><FieldLabel for="trade-send">交易发送</FieldLabel><FieldDescription>关闭后仍可查看与管理已有交易，但不会发送新的开仓动作。</FieldDescription></FieldContent>
              <Switch id="trade-send" v-model="tradeSendEnabled" :disabled="!editableFields.has('trade_send_enabled')" />
            </Field>
            <Field orientation="horizontal" class="rounded-xl border border-destructive/30 p-4">
              <FieldContent><FieldLabel for="account-kill-switch">账户暂停</FieldLabel><FieldDescription>立即阻止新的开仓动作；已有仓位的保护性操作仍由服务端判断。</FieldDescription></FieldContent>
              <Switch id="account-kill-switch" v-model="accountKillSwitch" :disabled="!editableFields.has('account_kill_switch')" />
            </Field>
          </div>

          <Tabs default-value="loss" class="min-w-0">
            <TabsList class="h-auto w-full justify-start overflow-x-auto p-1">
              <TabsTrigger v-for="group in groups" :key="group.id" :value="group.id" class="min-h-11 shrink-0">{{ group.label }}</TabsTrigger>
            </TabsList>
            <TabsContent v-for="group in groups" :key="group.id" :value="group.id" class="mt-4">
              <FieldGroup class="grid gap-4 sm:grid-cols-2">
                <Field v-for="field in policyFields.filter((item) => item.group === group.id)" :key="field.key">
                  <FieldLabel :for="`risk-${field.key}`">{{ field.label }}</FieldLabel>
                  <div class="relative">
                    <Input :id="`risk-${field.key}`" v-model="values[field.key]" type="number" inputmode="decimal" min="0" :step="field.step" :disabled="!editableFields.has(field.wire)" class="pr-16" />
                    <span class="pointer-events-none absolute inset-y-0 right-3 flex items-center text-xs text-muted-foreground">{{ field.suffix }}</span>
                  </div>
                  <FieldDescription>{{ editableFields.has(field.wire) ? field.description : '此项由平台统一管理。' }}</FieldDescription>
                </Field>
              </FieldGroup>
            </TabsContent>
          </Tabs>

          <Separator />
          <Field :data-invalid="Boolean(localError || error)">
            <FieldLabel for="risk-change-reason">修改原因</FieldLabel>
            <Input id="risk-change-reason" v-model="reason" maxlength="500" placeholder="例如：降低单笔风险并收紧每日亏损上限" :aria-invalid="Boolean(localError || error)" />
            <FieldDescription>原因会进入系统审计，便于复核规则变更。</FieldDescription>
            <FieldError :errors="localError || error ? [localError || error] : []" />
          </Field>
        </div>
      </form>

      <SheetFooter class="border-t sm:flex-row sm:justify-end">
        <Button variant="outline" size="lg" :disabled="submitting" @click="emit('update:open', false)">取消</Button>
        <Button size="lg" :disabled="!policy || submitting" @click="submit"><Save />{{ submitting ? '正在保存…' : '保存规则' }}</Button>
      </SheetFooter>
    </SheetContent>
  </Sheet>
</template>
