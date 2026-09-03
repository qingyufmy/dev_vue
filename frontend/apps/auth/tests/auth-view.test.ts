import { mount } from '@vue/test-utils'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import App from '../src/App.vue'

const validQuery = new URLSearchParams({
  client_id: 'trade-web', redirect_uri: 'https://trade.example.test/auth/callback', response_type: 'code',
  scope: 'openid profile', state: 'state_abcdefghijklmnopqrstuvwxyz123456', nonce: 'nonce_abcdefghijklmnopqrstuvwxyz123456',
  code_challenge: 'a'.repeat(43), code_challenge_method: 'S256',
})

describe('auth center', () => {
  beforeEach(() => window.history.replaceState({}, '', `/?${validQuery}`))

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
    expect(vi.isMockFunction(window.fetch)).toBe(false)
  })
})
