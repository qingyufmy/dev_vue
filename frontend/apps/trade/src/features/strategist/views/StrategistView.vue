<script setup lang="ts">
import { AlertCircle, BrainCircuit, CheckCircle2, Library, Network, ShieldAlert } from '@lucide/vue'
import type { StrategyKind, StrategySummary } from '@aurum/contracts'
import { computed, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { Alert, AlertDescription, AlertTitle } from '@aurum/ui/alert'
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from '@aurum/ui/alert-dialog'
import { Badge } from '@aurum/ui/badge'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@aurum/ui/tabs'
import StrategyCatalog from '../components/StrategyCatalog.vue'
import StrategyDetail from '../components/StrategyDetail.vue'
import StrategyEditorSheet from '../components/StrategyEditorSheet.vue'
import StrategyMetadataSheet from '../components/StrategyMetadataSheet.vue'
import SubscriptionEditorSheet from '../components/SubscriptionEditorSheet.vue'
import SubscriptionWorkspace from '../components/SubscriptionWorkspace.vue'
import { useStrategistWorkspace } from '../composables/use-strategist-workspace'
import type { StrategyDetailView, StrategyDraft, StrategySection, StrategySubscriptionView, SubscriptionDraft } from '../model/strategy-presentation'

const route = useRoute()
const router = useRouter()
const workspace = useStrategistWorkspace()
const editorOpen = ref(false)
const editorMode = ref<'create' | 'version'>('create')
const editorKind = ref<StrategyKind>('analysis')
const editorBase = ref<StrategyDetailView | null>(null)
const metadataOpen = ref(false)
const metadataStrategy = ref<StrategySummary | null>(null)
const retireOpen = ref(false)
const pendingPublishVersionId = ref('')
const subscriptionOpen = ref(false)
const editingSubscription = ref<StrategySubscriptionView | null>(null)
const endingSubscription = ref<StrategySubscriptionView | null>(null)

const section = computed<StrategySection>(() => route.query.section === 'subscriptions' ? 'subscriptions' : 'library')
const kind = computed<StrategyKind>(() => route.query.kind === 'trader' ? 'trader' : 'analysis')
const selectedStrategyId = computed(() => typeof route.query.strategy_id === 'string' ? route.query.strategy_id : '')
const selectedAccountId = computed(() => typeof route.query.account_id === 'string' ? route.query.account_id : '')
const latestVersion = computed(() => workspace.detail.value?.versions.reduce((latest, item) => !latest || item.versionNumber > latest.versionNumber ? item : latest, undefined as StrategyDetailView['versions'][number] | undefined) ?? null)

function updateQuery(patch: Record<string, string | undefined>) {
  const query = { ...route.query }
  for (const [key, value] of Object.entries(patch)) {
    if (value) query[key] = value
    else delete query[key]
  }
  void router.replace({ path: '/strategist', query })
}

function changeSection(value: string | number) {
  if (value === 'library') updateQuery({ section: undefined })
  if (value === 'subscriptions') updateQuery({ section: 'subscriptions' })
}

function changeKind(value: StrategyKind) {
  const first = workspace.strategies.value.find((item) => item.kind === value)
  updateQuery({ kind: value === 'analysis' ? undefined : value, strategy_id: first?.id })
}

function selectStrategy(id: string) { updateQuery({ strategy_id: id }) }

function openCreate(value: StrategyKind) {
  workspace.clearCompile()
  editorMode.value = 'create'
  editorKind.value = value
  editorBase.value = null
  editorOpen.value = true
}

function openVersion(value: StrategyDetailView) {
  workspace.clearCompile()
  editorMode.value = 'version'
  editorKind.value = value.strategy.kind
  editorBase.value = value
  editorOpen.value = true
}

function openMetadata(value: StrategySummary) { metadataStrategy.value = value; metadataOpen.value = true }

async function saveStrategy(draft: StrategyDraft) {
  if (editorMode.value === 'create') {
    const id = await workspace.createStrategy(draft)
    if (id) { editorOpen.value = false; updateQuery({ kind: draft.kind === 'analysis' ? undefined : draft.kind, strategy_id: id }) }
  } else if (await workspace.createVersion(draft)) editorOpen.value = false
}

async function saveMetadata(value: { name: string; description: string }) {
  if (await workspace.updateMetadata(value.name, value.description)) metadataOpen.value = false
}

async function retire() { if (await workspace.retire()) retireOpen.value = false }
async function publish() {
  if (!pendingPublishVersionId.value) return
  if (await workspace.publish(pendingPublishVersionId.value)) pendingPublishVersionId.value = ''
}

function openSubscriptionEditor(item?: StrategySubscriptionView) { editingSubscription.value = item ?? null; subscriptionOpen.value = true }
async function saveSubscription(draft: SubscriptionDraft) { if (await workspace.saveSubscription(draft, editingSubscription.value)) subscriptionOpen.value = false }
async function endSubscription() { if (endingSubscription.value && await workspace.endSubscription(endingSubscription.value)) endingSubscription.value = null }

watch([() => workspace.loading.value, () => workspace.strategies.value, kind], ([loading]) => {
  if (loading) return
  const visible = workspace.strategies.value.filter((item) => item.kind === kind.value)
  if (!visible.some((item) => item.id === selectedStrategyId.value)) updateQuery({ strategy_id: visible[0]?.id })
}, { immediate: true })
watch(selectedStrategyId, (id) => { void workspace.loadDetail(id) }, { immediate: true })
watch([() => workspace.loading.value, () => workspace.accounts.value, selectedAccountId, section], ([loading]) => {
  if (loading || section.value !== 'subscriptions') return
  const id = workspace.accounts.value.some((item) => item.id === selectedAccountId.value) ? selectedAccountId.value : workspace.accounts.value[0]?.id ?? ''
  if (id !== selectedAccountId.value) updateQuery({ account_id: id || undefined })
  else void workspace.loadSubscriptions(id)
}, { immediate: true })
</script>

<template>
  <div class="mx-auto grid w-full max-w-[1680px] gap-4 p-3 sm:p-5 lg:p-6">
    <header class="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
      <div>
        <div class="flex items-center gap-2 text-xs font-medium text-primary"><BrainCircuit class="size-4" aria-hidden="true" />AI 交易团队</div>
        <h1 class="mt-1 text-2xl font-semibold tracking-tight">AI 策略师</h1>
        <p class="mt-1 max-w-3xl text-sm leading-6 text-muted-foreground">管理行情分析与交易执行两类策略。提示词版本保持不可变，账户订阅只绑定已发布版本。</p>
      </div>
      <Badge variant="outline"><ShieldAlert />策略不能绕过平台安全边界</Badge>
    </header>

    <Alert v-if="workspace.error.value" variant="destructive"><AlertCircle /><AlertTitle>策略工作区读取失败</AlertTitle><AlertDescription>{{ workspace.error.value }}</AlertDescription></Alert>
    <Alert v-if="workspace.actionError.value" variant="destructive"><AlertCircle /><AlertTitle>策略操作没有完成</AlertTitle><AlertDescription>{{ workspace.actionError.value }}</AlertDescription></Alert>
    <Alert v-if="workspace.notice.value"><CheckCircle2 /><AlertTitle>操作已完成</AlertTitle><AlertDescription>{{ workspace.notice.value }}</AlertDescription></Alert>

    <Tabs :model-value="section" @update:model-value="changeSection">
      <TabsList class="h-auto w-full justify-start overflow-x-auto sm:w-auto">
        <TabsTrigger value="library" class="min-h-11"><Library />策略库与版本</TabsTrigger>
        <TabsTrigger value="subscriptions" class="min-h-11"><Network />账户订阅</TabsTrigger>
      </TabsList>

      <TabsContent value="library" class="mt-4">
        <div class="grid min-w-0 gap-4 xl:grid-cols-[21rem_minmax(0,1fr)]">
          <StrategyCatalog :items="workspace.strategies.value" :selected-id="selectedStrategyId" :loading="workspace.loading.value" :kind="kind" @select="selectStrategy" @create="openCreate" @kind-change="changeKind" />
          <StrategyDetail :detail="workspace.detail.value" :loading="workspace.detailLoading.value" :busy="workspace.submitting.value" @edit-meta="openMetadata" @new-version="openVersion" @publish="pendingPublishVersionId = $event" @retire="retireOpen = true" />
        </div>
      </TabsContent>

      <TabsContent value="subscriptions" class="mt-4">
        <SubscriptionWorkspace
          :account-id="selectedAccountId"
          :accounts="workspace.accounts.value"
          :strategies="workspace.strategies.value"
          :subscriptions="workspace.subscriptions.value"
          :loading="workspace.loading.value || workspace.subscriptionLoading.value"
          :refreshing="workspace.refreshing.value"
          @account-change="updateQuery({ account_id: $event })"
          @create="openSubscriptionEditor()"
          @edit="openSubscriptionEditor"
          @end="endingSubscription = $event"
          @refresh="workspace.refreshSubscriptions(selectedAccountId)"
        />
      </TabsContent>
    </Tabs>

    <StrategyEditorSheet
      v-model:open="editorOpen"
      :mode="editorMode"
      :kind="editorKind"
      :strategy-name="editorBase?.strategy.name"
      :base-version="editorMode === 'version' ? latestVersion : null"
      :compile-result="workspace.compileResult.value"
      :compiling="workspace.compiling.value"
      :submitting="workspace.submitting.value"
      :error="workspace.actionError.value"
      @compile="workspace.compile"
      @submit="saveStrategy"
    />
    <StrategyMetadataSheet v-model:open="metadataOpen" :strategy="metadataStrategy" :submitting="workspace.submitting.value" :error="workspace.actionError.value" @submit="saveMetadata" />
    <SubscriptionEditorSheet
      v-model:open="subscriptionOpen"
      :account-id="selectedAccountId"
      :accounts="workspace.accounts.value"
      :strategies="workspace.strategies.value"
      :subscription="editingSubscription"
      :symbols="workspace.symbols.value"
      :submitting="workspace.submitting.value"
      :error="workspace.actionError.value"
      @submit="saveSubscription"
    />

    <AlertDialog :open="retireOpen" @update:open="retireOpen = $event">
      <AlertDialogContent><AlertDialogHeader><AlertDialogTitle>确认退役这条策略？</AlertDialogTitle><AlertDialogDescription>退役后不能再创建版本或作为新订阅使用，现有订阅也会停止生成新任务；订阅本身、历史版本、运行记录和审计证据都会保留。此操作不会自动平仓或撤单。</AlertDialogDescription></AlertDialogHeader><AlertDialogFooter><AlertDialogCancel>取消</AlertDialogCancel><AlertDialogAction variant="destructive" :disabled="workspace.submitting.value" @click="retire">确认退役</AlertDialogAction></AlertDialogFooter></AlertDialogContent>
    </AlertDialog>
    <AlertDialog :open="Boolean(pendingPublishVersionId)" @update:open="!$event && (pendingPublishVersionId = '')">
      <AlertDialogContent><AlertDialogHeader><AlertDialogTitle>发布这个策略版本？</AlertDialogTitle><AlertDialogDescription>发布后，它会成为当前生效版本；引用这条策略且尚未结束的账户订阅会切换到该版本。已经保存的历史分析、决定和执行记录不会改变。</AlertDialogDescription></AlertDialogHeader><AlertDialogFooter><AlertDialogCancel>取消</AlertDialogCancel><AlertDialogAction :disabled="workspace.submitting.value" @click="publish">确认发布</AlertDialogAction></AlertDialogFooter></AlertDialogContent>
    </AlertDialog>
    <AlertDialog :open="Boolean(endingSubscription)" @update:open="!$event && (endingSubscription = null)">
      <AlertDialogContent><AlertDialogHeader><AlertDialogTitle>结束 {{ endingSubscription?.symbol }} 的账户订阅？</AlertDialogTitle><AlertDialogDescription>结束后不再生成新的自动分析或账户级交易判断；历史分析、决定和执行记录会保留。此操作不会自动平仓或撤单。</AlertDialogDescription></AlertDialogHeader><AlertDialogFooter><AlertDialogCancel>取消</AlertDialogCancel><AlertDialogAction variant="destructive" :disabled="workspace.submitting.value" @click="endSubscription">确认结束</AlertDialogAction></AlertDialogFooter></AlertDialogContent>
    </AlertDialog>
  </div>
</template>
