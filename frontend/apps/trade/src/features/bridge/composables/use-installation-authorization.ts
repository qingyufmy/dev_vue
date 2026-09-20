import { computed, onScopeDispose, ref, watch, type Ref } from 'vue'
import type { InstallationAuthorization } from '@aurum/contracts'
import type { TradeSessionSnapshot } from '~/features/auth'
import { bridgeApi } from '../api/bridge-api'

export function useInstallationAuthorization(id: Readonly<Ref<string>>, session: Readonly<Ref<TradeSessionSnapshot | null>>, api: Pick<typeof bridgeApi, 'getAuthorization' | 'decideAuthorization'> = bridgeApi) {
  const authorization = ref<InstallationAuthorization | null>(null)
  const busy = ref(false)
  const error = ref('')
  const now = ref(Date.now())
  let clockOffset = 0
  let generation = 0
  let controller: AbortController | null = null
  let pending: { key: string; body: { decision: 'approved' | 'denied'; expected_revision: string; current_user_id: string } } | null = null
  const timer = setInterval(() => { now.value = Date.now() + clockOffset }, 1000)
  const canDecide = computed(() => !busy.value && authorization.value?.status === 'pending'
    && Date.parse(authorization.value.expires_at) > now.value
    && authorization.value.current_user.id === String(session.value?.user.id))
  async function load() {
    const current = ++generation
    controller?.abort()
    controller = new AbortController()
    authorization.value = null
    error.value = ''
    if (!id.value || !session.value) { busy.value = false; error.value = '授权链接无效，请回到软件重新发起。'; return }
    busy.value = true
    try {
      const response = await api.getAuthorization(id.value, controller.signal)
      if (current !== generation) return
      if (response.data.authorization_id !== id.value || response.data.current_user.id !== String(session.value?.user.id)) {
        error.value = '登录用户或授权请求已变化，请刷新后重新确认。'
        return
      }
      authorization.value = response.data
      clockOffset = Date.parse(response.meta.generated_at) - Date.now()
      now.value = Date.now() + clockOffset
      if (response.data.status !== 'pending') pending = null
    } catch { if (current === generation) error.value = '无法读取授权请求，请刷新重试或回到软件重新发起。' }
    finally { if (current === generation) busy.value = false }
  }
  async function decide(decision: 'approved' | 'denied') {
    if (!canDecide.value || !authorization.value || !session.value) return
    if (pending && pending.body.decision !== decision) { error.value = '上次提交结果尚未确认，请先刷新状态。'; return }
    pending ??= { key: crypto.randomUUID(), body: { decision, expected_revision: authorization.value.revision, current_user_id: String(session.value.user.id) } }
    const current = generation
    busy.value = true
    error.value = ''
    try {
      const response = await api.decideAuthorization(id.value, pending.body, pending.key, session.value.csrf_token, controller?.signal)
      if (current !== generation) return
      if (response.data.authorization_id !== id.value || response.data.current_user.id !== String(session.value?.user.id)) throw Error('identity_changed')
      authorization.value = response.data
      pending = null
    } catch { if (current === generation) error.value = '提交结果尚未确认，请刷新状态；重复同一操作不会重复授权。' }
    finally { if (current === generation) busy.value = false }
  }
  watch(() => [id.value, session.value?.user.id], () => { pending = null; void load() }, { immediate: true, flush: 'sync' })
  onScopeDispose(() => { ++generation; controller?.abort(); clearInterval(timer) })
  return { authorization, busy, error, canDecide, now, load, decide }
}
