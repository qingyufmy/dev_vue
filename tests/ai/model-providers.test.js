import { describe, expect, it } from 'vitest'
import {
  KIMI_CODE_BASE_URL,
  isPlatformShareableProvider,
  normalizeModelProviderProfile,
} from '../../server/routes/ai/model-providers.js'

describe('Kimi Code provider policy', () => {
  it('normalizes the subscription endpoint and forces thinking on', () => {
    expect(normalizeModelProviderProfile({ provider: 'kimi_code', model_name: 'kimi-for-coding' }))
      .toMatchObject({ api_base_url: KIMI_CODE_BASE_URL, thinking_enabled: 1 })
    expect(normalizeModelProviderProfile({ provider: 'kimi_code', model_name: 'k3', reasoning_effort: 'low' }))
      .toMatchObject({ reasoning_effort: 'max', thinking_enabled: 1 })
  })

  it('rejects unknown subscription model ids and platform sharing', () => {
    expect(() => normalizeModelProviderProfile({ provider: 'kimi_code', model_name: 'moonshot-v1-8k' }))
      .toThrow('kimi_code_model_not_supported')
    expect(isPlatformShareableProvider('kimi_code')).toBe(false)
    expect(isPlatformShareableProvider('kimi')).toBe(true)
  })

  it('rejects unknown providers and unsafe custom base URLs before persistence', () => {
    expect(() => normalizeModelProviderProfile({ provider: 'unknown', model_name: 'anything' }))
      .toThrow('unsupported_model_provider')
    expect(() => normalizeModelProviderProfile({ provider: 'deepseek', model_name: 'deepseek-chat', api_base_url: 'http://127.0.0.1:3000' }))
      .toThrow('model_endpoint_https_required')
  })
})
