import { onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { ApiClientError } from '@aurum/api-client'
import type { RiskPolicyPatchBody } from '@aurum/contracts'
import { riskApi } from '../api/risk-api'
import { createPolicyWriteRecovery, readPendingPolicy, type PendingPolicyWrite } from '../model/policy-write-recovery'

interface Context { userId: string; accountId: string; csrfToken: string; revision: number; readOnly: boolean; generation: number }
export function usePolicyWriteRecovery(context: () => Context | null, refresh: () => Promise<void>) {
  const pending = ref<PendingPolicyWrite | null>(null), busy = ref(false), message = ref(''), error = ref('')
  let operation: symbol | null = null
  function sync() {
    pending.value = null
    const current = context()
    if (!current) return
    try { pending.value = readPendingPolicy(localStorage, current) }
    catch { error.value = '无法读取待确认策略，请检查浏览器存储。' }
  }
  async function run(action: 'create' | 'query' | 'retry', body?: RiskPolicyPatchBody) {
    const start = context()
    if (!start || busy.value || (action !== 'query' && start.readOnly)) return false
    const current = () => {
      const now = context()
      return now !== null && now.userId === start.userId && now.accountId === start.accountId
        && now.generation === start.generation && (action === 'query' || !now.readOnly)
    }
    const token = Symbol('policy-write')
    operation = token; busy.value = true; error.value = ''; message.value = ''
    let confirmed = false
    try {
      const recovery = createPolicyWriteRecovery({ storage: localStorage, key: () => crypto.randomUUID(), current,
        lock: async (name, work) => {
          if (!navigator.locks) throw Error('policy_storage_lock_unavailable')
          return navigator.locks.request(name, work)
        },
        query: async request => (await riskApi.getPolicyReceipt(request.accountId, request.key)).data.state,
        send: async request => { await riskApi.replacePolicy(context()!.csrfToken, request.accountId, request.body, request.revision, request.key) },
        knownPreWriteRejection: failure => failure instanceof ApiClientError
          && [400, 412, 422, 428].includes(failure.status)
          && ['api_request_invalid', 'if_match_required', 'risk_policy_revision_conflict', 'risk_policy_revision_invalid',
            'risk_policy_reason_invalid', 'risk_policy_changes_required', 'idempotency_key_invalid'].includes(failure.problem?.code ?? ''),
      })
      const result = await recovery.run({ userId: start.userId, accountId: start.accountId }, action,
        action === 'create' && body ? { body, revision: start.revision } : undefined)
      if (!current()) return false
      sync()
      if (result !== 'confirmed') {
        message.value = result === 'rejected' ? '本次保存已被拒绝，请刷新策略并检查输入后再提交。'
          : result === 'absent' ? '当前账户没有待确认的策略保存。' : '原保存尚未确认，可以继续查询或重试原请求。'
        return false
      }
      confirmed = true
      await refresh()
      if (current()) message.value = '原策略保存已确认，当前账户状态已刷新。'
      return current()
    } catch {
      if (current()) {
        sync()
        error.value = confirmed ? '原策略保存已确认，但当前状态刷新失败，请刷新页面。'
          : pending.value ? '保存结果尚未确认，原请求已保留。请先查询结果。'
            : '无法安全保存或读取请求，请检查输入及浏览器存储。'
        message.value = error.value
      }
      return false
    } finally {
      if (operation === token) { operation = null; busy.value = false; sync() }
    }
  }
  watch(() => { const value = context(); return value ? `${value.userId}:${value.accountId}` : '' }, () => {
    operation = null; busy.value = false; message.value = ''; error.value = ''; sync()
  }, { flush: 'sync' })
  const storageChanged = (event: StorageEvent) => { if (event.key === null || event.key.startsWith('aurum:risk-policy:v1:')) sync() }
  onMounted(() => { sync(); window.addEventListener('storage', storageChanged) })
  onBeforeUnmount(() => { operation = null; window.removeEventListener('storage', storageChanged) })
  return { pending, busy, message, error, run }
}
