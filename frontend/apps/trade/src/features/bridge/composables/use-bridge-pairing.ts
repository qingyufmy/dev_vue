import type { TradeSessionSnapshot } from '~/features/auth'
import { computed, onScopeDispose, ref, watch, type Ref } from 'vue'
import { ApiClientError } from '@aurum/api-client'

import { bridgeApi } from '../api/bridge-api'
import { createPairingCode } from '../model/pairing-code'

export function useBridgePairing(session: Readonly<Ref<TradeSessionSnapshot | null>>, api = bridgeApi) {
  const code = ref('')
  const error = ref('')
  const busy = ref(false)
  const copied = ref(false)
  const expiresAt = ref(0)
  const now = ref(Date.now())
  let pending: Awaited<ReturnType<typeof createPairingCode>> | null = null
  let request: AbortController | null = null
  let revision = 0
  const remaining = computed(() => Math.max(0, Math.ceil((expiresAt.value - now.value) / 1000)))
  const timer = setInterval(() => {
    now.value = Date.now()
    if (expiresAt.value && remaining.value === 0) { code.value = ''; pending = null }
  }, 1000)
  function reset() {
    revision++
    request?.abort()
    pending = null
    code.value = ''
    error.value = ''
    expiresAt.value = 0
    busy.value = false
    copied.value = false
  }
  watch(() => session.value?.user.id, reset, { flush: 'sync' })
  onScopeDispose(() => { clearInterval(timer); reset() })

  async function generate() {
    if (busy.value || code.value) return
    const identity = session.value
    if (!identity) { error.value = '请重新登录后生成配对码。'; return }
    const current = ++revision
    busy.value = true
    expiresAt.value = 0
    error.value = ''
    copied.value = false
    request = new AbortController()
    try {
      const draft = pending ?? await createPairingCode()
      if (current !== revision) return
      pending = draft
      const result = await api.createPairing(draft.hash, draft.key, identity.csrf_token, request.signal)
      if (current !== revision) return
      now.value = Date.now()
      // Use the server's duration so local clock drift cannot extend a code.
      expiresAt.value = now.value + Math.max(0, Date.parse(result.data.expires_at) - Date.parse(result.meta.generated_at))
      if (remaining.value === 0) { pending = null; error.value = '配对码已过期，请重新生成。'; return }
      code.value = draft.code
    } catch (cause) {
      if (current !== revision) return
      if (cause instanceof ApiClientError) {
        if ([401, 403, 409, 410, 429].includes(cause.status)) pending = null
        error.value = cause.status === 403 ? '当前账户暂无配对权限，请确认会员权益。'
          : cause.status === 401 ? '登录已失效，请重新登录。'
          : cause.status === 429 ? '生成次数较多，请稍后再试。'
          : cause.status === 410 ? '配对码已过期，请重新生成。' : '暂未获取到配对码，请重试。'
      } else error.value = globalThis.crypto?.subtle ? '网络或响应异常，请重试原请求。' : '请使用 HTTPS 或本机安全地址打开此页面。'
    } finally { if (current === revision) busy.value = false }
  }
  async function copy() {
    if (!code.value || remaining.value === 0) return
    const current = revision
    try {
      await navigator.clipboard.writeText(code.value)
      if (current === revision) { copied.value = true; error.value = '' }
    } catch { if (current === revision) error.value = '未能自动复制，请选中配对码后手动复制。' }
  }
  return { code, error, busy, copied, remaining, generate, copy }
}
