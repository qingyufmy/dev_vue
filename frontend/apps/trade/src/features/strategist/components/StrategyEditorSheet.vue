<script setup lang="ts">
import { Save } from '@lucide/vue'
import { computed, reactive, ref, toRaw, watch } from 'vue'
import { Badge } from '@aurum/ui/badge'
import { Button } from '@aurum/ui/button'
import { Field, FieldDescription, FieldLabel } from '@aurum/ui/field'
import { Input } from '@aurum/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@aurum/ui/select'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@aurum/ui/dialog'
import { AlertDialog, AlertDialogContent, AlertDialogHeader, AlertDialogTitle, AlertDialogDescription, AlertDialogFooter, AlertDialogCancel } from '@aurum/ui/alert-dialog'
import { Textarea } from '@aurum/ui/textarea'
import type { CompileResultView, StrategyCombinationDraft, StrategyVersionView } from '../model/strategy-presentation'
import { defaultConfig } from '../model/strategy-presentation'
import StrategyRuntimeSettings from './StrategyRuntimeSettings.vue'
import StrategyDataSettings from './StrategyDataSettings.vue'
import StrategyCompileResult from './StrategyCompileResult.vue'

const props = withDefaults(defineProps<{
  open: boolean; mode: 'create' | 'version'; strategyName?: string; strategyDescription?: string; strategyStatus?: string
  platform?: boolean; baseVersion?: StrategyVersionView | null; traderBaseVersion?: StrategyVersionView | null
  analysisCompileResult?: CompileResultView | null; traderCompileResult?: CompileResultView | null
  compiling?: boolean; submitting?: boolean; error?: string
}>(), { strategyName: '', strategyDescription: '', baseVersion: null, traderBaseVersion: null, analysisCompileResult: null, traderCompileResult: null, compiling: false, submitting: false, error: '' })

const emit = defineEmits<{ 'update:open': [value: boolean]; submit: [draft: StrategyCombinationDraft] }>()
const form = reactive<StrategyCombinationDraft>({ name: '', description: '', analysisPromptText: '', analysisConfig: {}, traderPromptText: '', traderConfig: {} })
const localError = ref('')
const initialForm = ref('')
const discardOpen = ref(false)
const draft = computed<StrategyCombinationDraft>(() => ({
  ...(props.mode === 'version' ? { status: form.status } : {}), name: form.name.trim(), description: form.description.trim(),
  analysisPromptText: form.analysisPromptText.trim(), analysisConfig: structuredClone(toRaw(form.analysisConfig)),
  traderPromptText: form.traderPromptText.trim(), traderConfig: structuredClone(toRaw(form.traderConfig)),
}))

function reset() {
  const analysisConfig = structuredClone(toRaw(props.baseVersion?.config ?? defaultConfig('analysis')))
  delete analysisConfig.trader_strategy_id
  Object.assign(form, {
    name: props.mode === 'version' ? props.strategyName : '', description: props.mode === 'version' ? props.strategyDescription : '',
    status: props.strategyStatus === 'active' ? 'active' : 'draft', analysisPromptText: props.baseVersion?.promptText ?? '', analysisConfig,
    traderPromptText: props.traderBaseVersion?.promptText ?? '', traderConfig: structuredClone(toRaw(props.traderBaseVersion?.config ?? defaultConfig('trader'))),
  })
  localError.value = ''; discardOpen.value = false; initialForm.value = JSON.stringify(form)
}
function requestClose() { if (!props.submitting && !props.compiling) JSON.stringify(form) !== initialForm.value ? discardOpen.value = true : emit('update:open', false) }
function discard() { discardOpen.value = false; emit('update:open', false) }
function validate() {
  if (draft.value.name.length < 2 || draft.value.name.length > 191) return fail('策略名称需填写 2 至 191 个字符')
  if (draft.value.description.length > 2000) return fail('策略说明不能超过 2000 个字符')
  if (draft.value.analysisPromptText.length < 20) return fail('分析策略提示词至少需要 20 个字符')
  if (draft.value.traderPromptText.length < 20) return fail('交易策略提示词至少需要 20 个字符')
  if (Array.isArray(form.traderConfig.entry_methods) && !form.traderConfig.entry_methods.length) return fail('请至少选择一种入场方式')
  localError.value = ''; return true
}
function submit() { if (!props.submitting && !props.compiling && validate()) emit('submit', draft.value) }
function fail(message: string) { localError.value = message; return false }
watch(() => props.open, open => { if (open) reset() }, { immediate: true })
</script>

