<script setup lang="ts">
import { tradingContext } from '~/features/trading-context'

import { accountInputTimezone } from '~/lib/account-input-timezone'

import { terminalInputTime, terminalInputUtc } from '~/lib/terminal-input-time'
import { computed, ref, watch } from 'vue'
import type { AccountSnapshot, ExecutionCommandContext, ExecutionDistributionPreview, MarketQuote, StrategySummary, TradingAccount } from '@aurum/contracts'
import { Alert, AlertDescription, AlertTitle } from '@aurum/ui/alert'
import { Badge } from '@aurum/ui/badge'
import { Button } from '@aurum/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@aurum/ui/card'
import { Checkbox } from '@aurum/ui/checkbox'
import { Field, FieldContent, FieldDescription, FieldError, FieldGroup, FieldLabel } from '@aurum/ui/field'
import { Input } from '@aurum/ui/input'
import { Select, SelectContent, SelectGroup, SelectItem, SelectLabel, SelectTrigger, SelectValue } from '@aurum/ui/select'
import { Sheet, SheetContent, SheetDescription, SheetFooter, SheetHeader, SheetTitle } from '@aurum/ui/sheet'
import { Tabs, TabsList, TabsTrigger } from '@aurum/ui/tabs'
import { CircleAlert, Clock3, Eye, HandCoins, Send, ShieldCheck, WalletCards } from '@lucide/vue'
import type { TraderEntryCommandDraft as CommandDraft, TraderEntryCommandType as CommandType, TraderEntrySide as Side, TraderPendingOrderType as PendingOrderType } from '../model/trader-command-drafts'

type Account = TradingAccount | AccountSnapshot
type Quote = MarketQuote | NonNullable<ExecutionCommandContext['quote']>

const props = withDefaults(defineProps<{
  open: boolean
  account?: Account | null
  accountId?: string | null
  symbols?: string[]
  quote?: Quote | null
  strategies?: StrategySummary[]
  mode?: CommandType
  distribution?: boolean
  distributionPreview?: ExecutionDistributionPreview | null
  previewingDistribution?: boolean
  readOnly?: boolean
  submitting?: boolean
  initial?: Partial<CommandDraft>
}>(), {
  account: null,
  accountId: null,
  symbols: () => [],
  quote: null,
  strategies: () => [],
  mode: 'market_order',
  distribution: false,
  distributionPreview: null,
  previewingDistribution: false,
  readOnly: false,
  submitting: false,
  initial: undefined,
})

const emit = defineEmits<{
  'update:open': [value: boolean]
  submit: [draft: CommandDraft]
  'symbol-change': [symbol: string]
  'strategy-change': [strategyId: string]
  'preview-distribution': [strategyId: string, symbol: string]
}>()

const commandType = ref<CommandType>('market_order')
const side = ref<Side>('buy')
const orderType = ref<PendingOrderType>('buy_limit')
const symbol = ref('')
const volume = ref('')
const stopLoss = ref('')
const takeProfit = ref('')
const pendingPrice = ref('')
const stopLimitPrice = ref('')
const expirationEnabled = ref(false)
const expiration = ref('')
const expirationZone = ref(accountInputTimezone())
const expirationAccountId = ref(tradingContext.value?.accountId)
function expirationUtc() {
  const current = accountInputTimezone()
  if (expirationZone.value.isDefault || current.isDefault || current.offsetMinutes !== expirationZone.value.offsetMinutes || expirationAccountId.value !== tradingContext.value?.accountId) return NaN
  return terminalInputUtc(expiration.value, expirationZone.value.offsetMinutes)
}
const strategyId = ref('')
const distributionConfirmed = ref(false)
const errors = ref<Record<string, string>>({})

