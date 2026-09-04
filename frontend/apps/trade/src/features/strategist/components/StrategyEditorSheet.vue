<script setup lang="ts">
import { CheckCircle2, Save, ShieldCheck } from '@lucide/vue'
import type { StrategyKind } from '@aurum/contracts'
import { computed, reactive, ref, watch } from 'vue'
import { Alert, AlertDescription, AlertTitle } from '@aurum/ui/alert'
import { Badge } from '@aurum/ui/badge'
import { Button } from '@aurum/ui/button'
import { Checkbox } from '@aurum/ui/checkbox'
import { Field, FieldDescription, FieldGroup, FieldLabel } from '@aurum/ui/field'
import { Input } from '@aurum/ui/input'
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from '@aurum/ui/select'
import { Separator } from '@aurum/ui/separator'
import { Sheet, SheetContent, SheetDescription, SheetFooter, SheetHeader, SheetTitle } from '@aurum/ui/sheet'
import { Textarea } from '@aurum/ui/textarea'
import type { CompileResultView, StrategyDraft, StrategyVersionView } from '../model/strategy-presentation'
import { defaultConfig, strategyKindLabel } from '../model/strategy-presentation'
import StrategyCompileResult from './StrategyCompileResult.vue'

const props = withDefaults(defineProps<{
  open: boolean
  mode: 'create' | 'version'
  kind: StrategyKind
  strategyName?: string
  baseVersion?: StrategyVersionView | null
  compileResult?: CompileResultView | null
  compiling?: boolean
  submitting?: boolean
  error?: string
}>(), { strategyName: '', baseVersion: null, compileResult: null, compiling: false, submitting: false, error: '' })

const emit = defineEmits<{
  'update:open': [value: boolean]
  compile: [draft: StrategyDraft]
  submit: [draft: StrategyDraft]
}>()

const form = reactive<StrategyDraft>({ kind: 'analysis', name: '', description: '', promptText: '', config: {} })
const candleLimit = ref('300')
const timeframes = ['M1', 'M5', 'M15', 'M30', 'H1', 'H4', 'D1'] as const
const selectedTimeframes = ref<string[]>([])
const localError = ref('')
const compiledSignature = ref('')
const draft = computed<StrategyDraft>(() => ({
  kind: form.kind,
  name: form.name.trim(),
  description: form.description.trim(),
  promptText: form.promptText.trim(),
  config: form.kind === 'analysis' ? { timeframes: [...selectedTimeframes.value], candle_limit: Number(candleLimit.value) } : {},
}))

function reset() {
  const sourceConfig = props.baseVersion?.config ?? defaultConfig(props.kind)
  form.kind = props.kind
  form.name = props.mode === 'version' ? props.strategyName : ''
  form.description = ''
  form.promptText = props.baseVersion?.promptText ?? ''
  selectedTimeframes.value = Array.isArray(sourceConfig.timeframes) ? sourceConfig.timeframes.map(String) : ['M5', 'M15', 'H1', 'H4']
  candleLimit.value = String(sourceConfig.candle_limit ?? 300)
  localError.value = ''
  compiledSignature.value = ''
}

function changeKind(value: unknown) {
  if (props.mode === 'create' && (value === 'analysis' || value === 'trader')) {
    form.kind = value
    const config = defaultConfig(value)
    selectedTimeframes.value = Array.isArray(config.timeframes) ? config.timeframes.map(String) : []
    candleLimit.value = String(config.candle_limit ?? 300)
  }
}

function toggleTimeframe(value: string, checked: boolean | 'indeterminate') {
  if (checked === true && !selectedTimeframes.value.includes(value)) selectedTimeframes.value = [...selectedTimeframes.value, value]
  if (checked === false) selectedTimeframes.value = selectedTimeframes.value.filter((item) => item !== value)
}

function validate() {
  if (props.mode === 'create' && (draft.value.name.length < 2 || draft.value.name.length > 191)) return fail('策略名称需填写 2 至 191 个字符')
  if (draft.value.description.length > 2000) return fail('策略说明不能超过 2000 个字符')
  if (draft.value.promptText.length < 20) return fail('策略提示词至少需要 20 个字符')
  if (form.kind === 'analysis' && !selectedTimeframes.value.length) return fail('行情分析策略至少选择一个数据周期')
  const limit = Number(candleLimit.value)
  if (form.kind === 'analysis' && (!Number.isInteger(limit) || limit < 50 || limit > 1000)) return fail('K 线数量需为 50 至 1000 的整数')
  localError.value = ''
  return true
}

function signature(value: StrategyDraft) { return JSON.stringify(value) }
function requestCompile() {
  if (!validate()) return
  compiledSignature.value = signature(draft.value)
  emit('compile', draft.value)
}
function submit() {
  if (!validate()) return
  if (!props.compileResult?.valid || compiledSignature.value !== signature(draft.value)) return fail('内容已变化，请重新完成策略合同校验')
  emit('submit', draft.value)
}
function fail(message: string) { localError.value = message; return false }

watch(() => props.open, (open) => { if (open) reset() }, { immediate: true })
</script>

