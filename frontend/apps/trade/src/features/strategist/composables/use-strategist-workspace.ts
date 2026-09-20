import { subscriptionTimeWindowSchema } from '@aurum/contracts'
import { prepareSubscriptionUpdate, clearSubscriptionUpdate } from '../model/subscription-update-request'
import { prepareSubscriptionCreate, clearSubscriptionCreate } from '../model/subscription-create-request'
import { prepareStrategyVersion, clearStrategyVersion, type StrategyVersionIntent } from '../model/strategy-version-request'
import { prepareStrategyMetadata, clearStrategyMetadata } from '../model/strategy-metadata-request'
import { ApiClientError } from '@aurum/api-client'
import { prepareStrategyCreate, clearStrategyCreate } from '../model/strategy-create-request'
import { prepareStrategyCombination, clearStrategyCombination } from '../model/strategy-combination-request'
import type {
  StrategyCompileResult, StrategyDetail, StrategySubscription, StrategySubscriptionPatchBody,
  StrategySummary, TradingAccount,
} from '@aurum/contracts'
import { computed, onMounted, ref } from 'vue'
import { useTradeSession } from '~/features/auth'
import { strategistApi } from '../api/strategist-api'
import type {
  CompileResultView, StrategyCombinationDraft, StrategyDetailView, StrategyDraft, StrategySubscriptionView, SubscriptionDraft,
} from '../model/strategy-presentation'

