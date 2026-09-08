import { computed, onBeforeUnmount, onMounted, ref, watch, type Ref } from 'vue'
import type { TradingAccount } from '@aurum/contracts'
import { useTradeSession } from '~/features/auth'
import { auditApi } from '../api/audit-api'
import { createAuditRealtime, type AuditRealtimeState } from '../realtime/audit-realtime'
import { emptyAuditSummary, isAuditSourceKind, type AuditDetail, type AuditEvent, type AuditFilters, type AuditSummary } from '../model/audit-presentation'

export function useAuditWorkspace(accountId: Ref<string>, filters: Ref<AuditFilters>) {
  const { session } = useTradeSession()
  const accounts = ref<TradingAccount[]>([])
  const items = ref<AuditEvent[]>([])
  const summary = ref<AuditSummary>(emptyAuditSummary())
  const nextCursor = ref<string | null>(null)
  const hasMore = ref(false)
  const selected = ref<AuditDetail | null>(null)
  const loading = ref(false)
  const loadingMore = ref(false)
  const detailLoading = ref(false)
  const error = ref('')
  const detailError = ref('')
  const realtime = ref<AuditRealtimeState>('idle')
  const isObserver = ref(false)
  const initialised = ref(false)
  let generation = 0
  let detailGeneration = 0
  let refreshTimer: number | null = null
  let realtimeController: ReturnType<typeof createAuditRealtime> | null = null

  const selectedAccount = computed(() => accounts.value.find((item) => item.id === accountId.value) ?? null)

  async function initialise() {
    loading.value = true
    error.value = ''
    try {
      const [contextResponse, accountResponse] = await Promise.all([auditApi.getContext(), auditApi.listAccounts()])
      accounts.value = accountResponse.data.items
      isObserver.value = contextResponse.data.mode === 'observer'

      if (accountId.value && !accounts.value.some((item) => item.id === accountId.value)) accountId.value = ''
      if (!accountId.value && contextResponse.data.mode === 'full' && contextResponse.data.accountId
        && accounts.value.some((item) => item.id === contextResponse.data.accountId)) {
        accountId.value = contextResponse.data.accountId
      }

      await load(true)
      initialised.value = true
      connectRealtimeForScope()
    } catch (reason) {
      error.value = readable(reason, '系统审计暂时无法读取')
    } finally {
      loading.value = false
    }
  }

  async function load(reset = true) {
    if (!initialised.value && !accountId.value && !accounts.value.length && loading.value) return
    const current = ++generation
    if (reset) loading.value = true
    else loadingMore.value = true
    error.value = ''
    try {
      const value = filters.value
      const response = await auditApi.list({
        ...(accountId.value ? { accountId: accountId.value } : {}),
        ...(value.category ? { category: value.category } : {}),
        ...(value.status ? { status: value.status } : {}),
        ...(value.actor ? { actor: value.actor } : {}),
        ...(value.from ? { from: `${value.from}T00:00:00.000Z` } : {}),
        ...(value.to ? { to: `${value.to}T23:59:59.999Z` } : {}),
        ...(value.query ? { query: value.query } : {}),
        pageSize: 50,
        cursor: reset ? null : nextCursor.value,
      })
      if (current !== generation) return
      items.value = reset ? response.data.items : [...items.value, ...response.data.items]
      summary.value = response.data.summary
      nextCursor.value = response.data.nextCursor
      hasMore.value = response.data.hasMore
    } catch (reason) {
      if (current === generation) error.value = readable(reason, '系统审计读取失败')
    } finally {
      if (current === generation) {
        loading.value = false
        loadingMore.value = false
      }
    }
  }

  async function loadDetail(sourceKind: string, sourceId: string) {
    if (!sourceKind || !sourceId || !isAuditSourceKind(sourceKind)) return
    const current = ++detailGeneration
    detailLoading.value = true
    detailError.value = ''
    selected.value = null
    try {
      const response = await auditApi.detail(sourceKind, sourceId)
      if (current === detailGeneration) selected.value = response.data
    } catch (reason) {
      if (current === detailGeneration) detailError.value = readable(reason, '审计详情读取失败')
    } finally {
      if (current === detailGeneration) detailLoading.value = false
    }
  }

  function closeDetail() {
    detailGeneration += 1
    selected.value = null
    detailError.value = ''
  }

  function connectRealtimeForScope() {
    realtimeController?.stop()
    realtimeController = null
    if (!session.value || isObserver.value) return
    realtimeController = createAuditRealtime({
      session: session.value,
      onState: (value) => { realtime.value = value },
      onChanged: () => {
        if (refreshTimer !== null) window.clearTimeout(refreshTimer)
        refreshTimer = window.setTimeout(() => void load(true), 350)
      },
      resync: () => load(true),
    })
  }

  function selectAccount(value: string) {
    accountId.value = value
  }

  watch(accountId, () => {
    if (!initialised.value) return
    items.value = []
    nextCursor.value = null
    hasMore.value = false
    closeDetail()
    void load(true)
    connectRealtimeForScope()
  })

  onMounted(() => void initialise())
  onBeforeUnmount(() => {
    realtimeController?.stop()
    if (refreshTimer !== null) window.clearTimeout(refreshTimer)
  })

  return {
    accounts,
    selectedAccount,
    items,
    summary,
    nextCursor,
    hasMore,
    selected,
    loading,
    loadingMore,
    detailLoading,
    error,
    detailError,
    realtime,
    isObserver,
    load,
    loadDetail,
    closeDetail,
    selectAccount,
  }
}

function readable(reason: unknown, fallback: string) {
  if (!(reason instanceof Error) || !reason.message) return fallback
  return reason.message.length <= 160 ? reason.message : fallback
}
