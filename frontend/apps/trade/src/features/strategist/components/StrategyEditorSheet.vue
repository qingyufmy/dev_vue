<script setup lang="ts">
import { ArrowLeft, CheckCircle2, RefreshCw, Save } from '@lucide/vue'
import { computed, reactive, ref, toRaw, watch } from 'vue'
import { Badge } from '@aurum/ui/badge'
import { Button } from '@aurum/ui/button'
import { Field, FieldDescription, FieldLabel } from '@aurum/ui/field'
import { Input } from '@aurum/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@aurum/ui/select'
import { Alert, AlertDescription, AlertTitle } from '@aurum/ui/alert'
import { AlertDialog, AlertDialogContent, AlertDialogHeader, AlertDialogTitle, AlertDialogDescription, AlertDialogFooter, AlertDialogCancel } from '@aurum/ui/alert-dialog'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@aurum/ui/tabs'
import { Textarea } from '@aurum/ui/textarea'
import type { CompileResultView, StrategyCombinationDraft, StrategyVersionView } from '../model/strategy-presentation'
import { defaultConfig, defaultPrompt } from '../model/strategy-presentation'
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
const convertOpen = ref(false)
const activeTab = ref('analysis')
const independent = computed(() => form.analysisConfig.responsibility_mode === 'independent_roles_v2' && form.traderConfig.responsibility_mode === 'independent_roles_v2')
const symbols = computed(() => Array.isArray(form.analysisConfig.symbols) ? form.analysisConfig.symbols.join('、') : '')
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
    status: props.strategyStatus === 'active' ? 'active' : 'draft', analysisPromptText: props.baseVersion?.promptText ?? defaultPrompt('analysis'), analysisConfig,
    traderPromptText: props.traderBaseVersion?.promptText ?? defaultPrompt('trader'), traderConfig: structuredClone(toRaw(props.traderBaseVersion?.config ?? defaultConfig('trader'))),
  })
  localError.value = ''; discardOpen.value = false; initialForm.value = JSON.stringify(form)
}
function requestClose() { if (!props.submitting && !props.compiling) JSON.stringify(form) !== initialForm.value ? discardOpen.value = true : emit('update:open', false) }
function discard() { discardOpen.value = false; emit('update:open', false) }
function convertToIndependent() {
  const shared = Array.isArray(form.analysisConfig.symbols) ? structuredClone(toRaw(form.analysisConfig.symbols)) : []
  const analysisModel = form.analysisConfig.model_profile_id
  const traderModel = form.traderConfig.model_profile_id
  form.analysisConfig = { ...defaultConfig('analysis'), symbols: shared, ...(analysisModel ? { model_profile_id: analysisModel } : {}) }
  form.traderConfig = { ...defaultConfig('trader'), symbols: shared, ...(traderModel ? { model_profile_id: traderModel } : {}) }
  form.analysisPromptText = defaultPrompt('analysis')
  form.traderPromptText = defaultPrompt('trader')
  convertOpen.value = false
  activeTab.value = 'analysis'
}
function setSymbols(value: string | number) {
  const next = [...new Set(String(value).toUpperCase().split(/[\s,，、;；]+/).filter(Boolean))]
  form.analysisConfig = { ...form.analysisConfig, symbols: next }
  form.traderConfig = { ...form.traderConfig, symbols: next }
}
function validate() {
  if (draft.value.name.length < 2 || draft.value.name.length > 191) { activeTab.value = 'review'; return fail('策略名称需填写 2 至 191 个字符') }
  if (draft.value.description.length > 2000) return fail('策略说明不能超过 2000 个字符')
  if (draft.value.analysisPromptText.length < 20) { activeTab.value = 'analysis'; return fail('分析策略提示词至少需要 20 个字符') }
  if (draft.value.traderPromptText.length < 20) { activeTab.value = 'trader'; return fail('交易策略提示词至少需要 20 个字符') }
  if (Array.isArray(form.traderConfig.entry_methods) && !form.traderConfig.entry_methods.length) { activeTab.value = 'trader'; return fail('请至少选择一种入场方式') }
  localError.value = ''; return true
}
function submit() { if (!props.submitting && !props.compiling && validate()) emit('submit', draft.value) }
function fail(message: string) { localError.value = message; return false }
watch(() => props.open, open => { if (open) { reset(); activeTab.value = 'analysis' } }, { immediate: true })
</script>

