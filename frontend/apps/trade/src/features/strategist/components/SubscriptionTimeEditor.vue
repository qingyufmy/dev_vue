<script setup lang="ts">
import { computed } from 'vue'
import type { SubscriptionTimeWindow } from '../model/strategy-presentation'
import { Switch } from '@aurum/ui/switch'
import { Input } from '@aurum/ui/input'
import { Button } from '@aurum/ui/button'
const model = defineModel<SubscriptionTimeWindow>({ required: true })
const value = computed(() => 'version' in model.value ? model.value : { enabled: false, version: 1 as const, timezone: 'terminal_server' as const, weekdays: [1,2,3,4,5], windows: [{ start: '00:00', end: '00:00' }], outsideBehavior: 'pause_all' as const })
function update(patch: Partial<typeof value.value>) { model.value = { ...value.value, ...patch } }
function day(index: number) { update({ weekdays: value.value.weekdays.includes(index) ? value.value.weekdays.filter(x => x !== index) : [...value.value.weekdays, index].sort() }) }
function time(index: number, key: 'start' | 'end', input: string | number) { update({ windows: value.value.windows.map((w, i) => i === index ? { ...w, [key]: String(input) } : w) }) }
</script>
<template>
  <section class="grid gap-3 rounded-lg border p-4">
    <div class="flex items-center justify-between gap-3"><div><label for="analysis-time-window" class="text-sm font-medium">限定接收时间</label><p class="text-xs text-muted-foreground">关闭时全天接收；开启后按交易终端时区执行。</p></div><Switch id="analysis-time-window" :model-value="model.enabled" @update:model-value="enabled => update({ enabled })" /></div>
    <template v-if="model.enabled">
      <div class="flex flex-wrap gap-1"><Button v-for="(name, index) in ['日','一','二','三','四','五','六']" :key="name" type="button" size="sm" :variant="value.weekdays.includes(index) ? 'default' : 'outline'" :aria-pressed="value.weekdays.includes(index)" @click="day(index)">周{{ name }}</Button></div>
      <div v-for="(window, index) in value.windows" :key="index" class="flex items-center gap-2"><Input type="time" :aria-label="`时段 ${index + 1} 开始`" :model-value="window.start" @update:model-value="time(index, 'start', $event)" /><span>至</span><Input type="time" :aria-label="`时段 ${index + 1} 结束`" :model-value="window.end" @update:model-value="time(index, 'end', $event)" /><Button v-if="value.windows.length > 1" type="button" variant="ghost" @click="update({ windows: value.windows.filter((_, i) => i !== index) })">删除</Button></div>
      <Button v-if="value.windows.length < 6" type="button" variant="outline" @click="update({ windows: [...value.windows, { start: '09:00', end: '18:00' }] })">添加时段</Button>
      <p class="text-xs text-muted-foreground">开始和结束相同表示全天；结束早于开始表示跨日。</p>
      <div class="flex items-center justify-between gap-3"><label for="outside-analysis" class="text-xs">时段外继续分析，仅禁止发送交易</label><Switch id="outside-analysis" :model-value="value.outsideBehavior === 'signals_only'" @update:model-value="enabled => update({ outsideBehavior: enabled ? 'signals_only' : 'pause_all' })" /></div>
    </template>
  </section>
</template>
