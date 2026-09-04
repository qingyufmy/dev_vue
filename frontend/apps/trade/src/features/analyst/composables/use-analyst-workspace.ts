import { ApiClientError } from '@aurum/api-client'
import type { AnalysisJob, InferenceRealtimeEvent } from '@aurum/contracts'
import { useMutation, useQuery, useQueryClient } from '@tanstack/vue-query'
import { computed, onBeforeUnmount, onMounted, ref, type Ref, watch } from 'vue'
import { useTradeSession } from '~/features/auth/session'
import { analystApi } from '../api/analyst-api'
import { createAnalystRealtime, type AnalystRealtimeState } from '../realtime/analyst-realtime'

export function useAnalystWorkspace(selectedAnalysisId: Ref<string>, selectAnalysis: (id: string) => void) {
  const queryClient = useQueryClient()
  const { session } = useTradeSession()
  const realtime = ref<AnalystRealtimeState>('idle')
  const currentJob = ref<AnalysisJob | null>(null)
  const manualError = ref('')
  const cooldownUntil = ref(0)
  let realtimeController: ReturnType<typeof createAnalystRealtime> | null = null
  let cooldownTimer: number | null = null

  const strategiesQuery = useQuery({
    queryKey: ['trade', 'analyst', 'strategies'],
    queryFn: async () => (await analystApi.listStrategies()).data.items,
    staleTime: 60_000,
  })
  const analysesQuery = useQuery({
    queryKey: ['trade', 'analyst', 'analyses'],
    queryFn: async () => (await analystApi.listAnalyses(50)).data.items,
    staleTime: 15_000,
  })
  const detailQuery = useQuery({
    queryKey: computed(() => ['trade', 'analyst', 'detail', selectedAnalysisId.value]),
    queryFn: async () => (await analystApi.getAnalysis(selectedAnalysisId.value)).data,
    enabled: computed(() => Boolean(selectedAnalysisId.value)),
    staleTime: 60_000,
  })

  watch(() => analysesQuery.data.value, (items) => {
    if (!selectedAnalysisId.value && items?.[0]) selectAnalysis(items[0].analysisId)
  }, { immediate: true })

  const manualMutation = useMutation({
    mutationFn: async (input: { strategyId: string; symbol: string }) => {
      if (!session.value) throw new Error('当前登录会话已失效，请重新登录')
      return (await analystApi.createManualAnalysis(session.value.csrf_token, {
        strategy_id: input.strategyId,
        symbol: input.symbol.trim().toUpperCase(),
        mode: 'manual',
      }, crypto.randomUUID())).data
    },
    onSuccess(job) {
      currentJob.value = job
      manualError.value = ''
      setCooldown(Date.now() + 180_000)
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
      return
    }
    if (event.type === 'analysis.job.changed' && currentJob.value?.analysisId === event.resource.id) {
      const data = objectData(event.data)
      const status = data.status
      if (typeof status === 'string' && ['queued', 'running', 'succeeded', 'failed', 'cancelled', 'expired'].includes(status)) {
        currentJob.value = { ...currentJob.value, status: status as AnalysisJob['status'], updatedAt: String(data.updated_at ?? currentJob.value.updatedAt), revision: Number(event.revision) }
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
    strategies: computed(() => (strategiesQuery.data.value ?? []).filter((item) => item.status === 'active' && item.activeVersionId)),
    analyses: computed(() => analysesQuery.data.value ?? []),
    detail: computed(() => detailQuery.data.value ?? null),
    loadingList: computed(() => analysesQuery.isPending.value),
    loadingDetail: computed(() => detailQuery.isPending.value || detailQuery.isFetching.value),
    refreshing: computed(() => analysesQuery.isFetching.value && !analysesQuery.isPending.value),
    listError: computed(() => readableQueryError(analysesQuery.error.value)),
    detailError: computed(() => readableQueryError(detailQuery.error.value)),
    realtime,
    currentJob,
    manualError,
    manualPending: computed(() => manualMutation.isPending.value),
    manualCoolingDown: computed(() => cooldownUntil.value > Date.now()),
    runManual: (strategyId: string, symbol: string) => manualMutation.mutateAsync({ strategyId, symbol }),
    refresh: () => analysesQuery.refetch(),
  }
}

function objectData(value: unknown) {
  return typeof value === 'object' && value !== null ? value as Record<string, unknown> : {}
}

function readableQueryError(error: unknown) {
  return error instanceof Error ? error.message : error ? '分析数据暂时无法读取' : ''
}

function manualAnalysisError(error: unknown) {
  if (error instanceof ApiClientError) {
    if (error.problem?.code === 'manual_analysis_cooldown') return '距离上次手动分析不足 3 分钟，请稍后再试。'
    if (error.problem?.code === 'strategy_not_active') return '所选策略当前未发布，无法执行分析。'
    return error.problem?.detail || error.message
  }
  return error instanceof Error ? error.message : '手动分析请求未能提交'
}
