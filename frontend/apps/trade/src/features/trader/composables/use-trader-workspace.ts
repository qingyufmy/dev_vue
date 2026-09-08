import { tradingAccounts, tradingContext, applyTradingContext, applyTradingAccounts } from '~/features/trading-context'
import { applyAccountMetrics } from '~/lib/apply-account-metrics'
import type {
  AccountSnapshot,
  StrategySummary,
  TraderDecisionDetail,
  TraderDecisionSummary,
  TradingAccount,
} from '@aurum/contracts'
import { computed, onBeforeUnmount, onMounted, ref, type Ref, watch } from 'vue'
import { useTradeSession } from '~/features/auth'
import { accountSnapshot, openPositions, pendingOrders, resourceRevisions } from '~/features/home/home-runtime'
import { traderApi } from '../api/trader-api'
import { createTraderRealtime, type TraderRealtimeState } from '../realtime/trader-realtime'

export function useTraderWorkspace(selectedDecisionId: Ref<string>, selectDecision: (id: string) => void, operationChanged?: (operationId: string) => void) {
  const { session } = useTradeSession()
  const loading = ref(false)
  const refreshing = ref(false)
  const switching = ref(false)
  const error = ref('')
  const detailError = ref('')
  const decisionsError = ref('')
  const detailLoading = ref(false)
  const decisionsLoading = ref(false)
  const realtime = ref<TraderRealtimeState>('idle')
  const activeAccountId = ref<string | null>(null)
  const observerChannelId = ref<string | null>(null)
  const symbols = ref<string[]>([])
  const strategies = ref<StrategySummary[]>([])
  const decisions = ref<TraderDecisionSummary[]>([])
  const detail = ref<TraderDecisionDetail | null>(null)
  const operationNotice = ref('')
  let generation = 0
  let realtimeController: ReturnType<typeof createTraderRealtime> | null = null
  let queuedAccountId: string | null = null

  const currentAccount = computed<TradingAccount | AccountSnapshot | null>(() => accountSnapshot.value
    ?? tradingAccounts.value.find((item) => item.id === activeAccountId.value)
    ?? null)
  const isObserver = computed(() => tradingContext.value?.mode === 'observer')

  async function load() {
    const currentGeneration = ++generation
    stopRealtime()
    loading.value = true
    error.value = ''
    try {
      const [contextResponse, accountsResponse, observersResponse, strategiesResponse] = await Promise.all([
        traderApi.getContext(), traderApi.listAccounts(), traderApi.listObservers(), traderApi.listStrategies(),
      ])
      if (currentGeneration !== generation) return
      applyTradingContext(contextResponse.data)
      applyTradingAccounts(accountsResponse.data.items)
      strategies.value = strategiesResponse.data.items
      const observer = contextResponse.data.mode === 'observer'
        ? observersResponse.data.items.find((item) => item.id === contextResponse.data.observerChannelId && item.active)
        : null
      if (contextResponse.data.mode === 'observer' && !observer) throw new Error('当前观摩授权已失效，请切换回本人交易账户')
      const accountId = observer?.sourceAccountId ?? contextResponse.data.accountId ?? accountsResponse.data.items[0]?.id ?? null
      observerChannelId.value = observer?.id ?? null
      activeAccountId.value = accountId
      if (!accountId) {
        clearWorkspace()
        return
      }
      await loadAccount(accountId, observer?.id ?? null, currentGeneration)
    } catch (reason) {
      if (currentGeneration === generation) error.value = readableError(reason, 'AI 交易员工作区暂时无法读取')
    } finally {
      if (currentGeneration === generation) loading.value = false
    }
  }

  async function loadAccount(accountId: string, observerId: string | null, currentGeneration = generation) {
    decisionsLoading.value = true
    decisionsError.value = ''
    const [workspaceResult, decisionsResult] = await Promise.allSettled([
      traderApi.getWorkspace(accountId, observerId),
      observerId ? Promise.resolve(null) : traderApi.listDecisions(accountId, 50),
    ])
    if (currentGeneration !== generation) return
    if (workspaceResult.status === 'rejected') {
      decisionsLoading.value = false
      throw workspaceResult.reason
    }
    const workspaceResponse = workspaceResult.value
    accountSnapshot.value = workspaceResponse.data.snapshot
    symbols.value = workspaceResponse.data.symbols
    openPositions.value = workspaceResponse.data.positions.items
    pendingOrders.value = workspaceResponse.data.pendingOrders.items
    resourceRevisions.value.account = workspaceResponse.data.snapshot?.revision ?? 0
    resourceRevisions.value.positions = workspaceResponse.data.positions.revision
    resourceRevisions.value.pendingOrders = workspaceResponse.data.pendingOrders.revision
    if (decisionsResult.status === 'fulfilled') decisions.value = decisionsResult.value?.data.items ?? []
    else {
      decisions.value = []
      decisionsError.value = readableError(decisionsResult.reason, 'AI 交易员记录暂时无法读取')
    }
    decisionsLoading.value = false
    normalizeDecisionSelection()
    startRealtime(accountId, observerId)
  }

  async function syncWorkspace() {
    if (!activeAccountId.value) return
    const currentGeneration = generation
    const workspace = await traderApi.getWorkspace(activeAccountId.value, observerChannelId.value)
    if (currentGeneration !== generation) return
    accountSnapshot.value = workspace.data.snapshot
    symbols.value = workspace.data.symbols
    openPositions.value = workspace.data.positions.items
    pendingOrders.value = workspace.data.pendingOrders.items
    resourceRevisions.value.account = workspace.data.snapshot?.revision ?? 0
    resourceRevisions.value.positions = workspace.data.positions.revision
    resourceRevisions.value.pendingOrders = workspace.data.pendingOrders.revision
  }

  async function refreshDecisions(preferredId = '') {
    if (!activeAccountId.value || observerChannelId.value) return
    const currentGeneration = generation
    decisionsLoading.value = true
    decisionsError.value = ''
    try {
      const response = await traderApi.listDecisions(activeAccountId.value, 50)
      if (currentGeneration !== generation) return
      decisions.value = response.data.items
      if (preferredId && decisions.value.some((item) => item.decisionId === preferredId)) selectDecision(preferredId)
      else normalizeDecisionSelection()
    } catch (reason) {
      if (currentGeneration === generation) decisionsError.value = readableError(reason, 'AI 交易员记录暂时无法读取')
    } finally {
      if (currentGeneration === generation) decisionsLoading.value = false
    }
  }

  async function refresh() {
    if (!activeAccountId.value) return
    refreshing.value = true
    error.value = ''
    try { await Promise.all([syncWorkspace(), refreshDecisions()]) }
    catch (reason) { error.value = readableError(reason, '账户最新状态同步失败') }
    finally { refreshing.value = false }
  }

  async function selectAccount(accountId: string) {
    if (!session.value || !tradingContext.value) return
    queuedAccountId = accountId
    if (switching.value) return
    switching.value = true
    error.value = ''
    while (queuedAccountId) {
      const nextAccountId = queuedAccountId
      queuedAccountId = null
      if (nextAccountId === activeAccountId.value && !observerChannelId.value) continue
      const currentGeneration = ++generation
      stopRealtime()
      try {
        const context = await traderApi.selectAccount(session.value.csrf_token, nextAccountId, tradingContext.value.revision)
        if (currentGeneration !== generation) break
        applyTradingContext(context.data)
        observerChannelId.value = null
        activeAccountId.value = nextAccountId
        detail.value = null
        selectDecision('')
        if (!queuedAccountId) await loadAccount(nextAccountId, null, currentGeneration)
      } catch (reason) {
        if (currentGeneration === generation) {
          const switchError = readableError(reason, '交易账户切换失败')
          queuedAccountId = null
          await load()
          error.value = switchError
        }
        break
      }
    }
    switching.value = false
  }

  function startRealtime(accountId: string, observerId: string | null) {
    stopRealtime()
    if (!session.value) return
    realtimeController = createTraderRealtime({
      session: session.value,
      accountId,
      observerChannelId: observerId,
      positionsRevision: resourceRevisions.value.positions,
      pendingOrdersRevision: resourceRevisions.value.pendingOrders,
      onState: (value) => { realtime.value = value },
      onPositions: (items, revision) => { openPositions.value = items; resourceRevisions.value.positions = revision },
      onPendingOrders: (items, revision) => { pendingOrders.value = items; resourceRevisions.value.pendingOrders = revision },
      onMetrics: (data, revision) => {
        if (!accountSnapshot.value || accountSnapshot.value.id !== accountId) return
        accountSnapshot.value = applyAccountMetrics(accountSnapshot.value, data, revision)
        resourceRevisions.value.account = accountSnapshot.value.revision
      },
      onBridge: (data) => {
        if (accountSnapshot.value) accountSnapshot.value = {
          ...accountSnapshot.value,
          bridgeState: data.state,
          lastSeenAt: data.last_seen_at,
        }
      },
      onDecisionChanged: (decisionId) => { void refreshDecisions(decisionId) },
      onOperationChanged: (operationId) => {
        operationNotice.value = '交易执行状态已变化，账户资源已重新同步。'
        operationChanged?.(operationId)
        void Promise.all([syncWorkspace(), refreshDecisions()])
      },
      resync: () => Promise.all([syncWorkspace(), refreshDecisions()]),
    })
  }

  function stopRealtime() {
    realtimeController?.stop()
    realtimeController = null
  }

  function normalizeDecisionSelection() {
    if (selectedDecisionId.value && decisions.value.some((item) => item.decisionId === selectedDecisionId.value)) {
      void loadDetail(selectedDecisionId.value)
      return
    }
    selectDecision(decisions.value[0]?.decisionId ?? '')
  }

  async function loadDetail(id: string) {
    const currentGeneration = generation
    detail.value = null
    detailError.value = ''
    if (!id || !decisions.value.some((item) => item.decisionId === id)) return
    detailLoading.value = true
    try {
      const response = await traderApi.getDecision(id)
      if (currentGeneration === generation && selectedDecisionId.value === id) detail.value = response.data
    } catch (reason) {
      if (currentGeneration === generation && selectedDecisionId.value === id) detailError.value = readableError(reason, 'AI 交易决策详情暂时无法读取')
    } finally {
      if (currentGeneration === generation && selectedDecisionId.value === id) detailLoading.value = false
    }
  }

  function clearWorkspace() {
    accountSnapshot.value = null
    openPositions.value = []
    pendingOrders.value = []
    symbols.value = []
    resourceRevisions.value.account = 0
    resourceRevisions.value.positions = 0
    resourceRevisions.value.pendingOrders = 0
    decisions.value = []
    detail.value = null
    selectDecision('')
  }

  watch(selectedDecisionId, (id) => { void loadDetail(id) })
  onMounted(() => { void load() })
  onBeforeUnmount(() => { generation += 1; stopRealtime() })

  return {
    accounts: tradingAccounts,
    context: tradingContext,
    account: currentAccount,
    snapshot: accountSnapshot,
    positions: openPositions,
    pendingOrders,
    symbols,
    strategies,
    decisions,
    detail,
    activeAccountId,
    isObserver,
    loading,
    refreshing,
    switching,
    decisionsLoading,
    detailLoading,
    realtime,
    error,
    detailError,
    decisionsError,
    operationNotice,
    load,
    refresh,
    selectAccount,
  }
}

function readableError(reason: unknown, fallback: string) {
  return reason instanceof Error && reason.message ? reason.message : fallback
}
