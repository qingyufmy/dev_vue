<script setup lang="ts">
import { Save } from '@lucide/vue'
import type { StrategyKind } from '@aurum/contracts'
import { computed, reactive, ref, toRaw, watch } from 'vue'
import { Badge } from '@aurum/ui/badge'
import { Button } from '@aurum/ui/button'
import { Field, FieldDescription, FieldGroup, FieldLabel } from '@aurum/ui/field'
import { Input } from '@aurum/ui/input'
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from '@aurum/ui/select'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@aurum/ui/dialog'
import { AlertDialog, AlertDialogContent, AlertDialogHeader, AlertDialogTitle, AlertDialogDescription, AlertDialogFooter, AlertDialogCancel } from '@aurum/ui/alert-dialog'
import { Textarea } from '@aurum/ui/textarea'
import type { CompileResultView, StrategyDraft, StrategyVersionView } from '../model/strategy-presentation'
import { defaultConfig, strategyKindLabel } from '../model/strategy-presentation'
import StrategyRuntimeSettings from './StrategyRuntimeSettings.vue'
import StrategyDataSettings from './StrategyDataSettings.vue'
import StrategyCompileResult from './StrategyCompileResult.vue'

const props = withDefaults(defineProps<{
  open: boolean
  mode: 'create' | 'version'
  kind: StrategyKind
  strategyName?: string
  strategyDescription?: string
  strategyStatus?: string
  platform?: boolean
  baseVersion?: StrategyVersionView | null
  compileResult?: CompileResultView | null
  compiling?: boolean
  submitting?: boolean
  error?: string
}>(), { strategyName: '', baseVersion: null, compileResult: null, compiling: false, submitting: false, error: '' })

const emit = defineEmits<{
  'update:open': [value: boolean]
  submit: [draft: StrategyDraft]
}>()

const form = reactive<StrategyDraft>({ kind: 'analysis', name: '', description: '', promptText: '', config: {} })
const localError = ref('')
const initialForm = ref('')
const discardOpen = ref(false)
function requestClose() {
  if (props.submitting || props.compiling) return
  if (JSON.stringify(form) !== initialForm.value) discardOpen.value = true
  else emit('update:open', false)
}
function discard() { discardOpen.value = false; emit('update:open', false) }
const draft = computed<StrategyDraft>(() => ({
  kind: form.kind,
  ...(props.mode === 'version' ? { status: form.status } : {}),
  name: form.name.trim(),
  description: form.description.trim(),
  promptText: form.promptText.trim(),
  config: structuredClone(toRaw(form.config)),
}))

function reset() {
  const sourceConfig = props.baseVersion?.config ?? defaultConfig(props.kind)
  form.config = structuredClone(toRaw(sourceConfig))
  form.kind = props.kind
  form.name = props.mode === 'version' ? props.strategyName : ''
  form.description = props.mode === 'version' ? props.strategyDescription ?? '' : ''
  form.status = props.strategyStatus === 'active' ? 'active' : 'draft'
  form.promptText = props.baseVersion?.promptText ?? ''
  localError.value = ''
  discardOpen.value = false
  initialForm.value = JSON.stringify(form)
}

function changeKind(value: unknown) {
  if (props.mode === 'create' && (value === 'analysis' || value === 'trader')) {
    form.kind = value
    const config = defaultConfig(value)
    form.config = structuredClone(config)
  }
}

function validate() {
  if (draft.value.name.length < 2 || draft.value.name.length > 191) return fail('策略名称需填写 2 至 191 个字符')
  if (draft.value.description.length > 2000) return fail('策略说明不能超过 2000 个字符')
  if (draft.value.promptText.length < 20) return fail('策略提示词至少需要 20 个字符')
  if (Array.isArray(form.config.symbols) && (form.config.symbols.length > 32 || form.config.symbols.some(value => typeof value !== 'string' || !/^[A-Z0-9]{1,32}$/.test(value)))) return fail('请填写不带后缀的标准品种，最多 32 个')
  if (form.kind === 'trader' && Array.isArray(form.config.entry_methods) && !form.config.entry_methods.length) return fail('请至少选择一种入场方式')
  localError.value = ''
  return true
}

function submit() {
  if (props.submitting || props.compiling || !validate()) return
  emit('submit', draft.value)
}
function fail(message: string) { localError.value = message; return false }

watch(() => props.open, (open) => { if (open) reset() }, { immediate: true })
</script>

