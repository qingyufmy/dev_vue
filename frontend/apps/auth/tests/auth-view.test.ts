import { flushPromises, mount } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import App from '../src/App.vue'

const validQuery = new URLSearchParams({
  client_id: 'trade-web', redirect_uri: 'https://trade.example.test/auth/callback', response_type: 'code',
  scope: 'openid profile', state: 'state_abcdefghijklmnopqrstuvwxyz123456', nonce: 'nonce_abcdefghijklmnopqrstuvwxyz123456',
  code_challenge: 'a'.repeat(43), code_challenge_method: 'S256',
})

describe('auth center', () => {
  beforeEach(() => window.history.replaceState({}, '', `/?${validQuery}`))
  afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks() })

  it('renders one authoritative credential form without browser token storage', () => {
    const wrapper = mount(App)
    expect(wrapper.text()).toContain('登录 AI 交易实验室')
    expect(wrapper.find('input[autocomplete="username"]').exists()).toBe(true)
    expect(wrapper.find('input[autocomplete="current-password"]').exists()).toBe(true)
    expect(wrapper.html()).not.toContain('localStorage')
    expect(wrapper.html()).not.toContain('access_token')
    expect(wrapper.html()).not.toContain('refresh_token')
  })

  it('does not submit an invalid or expired authorization request', async () => {
    window.history.replaceState({}, '', '/?client_id=trade-web')
    const wrapper = mount(App)
    await wrapper.find('#login').setValue('user@example.test')
    await wrapper.find('#password').setValue('secret')
    await wrapper.find('form').trigger('submit')
    expect(wrapper.text()).toContain('登录请求已失效')
    expect(wrapper.find('button[type="submit"]').attributes('disabled')).toBeDefined()
  })

  async function fill(wrapper: ReturnType<typeof mount>) {
    await wrapper.find('#login').setValue('user@example.test')
    await wrapper.find('#password').setValue('secret')
  }

  function problem(status: number, code: string) {
    return new Response(JSON.stringify({ type: 'about:blank', title: code, status, code,
      detail: 'internal detail must not be shown', instance: '/login', correlation_id: 'test', retryable: status >= 500 }), { status })
  }

  it.each([
    [401, 'auth_credentials_invalid', '账号或密码错误', true],
    [503, 'auth_service_unavailable', '登录服务暂时不可用', false],
    [403, 'auth_admin_required', '没有管理后台访问权限', false],
    [403, 'auth_mfa_required', '需要进一步验证身份', false],
    [400, 'auth_request_invalid', '登录请求已失效', false],
    [429, 'rate_limited', '登录尝试过于频繁', false],
  ])('classifies %s / %s without blaming every failure on credentials', async (status, code, message, invalid) => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(problem(status as number, code as string)))
    const wrapper = mount(App)
    await fill(wrapper)
    await wrapper.find('form').trigger('submit')
    await flushPromises()
    expect(wrapper.get('[role="alert"]').text()).toContain(message)
    expect(wrapper.text()).not.toContain('internal detail')
    expect(wrapper.get('#password').attributes('aria-invalid')).toBe(String(invalid))
    if (code === 'auth_request_invalid') expect(wrapper.get('button[type="submit"]').attributes('disabled')).toBeDefined()
    wrapper.unmount()
  })

  it('keeps a single request in flight and permits retry after a network failure', async () => {
    let reject!: (error: Error) => void
    const fetch = vi.fn().mockImplementation(() => new Promise((_resolve, fail) => { reject = fail }))
    vi.stubGlobal('fetch', fetch)
    const wrapper = mount(App)
    await fill(wrapper)
    await wrapper.find('form').trigger('submit')
    await wrapper.find('form').trigger('submit')
    expect(fetch).toHaveBeenCalledTimes(1)
    expect(wrapper.get('form').attributes('aria-busy')).toBe('true')
    expect(wrapper.get('#login').attributes('disabled')).toBeDefined()
    reject(new TypeError('Failed to fetch'))
    await flushPromises()
    expect(wrapper.text()).toContain('检查网络连接')
    expect(wrapper.get('form').attributes('aria-busy')).toBe('false')
    await wrapper.find('form').trigger('submit')
    expect(fetch).toHaveBeenCalledTimes(2)
    reject(new TypeError('Failed to fetch'))
    await flushPromises()
    wrapper.unmount()
  })

  it('never calls the API when authorization parameters are missing', async () => {
    const fetch = vi.fn()
    vi.stubGlobal('fetch', fetch)
    window.history.replaceState({}, '', '/?client_id=trade-web')
    const wrapper = mount(App)
    expect(wrapper.get('[role="alert"]').text()).toContain('登录请求已失效')
    await wrapper.find('form').trigger('submit')
    expect(fetch).not.toHaveBeenCalled()
    wrapper.unmount()
  })

  it.each([false, true])('handles a successful response with disposed=%s', async (disposed) => {
    let resolve!: (response: Response) => void
    const fetch = vi.fn().mockImplementation(() => new Promise((done) => { resolve = done }))
    vi.stubGlobal('fetch', fetch)
    const navigate = vi.spyOn(window.location, 'assign').mockImplementation(() => {})
    const wrapper = mount(App)
    await fill(wrapper)
    await wrapper.find('form').trigger('submit')
    if (disposed) wrapper.unmount()
    const target = 'https://trade.example.test/auth/callback?code=one-use-code'
    resolve(new Response(JSON.stringify({ data: { redirect_to: target }, meta: { request_id: 'login-test', generated_at: '2026-09-13T12:00:00Z' } })))
    await flushPromises()
    if (disposed) {
      expect(navigate).not.toHaveBeenCalled()
    } else {
      expect(navigate).toHaveBeenCalledWith(target)
      expect(wrapper.text()).toContain('登录成功，正在返回')
      expect((wrapper.get('#password').element as HTMLInputElement).value).toBe('')
      await wrapper.find('form').trigger('submit')
      expect(fetch).toHaveBeenCalledTimes(1)
      wrapper.unmount()
    }
  })

})
