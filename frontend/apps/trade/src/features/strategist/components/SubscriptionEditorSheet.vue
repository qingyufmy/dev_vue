<script setup lang="ts">
import { Save, Timer, TriangleAlert } from '@lucide/vue'
import type { StrategySummary, TradingAccount } from '@aurum/contracts'
import { computed, reactive, ref, watch } from 'vue'
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
  symbols?: string[]
  submitting?: boolean
  error?: string
}>(), { subscription: null, symbols: () => [], submitting: false, error: '' })

const emit = defineEmits<{ 'update:open': [value: boolean]; submit: [draft: SubscriptionDraft] }>()
const form = reactive<SubscriptionDraft>({ accountId: '', symbol: '', analysisStrategyId: '', traderStrategyId: null, analysisEnabled: true, traderEnabled: false, tradeSendEnabled: false, status: 'active' })
const localError = ref('')
const editing = computed(() => Boolean(props.subscription))
const analysisStrategies = computed(() => props.strategies.filter((item) => item.kind === 'analysis' && item.status === 'active' && item.activeVersionId))
const traderStrategies = computed(() => props.strategies.filter((item) => item.kind === 'trader' && item.status === 'active' && item.activeVersionId))

function reset() {
  const value = props.subscription
  form.accountId = value?.accountId ?? props.accountId
  form.symbol = value?.symbol ?? props.symbols[0] ?? 'XAUUSD'
  form.analysisStrategyId = value?.analysisStrategyId ?? analysisStrategies.value[0]?.id ?? ''
  form.traderStrategyId = value?.traderStrategyId ?? traderStrategies.value[0]?.id ?? null
  form.analysisEnabled = value?.analysisEnabled ?? true
  form.traderEnabled = value?.traderEnabled ?? false
  form.tradeSendEnabled = value?.tradeSendEnabled ?? false
  form.status = value?.status === 'paused' ? 'paused' : 'active'
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
  if (!form.accountId) return fail('请选择需要订阅的交易账户')
  if (!/^[A-Za-z0-9._-]{1,64}$/.test(form.symbol.trim())) return fail('交易品种格式不正确')
  if (!form.analysisStrategyId) return fail('请选择行情分析策略')
  if (form.traderEnabled && !form.traderStrategyId) return fail('启用 AI 交易员后必须选择交易执行策略')
  if (form.tradeSendEnabled && !form.traderEnabled) return fail('允许发送交易前必须启用 AI 交易员')
  localError.value = ''
  emit('submit', { ...form, symbol: form.symbol.trim().toUpperCase() })
}
function fail(message: string) { localError.value = message }

watch(() => props.open, (open) => { if (open) reset() }, { immediate: true })
watch(() => form.traderEnabled, (enabled) => { if (!enabled) form.tradeSendEnabled = false })
</script>

