<script setup lang="ts">
import type { StrategySummary } from '@aurum/contracts'
import { Bot } from '@lucide/vue'
import { Field, FieldContent, FieldDescription, FieldLabel } from '@aurum/ui/field'
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from '@aurum/ui/select'
import { Switch } from '@aurum/ui/switch'
defineProps<{ strategies: StrategySummary[] }>()
const enabled = defineModel<boolean>('enabled', { required: true })
const send = defineModel<boolean>('send', { required: true })
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
      <FieldContent><FieldLabel for="trader-enabled">自动评估</FieldLabel><FieldDescription>有交易机会，或需要管理持仓、挂单时运行。</FieldDescription></FieldContent>
      <Switch id="trader-enabled" v-model="enabled" />
    </Field>
    <Field v-if="enabled" orientation="horizontal">
      <FieldContent><FieldLabel for="trade-send-enabled">执行交易建议</FieldLabel><FieldDescription>开启后发送通过风控的指令；关闭时仅生成建议。</FieldDescription></FieldContent>
      <Switch id="trade-send-enabled" v-model="send" />
    </Field>
  </section>
</template>
