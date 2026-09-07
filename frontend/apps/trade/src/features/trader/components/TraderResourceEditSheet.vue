<script setup lang="ts">
import { activeTerminalDisplayTimezone } from '~/lib/laboratory-display-time'
import { tradingContext } from '~/lib/trading-runtime'
import { terminalInputTime, terminalInputUtc } from '~/lib/terminal-input-time'
import type { OpenPosition, PendingOrder } from '@aurum/contracts'
import { Alert, AlertDescription, AlertTitle } from '@aurum/ui/alert'
import { Button } from '@aurum/ui/button'
import { Checkbox } from '@aurum/ui/checkbox'
import { Field, FieldContent, FieldDescription, FieldError, FieldGroup, FieldLabel } from '@aurum/ui/field'
import { Input } from '@aurum/ui/input'
import { Sheet, SheetContent, SheetDescription, SheetFooter, SheetHeader, SheetTitle } from '@aurum/ui/sheet'
import { CircleAlert, Save, ShieldCheck } from '@lucide/vue'
import { computed, ref, watch } from 'vue'
import { isPosition } from '../model/trader-presentation'
import type { TraderResourceEditDraft as ResourceEditDraft } from '../model/trader-command-drafts'

const props = withDefaults(defineProps<{
  open: boolean
  resource: OpenPosition | PendingOrder | null
  readOnly?: boolean
  submitting?: boolean
}>(), {
  readOnly: false,
  submitting: false,
})

const emit = defineEmits<{
  'update:open': [value: boolean]
  submit: [draft: ResourceEditDraft]
}>()

const price = ref('')
const stopLimitPrice = ref('')
const stopLoss = ref('')
const takeProfit = ref('')
const originalExpiration = ref('')
const expiration = ref('')
const expirationZone = ref(activeTerminalDisplayTimezone())
const expirationAccountId = ref(tradingContext.value?.accountId)
function expirationUtc() {
  const current = activeTerminalDisplayTimezone()
  if (expirationZone.value.isDefault || current.isDefault || current.offsetMinutes !== expirationZone.value.offsetMinutes || expirationAccountId.value !== tradingContext.value?.accountId) return NaN
  return terminalInputUtc(expiration.value, expirationZone.value.offsetMinutes)
}
const removeStopLoss = ref(false)
const removeTakeProfit = ref(false)
const removeExpiration = ref(false)
const error = ref('')

const position = computed(() => props.resource && isPosition(props.resource) ? props.resource : null)
const order = computed(() => props.resource && !isPosition(props.resource) ? props.resource : null)
const title = computed(() => position.value ? '修改持仓保护价' : '修改挂单参数')

function reset() {
  expirationZone.value = activeTerminalDisplayTimezone()
  expirationAccountId.value = tradingContext.value?.accountId
  const resource = props.resource
  price.value = resource && !isPosition(resource) ? resource.price : ''
  stopLimitPrice.value = ''
  stopLoss.value = resource?.stopLoss ?? ''
  takeProfit.value = resource?.takeProfit ?? ''
  expiration.value = resource && !isPosition(resource) && resource.expiresAt ? toLocalDateTime(resource.expiresAt) : ''
  originalExpiration.value = expiration.value
  removeStopLoss.value = false
  removeTakeProfit.value = false
  removeExpiration.value = false
  error.value = ''
}

function toLocalDateTime(value: string) {
  return terminalInputTime(value, expirationZone.value.offsetMinutes)
}

function positive(value: string) {
  return value.trim() !== '' && Number.isFinite(Number(value)) && Number(value) > 0
}

function submit() {
  if (!props.resource || props.readOnly || props.submitting) return
  if (!removeStopLoss.value && stopLoss.value && !positive(stopLoss.value)) return fail('止损价必须大于 0')
  if (!removeTakeProfit.value && takeProfit.value && !positive(takeProfit.value)) return fail('止盈价必须大于 0')
  if (order.value && !positive(price.value)) return fail('挂单价格必须大于 0')
  if (stopLimitPrice.value && !positive(stopLimitPrice.value)) return fail('止损限价必须大于 0')
  if (!removeExpiration.value && expiration.value !== originalExpiration.value && expiration.value && !Number.isFinite(expirationUtc())) return fail('请填写有效的终端时间；账户或时区变化后请重新打开表单，未校准时暂不可设置有效期')

  const draft: ResourceEditDraft = {}
  if (order.value) draft.price = price.value
  if (stopLimitPrice.value) draft.stop_limit_price = stopLimitPrice.value
  if (removeStopLoss.value) draft.remove_stop_loss = true
  else if (stopLoss.value) draft.stop_loss = stopLoss.value
  if (removeTakeProfit.value) draft.remove_take_profit = true
  else if (takeProfit.value) draft.take_profit = takeProfit.value
  if (order.value) {
    if (removeExpiration.value) draft.remove_expiration = true
    else if (expiration.value && expiration.value !== originalExpiration.value) draft.expiration_utc_msc = expirationUtc()
  }
  if (!Object.keys(draft).length) return fail('请至少填写一项需要修改的参数')
  error.value = ''
  emit('submit', draft)
}