export function useStrategistWorkspace(options: { autoLoad?: boolean } = {}) {
  const { session } = useTradeSession()
  const strategies = ref<StrategySummary[]>([])
  const accounts = ref<TradingAccount[]>([])
  const detail = ref<StrategyDetailView | null>(null)
  const subscriptions = ref<StrategySubscriptionView[]>([])
  const symbols = ref<string[]>([])
  const loading = ref(options.autoLoad !== false)
  const detailLoading = ref(false)
  const subscriptionLoading = ref(false)
  const refreshing = ref(false)
  const compiling = ref(false)
  const submitting = ref(false)
  const error = ref('')
  const actionError = ref('')
  const notice = ref('')
  const compileResult = ref<CompileResultView | null>(null)
  const analysisCompileResult = ref<CompileResultView | null>(null)
  const traderCompileResult = ref<CompileResultView | null>(null)
  let detailGeneration = 0
  let accountGeneration = 0

  const personalStrategies = computed(() => strategies.value.filter((item) => item.scope === 'user'))
  const activeStrategies = computed(() => strategies.value.filter((item) => item.status === 'active' && item.activeVersionId))

  async function load() {
    loading.value = true
    error.value = ''
    try {
      const [strategyResponse, accountResponse] = await Promise.all([strategistApi.listStrategies(), strategistApi.listAccounts()])
      strategies.value = strategyResponse.data.items
      accounts.value = accountResponse.data.items
    } catch (reason) { error.value = readableError(reason, 'AI 策略师暂时无法读取') }
    finally { loading.value = false }
  }

  async function loadDetail(strategyId: string) {
    const generation = ++detailGeneration
    detail.value = null
    detailLoading.value = false
    if (!strategyId) return
    detailLoading.value = true
    actionError.value = ''
    try {
      const response = await strategistApi.getStrategy(strategyId)
      if (generation === detailGeneration) detail.value = mapDetail(response.data)
    } catch (reason) { if (generation === detailGeneration) actionError.value = readableError(reason, '策略详情读取失败') }
    finally { if (generation === detailGeneration) detailLoading.value = false }
  }

  async function fetchDetail(strategyId: string) { return mapDetail((await strategistApi.getStrategy(strategyId)).data) }

  async function compileCombination(draft: StrategyCombinationDraft) {
    if (!session.value || compiling.value) return false
    compiling.value = true; actionError.value = ''; analysisCompileResult.value = null; traderCompileResult.value = null
    try {
      const [analysis, trader] = await Promise.all([
        strategistApi.compileStrategy(session.value.csrf_token, { kind: 'analysis', prompt_text: draft.analysisPromptText, config: draft.analysisConfig }),
        strategistApi.compileStrategy(session.value.csrf_token, { kind: 'trader', prompt_text: draft.traderPromptText, config: draft.traderConfig }),
      ])
      analysisCompileResult.value = mapCompile(analysis.data); traderCompileResult.value = mapCompile(trader.data)
      return analysisCompileResult.value.valid && traderCompileResult.value.valid
    } catch (reason) { actionError.value = readableError(reason, '策略检查失败，请重试'); return false }
    finally { compiling.value = false }
  }

  async function saveCombination(draft: StrategyCombinationDraft, traderDetail: StrategyDetailView | null) {
    if (!session.value || submitting.value) return null
    const current = detail.value?.strategy ?? null, strategyId = current?.id ?? ''
    const userId = String(session.value.user.id), csrfToken = session.value.csrf_token
    return mutate(async () => {
      const common = { name: draft.name, description: draft.description, analysis_prompt_text: draft.analysisPromptText,
        analysis_config: draft.analysisConfig, trader_prompt_text: draft.traderPromptText, trader_config: draft.traderConfig }
      const body = current ? { ...common, status: draft.status ?? 'draft', trader_expected_revision: traderDetail?.strategy.revision ?? null } : common
      const pending = prepareStrategyCombination(sessionStorage, userId, strategyId, body, current?.revision ?? null)
      let response
      try {
        response = current
          ? await strategistApi.createStrategyCombinationVersion(csrfToken, current.id, pending.body as typeof body & { status: 'draft' | 'active'; trader_expected_revision: number | null }, current.revision, pending.idempotencyKey)
          : await strategistApi.createStrategyCombination(csrfToken, pending.body as typeof common, pending.idempotencyKey)
      } catch (reason) {
        if (reason instanceof ApiClientError && [400, 401, 403, 404, 409, 412, 422, 428].includes(reason.status)) clearStrategyCombination(sessionStorage, userId, strategyId)
        throw reason
      }
      clearStrategyCombination(sessionStorage, userId, strategyId)
      detail.value = mapDetail(response.data)
      try { await refreshStrategies() } catch { error.value = '策略组合已保存，列表刷新失败，请重新加载列表' }
      return response.data.id
    }, current ? '分析策略和交易策略已同时保存' : '策略组合已创建', '策略组合保存失败')
  }

  async function compile(draft: StrategyDraft) {
    if (!session.value || compiling.value) return false
    const userId = session.value.user.id
    compiling.value = true
    actionError.value = ''
    compileResult.value = null
    try {
      const response = await strategistApi.compileStrategy(session.value.csrf_token, {
        kind: draft.kind, prompt_text: draft.promptText, config: draft.config,
      })
      if (session.value?.user.id !== userId) return false
      compileResult.value = mapCompile(response.data)
      return compileResult.value.valid
    } catch (reason) { actionError.value = readableError(reason, '策略检查失败，请重试'); return false }
    finally { compiling.value = false }
  }

  async function createStrategy(draft: StrategyDraft) {
    if (!session.value || submitting.value) return null
    const userId = String(session.value.user.id), csrfToken = session.value.csrf_token
    return mutate(async () => {
      const pending = prepareStrategyCreate(sessionStorage, userId, {
        kind: draft.kind, name: draft.name, description: draft.description, prompt_text: draft.promptText, config: draft.config,
      })
      let response
      try { response = await strategistApi.createStrategy(csrfToken, pending.body, pending.idempotencyKey) }
      catch (reason) {
        if (reason instanceof ApiClientError && [400, 401, 403, 422].includes(reason.status)) clearStrategyCreate(sessionStorage, userId)
        throw reason
      }
      clearStrategyCreate(sessionStorage, userId)
      if (String(session.value?.user.id) !== userId) return null
      detail.value = mapDetail(response.data)
      // A list refresh failure must not turn an acknowledged create into another create attempt.
      try { await refreshStrategies() } catch { error.value = '策略已创建，列表刷新失败，请重新加载列表' }
      return response.data.id
    }, '策略草稿已保存', '策略创建失败')
  }

  async function updateMetadata(name: string, description: string) {
    if (!session.value || !detail.value || submitting.value) return false
    const current = detail.value.strategy, userId = String(session.value.user.id), csrfToken = session.value.csrf_token
    const result = await mutate(async () => {
      const pending = prepareStrategyMetadata(sessionStorage, userId, current.id, { name, description }, current.revision)
      let response
      try { response = await strategistApi.updateStrategyMetadata(csrfToken, current.id, pending.body, pending.expectedRevision, pending.idempotencyKey) }
      catch (reason) {
        if (reason instanceof ApiClientError && [400, 401, 403, 404, 409, 412, 422, 428].includes(reason.status)) clearStrategyMetadata(sessionStorage, userId, current.id)
        throw reason
      }
      clearStrategyMetadata(sessionStorage, userId, current.id)
      if (String(session.value?.user.id) !== userId) return false
      if (detail.value?.strategy.id === current.id) detail.value = mapDetail(response.data)
      try { await refreshStrategies() } catch { error.value = '资料已保存，列表刷新失败，请重新加载列表' }
      return true
    }, '策略资料已更新', '策略资料保存失败')
    return result === true
  }

  async function versionMutation(intent: StrategyVersionIntent, success: string, fallback: string) {
    if (!session.value || !detail.value || submitting.value) return false
    const current = detail.value.strategy, userId = String(session.value.user.id), csrfToken = session.value.csrf_token
    const result = await mutate(async () => {
      const pending = prepareStrategyVersion(sessionStorage, userId, current.id, intent, current.revision)
      let response
      try {
        const saved = pending.intent
        if (saved.action === 'create_version') response = await strategistApi.createStrategyVersion(csrfToken, current.id, saved.body, pending.expectedRevision, pending.idempotencyKey)
        else if (saved.action === 'publish_version') response = await strategistApi.publishStrategyVersion(csrfToken, current.id, saved.versionId, pending.expectedRevision, pending.idempotencyKey)
        else response = await strategistApi.retireStrategy(csrfToken, current.id, pending.expectedRevision, pending.idempotencyKey)
      } catch (reason) {
        if (reason instanceof ApiClientError && [400, 401, 403, 404, 409, 412, 422, 428].includes(reason.status)) clearStrategyVersion(sessionStorage, userId, current.id)
        throw reason
      }
      clearStrategyVersion(sessionStorage, userId, current.id)
      if (String(session.value?.user.id) !== userId) return false
      if (detail.value?.strategy.id === current.id) detail.value = mapDetail(response.data)
      try { await refreshStrategies() } catch { error.value = '操作已完成，列表刷新失败，请重新加载列表' }
      return true
    }, success, fallback)
    return result === true
  }

  async function createVersion(draft: StrategyDraft) {
    return versionMutation({ action: 'create_version', body: { name: draft.name, description: draft.description, ...(draft.status ? { status: draft.status } : {}), prompt_text: draft.promptText, config: draft.config } }, '策略已保存', '策略版本保存失败')
  }
  async function publish(versionId: string) {
    return versionMutation({ action: 'publish_version', versionId }, '策略版本已发布', '策略发布失败')
  }
  async function retire() {
    return versionMutation({ action: 'retire_strategy' }, '策略已退役，历史版本仍保留', '策略退役失败')
  }

  async function loadSubscriptions(accountId: string) {
    const generation = ++accountGeneration
    subscriptions.value = []
    symbols.value = []
    subscriptionLoading.value = false
    if (!accountId) return
    subscriptionLoading.value = true
    actionError.value = ''
    try {
      const [subscriptionResult, workspaceResult] = await Promise.allSettled([
        strategistApi.listSubscriptions(accountId), strategistApi.getWorkspace(accountId),
      ])
      if (generation !== accountGeneration) return
      if (subscriptionResult.status === 'rejected') throw subscriptionResult.reason
      subscriptions.value = subscriptionResult.value.data.items.map(mapSubscription)
      if (workspaceResult.status === 'fulfilled') symbols.value = workspaceResult.value.data.symbols
    } catch (reason) { if (generation === accountGeneration) actionError.value = readableError(reason, '账户策略订阅读取失败') }
    finally { if (generation === accountGeneration) subscriptionLoading.value = false }
  }

  async function refreshSubscriptions(accountId: string) {
    refreshing.value = true
    await loadSubscriptions(accountId)
    refreshing.value = false
  }

  async function saveSubscription(draft: SubscriptionDraft, current?: StrategySubscriptionView | null) {
    if (!session.value || submitting.value) return false
    const userId = String(session.value.user.id), csrfToken = session.value.csrf_token
    const generation = accountGeneration
    const result = await mutate(async () => {
      if (current) {
        const patch: StrategySubscriptionPatchBody = {
          analysis_strategy_id: draft.analysisStrategyId,
          ...(draft.receiveWindow ? { receive_window: draft.receiveWindow } : {}),
          trader_strategy_id: draft.traderEnabled ? draft.traderStrategyId : null,
          analysis_enabled: draft.analysisEnabled,
          trader_enabled: draft.traderEnabled,
          status: draft.status,
        }
        await sendSubscriptionPatch(userId, csrfToken, current, patch)
      } else {
        const pending = prepareSubscriptionCreate(sessionStorage, userId, {
          trading_account_id: draft.accountId, symbol: draft.symbol, analysis_strategy_id: draft.analysisStrategyId,
          ...(draft.receiveWindow ? { receive_window: draft.receiveWindow } : {}),
          trader_strategy_id: draft.traderEnabled ? draft.traderStrategyId : null,
          analysis_enabled: draft.analysisEnabled, trader_enabled: draft.traderEnabled,
          status: draft.status === 'paused' ? 'paused' : 'active',
        })
        try { await strategistApi.createSubscription(csrfToken, pending.body, pending.idempotencyKey) }
        catch (reason) {
          if (reason instanceof ApiClientError && [400, 401, 403, 404, 422].includes(reason.status)) clearSubscriptionCreate(sessionStorage, userId, draft.accountId)
          throw reason
        }
        clearSubscriptionCreate(sessionStorage, userId, draft.accountId)
      }
      if (String(session.value?.user.id) !== userId) return false
      if (generation === accountGeneration) await loadSubscriptions(draft.accountId)
      return true
    }, current ? '账户订阅已更新' : '账户订阅已创建', current ? '账户订阅更新失败' : '账户订阅创建失败')
    return result === true
  }

  async function sendSubscriptionPatch(userId: string, csrfToken: string, item: StrategySubscriptionView, patch: StrategySubscriptionPatchBody) {
    const pending = prepareSubscriptionUpdate(sessionStorage, userId, item.id, patch, item.revision)
    try { await strategistApi.updateSubscription(csrfToken, item.id, pending.body, pending.expectedRevision, pending.idempotencyKey) }
    catch (reason) {
      if (reason instanceof ApiClientError && [400, 401, 403, 404, 409, 412, 422, 428].includes(reason.status)) clearSubscriptionUpdate(sessionStorage, userId, item.id)
      throw reason
    }
    clearSubscriptionUpdate(sessionStorage, userId, item.id)
  }

  async function endSubscription(item: StrategySubscriptionView) {
    if (!session.value || submitting.value) return false
    const userId = String(session.value.user.id), csrfToken = session.value.csrf_token
    const generation = accountGeneration
    const result = await mutate(async () => {
      await sendSubscriptionPatch(userId, csrfToken, item, { status: 'ended' })
      if (String(session.value?.user.id) !== userId) return false
      if (generation === accountGeneration) await loadSubscriptions(item.accountId)
      return true
    }, '账户订阅已结束', '账户订阅结束失败')
    return result === true
  }

  async function refreshStrategies() {
    strategies.value = (await strategistApi.listStrategies()).data.items
  }

  async function mutate<T>(action: () => Promise<T>, success: string, fallback: string) {
    submitting.value = true
    actionError.value = ''
    notice.value = ''
    try { const value = await action(); notice.value = success; return value }
    catch (reason) { actionError.value = readableError(reason, fallback); return null }
    finally { submitting.value = false }
  }

  function clearCompile() { compileResult.value = null; analysisCompileResult.value = null; traderCompileResult.value = null; actionError.value = '' }
  function clearNotice() { notice.value = '' }

  onMounted(() => { if (options.autoLoad !== false) void load() })
  return {
    strategies, accounts, detail, subscriptions, symbols, loading, detailLoading, subscriptionLoading, refreshing, compiling,
    submitting, error, actionError, notice, compileResult, analysisCompileResult, traderCompileResult, personalStrategies, activeStrategies,
    load, loadDetail, fetchDetail, compile, compileCombination, saveCombination, createStrategy, updateMetadata, createVersion, publish, retire, loadSubscriptions,
    refreshSubscriptions, saveSubscription, endSubscription, clearCompile, clearNotice,
  }
}

