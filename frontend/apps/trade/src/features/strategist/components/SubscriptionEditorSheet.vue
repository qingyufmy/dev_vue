<script setup lang="ts">
import SubscriptionTraderFields from './SubscriptionTraderFields.vue'
import SubscriptionTimeEditor from './SubscriptionTimeEditor.vue'
import { subscriptionTimeWindowSchema } from '@aurum/contracts'
import { Save, Timer, TriangleAlert } from '@lucide/vue'
import type { StrategySummary, TradingAccount } from '@aurum/contracts'
import { computed, reactive, ref, toRaw, watch } from 'vue'
import { Alert, AlertDescription, AlertTitle } from '@aurum/ui/alert'
import { Button } from '@aurum/ui/button'
import { Field, FieldContent, FieldDescription, FieldGroup, FieldLabel } from '@aurum/ui/field'
import { Input } from '@aurum/ui/input'
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from '@aurum/ui/select'
import { Separator } from '@aurum/ui/separator'
import { Sheet, SheetContent, SheetDescription, SheetFooter, SheetHeader, SheetTitle } from '@aurum/ui/sheet'
import { Switch } from '@aurum/ui/switch'
import type { StrategySubscriptionView, SubscriptionDraft } from '../model/strategy-presentation'

const props = withDefaults(defineProps<{
  open: boolean
  accountId: string
  accounts: TradingAccount[]
  strategies: StrategySummary[]
  subscription?: StrategySubscriptionView | null
  subscriptions?: StrategySubscriptionView[]
  symbols?: string[]
  submitting?: boolean
  error?: string
  lockAccount?: boolean
  focus?: 'analysis' | 'trader'
}>(), { subscription: null, symbols: () => [], subscriptions: () => [], submitting: false, error: '' })

const emit = defineEmits<{ 'update:open': [value: boolean]; submit: [draft: SubscriptionDraft]; select: [id: string] }>()
const form = reactive<SubscriptionDraft>({ accountId: '', symbol: '', analysisStrategyId: '', traderStrategyId: null, analysisEnabled: true, traderEnabled: false, tradeSendEnabled: false, status: 'active', receiveWindow: { enabled: false } })
const localError = ref('')
const editing = computed(() => Boolean(props.subscription))
const analysisStrategies = computed(() => props.strategies.filter((item) => item.kind === 'analysis' && ((item.status === 'active' && item.activeVersionId) || item.id === props.subscription?.analysisStrategyId)))
const traderStrategies = computed(() => props.strategies.filter((item) => item.kind === 'trader' && ((item.status === 'active' && item.activeVersionId) || item.id === props.subscription?.traderStrategyId)))

function reset() {
  const value = props.subscription
  form.accountId = value?.accountId ?? props.accountId
  form.symbol = value?.symbol ?? props.symbols[0] ?? 'XAUUSD'
  form.analysisStrategyId = value?.analysisStrategyId ?? analysisStrategies.value[0]?.id ?? ''
  form.traderStrategyId = value?.traderStrategyId ?? traderStrategies.value[0]?.id ?? null
  form.analysisEnabled = value ? value.analysisEnabled && value.status === 'active' : true
  form.traderEnabled = value?.traderEnabled ?? false
  form.tradeSendEnabled = value?.tradeSendEnabled ?? false
  form.status = value?.status === 'paused' ? 'paused' : 'active'
  form.receiveWindow = structuredClone(toRaw(value?.receiveWindow ?? { enabled: false }))
  localError.value = ''
}

function setValue(key: 'accountId' | 'analysisStrategyId' | 'traderStrategyId' | 'status', value: unknown) {
  const next = String(value)
  if (key === 'status' && (next === 'active' || next === 'paused')) form.status = next
  else if (key === 'traderStrategyId') form.traderStrategyId = next || null
  else if (key === 'accountId') form.accountId = next
  else if (key === 'analysisStrategyId') form.analysisStrategyId = next
}

function submit() {
  if (props.submitting) return
  if (!subscriptionTimeWindowSchema.safeParse(form.receiveWindow).success) return fail('请选择接收日期，并填写完整的时间段')
  if (!form.accountId) return fail('请选择需要订阅的交易账户')
  if (!/^[A-Za-z0-9._-]{1,64}$/.test(form.symbol.trim())) return fail('交易品种格式不正确')
  if (!form.analysisStrategyId) return fail('请选择行情分析策略')
  if (form.traderEnabled && !form.traderStrategyId) return fail('启用 AI 交易员后必须选择交易执行策略')
  if (form.tradeSendEnabled && !form.traderEnabled) return fail('允许发送交易前必须启用 AI 交易员')
  localError.value = ''
  emit('submit', { ...form, status: form.analysisEnabled ? 'active' : 'paused', symbol: form.symbol.trim().toUpperCase() })
}
function fail(message: string) { localError.value = message }

watch(() => props.open, (open) => { if (open) reset() }, { immediate: true })
watch(() => [props.accountId, props.subscription?.id], () => { if (props.open) reset() })
watch(() => form.traderEnabled, (enabled) => { if (!enabled) form.tradeSendEnabled = false })
</script>