const accountLabel = computed(() => {
  if (!props.account) return '尚未选择交易账户'
  return `${props.account.platform.toUpperCase()} · ${props.account.login}`
})
const serverLabel = computed(() => props.account?.server ?? '账户连接后显示服务器')
const canSubmit = computed(() => !props.readOnly && (props.distribution || Boolean(props.account?.tradePermission)))
const effectiveSide = computed<Side>(() => commandType.value === 'market_order'
  ? side.value
  : orderType.value.startsWith('buy') ? 'buy' : 'sell')
const referencePrice = computed(() => props.initial?.reference_price
  ?? (effectiveSide.value === 'buy' ? props.quote?.ask : props.quote?.bid)
  ?? '')
const stopLimitVisible = computed(() => commandType.value === 'pending_order' && orderType.value.endsWith('stop_limit'))
const needsPendingPrice = computed(() => commandType.value === 'pending_order')
const title = computed(() => props.distribution ? '分发交易指令' : commandType.value === 'market_order' ? '新建市价单' : '新建挂单')
const submitLabel = computed(() => props.submitting ? '正在提交…' : props.distribution ? '核对分发指令' : '核对并继续')
const previewReadyCount = computed(() => props.distributionPreview?.targets.filter((target) => target.ready).length ?? 0)
const previewUnavailableCount = computed(() => (props.distributionPreview?.targetCount ?? 0) - previewReadyCount.value)
const previewMissingResources = computed(() => {
  const resources = props.distributionPreview?.targets.flatMap((target) => target.missingResources) ?? []
  return [...new Set(resources)]
})

function resetForm() {
  expirationZone.value = accountInputTimezone()
  expirationAccountId.value = tradingContext.value?.accountId
  const initial = props.initial ?? {}
  commandType.value = initial.command_type ?? props.mode
  side.value = initial.side ?? 'buy'
  orderType.value = initial.order_type ?? 'buy_limit'
  symbol.value = initial.symbol ?? props.symbols[0] ?? ''
  volume.value = initial.volume ?? ''
  stopLoss.value = initial.stop_loss ?? ''
  takeProfit.value = initial.take_profit ?? ''
  pendingPrice.value = initial.price ?? ''
  stopLimitPrice.value = initial.stop_limit_price ?? ''
  expirationEnabled.value = initial.expiration_utc_msc !== undefined
  expiration.value = initial.expiration_utc_msc ? toLocalDateTime(initial.expiration_utc_msc) : ''
  strategyId.value = initial.strategy_id ?? props.strategies[0]?.id ?? ''
  distributionConfirmed.value = false
  errors.value = {}
}

function toLocalDateTime(timestamp: number) {
  return Number.isFinite(timestamp) ? terminalInputTime(new Date(timestamp).toISOString(), expirationZone.value.offsetMinutes) : ''
}

function setCommandType(value: unknown) {
  if (value === 'market_order' || value === 'pending_order') commandType.value = value
}

function setSymbol(value: unknown) {
  symbol.value = String(value ?? '')
  emit('symbol-change', symbol.value)
}

function setSide(value: unknown) {
  if (value === 'buy' || value === 'sell') side.value = value
}

function setOrderType(value: unknown) {
  if (isPendingOrderType(value)) orderType.value = value
}

function setStrategy(value: unknown) {
  strategyId.value = String(value ?? '')
  emit('strategy-change', strategyId.value)
}

function requestDistributionPreview() {
  if (!props.distribution || !strategyId.value || !symbol.value || props.previewingDistribution) return
  emit('preview-distribution', strategyId.value, symbol.value)
}

function missingResourceLabel(value: string) {
  return ({ account: '账户', positions: '持仓', pending_orders: '挂单', quote: '报价', contract: '合约', risk: '风控' } as Record<string, string>)[value] ?? value
}

function positive(value: string) {
  return value.trim() !== '' && Number.isFinite(Number(value)) && Number(value) > 0
}

