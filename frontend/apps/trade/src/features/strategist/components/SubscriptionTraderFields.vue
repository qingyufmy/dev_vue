<script setup lang="ts">
import type { StrategySummary } from '@aurum/contracts'
import { Bot } from '@lucide/vue'
import { Field, FieldContent, FieldDescription, FieldLabel } from '@aurum/ui/field'
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from '@aurum/ui/select'
import { Switch } from '@aurum/ui/switch'
defineProps<{ strategies: StrategySummary[] }>()
const enabled = defineModel<boolean>('enabled', { required: true })
const strategy = defineModel<string | null>('strategy', { required: true })
</script>
<template>
  <section class="grid gap-4 rounded-xl border border-primary/20 bg-primary/5 p-4" aria-label="自动交易设置">
    <Field>
      <FieldLabel for="trader-strategy"><Bot class="size-4 text-primary" aria-hidden="true" />交易执行策略</FieldLabel>
      <Select :model-value="strategy ?? undefined" @update:model-value="strategy = $event == null ? null : String($event)">
        <SelectTrigger id="trader-strategy"><SelectValue placeholder="选择交易执行策略" /></SelectTrigger>
        <SelectContent><SelectGroup><SelectItem v-for="item in strategies" :key="item.id" :value="item.id" :disabled="item.status !== 'active' || !item.activeVersionId">{{ item.name }}{{ item.status !== 'active' || !item.activeVersionId ? '（暂不可用）' : '' }}</SelectItem></SelectGroup></SelectContent>
      </Select>
      <FieldDescription>根据分析结果、账户持仓与挂单提出交易动作。</FieldDescription>
    </Field>
    <Field orientation="horizontal" class="border-t border-primary/15 pt-4">
      <FieldContent><FieldLabel for="trader-enabled">AI 交易员</FieldLabel><FieldDescription>启用后自动评估，并发送通过账户权限与服务端风控的交易动作。</FieldDescription></FieldContent>
      <Switch id="trader-enabled" v-model="enabled" />
    </Field>
  </section>
</template>