<template>
  <Sheet :open="open" @update:open="emit('update:open', $event)">
    <SheetContent side="right" class="gap-0 overflow-hidden p-0 data-[side=right]:w-full data-[side=right]:sm:max-w-2xl">
      <SheetHeader class="border-b pr-16 text-left">
        <SheetTitle>{{ focus === 'trader' ? '自动交易设置' : focus === 'analysis' ? '自动分析设置' : editing ? '编辑账户订阅' : '新增账户订阅' }}</SheetTitle>
        <SheetDescription>{{ focus === 'trader' ? '选择交易策略，配置自动评估与指令发送。' : '选择分析策略，设置接收分析的时间。' }}</SheetDescription>
      </SheetHeader>
      <form class="min-h-0 flex-1 overflow-y-auto" @submit.prevent="submit">
        <div class="grid gap-6 p-4 sm:p-6">
          <Alert v-if="focus !== 'trader'"><Timer aria-hidden="true" /><AlertTitle>自动分析按策略运行间隔调度</AlertTitle><AlertDescription>可选择策略与接收时段；时间限制对当前账户订阅生效。</AlertDescription></Alert>

          <Field v-if="subscriptions.length > 1">
            <FieldLabel for="subscription-choice">当前订阅</FieldLabel>
            <Select :model-value="subscription?.id" :disabled="submitting" @update:model-value="emit('select', String($event))">
              <SelectTrigger id="subscription-choice"><SelectValue placeholder="选择订阅" /></SelectTrigger>
              <SelectContent><SelectGroup><SelectItem v-for="item in subscriptions" :key="item.id" :value="item.id">{{ item.symbol }} · {{ strategies.find(strategy => strategy.id === item.analysisStrategyId)?.name ?? '历史策略' }}</SelectItem></SelectGroup></SelectContent>
            </Select>
          </Field>
          <FieldGroup class="grid gap-4 sm:grid-cols-2">
            <Field>
              <FieldLabel for="subscription-account">交易账户</FieldLabel>
              <Select :model-value="form.accountId" :disabled="editing || lockAccount" @update:model-value="setValue('accountId', $event)">
                <SelectTrigger id="subscription-account"><SelectValue placeholder="选择交易账户" /></SelectTrigger>
                <SelectContent><SelectGroup><SelectItem v-for="account in accounts" :key="account.id" :value="account.id">{{ account.platform.toUpperCase() }} · {{ account.login }} · {{ account.server }}</SelectItem></SelectGroup></SelectContent>
              </Select>
            </Field>
            <Field>
              <FieldLabel for="subscription-symbol">交易品种</FieldLabel>
              <Input id="subscription-symbol" v-model.trim="form.symbol" list="subscription-symbols" maxlength="64" :disabled="editing" placeholder="XAUUSD" />
              <datalist id="subscription-symbols"><option v-for="symbol in symbols" :key="symbol" :value="symbol" /></datalist>
              <FieldDescription>使用标准品种名，例如 XAUUSD；券商后缀由量见智桥自动识别。</FieldDescription>
            </Field>
          </FieldGroup>

          <SubscriptionTraderFields v-if="focus === 'trader'" v-model:enabled="form.traderEnabled" v-model:send="form.tradeSendEnabled" v-model:strategy="form.traderStrategyId" :strategies="traderStrategies" />
          <details :open="focus !== 'trader' || !editing || !form.analysisEnabled" class="rounded-xl border p-4">
            <summary class="cursor-pointer text-sm font-medium">{{ focus === 'trader' ? '关联的自动分析' : '分析与接收设置' }}<span class="ml-2 text-xs text-muted-foreground">{{ analysisStrategies.find(item => item.id === form.analysisStrategyId)?.name ?? '待选择策略' }}</span></summary>
            <div class="mt-4 grid gap-4">
          <Field>
            <FieldLabel for="analysis-strategy">行情分析策略</FieldLabel>
            <Select :model-value="form.analysisStrategyId" @update:model-value="setValue('analysisStrategyId', $event)">
              <SelectTrigger id="analysis-strategy"><SelectValue placeholder="选择已发布的分析策略" /></SelectTrigger>
              <SelectContent><SelectGroup><SelectItem v-for="strategy in analysisStrategies" :key="strategy.id" :value="strategy.id" :disabled="strategy.status !== 'active' || !strategy.activeVersionId">{{ strategy.name }}{{ strategy.status !== 'active' || !strategy.activeVersionId ? '（暂不可用）' : '' }} · {{ strategy.scope === 'platform' ? '平台' : '个人' }}</SelectItem></SelectGroup></SelectContent>
            </Select>
          </Field>

          <SubscriptionTimeEditor v-if="form.receiveWindow" v-model="form.receiveWindow" />
          <Separator />
          <Field orientation="horizontal" class="rounded-xl border p-4">
            <FieldContent><FieldLabel for="analysis-enabled">接收自动分析</FieldLabel><FieldDescription>开启后启动此订阅；关闭后暂停此订阅。</FieldDescription></FieldContent>
            <Switch id="analysis-enabled" v-model="form.analysisEnabled" />
          </Field>

            </div>
          </details>
          <details v-if="focus !== 'trader'" :open="!focus" class="rounded-xl border p-4">
            <summary class="cursor-pointer text-sm font-medium">自动交易设置<span class="ml-2 text-xs text-muted-foreground">{{ form.traderEnabled ? '已启用' : '未启用' }}</span></summary>
            <SubscriptionTraderFields class="mt-4" v-model:enabled="form.traderEnabled" v-model:send="form.tradeSendEnabled" v-model:strategy="form.traderStrategyId" :strategies="traderStrategies" />
          </details>



          <Alert v-if="localError || error" variant="destructive"><TriangleAlert aria-hidden="true" /><AlertTitle>订阅设置无法保存</AlertTitle><AlertDescription>{{ localError || error }}</AlertDescription></Alert>
        </div>
      </form>
      <SheetFooter class="border-t"><Button variant="outline" size="lg" :disabled="submitting" @click="emit('update:open', false)">取消</Button><Button size="lg" :disabled="submitting" @click="submit"><Save />{{ submitting ? '正在保存…' : '保存订阅' }}</Button></SheetFooter>
    </SheetContent>
  </Sheet>
</template>
