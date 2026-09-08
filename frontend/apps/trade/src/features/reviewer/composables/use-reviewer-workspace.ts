import { computed, onMounted, onBeforeUnmount, ref, watch, type Ref } from 'vue'
import type { ReviewRealtimeEvent } from '@aurum/contracts'
import { useTradeSession } from '~/features/auth'
import { reviewerApi } from '../api/reviewer-api'
import { createReviewerRealtime, type ReviewerRealtimeState } from '../realtime/reviewer-realtime'
import {
  mapManualReviewCandidate,
  mapReviewCaseDetail,
  mapReviewCaseSummary,
  mapMemoryUpdate,
  mapStrategyMemoryDetail,
  mapStrategyMemorySummary,
  reviewContentForVersion,
  type ManualReviewCandidate,
  type MemoryUpdate,
  type ReviewCaseDetail,
  type ReviewCaseSummary,
  type ReviewerSection,
  type StrategyMemoryDetail,
  type StrategyMemorySummary,
} from '../model/reviewer-presentation'

export function useReviewerWorkspace(input: {
  section: Ref<ReviewerSection>
  selectedCaseId: Ref<string>
  selectedMemoryId: Ref<string>
}) {
  const { session } = useTradeSession()
  const periodCases = ref<ReviewCaseSummary[]>([])
  const manualCases = ref<ReviewCaseSummary[]>([])
  const manualCandidates = ref<ManualReviewCandidate[]>([])
  const analysisStrategies = ref<Array<{ id: string; name: string }>>([])
  const memories = ref<StrategyMemorySummary[]>([])
  const memoryUpdates = ref<MemoryUpdate[]>([])
  const caseDetail = ref<ReviewCaseDetail | null>(null)
  const memoryDetail = ref<StrategyMemoryDetail | null>(null)

  const loading = ref(false)
  const refreshing = ref(false)
  const detailLoading = ref(false)
  const memoryDetailLoading = ref(false)
  const action = ref('')
  const error = ref('')
  const periodError = ref('')
  const manualError = ref('')
  const memoryError = ref('')
  const detailError = ref('')
  const memoryDetailError = ref('')
  const notice = ref('')
  const realtime = ref<ReviewerRealtimeState>('idle')
  let realtimeController: ReturnType<typeof createReviewerRealtime> | null = null
  let generation = 0
  let detailGeneration = 0
  let memoryGeneration = 0

  const currentList = computed(() => input.section.value === 'memory'
    ? memories.value
    : input.section.value === 'manual' ? manualCases.value : periodCases.value)

  async function loadSection(section = input.section.value) {
    const currentGeneration = ++generation
    loading.value = true
    error.value = ''
    notice.value = ''
    try {
      if (section === 'period') await loadPeriods(currentGeneration)
      else if (section === 'manual') await loadManual(currentGeneration)
      else await loadMemories(currentGeneration)
    } catch (reason) {
      if (currentGeneration === generation) error.value = readableError(reason, '复盘工作区暂时无法读取')
    } finally {
      if (currentGeneration === generation) loading.value = false
    }
  }

  async function loadPeriods(currentGeneration = generation) {
    periodError.value = ''
    try {
      const response = await reviewerApi.listReviewCases({ pageSize: 50 })
      if (currentGeneration !== generation) return
      periodCases.value = response.data.items
        .map(mapReviewCaseSummary)
        .filter((item) => item.kind === 'daily' || item.kind === 'monthly')
    } catch (reason) {
      if (currentGeneration === generation) { periodCases.value = []; periodError.value = readableError(reason, '周期复盘列表读取失败') }
      throw reason
    }
  }

  async function loadManual(currentGeneration = generation) {
    manualError.value = ''
    try {
      const [candidateResponse, caseResponse, strategyResponse] = await Promise.all([
        reviewerApi.listManualReviewCandidates(undefined, 50),
        reviewerApi.listReviewCases({ kind: 'manual', pageSize: 50 }),
        reviewerApi.listAnalysisStrategies(),
      ])
      if (currentGeneration !== generation) return
      manualCandidates.value = candidateResponse.data.items.map(mapManualReviewCandidate).filter((item) => item.id)
      manualCases.value = caseResponse.data.items.map(mapReviewCaseSummary)
      analysisStrategies.value = strategyResponse.data.items.map((item) => ({ id: item.id, name: item.name }))
    } catch (reason) {
      if (currentGeneration === generation) { manualCandidates.value = []; manualCases.value = []; manualError.value = readableError(reason, '手动交易复盘读取失败') }
      throw reason
    }
  }

  async function loadMemories(currentGeneration = generation) {
    memoryError.value = ''
    try {
      const memoryResponse = await reviewerApi.listStrategyMemories()
      if (currentGeneration !== generation) return
      memories.value = memoryResponse.data.items.map(mapStrategyMemorySummary).filter((item) => item.id)
      memoryUpdates.value = []
    } catch (reason) {
      if (currentGeneration === generation) { memories.value = []; memoryUpdates.value = []; memoryError.value = readableError(reason, '策略记忆读取失败') }
      throw reason
    }
  }

  async function loadCase(caseId: string) {
    const currentGeneration = ++detailGeneration
    caseDetail.value = null
    detailError.value = ''
    if (!caseId) return
    detailLoading.value = true
    try {
      const response = await reviewerApi.getReviewCase(caseId)
      if (currentGeneration === detailGeneration) caseDetail.value = mapReviewCaseDetail(response.data)
    } catch (reason) {
      if (currentGeneration === detailGeneration) detailError.value = readableError(reason, '复盘详情读取失败')
    } finally {
      if (currentGeneration === detailGeneration) detailLoading.value = false
    }
  }

  async function loadMemory(memoryId: string) {
    const currentGeneration = ++memoryGeneration
    memoryDetail.value = null
    memoryDetailError.value = ''
    if (!memoryId) return
    memoryDetailLoading.value = true
    try {
      const [response, updateResponse] = await Promise.all([
        reviewerApi.getStrategyMemory(memoryId),
        reviewerApi.listMemoryUpdates(memoryId),
      ])
      if (currentGeneration === memoryGeneration) {
        memoryDetail.value = mapStrategyMemoryDetail(response.data)
        memoryUpdates.value = updateResponse.data.items
          .map(mapMemoryUpdate)
          .filter((item) => ['collecting_evidence', 'awaiting_confirmation', 'merged'].includes(item.status))
        memoryDetail.value.updates = memoryUpdates.value
      }
    } catch (reason) {
      if (currentGeneration === memoryGeneration) memoryDetailError.value = readableError(reason, '策略记忆详情读取失败')
    } finally {
      if (currentGeneration === memoryGeneration) memoryDetailLoading.value = false
    }
  }

  async function refresh() {
    refreshing.value = true
    try { await loadSection() }
    finally { refreshing.value = false }
  }

  async function createManualReview(items: ManualReviewCandidate[], strategyId: string, tradingIdea: string) {
    if (!session.value || action.value || !items.length || !strategyId) return null
    action.value = 'create-manual'
    error.value = ''
    try {
      const response = await reviewerApi.createManualReviewCase(session.value.csrf_token, {
        candidate_ids: items.map((item) => item.id),
        selection_tokens: items.map((item) => item.selectionToken),
        strategy_id: strategyId,
        user_thesis: tradingIdea.trim() || null,
      }, crypto.randomUUID())
      notice.value = '手动复盘已受理，生成完成后会出现在复盘记录中。'
      await loadManual()
      const id = response.data.summary.id
      return id
    } catch (reason) {
      error.value = readableError(reason, '手动复盘创建失败')
      return null
    } finally { action.value = '' }
  }

  async function createVersion(content: string, _changeNote: string) {
    if (!session.value || !caseDetail.value || action.value) return false
    action.value = 'version'
    error.value = ''
    try {
      await reviewerApi.createReviewVersion(session.value.csrf_token, caseDetail.value.id, reviewContentForVersion(caseDetail.value, content), caseDetail.value.revision)
      notice.value = '复盘修订已保存为新版本。'
      await loadCase(caseDetail.value.id)
      return true
    } catch (reason) {
      error.value = readableError(reason, '复盘修订保存失败')
      return false
    } finally { action.value = '' }
  }

  async function confirmCase(versionId?: string) {
    if (!session.value || !caseDetail.value || action.value) return false
    const selectedVersionId = versionId || caseDetail.value.currentVersionId
    if (!selectedVersionId) return false
    action.value = 'confirm-case'
    error.value = ''
    try {
      await reviewerApi.confirmReviewVersion(session.value.csrf_token, caseDetail.value.id, selectedVersionId, caseDetail.value.revision)
      notice.value = '复盘已确认，符合条件的记忆候选仍需单独确认。'
      await loadCase(caseDetail.value.id)
      await loadSection(input.section.value)
      return true
    } catch (reason) {
      error.value = readableError(reason, '复盘确认失败')
      return false
    } finally { action.value = '' }
  }

  async function returnCase(reasonText: string) {
    if (!session.value || !caseDetail.value || action.value) return false
    action.value = 'return-case'
    error.value = ''
    try {
      await reviewerApi.returnReviewCase(session.value.csrf_token, caseDetail.value.id, reasonText, caseDetail.value.revision)
      notice.value = '复盘已退回，系统会保留原版本和证据链。'
      await loadCase(caseDetail.value.id)
      await loadSection()
      return true
    } catch (failure) {
      error.value = readableError(failure, '复盘退回失败')
      return false
    } finally { action.value = '' }
  }

  async function decideMemoryUpdate(update: MemoryUpdate, decision: 'confirm' | 'reject' | 'revoke', _reasonText = '') {
    const canDecide = decision === 'revoke'
      ? update.status === 'merged'
      : update.status === 'awaiting_confirmation'
    if (!session.value || action.value || !canDecide) return false
    action.value = `memory-${decision}`
    error.value = ''
    try {
      const apiDecision = decision === 'confirm' ? 'accept' : decision === 'revoke' ? 'revoke' : 'reject'
      await reviewerApi.decideMemoryUpdate(session.value.csrf_token, update.id, apiDecision, update.revision)
      notice.value = decision === 'confirm' ? '记忆候选已确认，系统已创建新的不可变记忆版本。' : decision === 'revoke' ? '记忆合并已撤销，原记忆版本仍保留。' : '记忆候选已驳回，原记忆版本未改变。'
      await loadMemories()
      if (memoryDetail.value?.id) await loadMemory(memoryDetail.value.id)
      return true
    } catch (failure) {
      error.value = readableError(failure, decision === 'confirm' ? '记忆候选确认失败' : decision === 'revoke' ? '记忆合并撤销失败' : '记忆候选驳回失败')
      return false
    } finally { action.value = '' }
  }

  function handleRealtimeEvent(event: ReviewRealtimeEvent) {
    if (event.type === 'review.case.changed') {
      if (input.section.value === 'period' || input.section.value === 'manual') void loadSection(input.section.value)
      if (input.selectedCaseId.value === event.data.review_case_id) void loadCase(event.data.review_case_id)
      return
    }
    if (input.section.value === 'memory') void loadSection('memory')
    if (input.selectedMemoryId.value === event.data.strategy_memory_id) void loadMemory(event.data.strategy_memory_id)
  }

  async function resync() {
    await loadSection(input.section.value)
    await Promise.all([
      input.selectedCaseId.value ? loadCase(input.selectedCaseId.value) : Promise.resolve(),
      input.selectedMemoryId.value ? loadMemory(input.selectedMemoryId.value) : Promise.resolve(),
    ])
  }

  function startRealtime() {
    if (!session.value || realtimeController) return
    realtimeController = createReviewerRealtime({
      session: session.value,
      onState: (state) => { realtime.value = state },
      onEvent: handleRealtimeEvent,
      resync,
    })
  }

  watch(input.section, (section) => { void loadSection(section) })
  watch(input.selectedCaseId, (id) => { void loadCase(id) })
  watch(input.selectedMemoryId, (id) => { void loadMemory(id) })
  onMounted(async () => {
    await loadSection()
    if (input.selectedCaseId.value) await loadCase(input.selectedCaseId.value)
    if (input.selectedMemoryId.value) await loadMemory(input.selectedMemoryId.value)
    startRealtime()
  })
  onBeforeUnmount(() => { realtimeController?.stop(); realtimeController = null })

  return {
    periodCases, manualCases, manualCandidates, analysisStrategies, memories, memoryUpdates, currentList,
    caseDetail, memoryDetail, loading, refreshing, detailLoading, memoryDetailLoading, action,
    error, periodError, manualError, memoryError, detailError, memoryDetailError, notice, realtime,
    loadSection, loadPeriods, loadManual, loadMemories, loadCase, loadMemory, refresh,
    createManualReview, createVersion, confirmCase, returnCase, decideMemoryUpdate,
  }
}

function readableError(reason: unknown, fallback: string): string {
  return reason instanceof Error && reason.message ? reason.message : fallback
}
