<script setup lang="ts">
import type { StrategySummary } from '@aurum/contracts'
import { Bot } from '@lucide/vue'
import { Badge } from '@aurum/ui/badge'
import { Field, FieldContent, FieldDescription, FieldLabel } from '@aurum/ui/field'
import { Switch } from '@aurum/ui/switch'
defineProps<{ strategy: StrategySummary['pairedTraderStrategy'] }>()
const enabled = defineModel<boolean>('enabled', { required: true })
</script>
<template>
  <section class="grid gap-4 rounded-xl border border-primary/20 bg-primary/5 p-4" aria-label="自动交易设置">
    <Field class="rounded-lg bg-background/70 p-3">
      <div class="flex items-center gap-2"><Bot class="size-4 text-primary" aria-hidden="true" /><FieldLabel>配套交易引擎</FieldLabel><Badge class="ml-auto" variant="outline">自动绑定</Badge></div>
      <strong class="mt-2 text-sm">{{ strategy?.name ?? '当前组合尚未绑定交易策略' }}</strong>
      <FieldDescription>{{ strategy?.activeVersionId ? '根据分析结论与账户状态提出动作。' : '需要先为策略组合发布可用的交易执行策略。' }}</FieldDescription>
    </Field>
    <Field orientation="horizontal" class="border-t border-primary/15 pt-4">
      <FieldContent><FieldLabel for="trader-enabled">AI 交易员</FieldLabel><FieldDescription>启用后自动评估，并发送通过账户权限与服务端风控的交易动作。</FieldDescription></FieldContent>
      <Switch id="trader-enabled" v-model="enabled" :disabled="!strategy?.activeVersionId" />
    </Field>
  </section>
</template>
