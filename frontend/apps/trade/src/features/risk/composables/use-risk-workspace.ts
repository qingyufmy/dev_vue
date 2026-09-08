import { tradingAccounts, tradingContext, applyTradingContext, applyTradingAccounts } from '~/features/trading-context'
import type { ManualReleaseState, RiskDecisionDetail, RiskDecisionSummary, RiskPolicy, RiskPolicyPatchBody, RiskSummary, TradingAccount } from '@aurum/contracts'
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import type { Ref } from 'vue'
import { useTradeSession } from '~/features/auth'

import { riskApi } from '../api/risk-api'
import { createRiskRealtime, type RiskChangeKind, type RiskRealtimeState } from '../realtime/risk-realtime'
import type { NumericPolicyKey } from '../model/risk-presentation'

export function useRiskWorkspace(selectedDecisionId: Ref<string>, selectDecision: (id: string) => void) {
  const { session } = useTradeSession()
  const loading = ref(false)
  const refreshing = ref(false)
  const switching = ref(false)
  const savingPolicy = ref(false)
  const releasing = ref(false)
  const error = ref('')
  const summaryError = ref('')
  const decisionsError = ref('')
  const policyError = ref('')
  const releaseError = ref('')
  const detailError = ref('')
  const detailLoading = ref(false)
  const realtime = ref<RiskRealtimeState>('idle')
  const activeAccountId = ref<string | null>(null)
  const policy = ref<RiskPolicy | null>(null)
  const summary = ref<RiskSummary | null>(null)
  const manualRelease = ref<ManualReleaseState | null>(null)
  const decisions = ref<RiskDecisionSummary[]>([])
  const detail = ref<RiskDecisionDetail | null>(null)
  let generation = 0
  let realtimeController: ReturnType<typeof createRiskRealtime> | null = null

  const account = computed<TradingAccount | null>(() => tradingAccounts.value.find((item) => item.id === activeAccountId.value) ?? null)
  const isObserver = computed(() => tradingContext.value?.mode === 'observer')
  const readOnly = computed(() => isObserver.value || tradingContext.value?.readOnly !== false)

  async function load() {
    const currentGeneration = ++generation
    stopRealtime()
    loading.value = true
    error.value = ''
    try {
      const [contextResponse, accountsResponse] = await Promise.all([riskApi.getContext(), riskApi.listAccounts()])
      if (currentGeneration !== generation) return
      applyTradingContext(contextResponse.data)
      applyTradingAccounts(accountsResponse.data.items)
      if (contextResponse.data.mode === 'observer') {
        activeAccountId.value = null
        clearRisk()
        return
      }
      const accountId = contextResponse.data.accountId ?? accountsResponse.data.items[0]?.id ?? null
      activeAccountId.value = accountId
      if (!accountId) { clearRisk(); return }
      if (accountId !== contextResponse.data.accountId && session.value) {
        applyTradingContext((await riskApi.selectAccount(session.value.csrf_token, accountId, contextResponse.data.revision)).data)
      }
      await loadAccount(accountId, currentGeneration)
    } catch (reason) {
      if (currentGeneration === generation) error.value = readableError(reason, 'AI 风控师暂时无法读取')
    } finally {
      if (currentGeneration === generation) loading.value = false
    }
  }

  async function loadAccount(accountId: string, currentGeneration = generation) {
    summaryError.value = ''
    decisionsError.value = ''
    releaseError.value = ''
    const [policyResult, summaryResult, releaseResult, decisionsResult] = await Promise.allSettled([
      riskApi.getPolicy(accountId), riskApi.getSummary(accountId), riskApi.getManualRelease(accountId), riskApi.listDecisions(accountId, 50),
    ])
    if (currentGeneration !== generation) return
    if (policyResult.status === 'rejected') throw policyResult.reason
    policy.value = policyResult.value.data
    if (summaryResult.status === 'fulfilled') summary.value = summaryResult.value.data
    else { summary.value = null; summaryError.value = readableError(summaryResult.reason, '账户风险快照尚未生成') }
    if (releaseResult.status === 'fulfilled') manualRelease.value = releaseResult.value.data
    else { manualRelease.value = null; releaseError.value = readableError(releaseResult.reason, '手动解除状态暂时无法读取') }
    if (decisionsResult.status === 'fulfilled') decisions.value = decisionsResult.value.data.items
    else { decisions.value = []; decisionsError.value = readableError(decisionsResult.reason, '风控评审记录暂时无法读取') }
    normalizeDecisionSelection()
    startRealtime(accountId)
  }

  async function refresh() {
    if (!activeAccountId.value || isObserver.value) return
    refreshing.value = true
    error.value = ''
    try { await loadAccount(activeAccountId.value) }
    catch (reason) { error.value = readableError(reason, '风控状态同步失败') }
    finally { refreshing.value = false }
  }

  async function selectAccount(accountId: string) {
    if (!session.value || !tradingContext.value || accountId === activeAccountId.value) return
    const currentGeneration = ++generation
    stopRealtime()
    switching.value = true
    error.value = ''
    try {
      applyTradingContext((await riskApi.selectAccount(session.value.csrf_token, accountId, tradingContext.value.revision)).data)
      if (currentGeneration !== generation) return
      activeAccountId.value = accountId
      clearRisk()
      selectDecision('')
      await loadAccount(accountId, currentGeneration)
    } catch (reason) {
      if (currentGeneration === generation) error.value = readableError(reason, '交易账户切换失败')
    } finally {
      if (currentGeneration === generation) switching.value = false
    }
  }

  async function savePolicy(input: { patch: Partial<Record<NumericPolicyKey, string>> & { tradeSendEnabled?: boolean; accountKillSwitch?: boolean }; reason: string }) {
    if (!session.value || !activeAccountId.value || !policy.value || readOnly.value) return false
    savingPolicy.value = true
    policyError.value = ''
    try {
      const body = policyPatchBody(input.patch, input.reason)
      policy.value = (await riskApi.replacePolicy(session.value.csrf_token, activeAccountId.value, body, policy.value.revision)).data
      await Promise.all([refreshSummaryAndRelease(), refreshDecisions()])
      return true
    } catch (reason) {
      policyError.value = readableError(reason, '风控规则保存失败')
      return false
    } finally { savingPolicy.value = false }
  }

  async function createManualRelease(reason: string) {
    if (!session.value || !activeAccountId.value || !summary.value || readOnly.value) return false
    releasing.value = true
    releaseError.value = ''
    try {
      await riskApi.createManualRelease(session.value.csrf_token, activeAccountId.value, { acknowledge_risk: true, reason }, summary.value.revision, crypto.randomUUID())
      await Promise.all([refreshSummaryAndRelease(), refreshDecisions()])
      return true
    } catch (failure) {
      releaseError.value = readableError(failure, '手动解除限制失败')
      return false
    } finally { releasing.value = false }
  }

  async function refreshSummaryAndRelease() {
    if (!activeAccountId.value) return
    const currentGeneration = generation
    const [summaryResult, releaseResult] = await Promise.allSettled([riskApi.getSummary(activeAccountId.value), riskApi.getManualRelease(activeAccountId.value)])
    if (currentGeneration !== generation) return
    if (summaryResult.status === 'fulfilled') { summary.value = summaryResult.value.data; summaryError.value = '' }
    else { summary.value = null; summaryError.value = readableError(summaryResult.reason, '账户风险快照尚未生成') }
    if (releaseResult.status === 'fulfilled') { manualRelease.value = releaseResult.value.data; releaseError.value = '' }
    else { manualRelease.value = null; releaseError.value = readableError(releaseResult.reason, '手动解除状态暂时无法读取') }
  }

  async function refreshPolicy() {
    if (!activeAccountId.value) return
    const currentGeneration = generation
    const response = await riskApi.getPolicy(activeAccountId.value)
    if (currentGeneration === generation) policy.value = response.data
  }

  async function refreshDecisions(preferredId = '') {
    if (!activeAccountId.value) return
    const currentGeneration = generation
    try {
      const response = await riskApi.listDecisions(activeAccountId.value, 50)
      if (currentGeneration !== generation) return
      decisions.value = response.data.items
      decisionsError.value = ''
      if (preferredId && decisions.value.some((item) => item.riskDecisionId === preferredId)) selectDecision(preferredId)
      else normalizeDecisionSelection()
    } catch (reason) {
      if (currentGeneration === generation) decisionsError.value = readableError(reason, '风控评审记录暂时无法读取')
    }
  }

  async function loadDetail(id: string) {
    detail.value = null
    detailError.value = ''
    if (!id || !decisions.value.some((item) => item.riskDecisionId === id)) return
    const currentGeneration = generation
    detailLoading.value = true
    try {
      const response = await riskApi.getDecision(id)
      if (currentGeneration === generation && selectedDecisionId.value === id) detail.value = response.data
    } catch (reason) {
      if (currentGeneration === generation) detailError.value = readableError(reason, '风控评审详情读取失败')
    } finally {
      if (currentGeneration === generation) detailLoading.value = false
    }
  }

  function normalizeDecisionSelection() {
    const selected = selectedDecisionId.value
    if (selected && decisions.value.some((item) => item.riskDecisionId === selected)) { void loadDetail(selected); return }
    selectDecision('')
  }

  function startRealtime(accountId: string) {
    stopRealtime()
    if (!session.value) return
    realtimeController = createRiskRealtime({
      session: session.value,
      accountId,
      onState: (value) => { realtime.value = value },
      onChanged: (kind, resourceId) => { void handleRealtime(kind, resourceId) },
      resync: () => Promise.all([refreshPolicy(), refreshSummaryAndRelease(), refreshDecisions()]),
    })
  }

  async function handleRealtime(kind: RiskChangeKind, resourceId: string) {
    if (kind === 'policy') await Promise.all([refreshPolicy(), refreshSummaryAndRelease()])
    else if (kind === 'summary' || kind === 'manual_release') await refreshSummaryAndRelease()
    else await refreshDecisions(resourceId)
  }

  function stopRealtime() { realtimeController?.stop(); realtimeController = null }
  function clearRisk() { policy.value = null; summary.value = null; manualRelease.value = null; decisions.value = []; detail.value = null }

  onMounted(load)
  onBeforeUnmount(() => { generation += 1; stopRealtime() })

  return {
    loading, refreshing, switching, savingPolicy, releasing, error, summaryError, decisionsError, policyError, releaseError, detailError, detailLoading, realtime,
    activeAccountId, accounts: tradingAccounts, context: tradingContext, account, policy, summary, manualRelease, decisions, detail,
    isObserver, readOnly, load, refresh, selectAccount, savePolicy, createManualRelease, loadDetail,
  }
}

