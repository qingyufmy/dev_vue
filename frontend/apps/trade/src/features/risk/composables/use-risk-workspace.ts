import { riskErrorMessage } from '../model/risk-presentation'
import { usePolicyWriteRecovery } from './use-policy-write-recovery'
import { runContextCommand, recoverContextCommand, contextCommandState } from '~/features/trading-context'
import { tradingAccounts, tradingContext, applyTradingContext, applyTradingAccounts } from '~/features/trading-context'
import type { ManualReleaseState, RiskDecisionDetail, RiskDecisionSummary, RiskPolicy, RiskPolicyPatchBody, RiskSummary, TradingAccount } from '@aurum/contracts'
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import type { Ref } from 'vue'
import { useTradeSession } from '~/features/auth'
import { ApiClientError } from '@aurum/api-client'

import { riskApi } from '../api/risk-api'
import { createRiskRealtime, type RiskChangeKind, type RiskRealtimeState } from '../realtime/risk-realtime'
import type { NumericPolicyKey } from '../model/risk-presentation'
import { createManualReleaseRecovery, readPendingRelease, type PendingManualRelease } from '../model/manual-release-recovery'

export function useRiskWorkspace(selectedDecisionId: Ref<string>, selectDecision: (id: string) => void) {
  const { session } = useTradeSession()
  const loading = ref(false)
  const refreshing = ref(false)
  const switching = ref(false)
  const releasing = ref(false)
  const error = ref('')
  const summaryError = ref('')
  const decisionsError = ref('')
  const releaseError = ref('')
  const pendingRelease = ref<PendingManualRelease | null>(null)
  const releaseRecoveryMessage = ref('')
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
  let releaseOperation: symbol | null = null
  let realtimeController: ReturnType<typeof createRiskRealtime> | null = null

  const account = computed<TradingAccount | null>(() => tradingAccounts.value.find((item) => item.id === activeAccountId.value) ?? null)
  const isObserver = computed(() => tradingContext.value?.mode === 'observer')
  const readOnly = computed(() => Boolean(contextCommandState.value.intent) || isObserver.value || tradingContext.value?.readOnly !== false)

  async function load() {
    const currentGeneration = ++generation
    stopRealtime()
    loading.value = true
    error.value = ''
    try {
      if (session.value) await recoverContextCommand(session.value)
      if (currentGeneration !== generation) return
      const [contextResponse, accountsResponse] = await Promise.all([riskApi.getContext(), riskApi.listAccounts()])
      if (currentGeneration !== generation) return
      applyTradingContext(contextResponse.data)
      applyTradingAccounts(accountsResponse.data.items)
      if (contextResponse.data.mode === 'observer') {
        activeAccountId.value = null
        clearRisk()
        return
      }
      let accountId = contextResponse.data.accountId ?? accountsResponse.data.items[0]?.id ?? null
      activeAccountId.value = accountId
      if (!accountId) { clearRisk(); return }
      if (accountId !== contextResponse.data.accountId && session.value) {
        const selected = await runContextCommand(session.value, 'select_account', accountId, contextResponse.data.revision)
        if (currentGeneration !== generation) return
        applyTradingContext(selected.data)
        accountId = selected.data.mode === 'full' ? selected.data.accountId : null
        activeAccountId.value = accountId
        if (!accountId) { clearRisk(); return }
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
    if (contextCommandState.value.busy) return
    if (!session.value || !tradingContext.value || (accountId === activeAccountId.value && tradingContext.value.mode === 'full' && tradingContext.value.accountId === accountId)) return
    const currentGeneration = ++generation
    stopRealtime()
    switching.value = true
    error.value = ''
    try {
      const selected = await runContextCommand(session.value, 'select_account', accountId, tradingContext.value.revision)
      if (currentGeneration !== generation) return
      applyTradingContext(selected.data)
      const selectedAccount = selected.data.mode === 'full' ? selected.data.accountId : null
      activeAccountId.value = selectedAccount
      clearRisk()
      selectDecision('')
      if (selectedAccount) await loadAccount(selectedAccount, currentGeneration)
    } catch (reason) {
      if (currentGeneration === generation) error.value = readableError(reason, '交易账户切换失败')
    } finally {
      if (currentGeneration === generation) switching.value = false
    }
  }

  const policyRecovery = usePolicyWriteRecovery(() => session.value && activeAccountId.value && policy.value && !isObserver.value
    ? { userId: String(session.value.user.id), accountId: activeAccountId.value, csrfToken: session.value.csrf_token,
      revision: policy.value.revision, readOnly: readOnly.value, generation } : null,
    async () => { await Promise.all([refreshPolicy(), refreshSummaryAndRelease(), refreshDecisions()]);
      if (summaryError.value || releaseError.value || decisionsError.value) throw Error('partial refresh failed') })
  const savingPolicy = policyRecovery.busy, policyError = policyRecovery.error
  async function savePolicy(input: { patch: Partial<Record<NumericPolicyKey, string>> & { accountKillSwitch?: boolean }; reason: string }) {
    return policyRecovery.run('create', policyPatchBody(input.patch, input.reason))
  }

  async function createManualRelease(reason: string) {
    return runReleaseRecovery('create', reason)
  }

  function syncPendingRelease() {
    pendingRelease.value = null
    if (!session.value || !activeAccountId.value || isObserver.value) return
    try { pendingRelease.value = readPendingRelease(localStorage, { userId: String(session.value.user.id), accountId: activeAccountId.value }) }
    catch { releaseRecoveryMessage.value = '无法读取待确认操作，请检查浏览器存储后再操作。' }
  }

  async function runReleaseRecovery(action: 'create' | 'query' | 'retry', reason = '') {
    if (!session.value || !activeAccountId.value || readOnly.value || releasing.value || (action === 'create' && !summary.value)) return false
    const accountId = activeAccountId.value, userId = session.value.user.id, currentGeneration = generation
    const isCurrent = () => currentGeneration === generation && activeAccountId.value === accountId && session.value?.user.id === userId
    const operation = Symbol('manual-release')
    releaseOperation = operation
    releasing.value = true
    releaseError.value = ''
    releaseRecoveryMessage.value = ''
    let confirmed = false
    try {
      const recovery = createManualReleaseRecovery({ storage: localStorage, key: () => crypto.randomUUID(),
        current: () => isCurrent() && !readOnly.value,
        knownPreWriteRejection: failure => failure instanceof ApiClientError && [400, 412, 422, 428].includes(failure.status)
          && ['api_request_invalid', 'if_match_required', 'risk_manual_release_revision_invalid', 'idempotency_key_invalid',
            'risk_manual_release_acknowledgement_required', 'risk_manual_release_reason_invalid', 'risk_summary_revision_conflict']
            .includes(failure.problem?.code ?? ''),
        lock: async (name, work) => {
          if (!navigator.locks) throw Error('release_storage_lock_unavailable')
          return navigator.locks.request(name, work)
        },
        query: async request => (await riskApi.getManualReleaseReceipt(request.accountId, request.key)).data.state,
        send: async request => { await riskApi.createManualRelease(session.value!.csrf_token, request.accountId, request.body, request.revision, request.key) },
      })
      const result = await recovery.run({ userId: String(userId), accountId }, action,
        action === 'create' ? { reason, revision: summary.value!.revision } : undefined)
      if (!isCurrent()) return false
      syncPendingRelease()
      if (result !== 'confirmed') {
        releaseRecoveryMessage.value = result === 'rejected' ? '本次请求已被拒绝，未创建解除记录。请刷新风险状态并检查输入后再提交。'
          : result === 'absent' ? '当前账户没有待确认的解除操作。' : '服务端尚未确认原操作。可以继续查询，或使用下方按钮重试原请求。'
        if (result === 'rejected') releaseError.value = releaseRecoveryMessage.value
        return false
      }
      confirmed = true
      releaseRecoveryMessage.value = '原解除操作已确认，正在更新账户状态。'
      await Promise.all([refreshSummaryAndRelease(), refreshDecisions()])
      if (isCurrent()) releaseRecoveryMessage.value = summaryError.value || releaseError.value || decisionsError.value
        ? '原解除操作已确认，但部分账户状态未能更新，请刷新页面。' : '原解除操作已确认，账户状态已更新。'
      return isCurrent()
    } catch {
      if (isCurrent()) {
        syncPendingRelease()
        releaseError.value = confirmed ? '原解除操作已确认，但账户状态更新失败，请刷新页面。'
          : pendingRelease.value ? '操作尚未确认，原请求已保留。请查询结果后再决定是否重试。'
            : '无法安全保存或读取操作，未创建新的解除请求。请检查浏览器存储后重试。'
        releaseRecoveryMessage.value = releaseError.value
      }
      return false
    } finally {
      if (releaseOperation === operation) {
        releaseOperation = null
        releasing.value = false
        syncPendingRelease()
      }
    }
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

  watch(() => JSON.stringify([session.value?.user.id, session.value?.authenticated_at]), () => {
    generation += 1
    stopRealtime(); clearRisk()
    activeAccountId.value = null
    applyTradingContext(null); applyTradingAccounts([])
    for (const state of [loading, refreshing, switching, savingPolicy, releasing, detailLoading]) state.value = false
    for (const message of [error, summaryError, decisionsError, policyError, releaseError, detailError]) message.value = ''
    if (session.value) void load()
  }, { flush: 'sync' })
  watch(() => [session.value?.user.id, activeAccountId.value, isObserver.value], () => {
    releaseOperation = null
    releasing.value = false
    releaseRecoveryMessage.value = ''
    syncPendingRelease()
  }, { flush: 'sync' })
  const onReleaseStorage = (event: StorageEvent) => {
    if (event.key === null || event.key.startsWith('aurum:risk-release:v1:')) syncPendingRelease()
  }
  onMounted(() => { window.addEventListener('storage', onReleaseStorage); void load() })
  onBeforeUnmount(() => { generation += 1; releaseOperation = null; stopRealtime(); window.removeEventListener('storage', onReleaseStorage) })

  return {
    loading, refreshing, switching, savingPolicy, releasing, error, summaryError, decisionsError, policyError, releaseError, detailError, detailLoading, realtime,
    activeAccountId, accounts: tradingAccounts, context: tradingContext, account, policy, summary, manualRelease, decisions, detail,
    isObserver, readOnly, load, refresh, selectAccount, savePolicy, createManualRelease, loadDetail,
    pendingRelease, releaseRecoveryMessage, runReleaseRecovery,
    pendingPolicy: policyRecovery.pending, policyRecoveryMessage: policyRecovery.message, runPolicyRecovery: policyRecovery.run,
  }
}

function policyPatchBody(patch: Partial<Record<NumericPolicyKey, string>> & { accountKillSwitch?: boolean }, reason: string): RiskPolicyPatchBody {
  const body: RiskPolicyPatchBody = { reason }
  if (patch.maxRiskPerTradePercent !== undefined) body.max_risk_per_trade_percent = patch.maxRiskPerTradePercent
  if (patch.maxDailyLossPercent !== undefined) body.max_daily_loss_percent = patch.maxDailyLossPercent
  if (patch.maxDrawdownPercent !== undefined) body.max_drawdown_percent = patch.maxDrawdownPercent
  if (patch.maxOpenPositions !== undefined) body.max_open_positions = Number(patch.maxOpenPositions)
  if (patch.maxPendingOrders !== undefined) body.max_pending_orders = Number(patch.maxPendingOrders)
  if (patch.maxOrderVolume !== undefined) body.max_order_volume = patch.maxOrderVolume
  if (patch.maxTotalVolume !== undefined) body.max_total_volume = patch.maxTotalVolume
  if (patch.maxSpreadPoints !== undefined) body.max_spread_points = patch.maxSpreadPoints
  if (patch.minOpenIntervalSeconds !== undefined) body.min_open_interval_seconds = Number(patch.minOpenIntervalSeconds)
  if (patch.maxDailyOpenCount !== undefined) body.max_daily_open_count = Number(patch.maxDailyOpenCount)
  if (patch.consecutiveLossLimit !== undefined) body.consecutive_loss_limit = Number(patch.consecutiveLossLimit)
  if (patch.lossCooldownMinutes !== undefined) body.loss_cooldown_minutes = Number(patch.lossCooldownMinutes)
  if (patch.pendingValidMinutes !== undefined) body.pending_valid_minutes = Number(patch.pendingValidMinutes)
  if (patch.weekendCloseMinutes !== undefined) body.weekend_close_minutes = Number(patch.weekendCloseMinutes)
  if (patch.accountKillSwitch !== undefined) body.account_kill_switch = patch.accountKillSwitch
  return body
}

function readableError(reason: unknown, fallback: string) {
  return riskErrorMessage(reason, fallback)
}