<template>
  <Dialog :open="open" @update:open="!$event && requestClose()">
    <DialogContent :show-close-button="!submitting && !compiling" class="flex max-h-[92svh] flex-col gap-0 overflow-hidden p-0 sm:max-w-7xl">
      <DialogHeader class="shrink-0 border-b px-5 py-4 pr-12 text-left sm:px-6"><DialogTitle>{{ mode === 'create' ? '新建策略组合' : '编辑策略组合' }}</DialogTitle><DialogDescription>一次维护分析师与交易员，两份提示词会作为独立版本同时保存。</DialogDescription></DialogHeader>
      <form class="min-h-0 flex-1 overflow-y-auto" @submit.prevent="submit">
        <fieldset :disabled="submitting || compiling" class="grid min-w-0 gap-6 p-4 sm:p-6">
          <section class="grid gap-4 rounded-xl border bg-muted/20 p-4 sm:grid-cols-2" aria-label="组合信息">
            <Field><FieldLabel for="strategy-name">组合名称</FieldLabel><Input id="strategy-name" v-model.trim="form.name" maxlength="191" placeholder="例如：黄金多周期趋势策略" /><FieldDescription>客户在策略库和账户订阅中看到的名称。</FieldDescription></Field>
            <Field v-if="mode === 'version'"><FieldLabel for="strategy-status">组合状态</FieldLabel><Select v-model="form.status"><SelectTrigger id="strategy-status"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="active">启用</SelectItem><SelectItem value="draft">停用</SelectItem></SelectContent></Select><FieldDescription>两条策略会一起切换到相同状态。</FieldDescription></Field>
            <Field :class="mode === 'version' ? 'sm:col-span-2' : ''"><FieldLabel for="strategy-description">策略说明</FieldLabel><Textarea id="strategy-description" v-model="form.description" class="min-h-20 resize-y" maxlength="2000" placeholder="说明适用市场、核心方法与不适用条件" /></Field>
          </section>
          <div class="grid min-w-0 gap-5 lg:grid-cols-2">
            <section class="grid min-w-0 content-start gap-5 rounded-xl border p-4 sm:p-5" aria-label="分析策略">
              <div class="flex items-start justify-between gap-3"><div><h3 class="font-semibold">行情分析策略</h3><p class="mt-1 text-xs leading-5 text-muted-foreground">读取行情证据，识别方向、结构与机会，不直接决定账户下单。</p></div><Badge variant="outline">分析师</Badge></div>
              <StrategyRuntimeSettings v-model="form.analysisConfig" :trader="false" :platform="Boolean(platform)" />
              <StrategyDataSettings v-model="form.analysisConfig" />
              <Field><FieldLabel for="analysis-prompt">分析策略提示词</FieldLabel><Textarea id="analysis-prompt" v-model="form.analysisPromptText" class="min-h-80 resize-y text-sm leading-6" placeholder="描述行情证据、分析流程、机会判断、禁止猜测与输出合同…" /><FieldDescription>证据不足时应明确观望，不要补造行情事实。</FieldDescription></Field>
              <StrategyCompileResult v-if="analysisCompileResult && !analysisCompileResult.valid" :result="analysisCompileResult" />
            </section>
            <section class="grid min-w-0 content-start gap-5 rounded-xl border p-4 sm:p-5" aria-label="交易策略">
              <div class="flex items-start justify-between gap-3"><div><h3 class="font-semibold">交易执行策略</h3><p class="mt-1 text-xs leading-5 text-muted-foreground">结合分析结论、账户状态和持仓，提出账户级交易动作。</p></div><Badge variant="outline">交易员</Badge></div>
              <StrategyRuntimeSettings v-model="form.traderConfig" trader :platform="Boolean(platform)" />
              <Field><FieldLabel for="trader-prompt">交易策略提示词</FieldLabel><Textarea id="trader-prompt" v-model="form.traderPromptText" class="min-h-80 resize-y text-sm leading-6" placeholder="描述账户约束、入场与退出判断、风险条件、保持动作与输出合同…" /><FieldDescription>交易员只提出结构化动作，确定性服务端风控仍独立审核。</FieldDescription></Field>
              <StrategyCompileResult v-if="traderCompileResult && !traderCompileResult.valid" :result="traderCompileResult" />
            </section>
          </div>
        </fieldset>
      </form>
      <footer class="grid shrink-0 gap-3 border-t bg-background px-5 py-4 sm:px-6"><StrategyCompileResult v-if="error || localError" :result="null" :error="error || localError" /><div class="flex justify-end gap-2"><Button variant="ghost" size="lg" :disabled="submitting || compiling" @click="requestClose">取消</Button><Button size="lg" :disabled="submitting || compiling" :aria-busy="submitting || compiling" @click="submit"><Save />{{ compiling ? '正在检查两份策略…' : submitting ? '正在同时保存…' : mode === 'create' ? '保存策略组合' : '保存两个新版本' }}</Button></div></footer>
    </DialogContent>
  </Dialog>
  <AlertDialog :open="discardOpen" @update:open="discardOpen = $event"><AlertDialogContent><AlertDialogHeader><AlertDialogTitle>放弃未保存的修改？</AlertDialogTitle><AlertDialogDescription>分析与交易提示词的本次修改都会丢失。</AlertDialogDescription></AlertDialogHeader><AlertDialogFooter><AlertDialogCancel>继续编辑</AlertDialogCancel><Button variant="destructive" @click="discard">放弃修改</Button></AlertDialogFooter></AlertDialogContent></AlertDialog>
</template>