function policyPatchBody(patch: Partial<Record<NumericPolicyKey, string>> & { tradeSendEnabled?: boolean; accountKillSwitch?: boolean }, reason: string): RiskPolicyPatchBody {
  const body: RiskPolicyPatchBody = { reason }
  if (patch.maxRiskPerTradePercent !== undefined) body.max_risk_per_trade_percent = patch.maxRiskPerTradePercent
  if (patch.maxDailyLossPercent !== undefined) body.max_daily_loss_percent = patch.maxDailyLossPercent
  if (patch.maxDrawdownPercent !== undefined) body.max_drawdown_percent = patch.maxDrawdownPercent
  if (patch.maxOpenPositions !== undefined) body.max_open_positions = Number(patch.maxOpenPositions)
  if (patch.maxPendingOrders !== undefined) body.max_pending_orders = Number(patch.maxPendingOrders)
  if (patch.maxTotalVolume !== undefined) body.max_total_volume = patch.maxTotalVolume
  if (patch.maxSpreadPoints !== undefined) body.max_spread_points = patch.maxSpreadPoints
  if (patch.minOpenIntervalSeconds !== undefined) body.min_open_interval_seconds = Number(patch.minOpenIntervalSeconds)
  if (patch.maxDailyOpenCount !== undefined) body.max_daily_open_count = Number(patch.maxDailyOpenCount)
  if (patch.consecutiveLossLimit !== undefined) body.consecutive_loss_limit = Number(patch.consecutiveLossLimit)
  if (patch.lossCooldownMinutes !== undefined) body.loss_cooldown_minutes = Number(patch.lossCooldownMinutes)
  if (patch.pendingValidMinutes !== undefined) body.pending_valid_minutes = Number(patch.pendingValidMinutes)
  if (patch.weekendCloseMinutes !== undefined) body.weekend_close_minutes = Number(patch.weekendCloseMinutes)
  if (patch.tradeSendEnabled !== undefined) body.trade_send_enabled = patch.tradeSendEnabled
  if (patch.accountKillSwitch !== undefined) body.account_kill_switch = patch.accountKillSwitch
  return body
}

function readableError(reason: unknown, fallback: string) {
  return reason instanceof Error && reason.message ? reason.message : fallback
}
