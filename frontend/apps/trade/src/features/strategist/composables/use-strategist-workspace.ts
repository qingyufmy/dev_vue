import type {
  StrategyCompileResult, StrategyDetail, StrategySubscription, StrategySubscriptionPatchBody,
  StrategySummary, TradingAccount,
} from '@aurum/contracts'
import { computed, onMounted, ref } from 'vue'
import { useTradeSession } from '~/features/auth/session'
import { strategistApi } from '../api/strategist-api'
import type {
  CompileResultView, StrategyDetailView, StrategyDraft, StrategySubscriptionView, SubscriptionDraft,
} from '../model/strategy-presentation'

export function useStrategistWorkspace() {
  const { session } = useTradeSession()
  const strategies = ref<StrategySummary[]>([])
  const accounts = ref<TradingAccount[]>([])
  const detail = ref<StrategyDetailView | null>(null)
  const subscriptions = ref<StrategySubscriptionView[]>([])
  const symbols = ref<string[]>([])
  const loading = ref(false)
  const detailLoading = ref(false)
  const subscriptionLoading = ref(false)
  const refreshing = ref(false)
  const compiling = ref(false)
  const submitting = ref(false)
  const error = ref('')
  const actionError = ref('')
  const notice = ref('')
  const compileResult = ref<CompileResultView | null>(null)
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
    if (!strategyId) return
    detailLoading.value = true
    actionError.value = ''
    try {
      const response = await strategistApi.getStrategy(strategyId)
      if (generation === detailGeneration) detail.value = mapDetail(response.data)
    } catch (reason) { if (generation === detailGeneration) actionError.value = readableError(reason, '策略详情读取失败') }
    finally { if (generation === detailGeneration) detailLoading.value = false }
  }

  async function compile(draft: StrategyDraft) {
    if (!session.value) return
    compiling.value = true
    actionError.value = ''
    compileResult.value = null
    try {
      const response = await strategistApi.compileStrategy(session.value.csrf_token, {
        kind: draft.kind, prompt_text: draft.promptText, config: draft.config,
      })
      compileResult.value = mapCompile(response.data)
    } catch (reason) { actionError.value = readableError(reason, '策略合同校验失败') }
    finally { compiling.value = false }
  }

  async function createStrategy(draft: StrategyDraft) {
    if (!session.value) return null
    return mutate(async () => {
      const response = await strategistApi.createStrategy(session.value!.csrf_token, {
        kind: draft.kind, name: draft.name, description: draft.description, prompt_text: draft.promptText, config: draft.config,
      })
      await refreshStrategies()
      detail.value = mapDetail(response.data)
      return response.data.id
    }, '策略草稿已保存', '策略创建失败')
  }

  async function updateMetadata(name: string, description: string) {
    if (!session.value || !detail.value) return false
    const current = detail.value.strategy
    const result = await mutate(async () => {
      const response = await strategistApi.updateStrategyMetadata(session.value!.csrf_token, current.id, { name, description }, current.revision)
      detail.value = mapDetail(response.data)
      await refreshStrategies()
      return true
    }, '策略资料已更新', '策略资料保存失败')
    return result === true
  }

  async function createVersion(draft: StrategyDraft) {
    if (!session.value || !detail.value) return false
    const current = detail.value.strategy
    const result = await mutate(async () => {
      const response = await strategistApi.createStrategyVersion(session.value!.csrf_token, current.id, { prompt_text: draft.promptText, config: draft.config }, current.revision)
      detail.value = mapDetail(response.data)
      await refreshStrategies()
      return true
    }, '新版本已保存，尚未发布', '策略版本保存失败')
    return result === true
  }

  async function publish(versionId: string) {
    if (!session.value || !detail.value) return false
    const current = detail.value.strategy
    const result = await mutate(async () => {
      const response = await strategistApi.publishStrategyVersion(session.value!.csrf_token, current.id, versionId, current.revision)
      detail.value = mapDetail(response.data)
      await refreshStrategies()
      return true
    }, '策略版本已发布', '策略发布失败')
    return result === true
  }

  async function retire() {
    if (!session.value || !detail.value) return false
    const current = detail.value.strategy
    const result = await mutate(async () => {
      const response = await strategistApi.retireStrategy(session.value!.csrf_token, current.id, current.revision)
      detail.value = mapDetail(response.data)
      await refreshStrategies()
      return true
    }, '策略已退役，历史版本仍保留', '策略退役失败')
    return result === true
  }

  async function loadSubscriptions(accountId: string) {
    const generation = ++accountGeneration
    subscriptions.value = []
    symbols.value = []
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
    if (!session.value) return false
    const result = await mutate(async () => {
      if (current) {
        const patch: StrategySubscriptionPatchBody = {
          trader_strategy_id: draft.traderEnabled ? draft.traderStrategyId : null,
          analysis_enabled: draft.analysisEnabled,
          trader_enabled: draft.traderEnabled,
          trade_send_enabled: draft.tradeSendEnabled,
          status: draft.status,
        }
        await strategistApi.updateSubscription(session.value!.csrf_token, current.id, patch, current.revision)
      } else {
        await strategistApi.createSubscription(session.value!.csrf_token, {
          trading_account_id: draft.accountId, symbol: draft.symbol, analysis_strategy_id: draft.analysisStrategyId,
          trader_strategy_id: draft.traderEnabled ? draft.traderStrategyId : null,
          analysis_enabled: draft.analysisEnabled, trader_enabled: draft.traderEnabled,
          trade_send_enabled: draft.tradeSendEnabled, status: draft.status === 'paused' ? 'paused' : 'active',
        })
      }
      await loadSubscriptions(draft.accountId)
      return true
    }, current ? '账户订阅已更新' : '账户订阅已创建', current ? '账户订阅更新失败' : '账户订阅创建失败')
    return result === true
  }

  async function endSubscription(item: StrategySubscriptionView) {
    if (!session.value) return false
    const result = await mutate(async () => {
      await strategistApi.updateSubscription(session.value!.csrf_token, item.id, { status: 'ended' }, item.revision)
      await loadSubscriptions(item.accountId)
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

  function clearCompile() { compileResult.value = null; actionError.value = '' }
  function clearNotice() { notice.value = '' }

  onMounted(load)
  return {
    strategies, accounts, detail, subscriptions, symbols, loading, detailLoading, subscriptionLoading, refreshing, compiling,
    submitting, error, actionError, notice, compileResult, personalStrategies, activeStrategies,
    load, loadDetail, compile, createStrategy, updateMetadata, createVersion, publish, retire, loadSubscriptions,
    refreshSubscriptions, saveSubscription, endSubscription, clearCompile, clearNotice,
  }
}

function mapDetail(value: StrategyDetail): StrategyDetailView {
  const { versions, ...strategy } = value
  return {
    strategy,
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
    status: value.status, cadenceSeconds: value.schedule.cadenceSeconds, revision: value.revision, updatedAt: value.updatedAt,
  }
}

function readableError(reason: unknown, fallback: string) { return reason instanceof Error && reason.message ? reason.message : fallback }
