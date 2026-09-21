<script setup lang="ts">
import { AccountExecutionHistory } from '~/features/audit'
import { contextCommandState } from '~/features/trading-context'
import type { ExecutionCommand, ExecutionDistribution, OpenPosition, Operation, PendingOrder } from '@aurum/contracts'
import { AlertCircle, Cable, Eye, HandCoins, Plus, RefreshCw } from '@lucide/vue'
import { computed, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { toast } from '@aurum/ui/sonner'
import { Alert, AlertDescription, AlertTitle } from '@aurum/ui/alert'
import { Button } from '@aurum/ui/button'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@aurum/ui/tabs'
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from '@aurum/ui/empty'
import InventoryDetailSheet from '../components/InventoryDetailSheet.vue'
import InventoryWorkspace from '../components/InventoryWorkspace.vue'
import TraderAccountSummary from '../components/TraderAccountSummary.vue'
import TraderCommandSheet from '../components/TraderCommandSheet.vue'
import TraderDangerConfirm from '../components/TraderDangerConfirm.vue'
import TraderDecisionDetail from '../components/TraderDecisionDetail.vue'
import TraderDecisionHistory from '../components/TraderDecisionHistory.vue'
import TraderOperationCenter from '../components/TraderOperationCenter.vue'
import TraderResourceEditDialog from '../components/TraderResourceEditDialog.vue'
import { useTraderCommands } from '../composables/use-trader-commands'
import { useTraderWorkspace } from '../composables/use-trader-workspace'
import type { TraderEntryCommandDraft, TraderResourceEditDraft } from '../model/trader-command-drafts'
import { buildAccountEntryCommand, buildDistributionEntryCommand, buildResourceDestructiveCommand, buildResourceEditCommand } from '../model/trader-command-builder'
import { actionLabel, isPosition, statusLabel } from '../model/trader-presentation'

const route = useRoute()
const router = useRouter()
const resourceOpen = ref(false)
const resourceSelection = ref<{ kind: 'position' | 'order'; ticket: string } | null>(null)
const commandOpen = ref(false)
const distributionOpen = ref(false)
const resourceEditOpen = ref(false)
const editingResource = ref<OpenPosition | PendingOrder | null>(null)
const actionError = ref('')
type ConfirmSummary = { command: string; symbol?: string; ticket?: string; volume?: string; price?: string; stopLoss?: string; takeProfit?: string; scope: string; detail?: string }
type PendingAction =
  | { kind: 'command'; accountId: string; payload: ExecutionCommand; summary: ConfirmSummary }
  | { kind: 'distribution'; payload: ExecutionDistribution; summary: ConfirmSummary }
  | { kind: 'distribution_close'; distributionId: string; expectedRevision: string; summary: ConfirmSummary }
const pendingAction = ref<PendingAction | null>(null)
const terminalOperationStatuses = new Set(['succeeded', 'partially_succeeded', 'rejected', 'failed', 'uncertain', 'cancelled', 'expired'])
type InventoryBaseline = { positionsRevision: number; pendingOrdersRevision: number }
type OperationFeedback = { command: string; status: string; ticket?: string; baseline: InventoryBaseline }
const pendingOperationFeedback = new Map<string, OperationFeedback>()
const activeTab = computed({
  get: () => ['decisions','inventory','operations'].includes(String(route.query.tab)) ? String(route.query.tab) : 'decisions',
  set: (value: string) => {
    if (route.path !== '/trader') return
    const query = { ...route.query }
    if (value === 'decisions') delete query.tab
    else query.tab = value
    void router.replace({ path: '/trader', query })
  },
})
const executionDecisionId = ref('')
function navigateDecision(tab: 'operations' | 'inventory') {
  executionDecisionId.value = tab === 'operations' ? selectedDecisionId.value : ''
  activeTab.value = tab
}
const selectedDecisionId = computed(() => typeof route.query.decision_id === 'string' ? route.query.decision_id : '')

function selectDecision(id: string) {
  if (route.path !== '/trader' || id === selectedDecisionId.value) return
  const query = { ...route.query }
  if (id) query.decision_id = id
  else delete query.decision_id
  void router.replace({ path: '/trader', query })
}

const commands = useTraderCommands()
const workspace = useTraderWorkspace(selectedDecisionId, selectDecision, commands.handleOperationChanged)
const selectedResource = computed(() => {
  const selection = resourceSelection.value
  if (!selection) return null
  return selection.kind === 'position'
    ? workspace.positions.value.find((item) => item.ticket === selection.ticket) ?? null
    : workspace.pendingOrders.value.find((item) => item.ticket === selection.ticket) ?? null
})
const surfaceReadOnly = computed(() => Boolean(contextCommandState.value.intent) || workspace.isObserver.value || workspace.context.value?.readOnly !== false)
const readOnly = computed(() => surfaceReadOnly.value || workspace.account.value?.tradePermission !== true)
const traderStrategies = computed(() => workspace.strategies.value.filter((item) => item.kind === 'trader' && item.status === 'active' && item.activeVersionId))
const defaultSymbol = computed(() => workspace.symbols.value[0] ?? workspace.positions.value[0]?.symbol ?? workspace.pendingOrders.value[0]?.symbol ?? '')

function inspectResource(kind: 'position' | 'order', ticket: string) {
  resourceSelection.value = { kind, ticket }
  resourceOpen.value = true
}

async function openCommand(distribution: boolean) {
  if (!workspace.activeAccountId.value || !defaultSymbol.value || (distribution ? surfaceReadOnly.value : readOnly.value)) return
  actionError.value = ''
  const context = await commands.prepareCommand(workspace.activeAccountId.value, defaultSymbol.value)
  if (!context) return
  if (distribution) distributionOpen.value = true
  else commandOpen.value = true
}

async function changeCommandSymbol(symbol: string) {
  if (!workspace.activeAccountId.value) return
  await commands.prepareCommand(workspace.activeAccountId.value, symbol)
}

function requestEntryConfirmation(draft: TraderEntryCommandDraft, distribution: boolean) {
  const context = commands.commandContext.value
  if (!context || context.symbol !== draft.symbol) return failAction('交易上下文已变化，请重新选择品种后再提交。')
  const summary: ConfirmSummary = {
    command: draft.command_type,
    symbol: draft.symbol,
    volume: draft.volume,
    price: draft.command_type === 'pending_order' ? draft.price : draft.reference_price,
    stopLoss: draft.stop_loss,
    takeProfit: draft.take_profit,
    scope: distribution ? '分发给受理时仍符合资格、且订阅所选交易策略的全部账户' : '仅作用于当前交易账户',
    detail: distribution ? '预览仅用于核对；服务端会在受理时重新校验并冻结本次目标账户。' : undefined,
  }
  if (distribution) {
    if (!draft.strategy_id) return failAction('请选择用于分发的交易策略。')
    const preview = commands.distributionPreview.value
    if (!preview || preview.strategyId !== draft.strategy_id || preview.symbol !== draft.symbol) return failAction('请先刷新并核对当前策略的分发目标预览。')
    pendingAction.value = {
      kind: 'distribution',
      payload: { strategy_id: draft.strategy_id, command: buildDistributionEntryCommand(draft) },
      summary,
    }
  } else {
    pendingAction.value = { kind: 'command', accountId: context.accountId, payload: buildAccountEntryCommand(draft, context), summary }
  }
}

async function modifyResource(resource: OpenPosition | PendingOrder) {
  if (!workspace.activeAccountId.value || readOnly.value) return
  resourceOpen.value = false
  actionError.value = ''
  const context = await commands.prepareCommand(workspace.activeAccountId.value, resource.symbol, resource.ticket)
  if (!context?.targetRevision) return failAction('资源版本暂时不可用，请刷新账户后重试。')
  editingResource.value = resource
  resourceEditOpen.value = true
}

function requestResourceEditConfirmation(draft: TraderResourceEditDraft) {
  const resource = editingResource.value
  const context = commands.commandContext.value
  if (!resource || !context?.targetRevision || context.ticket !== resource.ticket) return failAction('交易资源已经变化，请重新打开详情。')
  const payload = buildResourceEditCommand(resource, draft, context)
  if (!payload) return failAction('交易资源已经变化，请重新打开详情。')
  pendingAction.value = {
    kind: 'command', accountId: context.accountId, payload,
    summary: { command: payload.command_type, symbol: resource.symbol, ticket: resource.ticket, price: draft.price, stopLoss: draft.stop_loss, takeProfit: draft.take_profit, scope: '仅修改当前账户中这一笔交易资源' },
  }
}

async function requestResourceDestructive(resource: OpenPosition | PendingOrder) {
  if (!workspace.activeAccountId.value || readOnly.value) return
  resourceOpen.value = false
  actionError.value = ''
  const context = await commands.prepareCommand(workspace.activeAccountId.value, resource.symbol, resource.ticket)
  if (!context?.targetRevision) return failAction('资源版本暂时不可用，请刷新账户后重试。')
  const payload = buildResourceDestructiveCommand(resource, context)
  if (!payload) return failAction('交易资源已经变化，请重新打开详情。')
  pendingAction.value = {
    kind: 'command', accountId: context.accountId, payload,
    summary: { command: payload.command_type, symbol: resource.symbol, ticket: resource.ticket, volume: resource.volume, price: isPosition(resource) ? resource.currentPrice : resource.price, stopLoss: resource.stopLoss ?? undefined, takeProfit: resource.takeProfit ?? undefined, scope: '仅作用于当前账户中这一笔交易资源' },
  }
}

function requestDistributionClose() {
  const distribution = commands.activeDistribution.value
  if (!distribution || distribution.kind !== 'manual_order') return
  pendingAction.value = {
    kind: 'distribution_close', distributionId: distribution.id, expectedRevision: distribution.revision,
    summary: { command: 'distribution_close', scope: `仅平仓本次分发中仍可精确归因的成功持仓；原始目标 ${distribution.targetCount} 个`, detail: '不会按品种或相似订单猜测目标，也不会触碰无法精确归因的持仓。' },
  }
}

async function confirmAction() {
  const action = pendingAction.value
  if (!action) return
  const baseline = workspace.inventoryRevisions.value
  const operation = action.kind === 'command'
    ? await commands.submitCommand(action.accountId, action.payload)
    : action.kind === 'distribution'
      ? await commands.submitDistributionCommand(action.payload)
      : await commands.submitDistributionClose(action.distributionId, action.expectedRevision)
  if (!operation) {
    toast.error('交易指令提交失败', {
      description: commands.error.value || '请核对连接、账户状态和交易参数后重试。',
      duration: 5000,
    })
    return
  }
  pendingAction.value = null
  commandOpen.value = false
  distributionOpen.value = false
  resourceEditOpen.value = false
  showOperationFeedback(operation, action.summary.command)
  if (!terminalOperationStatuses.has(operation.status)) {
    pendingOperationFeedback.set(operation.operationId, {
      command: action.summary.command,
      status: operation.status,
      ticket: action.summary.ticket,
      baseline,
    })
    await workspace.refresh()
    return
  }
  await refreshAfterTerminalOperation(operation, {
    command: action.summary.command,
    status: operation.status,
    ticket: action.summary.ticket,
    baseline,
  })
}

async function refreshAfterTerminalOperation(operation: Operation, feedback: OperationFeedback) {
  if (operation.status === 'succeeded') {
    await workspace.reconcileInventory({
      command: feedback.command,
      ticket: feedback.ticket,
      positionsRevision: feedback.baseline.positionsRevision,
      pendingOrdersRevision: feedback.baseline.pendingOrdersRevision,
    })
  } else await workspace.refresh()
  if (resourceSelection.value && !selectedResource.value) {
    resourceOpen.value = false
    resourceSelection.value = null
  }
  if (editingResource.value && !workspace.positions.value.some(item => item.ticket === editingResource.value?.ticket)
    && !workspace.pendingOrders.value.some(item => item.ticket === editingResource.value?.ticket)) {
    resourceEditOpen.value = false
    editingResource.value = null
    actionError.value = ''
    commands.clearPreparedState()
  }
}

function showOperationFeedback(operation: Operation, command: string) {
  const feedback = {
    description: `${actionLabel(command)}当前状态：${statusLabel(operation.status)}。当前页面会继续更新账户状态。`,
    duration: 5000,
    action: { label: '查看执行记录', onClick: () => { activeTab.value = 'operations' } },
  }
  if (operation.status === 'succeeded') toast.success('交易操作已完成', feedback)
  else if (['rejected', 'failed', 'cancelled', 'expired'].includes(operation.status)) toast.error('交易指令未完成', feedback)
  else if (['partially_succeeded', 'uncertain'].includes(operation.status)) toast.warning('交易结果需要核实', feedback)
  else toast.info('交易指令已受理', feedback)
}

function failAction(message: string) {
  actionError.value = message
}

watch(workspace.activeAccountId, () => {
  executionDecisionId.value = ''
  commandOpen.value = false
  distributionOpen.value = false
  resourceOpen.value = false
  resourceEditOpen.value = false
  resourceSelection.value = null
  editingResource.value = null
  pendingAction.value = null
  actionError.value = ''
  pendingOperationFeedback.clear()
  commands.clearPreparedState()
})

watch(commands.operations, (operations) => {
  for (const operation of operations) {
    const pending = pendingOperationFeedback.get(operation.operationId)
    if (!pending || pending.status === operation.status) continue
    pending.status = operation.status
    if (!terminalOperationStatuses.has(operation.status)) continue
    showOperationFeedback(operation, pending.command)
    pendingOperationFeedback.delete(operation.operationId)
    void refreshAfterTerminalOperation(operation, pending)
  }
}, { deep: true })
</script>

<template>
  <div class="mx-auto grid w-full max-w-[1680px] gap-4 p-3 sm:p-5 lg:p-6">
    <header class="flex flex-col gap-4 xl:flex-row xl:items-center xl:justify-between">
      <div>

        <h1 class="mt-1 text-2xl font-semibold tracking-tight">AI 交易员</h1>
        <p class="mt-1 max-w-2xl text-sm leading-6 text-muted-foreground">查看交易建议，管理当前账户的持仓与执行记录。</p>
      </div>
      <div class="flex flex-wrap items-center gap-2">

        <Button variant="outline" size="lg" :disabled="readOnly || !defaultSymbol" @click="openCommand(false)"><Plus />手动下单</Button>
        <Button v-if="commands.administrator.value" variant="outline" size="lg" :disabled="surfaceReadOnly || !defaultSymbol || !traderStrategies.length" @click="openCommand(true)"><HandCoins />策略分发</Button>
        <Button variant="outline" size="lg" :disabled="workspace.loading.value || workspace.refreshing.value" @click="workspace.refresh">
          <RefreshCw :class="workspace.refreshing.value ? 'animate-spin motion-reduce:animate-none' : ''" aria-hidden="true" />
          刷新账户
        </Button>
      </div>
    </header>

    <Alert v-if="workspace.error.value" variant="destructive">
      <AlertCircle aria-hidden="true" />
      <AlertTitle>交易员数据读取失败</AlertTitle>
      <AlertDescription>{{ workspace.error.value }}</AlertDescription>
    </Alert>

    <Alert v-if="workspace.isObserver.value">
      <Eye aria-hidden="true" />
      <AlertTitle>当前为观摩模式</AlertTitle>
      <AlertDescription>你可以查看来源账户的持仓和挂单；账户级 AI 交易决定与所有交易操作仅对账户所有者开放。</AlertDescription>
    </Alert>

    <Alert v-if="workspace.operationNotice.value">
      <RefreshCw aria-hidden="true" />
      <AlertTitle>执行状态已更新</AlertTitle>
      <AlertDescription>{{ workspace.operationNotice.value }}</AlertDescription>
    </Alert>

    <Alert v-if="actionError || commands.error.value" variant="destructive">
      <AlertCircle aria-hidden="true" />
      <AlertTitle>交易操作暂时无法继续</AlertTitle>
      <AlertDescription>{{ actionError || commands.error.value }}</AlertDescription>
    </Alert>

    <TraderAccountSummary
      v-if="workspace.activeAccountId.value"
      :accounts="workspace.accounts.value"
      :account-id="workspace.activeAccountId.value"
      :account="workspace.account.value"
      :snapshot="workspace.snapshot.value"
      :loading="workspace.loading.value"
      :switching="workspace.switching.value"
      :observer="workspace.isObserver.value"
      :realtime="workspace.realtime.value"
      @account-change="workspace.selectAccount"
      @refresh="workspace.refresh"
    />

    <Empty v-if="!workspace.loading.value && !workspace.activeAccountId.value" class="min-h-[28rem]">
      <EmptyHeader>
        <EmptyMedia variant="icon"><Cable /></EmptyMedia>
        <EmptyTitle>还没有可用的交易账户</EmptyTitle>
        <EmptyDescription>连接量见智桥并绑定交易账户后，持仓、挂单和账户级 AI 交易决定会显示在这里。</EmptyDescription>
      </EmptyHeader>
    </Empty>

    <template v-else-if="workspace.activeAccountId.value">
      <Tabs v-model="activeTab" class="min-w-0 flex-col gap-4">
        <TabsList variant="line" class="h-auto min-h-11 w-full justify-start border-b">
          <TabsTrigger value="decisions" class="min-h-11 flex-none rounded-none border-b-2 border-transparent px-4 data-[state=active]:border-primary data-[state=active]:text-primary">AI 决策</TabsTrigger>
          <TabsTrigger value="inventory" class="min-h-11 flex-none rounded-none border-b-2 border-transparent px-4 data-[state=active]:border-primary data-[state=active]:text-primary">持仓挂单 <span class="font-mono text-xs text-muted-foreground">{{ workspace.positions.value.length + workspace.pendingOrders.value.length }}</span></TabsTrigger>
          <TabsTrigger value="operations" class="min-h-11 flex-none rounded-none border-b-2 border-transparent px-4 data-[state=active]:border-primary data-[state=active]:text-primary">执行记录</TabsTrigger>
        </TabsList>
        <TabsContent value="decisions" class="min-w-0 m-0">
      <div class="grid min-w-0 gap-4" :class="workspace.decisions.value.length ? 'lg:grid-cols-[18rem_minmax(0,1fr)]' : ''">
        <TraderDecisionHistory
          :account-id="workspace.isObserver.value ? null : workspace.activeAccountId.value"
          :items="workspace.decisions.value"
          :strategies="workspace.strategies.value"
          :selected-id="selectedDecisionId"
          :loading="workspace.decisionsLoading.value"
          :refreshing="workspace.refreshing.value"
          :error="workspace.decisionsError.value"
          :timezone-offset-minutes="workspace.snapshot.value?.timezoneOffsetMinutes ?? null"
          @select="selectDecision"
        />
        <section v-if="workspace.decisions.value.length || selectedDecisionId" class="min-w-0" aria-label="AI 交易员决定详情">
          <TraderDecisionDetail
            @navigate="navigateDecision"
            :detail="workspace.detail.value"
            :strategies="workspace.strategies.value"
            :loading="workspace.detailLoading.value"
            :error="workspace.detailError.value"
            :timezone-offset-minutes="workspace.snapshot.value?.timezoneOffsetMinutes ?? null"
          />
        </section>
      </div>

        </TabsContent>
        <TabsContent value="inventory" class="min-w-0 m-0">
      <InventoryWorkspace
        :positions="workspace.positions.value"
        :orders="workspace.pendingOrders.value"
        :loading="workspace.loading.value"
        :read-only="readOnly"
        :timezone-offset-minutes="workspace.snapshot.value?.timezoneOffsetMinutes ?? null"
        @inspect="inspectResource"
      />

        </TabsContent>
        <TabsContent value="operations" class="min-w-0 m-0 space-y-4">
          <AccountExecutionHistory @detail-close="executionDecisionId = ''" :refresh-version="workspace.executionRefreshVersion.value" :decision-id="executionDecisionId" :account-id="workspace.activeAccountId.value" :read-only="workspace.isObserver.value" />
      <TraderOperationCenter v-if="commands.operations.value.length || commands.activeDistribution.value"
        :operations="commands.operations.value"
        :distribution="commands.activeDistribution.value"
        :loading="commands.submitting.value"
        :timezone-offset-minutes="workspace.snapshot.value?.timezoneOffsetMinutes ?? null"
        @close-distribution="requestDistributionClose"
      />
        </TabsContent>
      </Tabs>
    </template>

    <InventoryDetailSheet
      v-model:open="resourceOpen"
      :resource="selectedResource"
      :read-only="readOnly"
      :timezone-offset-minutes="workspace.snapshot.value?.timezoneOffsetMinutes ?? null"
      @modify-position="modifyResource"
      @close-position="requestResourceDestructive"
      @modify-order="modifyResource"
      @cancel-order="requestResourceDestructive"
    />

    <TraderCommandSheet
      v-model:open="commandOpen"
      :account="workspace.account.value"
      :account-id="workspace.activeAccountId.value"
      :symbols="workspace.symbols.value"
      :quote="commands.commandContext.value?.quote"
      :read-only="readOnly"
      :submitting="commands.submitting.value"
      @symbol-change="changeCommandSymbol"
      @submit="requestEntryConfirmation($event, false)"
    />

    <TraderCommandSheet
      v-model:open="distributionOpen"
      :account="workspace.account.value"
      :account-id="workspace.activeAccountId.value"
      :symbols="workspace.symbols.value"
      :quote="commands.commandContext.value?.quote"
      :strategies="traderStrategies"
      :distribution="true"
      :distribution-preview="commands.distributionPreview.value"
      :previewing-distribution="commands.previewingDistribution.value"
      :read-only="surfaceReadOnly"
      :submitting="commands.submitting.value"
      @symbol-change="changeCommandSymbol"
      @strategy-change="commands.clearDistributionPreview"
      @preview-distribution="commands.previewDistribution"
      @submit="requestEntryConfirmation($event, true)"
    />

    <TraderResourceEditDialog
      v-model:open="resourceEditOpen"
      :resource="editingResource"
      :read-only="readOnly"
      :submitting="commands.submitting.value"
      @submit="requestResourceEditConfirmation"
    />

    <TraderDangerConfirm
      :open="Boolean(pendingAction)"
      :account="workspace.account.value"
      :command="pendingAction?.summary.command"
      :symbol="pendingAction?.summary.symbol"
      :ticket="pendingAction?.summary.ticket"
      :volume="pendingAction?.summary.volume"
      :price="pendingAction?.summary.price"
      :stop-loss="pendingAction?.summary.stopLoss"
      :take-profit="pendingAction?.summary.takeProfit"
      :scope="pendingAction?.summary.scope"
      :detail="pendingAction?.summary.detail"
      :submitting="commands.submitting.value"
      :error="commands.error.value"
      @update:open="!commands.submitting.value && !$event && (pendingAction = null)"
      @confirm="confirmAction"
    />
  </div>
</template>