<template>
  <Dialog :open="open" @update:open="!$event && requestClose()">
    <DialogContent :show-close-button="!submitting && !compiling" class="flex max-h-[90svh] flex-col gap-0 overflow-hidden p-0 sm:max-w-6xl">
      <DialogHeader class="shrink-0 border-b px-6 py-5 pr-12 text-left">
        <DialogTitle>{{ mode === 'create' ? '新建个人策略' : '编辑策略' }}</DialogTitle>
        <DialogDescription>{{ mode === 'create' ? '设置策略信息、适用范围和分析方法。' : '保存时一起更新策略信息与运行配置，历史版本继续保留。' }}</DialogDescription>
      </DialogHeader>

      <form class="min-h-0 flex-1 overflow-y-auto" @submit.prevent="submit">
        <fieldset :disabled="submitting || compiling" class="grid min-w-0 gap-6 p-4 sm:p-6 lg:grid-cols-2">
          <section class="grid min-w-0 content-start gap-5" aria-label="基础配置">
          <div><h3 class="font-semibold">基础信息</h3><p class="mt-1 text-xs text-muted-foreground">清晰的名称与说明，方便选择和管理策略。</p></div>

          <FieldGroup class="grid gap-4 sm:grid-cols-2">
            <Field>
              <FieldLabel for="strategy-kind">策略用途</FieldLabel>
              <Select :model-value="form.kind" :disabled="mode === 'version'" @update:model-value="changeKind">
                <SelectTrigger id="strategy-kind"><SelectValue /></SelectTrigger>
                <SelectContent><SelectGroup><SelectItem value="analysis">行情分析</SelectItem><SelectItem value="trader">交易执行</SelectItem></SelectGroup></SelectContent>
              </Select>
              <FieldDescription>{{ form.kind === 'analysis' ? '判断行情方向与做单机会，不直接面向账户下单。' : '结合分析结论与账户状态，提出账户级动作。' }}</FieldDescription>
            </Field>
            <Field :data-invalid="Boolean(localError)">
              <FieldLabel for="strategy-name">策略名称</FieldLabel>
              <Input id="strategy-name" v-model.trim="form.name" maxlength="191" placeholder="例如：黄金多周期趋势分析" />
              <FieldDescription>名称用于策略库和账户订阅选择。</FieldDescription>
            </Field>
          </FieldGroup>

          <Field>
            <FieldLabel for="strategy-description">策略说明</FieldLabel>
            <Textarea id="strategy-description" v-model="form.description" class="min-h-24 resize-y" maxlength="2000" placeholder="简要说明适用市场、核心方法与不适用条件" />
          </Field>

          <Field v-if="mode === 'version'">
            <FieldLabel for="strategy-status">策略状态</FieldLabel>
            <Select v-model="form.status">
              <SelectTrigger id="strategy-status"><SelectValue /></SelectTrigger>
              <SelectContent><SelectItem value="active">启用</SelectItem><SelectItem value="draft">停用</SelectItem></SelectContent>
            </Select>
            <FieldDescription>{{ form.status === 'active' ? '保存后现有订阅使用更新后的策略。' : '保存后该策略不再参与分析或交易，订阅配置和历史记录保留。' }}</FieldDescription>
          </Field>
          <StrategyRuntimeSettings v-model="form.config" :trader="form.kind === 'trader'" :platform="Boolean(platform)" />
          </section>
          <Field class="min-w-0" :data-invalid="Boolean(localError)">
            <div class="flex flex-wrap items-center justify-between gap-2">
              <FieldLabel for="strategy-prompt">策略提示词</FieldLabel>
              <Badge variant="outline">{{ strategyKindLabel[form.kind] }}</Badge>
            </div>
            <Textarea id="strategy-prompt" v-model="form.promptText" class="min-h-80 lg:min-h-[32rem] max-h-[65svh] overflow-y-auto resize-y text-sm leading-6" placeholder="描述目标、输入证据、判断流程、禁止条件、输出要求与无法确认时的处理方式…" />
            <FieldDescription>缺少证据、规则冲突或数据不完整时，应明确输出观望或保持，而不是猜测。</FieldDescription>
          </Field>

          <StrategyDataSettings class="lg:col-span-2" v-if="form.kind === 'analysis'" v-model="form.config" />


        </fieldset>
      </form>

      <footer class="grid shrink-0 gap-3 border-t bg-background px-6 py-4">
        <div v-if="error || localError || (compileResult && !compileResult.valid)" class="max-h-32 overflow-y-auto"><StrategyCompileResult :result="compileResult?.valid ? null : compileResult" :error="error || localError" /></div>
        <div class="flex justify-end gap-2">
        <Button variant="ghost" size="lg" :disabled="submitting || compiling" @click="requestClose">取消</Button>
        <Button size="lg" :disabled="submitting || compiling" :aria-busy="submitting || compiling" @click="submit"><Save />{{ compiling ? '正在检查…' : submitting ? '正在保存…' : mode === 'create' ? '保存草稿' : '保存策略' }}</Button>
      </div>
      </footer>
    </DialogContent>
  </Dialog>
  <AlertDialog :open="discardOpen" @update:open="discardOpen = $event"><AlertDialogContent><AlertDialogHeader><AlertDialogTitle>放弃未保存的修改？</AlertDialogTitle><AlertDialogDescription>策略尚未保存，关闭后本次修改将丢失。</AlertDialogDescription></AlertDialogHeader><AlertDialogFooter><AlertDialogCancel>继续编辑</AlertDialogCancel><Button variant="destructive" @click="discard">放弃修改</Button></AlertDialogFooter></AlertDialogContent></AlertDialog>
</template>