<template>
  <Sheet :open="open" @update:open="emit('update:open', $event)">
    <SheetContent side="right" class="w-full gap-0 overflow-hidden p-0 sm:max-w-3xl">
      <SheetHeader class="border-b pr-16 text-left">
        <SheetTitle>{{ mode === 'create' ? '新建个人策略' : `为 ${strategyName} 新建版本` }}</SheetTitle>
        <SheetDescription>{{ mode === 'create' ? '先明确用途与提示词，再通过确定性合同校验。' : '历史版本保持不变；保存后需要单独发布才会成为当前版本。' }}</SheetDescription>
      </SheetHeader>

      <form class="min-h-0 flex-1 overflow-y-auto" @submit.prevent="submit">
        <div class="grid gap-6 p-4 sm:p-6">
          <Alert>
            <ShieldCheck aria-hidden="true" />
            <AlertTitle>策略与平台安全边界彼此独立</AlertTitle>
            <AlertDescription>策略可以定义分析和交易判断，但不能绕过账户权限、风控、数据契约或直接调用终端交易工具。</AlertDescription>
          </Alert>

          <FieldGroup class="grid gap-4 sm:grid-cols-2">
            <Field>
              <FieldLabel for="strategy-kind">策略用途</FieldLabel>
              <Select :model-value="form.kind" :disabled="mode === 'version'" @update:model-value="changeKind">
                <SelectTrigger id="strategy-kind"><SelectValue /></SelectTrigger>
                <SelectContent><SelectGroup><SelectItem value="analysis">行情分析</SelectItem><SelectItem value="trader">交易执行</SelectItem></SelectGroup></SelectContent>
              </Select>
              <FieldDescription>{{ form.kind === 'analysis' ? '判断行情方向与做单机会，不直接面向账户下单。' : '结合分析结论与账户状态，提出账户级动作。' }}</FieldDescription>
            </Field>
            <Field v-if="mode === 'create'" :data-invalid="Boolean(localError)">
              <FieldLabel for="strategy-name">策略名称</FieldLabel>
              <Input id="strategy-name" v-model.trim="form.name" maxlength="191" placeholder="例如：黄金多周期趋势分析" />
              <FieldDescription>名称用于策略库和账户订阅选择。</FieldDescription>
            </Field>
          </FieldGroup>

          <Field v-if="mode === 'create'">
            <FieldLabel for="strategy-description">策略说明</FieldLabel>
            <Textarea id="strategy-description" v-model="form.description" class="min-h-24 resize-y" maxlength="2000" placeholder="简要说明适用市场、核心方法与不适用条件" />
          </Field>

          <Separator />
          <Field :data-invalid="Boolean(localError)">
            <div class="flex flex-wrap items-center justify-between gap-2">
              <FieldLabel for="strategy-prompt">策略提示词</FieldLabel>
              <Badge variant="outline">{{ strategyKindLabel[form.kind] }}</Badge>
            </div>
            <Textarea id="strategy-prompt" v-model="form.promptText" class="min-h-72 resize-y font-mono text-sm leading-6" placeholder="描述目标、输入证据、判断流程、禁止条件、输出要求与无法确认时的处理方式…" />
            <FieldDescription>缺少证据、规则冲突或数据不完整时，应明确输出观望或保持，而不是猜测。</FieldDescription>
          </Field>

          <template v-if="form.kind === 'analysis'">
            <Separator />
            <section class="grid gap-4" aria-labelledby="analysis-data-title">
              <div><h3 id="analysis-data-title" class="font-semibold">行情数据范围</h3><p class="mt-1 text-xs text-muted-foreground">这是运行时输入配置，不会写入提示词正文。</p></div>
              <div class="grid gap-2 sm:grid-cols-4">
                <label v-for="timeframe in timeframes" :key="timeframe" class="flex min-h-11 cursor-pointer items-center gap-2 rounded-lg border px-3 text-sm hover:bg-muted/50">
                  <Checkbox :model-value="selectedTimeframes.includes(timeframe)" @update:model-value="toggleTimeframe(timeframe, $event)" />{{ timeframe }}
                </label>
              </div>
              <Field class="max-w-56">
                <FieldLabel for="candle-limit">每周期 K 线数量</FieldLabel>
                <Input id="candle-limit" v-model="candleLimit" type="number" min="50" max="1000" step="1" />
                <FieldDescription>允许 50 至 1000 根，默认 300。</FieldDescription>
              </Field>
            </section>
          </template>

          <StrategyCompileResult :result="compileResult" :error="error || localError" />
        </div>
      </form>

      <SheetFooter class="border-t sm:flex-row sm:justify-between">
        <Button variant="outline" size="lg" :disabled="submitting || compiling" @click="requestCompile"><CheckCircle2 />{{ compiling ? '正在校验…' : '校验策略' }}</Button>
        <div class="flex gap-2"><Button variant="ghost" size="lg" :disabled="submitting" @click="emit('update:open', false)">取消</Button><Button size="lg" :disabled="submitting || !compileResult?.valid" @click="submit"><Save />{{ submitting ? '正在保存…' : mode === 'create' ? '保存草稿' : '保存新版本' }}</Button></div>
      </SheetFooter>
    </SheetContent>
  </Sheet>
</template>
