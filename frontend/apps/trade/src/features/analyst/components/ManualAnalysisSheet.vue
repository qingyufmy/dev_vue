<script setup lang="ts">
import { Play, RadioTower } from '@lucide/vue'
import type { AnalysisJob, StrategySummary } from '@aurum/contracts'
import { Alert, AlertDescription, AlertTitle } from '@aurum/ui/alert'
import { Badge } from '@aurum/ui/badge'
import { Button } from '@aurum/ui/button'
import { Field, FieldDescription, FieldGroup, FieldLabel } from '@aurum/ui/field'
import { Input } from '@aurum/ui/input'
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from '@aurum/ui/select'
import { Sheet, SheetContent, SheetDescription, SheetFooter, SheetHeader, SheetTitle } from '@aurum/ui/sheet'
import { ref, watch } from 'vue'

const props = defineProps<{
  open: boolean
  strategies: StrategySummary[]
  defaultSymbol: string
  pending: boolean
  coolingDown: boolean
  job: AnalysisJob | null
  error: string
}>()

const emit = defineEmits<{ 'update:open': [value: boolean]; submit: [strategyId: string, symbol: string] }>()
const strategyId = ref('')
const symbol = ref('XAUUSD')

watch(() => props.open, (open) => {
  if (!open) return
  if (!strategyId.value || !props.strategies.some((item) => item.id === strategyId.value)) strategyId.value = props.strategies[0]?.id ?? ''
  symbol.value = props.defaultSymbol || symbol.value
})

function submit() {
  if (!strategyId.value || !symbol.value.trim()) return
  emit('submit', strategyId.value, symbol.value)
}

const statusLabels: Record<AnalysisJob['status'], string> = {
  queued: '已排队', running: '分析中', succeeded: '已完成', failed: '失败', cancelled: '已取消', expired: '已过期',
}
</script>

<template>
  <Sheet :open="open" @update:open="emit('update:open', $event)">
    <SheetContent class="w-full overflow-y-auto sm:max-w-md" side="right">
      <SheetHeader>
        <SheetTitle>手动分析行情</SheetTitle>
        <SheetDescription>选择一条已发布的分析策略并提交一次分析。手动分析不自动下单，服务端限制每 3 分钟一次。</SheetDescription>
      </SheetHeader>

      <form class="grid flex-1 content-start gap-5 px-4" @submit.prevent="submit">
        <FieldGroup>
          <Field>
            <FieldLabel>分析策略</FieldLabel>
            <Select v-model="strategyId">
              <SelectTrigger class="w-full"><SelectValue placeholder="选择分析策略" /></SelectTrigger>
              <SelectContent><SelectGroup><SelectItem v-for="strategy in strategies" :key="strategy.id" :value="strategy.id">{{ strategy.name }}</SelectItem></SelectGroup></SelectContent>
            </Select>
            <FieldDescription>只列出当前账号可用的分析类策略。</FieldDescription>
          </Field>
          <Field>
            <FieldLabel for="manual-analysis-symbol">交易品种</FieldLabel>
            <Input id="manual-analysis-symbol" v-model="symbol" maxlength="64" autocomplete="off" placeholder="例如 XAUUSD" />
            <FieldDescription>请输入终端可识别的标准品种代码。</FieldDescription>
          </Field>
        </FieldGroup>

        <Alert v-if="error" variant="destructive"><AlertTitle>提交失败</AlertTitle><AlertDescription>{{ error }}</AlertDescription></Alert>
        <Alert v-if="job">
          <RadioTower />
          <AlertTitle class="flex items-center gap-2">本次任务 <Badge variant="outline">{{ statusLabels[job.status] }}</Badge></AlertTitle>
          <AlertDescription>{{ job.symbol }} 已进入独立分析队列，完成后分析记录会自动更新。</AlertDescription>
        </Alert>
      </form>

      <SheetFooter>
        <Button type="button" variant="outline" size="lg" @click="emit('update:open', false)">关闭</Button>
        <Button type="button" size="lg" :disabled="pending || coolingDown || !strategyId || !symbol.trim()" @click="submit">
          <Play data-icon="inline-start" />
          {{ pending ? '正在提交' : coolingDown ? '3 分钟冷却中' : '执行一次分析' }}
        </Button>
      </SheetFooter>
    </SheetContent>
  </Sheet>
</template>
