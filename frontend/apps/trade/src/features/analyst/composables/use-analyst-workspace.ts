import { readAnalysisFailureMessage } from '~/features/audit'
import { ApiClientError } from '@aurum/api-client'
import type { AnalysisJob, InferenceRealtimeEvent } from '@aurum/contracts'
import { useMutation, useQuery, useQueryClient } from '@tanstack/vue-query'
import { computed, onBeforeUnmount, onMounted, ref, type Ref, watch } from 'vue'
import { useTradeSession } from '~/features/auth'
import { prepareManualAnalysis, clearManualAnalysis } from '../model/manual-analysis-request'
import { analystApi } from '../api/analyst-api'
import { createAnalystRealtime, type AnalystRealtimeState } from '../realtime/analyst-realtime'

export function useAnalystWorkspace(selectedAnalysisId: Ref<string>, selectAnalysis: (id: string) => void) {
  const queryClient = useQueryClient()
  const { session } = useTradeSession()
  const userScope = computed(() => `${session.value?.user.id ?? ''}:${session.value?.authenticated_at ?? ''}`)
  const realtime = ref<AnalystRealtimeState>('idle')
  const currentJob = ref<AnalysisJob | null>(null)
  const manualError = ref('')
  const cooldownUntil = ref(0)
  let realtimeController: ReturnType<typeof createAnalystRealtime> | null = null
  let cooldownTimer: number | null = null

  const strategiesQuery = useQuery({
    queryKey: computed(() => ['trade', 'analyst', 'strategies', userScope.value]),
    queryFn: async () => (await analystApi.listStrategies()).data.items,
    staleTime: 60_000,
  })
  const analysesQuery = useQuery({
    queryKey: computed(() => ['trade', 'analyst', 'analyses', userScope.value]),
    queryFn: async () => (await analystApi.listAnalyses(50)).data.items,
    staleTime: 15_000,
  })
  const detailQuery = useQuery({
    queryKey: computed(() => ['trade', 'analyst', 'detail', userScope.value, selectedAnalysisId.value]),
    queryFn: async () => (await analystApi.getAnalysis(selectedAnalysisId.value)).data,
    enabled: computed(() => Boolean(selectedAnalysisId.value)),
    staleTime: 60_000,
  })

  watch(() => analysesQuery.data.value, (items, previous) => {
    if (items?.[0] && (!selectedAnalysisId.value || selectedAnalysisId.value === previous?.[0]?.analysisId)) {
      if (selectedAnalysisId.value !== items[0].analysisId) selectAnalysis(items[0].analysisId)
    }
  }, { immediate: true })

  const manualMutation = useMutation({
    mutationFn: async (input: { strategyId: string; symbol: string }) => {
      if (!session.value) throw new Error('当前登录会话已失效，请重新登录')
      const captured = userScope.value
      const user = String(session.value.user.id)
      const request = prepareManualAnalysis(sessionStorage, user, {
        strategy_id: input.strategyId, symbol: input.symbol.trim().toUpperCase(), mode: 'manual',
      })
      try {
        const job = (await analystApi.createManualAnalysis(session.value.csrf_token, request.body, request.idempotencyKey)).data
        clearManualAnalysis(sessionStorage, user)
        if (captured === userScope.value) {
          currentJob.value = job
          manualError.value = ''
          setCooldown(Date.parse(job.createdAt) + 300_000)
        }
        return job
      } catch (error) {
        if (error instanceof ApiClientError && [400, 401, 403, 404, 422, 429].includes(error.status)) clearManualAnalysis(sessionStorage, user)
        if (captured !== userScope.value) return null
        throw error
      }
    },
    onError(error) {
      manualError.value = manualAnalysisError(error)
      if (error instanceof ApiClientError && error.problem?.retry_after_ms) setCooldown(Date.now() + error.problem.retry_after_ms)
    },
  })

  async function resync() {
    await Promise.all([analysesQuery.refetch(), strategiesQuery.refetch()])
  }

  function onRealtimeEvent(event: InferenceRealtimeEvent) {
    if (event.type === 'market_analysis.created') {
      void queryClient.invalidateQueries({ queryKey: ['trade', 'analyst', 'analyses'] })
      if (!selectedAnalysisId.value) selectAnalysis(event.resource.id)
      return
    }
    if (event.type === 'analysis.job.changed' && currentJob.value?.analysisId === event.resource.id) {
      const data = objectData(event.data)
      if (Number(event.revision) <= Number(currentJob.value.revision ?? 0)) return
      const status = data.status
      if (typeof status === 'string' && ['queued', 'running', 'succeeded', 'failed', 'cancelled', 'expired'].includes(status)) {
        currentJob.value = { ...currentJob.value, status: status as AnalysisJob['status'], updatedAt: String(data.updated_at ?? currentJob.value.updatedAt), revision: Number(event.revision) }
        if (status === 'failed') {
          const id = event.resource.id, scope = userScope.value, revision = Number(event.revision)
          void readAnalysisFailureMessage(id).then(message => {
            if (userScope.value === scope && currentJob.value?.analysisId === id && currentJob.value.revision === revision) manualError.value = message
          })
        }
      }
    }
  }

  function setCooldown(value: number) {
    cooldownUntil.value = value
    if (cooldownTimer !== null) window.clearTimeout(cooldownTimer)
    cooldownTimer = window.setTimeout(() => { cooldownUntil.value = 0; cooldownTimer = null }, Math.max(0, value - Date.now()))
  }

  onMounted(() => {
    if (!session.value) return
    realtimeController = createAnalystRealtime({ session: session.value, onState: (value) => { realtime.value = value }, onEvent: onRealtimeEvent, resync })
  })
  onBeforeUnmount(() => {
    realtimeController?.stop()
    if (cooldownTimer !== null) window.clearTimeout(cooldownTimer)
  })

  return {
    strategiesLoading: computed(() => strategiesQuery.isPending.value),
    strategiesError: computed(() => readableQueryError(strategiesQuery.error.value)),
    retryDetail: () => detailQuery.refetch(),
    historyStrategies: computed(() => strategiesQuery.data.value ?? []),
    strategies: computed(() => (strategiesQuery.data.value ?? []).filter((item) => item.status === 'active' && item.activeVersionId)),
    analyses: computed(() => analysesQuery.data.value ?? []),
    detail: computed(() => detailQuery.data.value ?? null),
    loadingList: computed(() => analysesQuery.isPending.value),
    loadingDetail: computed(() => Boolean(selectedAnalysisId.value) && (detailQuery.isPending.value || detailQuery.isFetching.value)),
    refreshing: computed(() => analysesQuery.isFetching.value && !analysesQuery.isPending.value),
    listError: computed(() => readableQueryError(analysesQuery.error.value)),
    detailError: computed(() => readableQueryError(detailQuery.error.value)),
    realtime,
    currentJob,
    manualError,
    manualPending: computed(() => manualMutation.isPending.value),
    manualCoolingDown: computed(() => cooldownUntil.value > Date.now()),
    runManual: (strategyId: string, symbol: string) => manualMutation.mutateAsync({ strategyId, symbol }),
    refresh: resync,
  }
}

function objectData(value: unknown) {
  return typeof value === 'object' && value !== null ? value as Record<string, unknown> : {}
}

function readableQueryError(error: unknown) {
  return error ? '分析数据暂时无法读取，请稍后重试。' : ''
}

function manualAnalysisError(error: unknown) {
  if (error instanceof ApiClientError) {
    if (error.problem?.code === 'manual_analysis_cooldown') return '距离上次手动分析不足 5 分钟，请稍后再试。'
    if (error.problem?.code === 'strategy_not_active') return '所选策略当前未发布，无法执行分析。'
    return '分析请求未能提交，请检查策略状态后重试。'
  }
  return '手动分析请求未能提交，请稍后重试。'
}