function fail(message: string) {
  error.value = message
}

watch(() => props.open, (open) => { if (open) reset() }, { immediate: true })
</script>

<template>
  <Sheet :open="open" @update:open="emit('update:open', $event)">
    <SheetContent side="right" class="w-full gap-0 overflow-hidden p-0 sm:max-w-lg">
      <SheetHeader class="border-b pr-16 text-left">
        <SheetTitle>{{ title }}</SheetTitle>
        <SheetDescription v-if="resource">{{ resource.symbol }} · #{{ resource.ticket }}。保存前会重新读取资源版本并由服务端执行风控。</SheetDescription>
      </SheetHeader>

      <form class="min-h-0 flex-1 overflow-y-auto" @submit.prevent="submit">
        <div class="grid gap-5 p-4 sm:p-6">
          <Alert>
            <ShieldCheck aria-hidden="true" />
            <AlertTitle>只修改终端资源参数</AlertTitle>
            <AlertDescription>页面提交成功仅表示服务器已受理；最终结果请在执行操作中心确认。</AlertDescription>
          </Alert>

          <FieldGroup v-if="resource">
            <Field v-if="order">
              <FieldLabel for="resource-price">挂单价格</FieldLabel>
              <Input id="resource-price" v-model="price" inputmode="decimal" :disabled="readOnly" />
              <FieldDescription>保留当前值即可只修改其他参数。</FieldDescription>
            </Field>

            <Field v-if="order && order.type.endsWith('stop_limit')">
              <FieldLabel for="resource-stop-limit">止损限价</FieldLabel>
              <Input id="resource-stop-limit" v-model="stopLimitPrice" inputmode="decimal" placeholder="仅需修改时填写" :disabled="readOnly" />
            </Field>

            <Field>
              <FieldLabel for="resource-stop-loss">止损价</FieldLabel>
              <Input id="resource-stop-loss" v-model="stopLoss" inputmode="decimal" placeholder="未设置" :disabled="readOnly || removeStopLoss" />
              <Field orientation="horizontal" class="rounded-lg border p-3">
                <Checkbox id="remove-stop-loss" v-model="removeStopLoss" :disabled="readOnly" />
                <FieldContent><FieldLabel for="remove-stop-loss">移除现有止损</FieldLabel><FieldDescription>服务端仍会根据风险规则判断是否允许。</FieldDescription></FieldContent>
              </Field>
            </Field>

            <Field>
              <FieldLabel for="resource-take-profit">止盈价</FieldLabel>
              <Input id="resource-take-profit" v-model="takeProfit" inputmode="decimal" placeholder="未设置" :disabled="readOnly || removeTakeProfit" />
              <Field orientation="horizontal" class="rounded-lg border p-3">
                <Checkbox id="remove-take-profit" v-model="removeTakeProfit" :disabled="readOnly" />
                <FieldContent><FieldLabel for="remove-take-profit">移除现有止盈</FieldLabel><FieldDescription>不勾选则保留或更新止盈价。</FieldDescription></FieldContent>
              </Field>
            </Field>

            <Field v-if="order">
              <FieldLabel for="resource-expiration">到期时间（终端 {{ expirationZone.label }}）</FieldLabel>
              <Input id="resource-expiration" v-model="expiration" type="datetime-local" step="1" :disabled="readOnly || removeExpiration" />
              <Field orientation="horizontal" class="rounded-lg border p-3">
                <Checkbox id="remove-expiration" v-model="removeExpiration" :disabled="readOnly" />
                <FieldContent><FieldLabel for="remove-expiration">移除到期时间</FieldLabel><FieldDescription>不勾选且留空表示不修改有效期。</FieldDescription></FieldContent>
              </Field>
            </Field>

            <FieldError :errors="error ? [error] : []" />
          </FieldGroup>

          <Alert v-if="readOnly" variant="destructive"><CircleAlert aria-hidden="true" /><AlertTitle>当前不可编辑</AlertTitle><AlertDescription>观摩模式或没有交易权限时，交易写操作保持禁用。</AlertDescription></Alert>
        </div>
      </form>

      <SheetFooter class="border-t sm:flex-row sm:justify-end">
        <Button variant="outline" size="lg" :disabled="submitting" @click="emit('update:open', false)">取消</Button>
        <Button size="lg" :disabled="readOnly || !resource || submitting" @click="submit"><Save data-icon="inline-start" />{{ submitting ? '正在提交…' : '确认修改' }}</Button>
      </SheetFooter>
    </SheetContent>
  </Sheet>
</template>
