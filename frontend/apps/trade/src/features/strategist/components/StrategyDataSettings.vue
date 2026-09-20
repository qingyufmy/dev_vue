<script setup lang="ts">
import { computed } from 'vue'
import { Input } from '@aurum/ui/input'
import { Checkbox } from '@aurum/ui/checkbox'
import { Switch } from '@aurum/ui/switch'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@aurum/ui/select'
const props = defineProps<{ modelValue: Record<string, unknown> }>()
const emit = defineEmits<{ 'update:modelValue': [value: Record<string, unknown>] }>()
const periods = ['M1', 'M5', 'M15', 'M30', 'H1', 'H4', 'D1']
type Row = { timeframe: string; kline_count: number }
const rows = computed<Row[]>(() => (props.modelValue.market_data_plan as { timeframes?: Row[] })?.timeframes ?? ((props.modelValue.timeframes as string[]) ?? ['M5','M15','H1','H4']).map(timeframe => ({ timeframe, kline_count: Number(props.modelValue.candle_limit ?? 300) })))
const primary = computed(() => (props.modelValue.market_data_plan as { primary_timeframe?: string })?.primary_timeframe ?? rows.value[0]?.timeframe ?? 'M5')
const ema = computed(() => props.modelValue.ema34_evidence as { version: number; timeframe: string } | undefined)
const enabled = (key: string) => (props.modelValue[key] as { enabled?: boolean })?.enabled === true
function update(value: Record<string, unknown>) { emit('update:modelValue', JSON.parse(JSON.stringify(value))) }
function patch(value: Record<string, unknown>) { update({ ...props.modelValue, ...value }) }
function plan(next: Row[], selected = primary.value) {
  const config = { ...props.modelValue }
  delete config.timeframes; delete config.candle_limit
  config.market_data_plan = { version: 1, primary_timeframe: next.some(r => r.timeframe === selected) ? selected : next[0]?.timeframe ?? '', timeframes: next }
  update(config)
}
function toggle(timeframe: string, checked: boolean | 'indeterminate') {
  plan(checked === true ? [...rows.value, { timeframe, kline_count: 300 }] : rows.value.filter(r => r.timeframe !== timeframe))
}
function setEma(value: boolean) {
  if (value) patch({ ema34_evidence: { version: 1, timeframe: rows.value[0]?.timeframe ?? 'M1' } })
  else { const config = { ...props.modelValue }; delete config.ema34_evidence; update(config) }
}
</script>
<template>
  <section class="grid gap-5 rounded-xl border p-4">
    <h3 class="font-semibold">行情数据与运行设置</h3>
    <label class="grid max-w-56 gap-2 text-sm">运行间隔（分钟）<Input aria-label="运行间隔（分钟）" type="number" min="1" max="1440" :model-value="Number(modelValue.interval_minutes ?? 5)" @update:model-value="patch({ interval_minutes: Number($event) })" /></label>
    <p class="text-xs leading-5 text-muted-foreground">发布后，使用该版本的自动分析按此间隔运行。</p>
    <div class="grid gap-2 sm:grid-cols-2">
      <div v-for="period in periods" :key="period" class="flex min-h-12 items-center gap-3 rounded-lg border px-3 py-2">
        <label class="flex flex-1 cursor-pointer items-center gap-2 text-sm"><Checkbox :model-value="rows.some(r => r.timeframe === period)" @update:model-value="toggle(period, $event)" />{{ period }}</label>
        <Input v-if="rows.some(r => r.timeframe === period)" class="w-24" :aria-label="`${period} K线数量`" type="number" min="10" max="1000" :model-value="rows.find(r => r.timeframe === period)?.kline_count" @update:model-value="plan(rows.map(r => r.timeframe === period ? { ...r, kline_count: Number($event) } : r))" /><span class="text-xs text-muted-foreground">根</span>
      </div>
    </div>
    <label class="grid max-w-56 gap-2 text-sm">主周期<Select :model-value="primary" @update:model-value="plan(rows, String($event))"><SelectTrigger aria-label="主周期"><SelectValue /></SelectTrigger><SelectContent><SelectItem v-for="row in rows" :key="row.timeframe" :value="row.timeframe">{{ row.timeframe }}</SelectItem></SelectContent></Select></label>
    <div class="grid gap-4 border-t pt-4">
      <label class="flex items-center justify-between gap-3 text-sm">提供缠论数据<Switch :model-value="enabled('chan_evidence')" @update:model-value="patch({ chan_evidence: { version: 1, enabled: $event } })" /></label>
      <label class="flex items-center justify-between gap-3 text-sm">提供 EMA34 数据<Switch :model-value="!!ema" @update:model-value="setEma" /></label>
      <label v-if="ema" class="grid max-w-56 gap-2 text-sm">EMA34 计算周期<Select :model-value="ema.timeframe" @update:model-value="patch({ ema34_evidence: { version: 1, timeframe: String($event) } })"><SelectTrigger aria-label="EMA34 计算周期"><SelectValue /></SelectTrigger><SelectContent><SelectItem v-for="row in rows" :key="row.timeframe" :value="row.timeframe">{{ row.timeframe }}</SelectItem></SelectContent></Select></label>
      <label class="flex items-center justify-between gap-3 text-sm">提供突破与回收数据<Switch :model-value="enabled('price_action_evidence')" @update:model-value="patch({ price_action_evidence: { version: 1, enabled: $event } })" /></label>
      <p class="text-xs leading-5 text-muted-foreground">向 AI 提供已收盘 K 线的双 K 突破、突破后回收及确认结果，供策略判断，不会直接触发交易。</p>
    </div>
    <p class="text-xs leading-5 text-muted-foreground">开关控制模型收到的数据，不修改提示词中的规则。关闭某项后，请同步检查策略是否仍依赖它。</p>
  </section>
</template>