<template>
  <Sheet :open="open" @update:open="emit('update:open', $event)">
    <SheetContent side="right" class="w-full gap-0 overflow-hidden p-0 sm:max-w-2xl">
      <SheetHeader class="border-b pr-16 text-left">
        <SheetTitle>{{ editing ? '编辑账户订阅' : '新增账户订阅' }}</SheetTitle>
        <SheetDescription>行情分析按系统用户生成；AI 交易员与交易发送按交易账户分别决定。</SheetDescription>
      </SheetHeader>
      <form class="min-h-0 flex-1 overflow-y-auto" @submit.prevent="submit">
        <div class="grid gap-6 p-4 sm:p-6">
          <Alert><Timer aria-hidden="true" /><AlertTitle>自动分析固定每 5 分钟调度</AlertTitle><AlertDescription>当前阶段使用 UTC 全天接收。这里管理的是账户是否接收并执行策略结果，不会改变策略本身的运行逻辑。</AlertDescription></Alert>

          <FieldGroup class="grid gap-4 sm:grid-cols-2">
            <Field>
              <FieldLabel for="subscription-account">交易账户</FieldLabel>
              <Select :model-value="form.accountId" :disabled="editing" @update:model-value="setValue('accountId', $event)">
                <SelectTrigger id="subscription-account"><SelectValue placeholder="选择交易账户" /></SelectTrigger>
                <SelectContent><SelectGroup><SelectItem v-for="account in accounts" :key="account.id" :value="account.id">{{ account.platform.toUpperCase() }} · {{ account.login }} · {{ account.server }}</SelectItem></SelectGroup></SelectContent>
              </Select>
            </Field>
            <Field>
              <FieldLabel for="subscription-symbol">交易品种</FieldLabel>
              <Input id="subscription-symbol" v-model.trim="form.symbol" list="subscription-symbols" maxlength="64" :disabled="editing" placeholder="XAUUSD" />
              <datalist id="subscription-symbols"><option v-for="symbol in symbols" :key="symbol" :value="symbol" /></datalist>
              <FieldDescription>使用终端中的标准品种名，可随交易账户分别配置。</FieldDescription>
            </Field>
          </FieldGroup>

          <Field>
            <FieldLabel for="analysis-strategy">行情分析策略</FieldLabel>
            <Select :model-value="form.analysisStrategyId" :disabled="editing" @update:model-value="setValue('analysisStrategyId', $event)">
              <SelectTrigger id="analysis-strategy"><SelectValue placeholder="选择已发布的分析策略" /></SelectTrigger>
              <SelectContent><SelectGroup><SelectItem v-for="strategy in analysisStrategies" :key="strategy.id" :value="strategy.id">{{ strategy.name }} · {{ strategy.scope === 'platform' ? '平台' : '个人' }}</SelectItem></SelectGroup></SelectContent>
            </Select>
          </Field>

          <Separator />
          <Field orientation="horizontal" class="rounded-xl border p-4">
            <FieldContent><FieldLabel for="analysis-enabled">接收自动分析</FieldLabel><FieldDescription>关闭后，这个订阅不再参与新的五分钟分析调度。</FieldDescription></FieldContent>
            <Switch id="analysis-enabled" v-model="form.analysisEnabled" />
          </Field>

          <section class="grid gap-4 rounded-xl border p-4" aria-labelledby="trader-binding-title">
            <Field orientation="horizontal">
              <FieldContent><FieldLabel id="trader-binding-title" for="trader-enabled">启用 AI 交易员</FieldLabel><FieldDescription>有做单机会，或账户存在持仓、挂单时，才触发账户级交易判断。</FieldDescription></FieldContent>
              <Switch id="trader-enabled" v-model="form.traderEnabled" />
            </Field>
            <Field v-if="form.traderEnabled">
              <FieldLabel for="trader-strategy">交易执行策略</FieldLabel>
              <Select :model-value="form.traderStrategyId ?? undefined" @update:model-value="setValue('traderStrategyId', $event)">
                <SelectTrigger id="trader-strategy"><SelectValue placeholder="选择已发布的交易执行策略" /></SelectTrigger>
                <SelectContent><SelectGroup><SelectItem v-for="strategy in traderStrategies" :key="strategy.id" :value="strategy.id">{{ strategy.name }} · {{ strategy.scope === 'platform' ? '平台' : '个人' }}</SelectItem></SelectGroup></SelectContent>
              </Select>
            </Field>
            <Field v-if="form.traderEnabled" orientation="horizontal" class="rounded-lg bg-muted/40 p-3">
              <FieldContent><FieldLabel for="trade-send-enabled">允许发送交易</FieldLabel><FieldDescription>关闭时只生成交易建议；开启后仍必须通过账户风控与执行校验。</FieldDescription></FieldContent>
              <Switch id="trade-send-enabled" v-model="form.tradeSendEnabled" />
            </Field>
          </section>

          <Field v-if="editing">
            <FieldLabel for="subscription-status">运行状态</FieldLabel>
            <Select :model-value="form.status" @update:model-value="setValue('status', $event)">
              <SelectTrigger id="subscription-status"><SelectValue /></SelectTrigger>
              <SelectContent><SelectGroup><SelectItem value="active">运行中</SelectItem><SelectItem value="paused">暂停</SelectItem></SelectGroup></SelectContent>
            </Select>
          </Field>

          <Alert v-if="localError || error" variant="destructive"><TriangleAlert aria-hidden="true" /><AlertTitle>订阅设置无法保存</AlertTitle><AlertDescription>{{ localError || error }}</AlertDescription></Alert>
        </div>
      </form>
      <SheetFooter class="border-t"><Button variant="outline" size="lg" :disabled="submitting" @click="emit('update:open', false)">取消</Button><Button size="lg" :disabled="submitting" @click="submit"><Save />{{ submitting ? '正在保存…' : '保存订阅' }}</Button></SheetFooter>
    </SheetContent>
  </Sheet>
</template>
