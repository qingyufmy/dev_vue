import { computed, onScopeDispose, ref } from 'vue'
import { ApiClientError, createApiClient } from '@aurum/api-client'
import { authorizationRequestSchema, authLoginRequestSchema } from '@aurum/contracts'

interface LoginError {
  kind: 'credentials' | 'request' | 'unavailable' | 'permission'
  message: string
}

const invalidRequest: LoginError = { kind: 'request', message: '登录请求已失效，请返回原应用重新发起登录。' }

function describeError(error: unknown): LoginError {
  if (error instanceof ApiClientError) {
    const code = error.problem?.code
    if (code === 'auth_credentials_invalid') return { kind: 'credentials', message: '账号或密码错误，请检查后重试。' }
    if (code === 'auth_admin_required') return { kind: 'permission', message: '此账号没有管理后台访问权限，请返回原应用使用有权限的账号登录。' }
    if (code === 'auth_mfa_required') return { kind: 'permission', message: '此应用需要进一步验证身份，请联系管理员获取帮助。' }
    if (error.status === 429) return { kind: 'unavailable', message: '登录尝试过于频繁，请稍后再试。' }
    if (error.status >= 500) return { kind: 'unavailable', message: '登录服务暂时不可用，请稍后重试。' }
    if (error.status === 400 || error.status === 401 || error.status === 403 || error.status === 404) return invalidRequest
  }
  return { kind: 'unavailable', message: '暂时无法完成登录，请检查网络连接后重试。' }
}

/** Owns credential form state and the existing login contract; credentials never leave this feature except via the API. */
export function useLogin() {
  const client = createApiClient()
  const query = new URLSearchParams(window.location.search)
  const authorization = authorizationRequestSchema.safeParse(Object.fromEntries(query.entries()))
  const login = ref('')
  const password = ref('')
  const remember = ref(false)
  const submitting = ref(false)
  const redirecting = ref(false)
  const error = ref<LoginError | null>(authorization.success ? null : invalidRequest)
  const appName = { 'www-web': '量见主站', 'trade-web': 'AI 交易实验室', 'admin-web': '量见管理后台' }[query.get('client_id') ?? ''] ?? '量见'
  const credentialsInvalid = computed(() => error.value?.kind === 'credentials')
  const requestInvalid = computed(() => error.value?.kind === 'request')
  let disposed = false
  onScopeDispose(() => { disposed = true; password.value = '' })

  async function submit() {
    if (submitting.value || disposed || requestInvalid.value) return
    if (!authorization.success) { error.value = invalidRequest; return }
    const parsed = authLoginRequestSchema.safeParse({ ...authorization.data, login: login.value, password: password.value, remember: remember.value })
    if (!parsed.success) {
      error.value = { kind: 'credentials', message: '请填写有效的账号和密码后再登录。' }
      return
    }
    error.value = null
    submitting.value = true
    try {
      const response = await client.login(parsed.data)
      if (disposed) return
      password.value = ''
      redirecting.value = true
      window.location.assign(response.data.redirect_to)
    } catch (cause) {
      if (!disposed) error.value = describeError(cause)
    } finally {
      if (!disposed && !redirecting.value) submitting.value = false
    }
  }

  return { login, password, remember, submitting, redirecting, error, appName, credentialsInvalid, requestInvalid, submit }
}
