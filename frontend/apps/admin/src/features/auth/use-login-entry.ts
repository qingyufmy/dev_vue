import { computed, onScopeDispose, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useAdminSession } from './session'
import { beginAutomaticLogin, clearLoginAttempt, safeLoginNext } from './login-entry'

type Issue = 'none' | 'signed-out' | 'forbidden' | 'unavailable'
interface EntryRoute { fullPath: string; query: Record<string, unknown> }
interface EntryPorts {
  load: () => Promise<unknown>
  issue: () => Issue
  replace: (path: string) => Promise<unknown> | void
  authorize: (path: string, automatic: boolean) => void
  beginAttempt: () => boolean
  clearAttempt: () => void
}

export function createLoginEntry(route: () => EntryRoute, ports: EntryPorts) {
  const reason = (): Issue => {
    const value = route().query.reason
    return value === 'unavailable' || value === 'forbidden' || value === 'signed-out' ? value : 'none'
  }
  const issue = ref<Issue>(reason())
  const next = computed(() => safeLoginNext(route().query.next))
  const signedOut = computed(() => route().query.reason === 'signed-out')
  const checking = ref(false)
  const message = ref('')
  const problem = computed(() => issue.value === 'unavailable' ? '暂时无法连接登录服务，请检查网络后重试。'
    : issue.value === 'forbidden' ? '当前账号没有管理后台访问权限，请使用管理员账号登录。' : '')
  let generation = 0
  let disposed = false
  onScopeDispose(() => { disposed = true; generation++ })
  watch(() => route().fullPath, () => {
    generation++
    checking.value = false
    message.value = ''
    issue.value = reason()
  }, { flush: 'sync' })

  function continueLogin() {
    if (checking.value || disposed) return
    ports.clearAttempt()
    ports.beginAttempt()
    checking.value = true
    ports.authorize(`/auth/start?next=${encodeURIComponent(next.value)}`, false)
  }

  async function checkSession() {
    if (checking.value || disposed) return
    const request = ++generation
    const entryPath = route().fullPath
    const active = () => !disposed && request === generation && route().fullPath === entryPath
    checking.value = true
    message.value = ''
    try {
      const current = await ports.load()
      if (!active()) return
      issue.value = ports.issue()
      if (current) {
        await ports.replace(next.value)
        return
      }
    } catch {
      if (!active()) return
      issue.value = 'unavailable'
    }
    if (!active()) return
    checking.value = false
    if (issue.value !== 'signed-out') return
    if (ports.beginAttempt()) {
      checking.value = true
      ports.authorize(`/auth/start?next=${encodeURIComponent(next.value)}`, true)
    } else message.value = '登录尚未完成。你可以重新登录，或检查浏览器是否允许保存本站登录状态。'
  }

  function start() {
    if (reason() === 'none') return checkSession()
  }
  return { issue, checking, message, signedOut, problem, start, checkSession, continueLogin }
}

export function useLoginEntry() {
  const route = useRoute()
  const router = useRouter()
  const session = useAdminSession()
  return createLoginEntry(() => route, {
    load: session.load,
    issue: () => session.issue.value,
    replace: path => router.replace(path),
    authorize: (path, automatic) => automatic ? window.location.replace(path) : window.location.assign(path),
    beginAttempt: beginAutomaticLogin,
    clearAttempt: clearLoginAttempt,
  })
}
