import type {
  DistributionCloseCommand,
  ExecutionCommand,
  ExecutionCommandContext,
  ExecutionDistribution,
  ExecutionDistributionDetail,
  ExecutionDistributionPreview,
  Operation,
} from '@aurum/contracts'
import { computed, ref } from 'vue'
import { useTradeSession } from '~/features/auth/session'
import { traderApi } from '../api/trader-api'

export function useTraderCommands() {
  const { session } = useTradeSession()
  const commandContext = ref<ExecutionCommandContext | null>(null)
  const distributionPreview = ref<ExecutionDistributionPreview | null>(null)
  const activeDistribution = ref<ExecutionDistributionDetail | null>(null)
  const operations = ref<Operation[]>([])
  const loadingContext = ref(false)
  const previewingDistribution = ref(false)
  const submitting = ref(false)
  const error = ref('')
  const administrator = computed(() => session.value?.permissions.includes('admin') ?? false)
  let contextGeneration = 0
  let previewGeneration = 0
  const pendingRealtimeOperationIds = new Set<string>()

  async function prepareCommand(accountId: string, symbol?: string | null, ticket?: string | null) {
    const generation = ++contextGeneration
    loadingContext.value = true
    error.value = ''
    commandContext.value = null
    distributionPreview.value = null
    try {
      const context = (await traderApi.getCommandContext(accountId, symbol, ticket)).data
      if (generation !== contextGeneration) return null
      commandContext.value = context
      return commandContext.value
    } catch (reason) {
      if (generation === contextGeneration) error.value = readableError(reason, '交易执行上下文暂时无法读取')
      return null
    } finally {
      if (generation === contextGeneration) loadingContext.value = false
    }
  }

  async function previewDistribution(strategyId: string, symbol: string) {
    const generation = ++previewGeneration
    previewingDistribution.value = true
    error.value = ''
    distributionPreview.value = null
    try {
      const preview = (await traderApi.previewDistribution(strategyId, symbol)).data
      if (generation !== previewGeneration) return null
      distributionPreview.value = preview
      return distributionPreview.value
    } catch (reason) {
      if (generation === previewGeneration) error.value = readableError(reason, '策略分发范围暂时无法预览')
      return null
    } finally {
      if (generation === previewGeneration) previewingDistribution.value = false
    }
  }

  async function submitCommand(accountId: string, command: ExecutionCommand) {
    return submit(async () => {
      const current = requireSession()
      return (await traderApi.createCommand(current.csrf_token, accountId, command, crypto.randomUUID())).data
    })
  }

  async function submitDistributionCommand(distribution: ExecutionDistribution) {
    const operation = await submit(async () => {
      const current = requireSession()
      return (await traderApi.createDistribution(current.csrf_token, distribution, crypto.randomUUID())).data
    })
    if (operation?.distributionId) await refreshDistribution(operation.distributionId)
    return operation
  }

  async function submitDistributionClose(distributionId: string, expectedRevision: string, targetIds: string[] = []) {
    const body: DistributionCloseCommand = { expected_revision: expectedRevision, target_ids: targetIds }
    const operation = await submit(async () => {
      const current = requireSession()
      return (await traderApi.createDistributionClose(current.csrf_token, distributionId, body, crypto.randomUUID())).data
    })
    if (operation?.distributionId) await refreshDistribution(operation.distributionId)
    return operation
  }

  async function submit(work: () => Promise<Operation>) {
    if (submitting.value) return null
    submitting.value = true
    error.value = ''
    try {
      const operation = await work()
      upsertOperation(operation)
      if (pendingRealtimeOperationIds.delete(operation.operationId)) await refreshOperation(operation.operationId)
      return operation
    } catch (reason) {
      error.value = readableError(reason, '交易操作提交失败')
      return null
    } finally {
      submitting.value = false
      pendingRealtimeOperationIds.clear()
    }
  }

  async function handleOperationChanged(operationId: string) {
    if (!operations.value.some((item) => item.operationId === operationId)) {
      if (submitting.value) pendingRealtimeOperationIds.add(operationId)
      return
    }
    await refreshOperation(operationId)
  }

  async function refreshOperation(operationId: string) {
    try {
      const operation = (await traderApi.getOperation(operationId)).data
      upsertOperation(operation)
      if (operation.distributionId) await refreshDistribution(operation.distributionId)
    } catch {
      // A later HTTP refresh remains authoritative; realtime is only an invalidation hint.
    }
  }

  async function refreshDistribution(distributionId: string) {
    if (!administrator.value) return null
    try {
      activeDistribution.value = (await traderApi.getDistribution(distributionId)).data
      return activeDistribution.value
    } catch (reason) {
      error.value = readableError(reason, '分发执行详情暂时无法读取')
      return null
    }
  }

  function clearPreparedState() {
    contextGeneration += 1
    previewGeneration += 1
    commandContext.value = null
    distributionPreview.value = null
    error.value = ''
  }

  function clearDistributionPreview() {
    previewGeneration += 1
    distributionPreview.value = null
  }

  function upsertOperation(operation: Operation) {
    const next = operations.value.filter((item) => item.operationId !== operation.operationId)
    operations.value = [operation, ...next].slice(0, 20)
  }

  function requireSession() {
    if (!session.value) throw new Error('当前会话已失效，请重新登录')
    return session.value
  }

  return {
    administrator,
    commandContext,
    distributionPreview,
    activeDistribution,
    operations,
    loadingContext,
    previewingDistribution,
    submitting,
    error,
    prepareCommand,
    previewDistribution,
    submitCommand,
    submitDistributionCommand,
    submitDistributionClose,
    handleOperationChanged,
    refreshDistribution,
    clearPreparedState,
    clearDistributionPreview,
  }
}

function readableError(reason: unknown, fallback: string) {
  return reason instanceof Error && reason.message ? reason.message : fallback
}