<template>
  <div v-if="open" class="mx-auto grid w-full max-w-6xl gap-5 pb-8">
    <header class="flex flex-col gap-3 border-b pb-5 sm:flex-row sm:items-end sm:justify-between">
      <div><Button variant="ghost" class="mb-2 -ml-3" :disabled="submitting || compiling" @click="requestClose"><ArrowLeft />返回策略详情</Button><h1 class="text-2xl font-semibold tracking-tight">{{ mode === 'create' ? '新建策略' : `编辑：${strategyName}` }}</h1><p class="mt-1 text-sm text-muted-foreground">一个策略组合内分别维护市场背景与账户交易，两侧配置原子保存。</p></div>
      <div class="flex flex-wrap items-center gap-2"><Badge variant="outline">{{ independent ? '独立职责' : '旧版策略' }}</Badge><Button v-if="mode === 'version' && !independent" variant="outline" size="sm" type="button" @click="convertOpen = true"><RefreshCw />转换为独立职责</Button></div>
    </header>
    <form @submit.prevent="submit">
      <fieldset :disabled="submitting || compiling" class="grid min-w-0 gap-5">
          <section class="grid gap-4 rounded-xl border bg-muted/20 p-4 sm:grid-cols-2" aria-label="组合信息">
            <Field><FieldLabel for="strategy-name">组合名称</FieldLabel><Input id="strategy-name" v-model.trim="form.name" maxlength="191" placeholder="例如：黄金多周期趋势策略" /><FieldDescription>客户在策略库和账户订阅中看到的名称。</FieldDescription></Field>
            <Field><FieldLabel for="strategy-symbols">支持品种</FieldLabel><Input id="strategy-symbols" :model-value="symbols" placeholder="XAUUSD、EURUSD" @change="setSymbols(($event.target as HTMLInputElement).value)" /><FieldDescription>组合两侧使用同一标准品种范围。</FieldDescription></Field>
            <Field v-if="mode === 'version'"><FieldLabel for="strategy-status">组合状态</FieldLabel><Select v-model="form.status"><SelectTrigger id="strategy-status"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="active">启用</SelectItem><SelectItem value="draft">停用</SelectItem></SelectContent></Select><FieldDescription>两条策略会一起切换到相同状态。</FieldDescription></Field>
            <Field :class="mode === 'version' ? '' : 'sm:col-span-2'"><FieldLabel for="strategy-description">策略说明</FieldLabel><Textarea id="strategy-description" v-model="form.description" class="min-h-20 resize-y" maxlength="2000" placeholder="说明适用市场、核心方法与不适用条件" /></Field>
          </section>
          <StrategyCompileResult v-if="error || localError" :result="null" :error="error || localError" />
          <Tabs v-model="activeTab" class="min-w-0 flex-col">
            <TabsList class="h-auto w-full justify-start overflow-x-auto"><TabsTrigger value="analysis" class="min-h-11">行情分析师</TabsTrigger><TabsTrigger value="trader" class="min-h-11">AI 交易员</TabsTrigger><TabsTrigger value="review" class="min-h-11">检查与保存</TabsTrigger></TabsList>
            <TabsContent value="analysis" force-mount class="mt-4 data-[state=inactive]:hidden"><section class="grid min-w-0 content-start gap-5 rounded-xl border p-4 sm:p-6" aria-label="分析策略">
              <div class="flex items-start justify-between gap-3"><div><h3 class="font-semibold">行情分析策略</h3><p class="mt-1 text-xs leading-5 text-muted-foreground">读取行情证据，识别方向、结构与机会，不直接决定账户下单。</p></div><Badge variant="outline">分析师</Badge></div>
              <Alert v-if="independent"><CheckCircle2 /><AlertTitle>市场背景职责</AlertTitle><AlertDescription>使用 H1/H4 缠论证据判断趋势、阶段与关键区域；机会字段不再作为交易许可。</AlertDescription></Alert>
              <StrategyRuntimeSettings v-model="form.analysisConfig" id-prefix="analysis" :show-symbols="false" :trader="false" :platform="Boolean(platform)" />
              <StrategyDataSettings v-model="form.analysisConfig" role="analysis" :independent="independent" />
              <Field><FieldLabel for="analysis-prompt">分析策略提示词</FieldLabel><Textarea id="analysis-prompt" v-model="form.analysisPromptText" class="min-h-80 resize-y text-sm leading-6" placeholder="描述行情证据、分析流程、机会判断、禁止猜测与输出合同…" /><FieldDescription>证据不足时应明确观望，不要补造行情事实。</FieldDescription></Field>
              <StrategyCompileResult v-if="analysisCompileResult && !analysisCompileResult.valid" :result="analysisCompileResult" />
            </section></TabsContent>
            <TabsContent value="trader" force-mount class="mt-4 data-[state=inactive]:hidden"><section class="grid min-w-0 content-start gap-5 rounded-xl border p-4 sm:p-6" aria-label="交易策略">
              <div class="flex items-start justify-between gap-3"><div><h3 class="font-semibold">交易执行策略</h3><p class="mt-1 text-xs leading-5 text-muted-foreground">结合分析结论、账户状态和持仓，提出账户级交易动作。</p></div><Badge variant="outline">交易员</Badge></div>
              <Alert v-if="independent"><CheckCircle2 /><AlertTitle>独立机会识别</AlertTitle><AlertDescription>读取最新 M15/M5 价格行为，不接收缠论原始结构；背景过期时只允许管理已有持仓和挂单。</AlertDescription></Alert>
              <StrategyRuntimeSettings v-model="form.traderConfig" id-prefix="trader" :show-symbols="false" trader :platform="Boolean(platform)" />
              <StrategyDataSettings v-model="form.traderConfig" role="trader" :independent="independent" />
              <Field><FieldLabel for="trader-prompt">交易策略提示词</FieldLabel><Textarea id="trader-prompt" v-model="form.traderPromptText" class="min-h-80 resize-y text-sm leading-6" placeholder="描述账户约束、入场与退出判断、风险条件、保持动作与输出合同…" /><FieldDescription>交易员只提出结构化动作，确定性服务端风控仍独立审核。</FieldDescription></Field>
              <StrategyCompileResult v-if="traderCompileResult && !traderCompileResult.valid" :result="traderCompileResult" />
            </section></TabsContent>
            <TabsContent value="review" class="mt-4"><section class="grid gap-5 rounded-xl border p-4 sm:p-6"><div><h3 class="font-semibold">保存前检查</h3><p class="mt-1 text-sm text-muted-foreground">确认共同范围和两侧职责。保存会在一个事务中完成，不会产生半套新版本。</p></div><div class="grid gap-3 sm:grid-cols-2"><div class="rounded-lg border p-4"><p class="text-xs text-muted-foreground">行情分析师</p><p class="mt-2 font-medium">H1/H4 · 缠论背景</p><p class="mt-1 text-xs text-muted-foreground">正文 {{ form.analysisPromptText.length }} 字</p></div><div class="rounded-lg border p-4"><p class="text-xs text-muted-foreground">AI 交易员</p><p class="mt-2 font-medium">M15/M5 · 价格行为</p><p class="mt-1 text-xs text-muted-foreground">正文 {{ form.traderPromptText.length }} 字</p></div></div><StrategyCompileResult v-if="error || localError" :result="null" :error="error || localError" /></section></TabsContent>
          </Tabs>
      </fieldset>
    </form>
    <footer class="sticky bottom-0 z-10 flex flex-col gap-3 border-t bg-background/95 py-4 backdrop-blur sm:flex-row sm:items-center sm:justify-between"><p class="text-xs text-muted-foreground">{{ JSON.stringify(form) !== initialForm ? '有未保存的修改' : '没有未保存的修改' }}</p><div class="flex justify-end gap-2"><Button variant="ghost" size="lg" :disabled="submitting || compiling" @click="requestClose">取消</Button><Button size="lg" :disabled="submitting || compiling" :aria-busy="submitting || compiling" @click="submit"><Save />{{ compiling ? '正在检查两份策略…' : submitting ? '正在保存策略…' : '保存策略' }}</Button></div></footer>
  </div>
  <AlertDialog :open="discardOpen" @update:open="discardOpen = $event"><AlertDialogContent><AlertDialogHeader><AlertDialogTitle>放弃未保存的修改？</AlertDialogTitle><AlertDialogDescription>分析与交易提示词的本次修改都会丢失。</AlertDialogDescription></AlertDialogHeader><AlertDialogFooter><AlertDialogCancel>继续编辑</AlertDialogCancel><Button variant="destructive" @click="discard">放弃修改</Button></AlertDialogFooter></AlertDialogContent></AlertDialog>
  <AlertDialog :open="convertOpen" @update:open="convertOpen = $event"><AlertDialogContent><AlertDialogHeader><AlertDialogTitle>转换为独立职责策略？</AlertDialogTitle><AlertDialogDescription>将保留组合名称、说明、支持品种和两侧模型；分析师改为 H1/H4 缠论背景，交易员改为 M15/M5 价格行为，并用新版正文替换当前两份提示词。转换只修改本地表单，检查后点击“保存策略”才会生效，也不会开启任何账户开关。</AlertDialogDescription></AlertDialogHeader><AlertDialogFooter><AlertDialogCancel>取消</AlertDialogCancel><Button @click="convertToIndependent"><RefreshCw />确认转换</Button></AlertDialogFooter></AlertDialogContent></AlertDialog>
</template>