function validate() {
  const next: Record<string, string> = {}
  if (!props.account || !props.accountId && !props.account.id) next.account = '请先选择可操作的交易账户'
  if (props.readOnly) next.account = '当前为只读模式，不能提交交易指令'
  if (!props.distribution && props.account && !props.account.tradePermission) next.account = '当前账户没有交易权限，不能提交交易指令'
  if (!symbol.value) next.symbol = '请选择交易品种'
  if (!positive(volume.value)) next.volume = '请输入大于 0 的手数'
  if (!positive(referencePrice.value)) next.reference_price = '当前没有可用的参考报价，请稍后重试'
  if (needsPendingPrice.value && !positive(pendingPrice.value)) next.price = '请输入大于 0 的挂单价'
  if (stopLimitVisible.value && !positive(stopLimitPrice.value)) next.stop_limit_price = '止损限价单必须填写止损限价'
  if (props.distribution && !positive(stopLoss.value)) next.stop_loss = '策略分发必须填写大于 0 的止损价'
  if (!props.distribution && stopLoss.value && !positive(stopLoss.value)) next.stop_loss = '止损价必须大于 0'
  if (takeProfit.value && !positive(takeProfit.value)) next.take_profit = '止盈价必须大于 0'
  if (expirationEnabled.value && !expiration.value) next.expiration = '启用到期时间后，请选择具体时间'
  if (expirationEnabled.value && expiration.value && !Number.isFinite(expirationUtc())) next.expiration = '请填写有效的终端时间；账户或时区变化后请重新打开表单，未校准时暂不可设置有效期'
  if (props.distribution && !strategyId.value) next.strategy_id = '请选择要分发的交易策略'
  if (props.distribution && !distributionConfirmed.value) next.distribution = '请确认目标范围将在服务端受理时冻结'
  if (props.distribution && (!props.distributionPreview || props.distributionPreview.strategyId !== strategyId.value || props.distributionPreview.symbol !== symbol.value)) {
    next.preview = '请先刷新并核对当前策略与品种的目标范围预览'
  }
  errors.value = next
  return Object.keys(next).length === 0
}

function submit() {
  if (props.submitting || !validate()) return
  const draft: CommandDraft = {
    command_type: commandType.value,
    symbol: symbol.value,
    volume: volume.value,
    reference_price: referencePrice.value,
  }
  if (stopLoss.value) draft.stop_loss = stopLoss.value
  if (commandType.value === 'market_order') draft.side = side.value
  if (commandType.value === 'pending_order') {
    draft.order_type = orderType.value
    draft.price = pendingPrice.value
    if (stopLimitVisible.value) draft.stop_limit_price = stopLimitPrice.value
  }
  if (takeProfit.value) draft.take_profit = takeProfit.value
  if (expirationEnabled.value && expiration.value) draft.expiration_utc_msc = expirationUtc()
  if (props.distribution) draft.strategy_id = strategyId.value
  emit('submit', draft)
}

watch(() => props.open, (value) => { if (value) resetForm() }, { immediate: true })
watch(() => props.strategies, (items) => {
  if (!strategyId.value && items.length) strategyId.value = items[0]?.id ?? ''
}, { deep: true })
watch(() => props.symbols, (items) => {
  if (symbol.value && items.includes(symbol.value)) return
  symbol.value = items[0] ?? ''
}, { deep: true })

function isPendingOrderType(value: unknown): value is PendingOrderType {
  return ['buy_limit', 'sell_limit', 'buy_stop', 'sell_stop', 'buy_stop_limit', 'sell_stop_limit'].includes(String(value))
}

function pendingTypeLabel(value: PendingOrderType) {
  return ({
    buy_limit: '买入限价', sell_limit: '卖出限价', buy_stop: '买入止损', sell_stop: '卖出止损',
    buy_stop_limit: '买入止损限价', sell_stop_limit: '卖出止损限价',
  } satisfies Record<PendingOrderType, string>)[value]
}
</script>