function mapDetail(value: StrategyDetail): StrategyDetailView {
  const { versions, ...strategy } = value
  return {
    strategy,
    performance: value.performance,
    versions: versions.map((version) => ({
      id: version.id, versionNumber: version.version, promptText: version.promptText, promptSha256: version.promptHash,
      inputContractVersion: version.inputContractVersion, outputContractVersion: version.outputContractVersion,
      config: version.config, createdAt: version.createdAt,
    })),
  }
}

function mapCompile(value: StrategyCompileResult): CompileResultView {
  return {
    valid: value.valid, issues: value.issues.map((issue) => ({ ...issue, path: issue.path ?? '' })), normalizedConfig: value.normalizedConfig,
    promptSha256: value.promptHash, inputContractVersion: value.inputContractVersion, outputContractVersion: value.outputContractVersion,
  }
}

function mapSubscription(value: StrategySubscription): StrategySubscriptionView {
  return {
    id: value.id, accountId: value.tradingAccountId, symbol: value.standardSymbol,
    analysisStrategyId: value.analysisStrategyId, analysisStrategyVersionId: value.analysisStrategyVersionId,
    traderStrategyId: value.traderStrategyId, traderStrategyVersionId: value.traderStrategyVersionId,
    analysisEnabled: value.analysisEnabled, traderEnabled: value.traderEnabled, tradeSendEnabled: value.tradeSendEnabled,
    receiveWindow: subscriptionTimeWindowSchema.parse(value.schedule.receiveWindow), status: value.status, cadenceSeconds: value.schedule.cadenceSeconds, revision: value.revision, updatedAt: value.updatedAt,
  }
}

function readableError(reason: unknown, fallback: string) {
  if (reason instanceof ApiClientError) {
    if (reason.status === 401) return '登录已失效，请重新登录后再试。'
    if (reason.status === 403) return '当前账户没有此操作权限。'
    if (reason.problem?.code === 'strategy_subscription_strategy_unavailable') return '所选策略当前不可用，请确认策略已发布后再试。'
    if (reason.problem?.code === 'strategy_subscription_execution_conflict') return '此账户和品种已有启用的交易员订阅，请先关闭另一条订阅的 AI 交易员。'
    if (reason.status === 409) return '订阅与现有配置冲突，请检查是否重复或已结束。'
    if (reason.status === 412) return '设置已发生变化，请刷新后重新编辑。'
    if (reason.status === 429) return '操作较频繁，请稍后再试。'
  }
  return fallback
}
