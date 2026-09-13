import { computed, onScopeDispose, ref } from 'vue'
import { sessionResponseSchema } from '@aurum/contracts'
import { beginAutomaticLogin, clearLoginAttempt, safeLoginNext } from './login-entry'

interface LoginPorts {
  session: () => Promise<unknown>
  replace: (path: string) => void | Promise<unknown>
  authorize: (path: string, automatic: boolean) => void
  beginAttempt: () => boolean
  clearAttempt: () => void
}
type LoginIssue = 'signed-out' | 'unavailable' | 'forbidden' | null

export function useLoginEntry(query: () => Record<string, unknown>, ports: LoginPorts) {
  const next = computed(() => safeLoginNext(query().next))
  const signedOut = computed(() => query().reason === 'signed-out')
  const issue = ref<LoginIssue>(query().reason === 'unavailable' ? 'unavailable' : query().reason === 'forbidden' ? 'forbidden' : null)
  const checking = ref(false)
  const message = ref('')
  const problem = computed(() => issue.value === 'unavailable' ? '暂时无法连接登录服务，请检查网络后重试。'
    : issue.value === 'forbidden' ? '当前账号暂时无法访问量见主站，请确认账号状态。' : '')
  let disposed = false
  onScopeDispose(() => { disposed = true })

  function continueLogin() {
    if (checking.value || disposed) return
    ports.clearAttempt()
    ports.beginAttempt()
    checking.value = true
    ports.authorize(`/auth/start?next=${encodeURIComponent(next.value)}`, false)
  }

  async function checkSession() {
    if (checking.value || disposed) return
    checking.value = true
    message.value = ''
    issue.value = null
    try {
      const session = sessionResponseSchema.parse(await ports.session())
      if (disposed) return
      if (session.data.app !== 'www') throw new Error('session_app_mismatch')
      ports.clearAttempt()
      await ports.replace(next.value)
      return
    } catch (error) {
      if (disposed) return
      const status = (error as { statusCode?: number; response?: { status?: number } } | null)?.statusCode
        ?? (error as { response?: { status?: number } } | null)?.response?.status
      issue.value = status === 401 ? 'signed-out' : status === 403 ? 'forbidden' : 'unavailable'
    }
    checking.value = false
    if (issue.value !== 'signed-out') return
    if (ports.beginAttempt()) {
      checking.value = true
      ports.authorize(`/auth/start?next=${encodeURIComponent(next.value)}`, true)
    } else message.value = '登录尚未完成。你可以重新登录，或检查浏览器是否允许保存本站登录状态。'
  }

  function start() {
    if (!signedOut.value && query().reason !== 'unavailable' && query().reason !== 'forbidden') return checkSession()
  }
  return { signedOut, checking, message, issue, problem, start, checkSession, continueLogin }
}

export function browserLoginPorts(replace: LoginPorts['replace']): LoginPorts {
  return {
    session: () => $fetch<unknown>('/api/v4/session', { retry: 0, cache: 'no-store' }),
    replace,
    authorize: (path, automatic) => automatic ? window.location.replace(path) : window.location.assign(path),
    beginAttempt: beginAutomaticLogin,
    clearAttempt: clearLoginAttempt,
  }
}