<template>
  <Sheet :open="open" @update:open="emit('update:open', $event)">
    <SheetContent side="right" class="w-full gap-0 overflow-hidden p-0 sm:max-w-xl">
      <SheetHeader class="border-b pr-16 text-left">
        <div class="flex flex-wrap items-center gap-2">
          <Badge variant="outline"><Send aria-hidden="true" />{{ distribution ? '策略分发' : '账户交易' }}</Badge>
          <Badge v-if="readOnly" variant="secondary"><ShieldCheck aria-hidden="true" />只读</Badge>
        </div>
        <SheetTitle>{{ title }}</SheetTitle>
        <SheetDescription>{{ distribution ? '填写参数后分发，服务端会校验目标账户、风险策略与最新资源版本。' : '手动指令不经过策略风控；账户状态、资源版本和 MT5/券商规则仍会校验。' }}</SheetDescription>
      </SheetHeader>

      <div class="min-h-0 flex-1 overflow-y-auto">
        <form class="grid gap-5 p-4 sm:p-6" @submit.prevent="submit">
          <Alert v-if="readOnly || !distribution && account && !account.tradePermission" variant="destructive">
            <CircleAlert aria-hidden="true" />
            <AlertTitle>{{ readOnly ? '当前账户为只读模式' : '当前账户没有交易权限' }}</AlertTitle>
            <AlertDescription>观摩账户或未开启交易权限时只能查看数据，提交按钮会保持禁用。</AlertDescription>
          </Alert>

          <Card size="sm" class="border-primary/30 bg-primary/5 shadow-none">
            <CardHeader class="gap-1 pb-3">
              <CardTitle class="flex items-center gap-2 text-sm"><WalletCards aria-hidden="true" />{{ distribution ? '报价参考账户' : '执行账户' }}</CardTitle>
              <CardDescription>{{ distribution ? '当前账户只提供参考报价；实际目标由服务端按策略订阅资格冻结。' : '指令只会作用于当前账户，切换账户后需要重新确认。' }}</CardDescription>
            </CardHeader>
            <CardContent class="flex items-center justify-between gap-3 pt-0">
              <div class="min-w-0">
                <p class="truncate font-medium">{{ accountLabel }}</p>
                <p class="truncate text-xs text-muted-foreground">{{ serverLabel }}</p>
              </div>
              <div v-if="account" class="flex shrink-0 flex-wrap justify-end gap-1.5">
                <Badge variant="secondary">{{ account.platform.toUpperCase() }}</Badge>
                <Badge :variant="distribution || account.tradePermission ? 'default' : 'secondary'">{{ distribution ? '分发参考' : account.tradePermission ? '允许交易' : '只读账户' }}</Badge>
              </div>
            </CardContent>
          </Card>
          <FieldError :errors="errors.account ? [errors.account] : []" />

          <FieldGroup>
            <Field>
              <FieldLabel for="command-type">指令类型</FieldLabel>
              <Tabs :model-value="commandType" class="w-full" @update:model-value="setCommandType">
                <TabsList aria-label="指令类型" class="grid h-11 w-full grid-cols-2">
                  <TabsTrigger value="market_order" class="min-h-11">市价单</TabsTrigger>
                  <TabsTrigger value="pending_order" class="min-h-11">挂单</TabsTrigger>
                </TabsList>
              </Tabs>
              <FieldDescription>市价单按当前参考报价提交；挂单还需要填写触发价格。</FieldDescription>
            </Field>

            <Field :data-invalid="Boolean(errors.symbol)">
              <FieldLabel for="command-symbol">交易品种</FieldLabel>
              <Select :model-value="symbol" :disabled="!symbols.length || readOnly" @update:model-value="setSymbol">
                <SelectTrigger id="command-symbol" class="min-h-11 w-full" :aria-invalid="Boolean(errors.symbol)"><SelectValue placeholder="选择交易品种" /></SelectTrigger>
                <SelectContent>
                  <SelectGroup>
                    <SelectLabel>当前账户可用品种</SelectLabel>
                    <SelectItem v-for="item in symbols" :key="item" :value="item">{{ item }}</SelectItem>
                  </SelectGroup>
                </SelectContent>
              </Select>
              <FieldDescription v-if="symbols.length">报价和执行会以当前选择的品种为准。</FieldDescription>
              <FieldDescription v-else>当前账户暂无可用品种，请刷新账户快照后重试。</FieldDescription>
              <FieldError :errors="errors.symbol ? [errors.symbol] : []" />
            </Field>

            <Field v-if="commandType === 'market_order'">
              <FieldLabel for="command-side">交易方向</FieldLabel>
              <Select :model-value="side" :disabled="readOnly" @update:model-value="setSide">
                <SelectTrigger id="command-side" class="min-h-11 w-full"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="buy">买入</SelectItem>
                  <SelectItem value="sell">卖出</SelectItem>
                </SelectContent>
              </Select>
            </Field>

            <Field v-else>
              <FieldLabel for="command-order-type">挂单类型</FieldLabel>
              <Select :model-value="orderType" :disabled="readOnly" @update:model-value="setOrderType">
                <SelectTrigger id="command-order-type" class="min-h-11 w-full"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectGroup>
                    <SelectItem v-for="item in ['buy_limit', 'sell_limit', 'buy_stop', 'sell_stop', 'buy_stop_limit', 'sell_stop_limit']" :key="item" :value="item">{{ pendingTypeLabel(item as PendingOrderType) }}</SelectItem>
                  </SelectGroup>
                </SelectContent>
              </Select>
              <FieldDescription>方向包含在挂单类型中：{{ effectiveSide === 'buy' ? '买入' : '卖出' }}。</FieldDescription>
            </Field>

            <div class="grid gap-5 sm:grid-cols-2">
              <Field :data-invalid="Boolean(errors.volume)">
                <FieldLabel for="command-volume">手数</FieldLabel>
                <Input id="command-volume" v-model="volume" inputmode="decimal" placeholder="例如 0.10" :disabled="readOnly" :aria-invalid="Boolean(errors.volume)" aria-describedby="command-volume-help" />
                <FieldDescription id="command-volume-help">只填写本次指令手数。</FieldDescription>
                <FieldError :errors="errors.volume ? [errors.volume] : []" />
              </Field>
              <Field :data-invalid="Boolean(errors.reference_price)">
                <FieldLabel for="command-reference-price">参考价</FieldLabel>
                <Input id="command-reference-price" :model-value="referencePrice" readonly :aria-invalid="Boolean(errors.reference_price)" aria-describedby="command-reference-price-help" />
                <FieldDescription id="command-reference-price-help">{{ effectiveSide === 'buy' ? '买入参考 Ask' : '卖出参考 Bid' }} · {{ quote ? '实时报价' : '等待报价' }}</FieldDescription>
                <FieldError :errors="errors.reference_price ? [errors.reference_price] : []" />
              </Field>
            </div>

            <Field v-if="needsPendingPrice" :data-invalid="Boolean(errors.price)">
              <FieldLabel for="command-price">挂单价</FieldLabel>
              <Input id="command-price" v-model="pendingPrice" inputmode="decimal" placeholder="输入触发价" :disabled="readOnly" :aria-invalid="Boolean(errors.price)" />
              <FieldDescription>订单触发时由服务端和终端再次校验价格有效性。</FieldDescription>
              <FieldError :errors="errors.price ? [errors.price] : []" />
            </Field>

            <Field v-if="stopLimitVisible" :data-invalid="Boolean(errors.stop_limit_price)">
              <FieldLabel for="command-stop-limit-price">止损限价</FieldLabel>
              <Input id="command-stop-limit-price" v-model="stopLimitPrice" inputmode="decimal" placeholder="输入止损限价" :disabled="readOnly" :aria-invalid="Boolean(errors.stop_limit_price)" />
              <FieldDescription>仅止损限价挂单需要填写该价格。</FieldDescription>
              <FieldError :errors="errors.stop_limit_price ? [errors.stop_limit_price] : []" />
            </Field>

            <div class="grid gap-5 sm:grid-cols-2">
              <Field :data-invalid="Boolean(errors.stop_loss)">
                <FieldLabel for="command-stop-loss">止损价 <span :class="distribution ? 'text-destructive' : 'text-muted-foreground'">{{ distribution ? '必填' : '可选' }}</span></FieldLabel>
                <Input id="command-stop-loss" v-model="stopLoss" inputmode="decimal" :placeholder="distribution ? '输入保护价' : '可留空'" :disabled="readOnly" :aria-invalid="Boolean(errors.stop_loss)" />
                <FieldDescription>{{ distribution ? '策略分发仍执行确定性风控。' : '留空表示不设置止损，由 MT5/券商校验最终指令。' }}</FieldDescription>
                <FieldError :errors="errors.stop_loss ? [errors.stop_loss] : []" />
              </Field>
              <Field :data-invalid="Boolean(errors.take_profit)">
                <FieldLabel for="command-take-profit">止盈价 <span class="text-muted-foreground">可选</span></FieldLabel>
                <Input id="command-take-profit" v-model="takeProfit" inputmode="decimal" placeholder="可留空" :disabled="readOnly" :aria-invalid="Boolean(errors.take_profit)" />
                <FieldDescription>留空表示不设置止盈。</FieldDescription>
                <FieldError :errors="errors.take_profit ? [errors.take_profit] : []" />
              </Field>
            </div>

            <Field orientation="horizontal" class="rounded-lg border p-3">
              <Checkbox id="command-expiration" v-model="expirationEnabled" :disabled="readOnly" />
              <FieldContent>
                <FieldLabel for="command-expiration"><Clock3 aria-hidden="true" />设置到期时间</FieldLabel>
                <FieldDescription>不勾选表示使用服务器默认有效期。</FieldDescription>
              </FieldContent>
            </Field>
            <Field v-if="expirationEnabled" :data-invalid="Boolean(errors.expiration)">
              <FieldLabel for="command-expiration-time">到期时间（终端 {{ expirationZone.label }}）</FieldLabel>
              <Input id="command-expiration-time" v-model="expiration" type="datetime-local" step="1" :disabled="readOnly" :aria-invalid="Boolean(errors.expiration)" />
              <FieldDescription>按本机时间输入，提交时转换为 UTC 时间戳。</FieldDescription>
              <FieldError :errors="errors.expiration ? [errors.expiration] : []" />
            </Field>
          </FieldGroup>

          <Card v-if="distribution" size="sm" class="border-primary/30 shadow-none">
            <CardHeader class="gap-1 pb-3">
              <CardTitle class="flex items-center gap-2 text-sm"><HandCoins aria-hidden="true" />分发设置</CardTitle>
              <CardDescription>这笔指令将发送给订阅所选交易策略且符合服务端资格的账户。</CardDescription>
            </CardHeader>
            <CardContent class="grid gap-4 pt-0">
              <Field :data-invalid="Boolean(errors.strategy_id)">
                <FieldLabel for="command-strategy">交易策略</FieldLabel>
                <Select :model-value="strategyId" :disabled="readOnly" @update:model-value="setStrategy">
                  <SelectTrigger id="command-strategy" class="min-h-11 w-full" :aria-invalid="Boolean(errors.strategy_id)"><SelectValue placeholder="选择交易策略" /></SelectTrigger>
                  <SelectContent>
                    <SelectGroup>
                      <SelectItem v-for="item in strategies" :key="item.id" :value="item.id">{{ item.name }}</SelectItem>
                    </SelectGroup>
                  </SelectContent>
                </Select>
                <FieldDescription>仅交易类策略可以接收手动交易分发。</FieldDescription>
                <FieldError :errors="errors.strategy_id ? [errors.strategy_id] : []" />
              </Field>
              <Field orientation="horizontal" class="rounded-lg border border-primary/25 bg-primary/5 p-3">
                <Checkbox id="command-distribution-confirm" v-model="distributionConfirmed" :disabled="readOnly" />
                <FieldContent>
                  <FieldLabel for="command-distribution-confirm">我确认目标范围将在确认时冻结</FieldLabel>
                  <FieldDescription>服务端会在受理分发时冻结订阅账户名单，之后不会因订阅变化而扩大或缩小本次范围。</FieldDescription>
                </FieldContent>
              </Field>
              <FieldError :errors="errors.distribution ? [errors.distribution] : []" />
              <div class="grid gap-3 rounded-lg border bg-muted/20 p-3" aria-live="polite">
                <div class="flex flex-wrap items-center justify-between gap-2">
                  <div>
                    <p class="text-sm font-medium">目标范围预览</p>
                    <p class="mt-1 text-xs text-muted-foreground">预览用于核对当前资格，最终名单仍在确认受理时冻结。</p>
                  </div>
                  <Button type="button" variant="outline" size="lg" class="min-h-11" :disabled="readOnly || !strategyId || !symbol || previewingDistribution" @click="requestDistributionPreview">
                    <Eye data-icon="inline-start" />{{ previewingDistribution ? '预览中…' : '刷新预览' }}
                  </Button>
                </div>
                <div v-if="distributionPreview" class="grid gap-2 sm:grid-cols-3">
                  <div class="rounded-md bg-background px-3 py-2"><p class="text-xs text-muted-foreground">预计目标</p><p class="mt-1 font-mono text-lg tabular-nums">{{ distributionPreview.targetCount }}</p></div>
                  <div class="rounded-md bg-background px-3 py-2"><p class="text-xs text-muted-foreground">当前可执行</p><p class="mt-1 font-mono text-lg tabular-nums text-trade-up">{{ previewReadyCount }}</p></div>
                  <div class="rounded-md bg-background px-3 py-2"><p class="text-xs text-muted-foreground">需排除</p><p class="mt-1 font-mono text-lg tabular-nums" :class="previewUnavailableCount ? 'text-trade-down' : ''">{{ previewUnavailableCount }}</p></div>
                </div>
                <p v-if="distributionPreview && previewUnavailableCount" class="text-xs leading-5 text-muted-foreground">部分订阅账户缺少 {{ previewMissingResources.map(missingResourceLabel).join('、') || '必要资源' }}，服务端会按资格规则处理。</p>
                <p v-else-if="distributionPreview" class="text-xs leading-5 text-muted-foreground">当前预览中的订阅账户均具备所需资源。</p>
                <p v-else class="text-xs text-muted-foreground">点击“刷新预览”后查看当前订阅账户数量和资源就绪情况。</p>
                <FieldError :errors="errors.preview ? [errors.preview] : []" />
              </div>
            </CardContent>
          </Card>

          <Alert>
            <ShieldCheck aria-hidden="true" />
            <AlertTitle>提交后请等待操作状态</AlertTitle>
            <AlertDescription>HTTP 接受只表示服务器已登记操作，不代表终端已经成交。最终结果会通过操作状态和账户资源复核确认。</AlertDescription>
          </Alert>

          <SheetFooter class="-mx-4 border-t px-4 pb-1 sm:-mx-6 sm:px-6">
            <Button type="button" variant="outline" size="lg" class="min-h-11" @click="emit('update:open', false)">取消</Button>
            <Button type="button" size="lg" class="min-h-11" :disabled="!canSubmit || submitting" @click="submit">
              <Send data-icon="inline-start" />{{ submitLabel }}
            </Button>
          </SheetFooter>
        </form>
      </div>
    </SheetContent>
  </Sheet>
</template>
