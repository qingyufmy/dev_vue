import { describe, expect, it } from 'vitest'
import {
  isPlatformShareableProvider,
  modelProviderProtocol,
  normalizeModelProviderProfile,
} from '../../server/routes/ai/model-providers.js'

describe('model provider validation', () => {
  it('rejects unknown providers and unsafe custom base URLs before persistence', () => {
    expect(() => normalizeModelProviderProfile({ provider: 'unknown', model_name: 'anything' }))
      .toThrow('unsupported_model_provider')
    expect(() => normalizeModelProviderProfile({ provider: 'deepseek', model_name: 'deepseek-chat', api_base_url: 'http://127.0.0.1:3000' }))
      .toThrow('model_endpoint_https_required')
  })

  it('keeps legacy providers and Kimi Code validation compatible', () => {
    expect(normalizeModelProviderProfile({ provider: 'kimi_code', model_name: 'kimi-for-coding' }))
      .toMatchObject({ provider: 'kimi_code', thinking_enabled: 1 })
    expect(normalizeModelProviderProfile({ provider: 'kimi_code', model_name: 'k3', thinking_enabled: false }))
      .toMatchObject({ provider: 'kimi_code', thinking_enabled: 0 })
    expect(isPlatformShareableProvider('kimi_code')).toBe(true)
    expect(() => normalizeModelProviderProfile({ provider: 'kimi_code', model_name: 'unsupported' }))
      .toThrow('kimi_code_model_not_supported')
    expect(normalizeModelProviderProfile({ provider: 'qwen', model_name: 'qwen-plus' }).provider)
      .toBe('qwen')
  })
})

describe('OpenAI-compatible custom provider', () => {
  it('accepts any OpenAI-protocol base URL and model name', () => {
    const result = normalizeModelProviderProfile({
      provider: 'openai_compatible',
      model_name: 'custom-gpt-model',
      api_base_url: 'https://api.openrouter.ai/api/v1',
    })
    expect(result).toMatchObject({
      provider: 'openai_compatible',
      model_name: 'custom-gpt-model',
      api_base_url: 'https://api.openrouter.ai/api/v1',
    })
    expect(isPlatformShareableProvider('openai_compatible')).toBe(true)
  })

  it('requires an explicit base URL (no default fallback)', () => {
    expect(() => normalizeModelProviderProfile({ provider: 'openai_compatible', model_name: 'custom-model' }))
      .toThrow('model_endpoint_invalid_url')
  })

  it('uses the standard OpenAI chat/completions protocol', () => {
    expect(modelProviderProtocol('openai_compatible')).toBe('chat_completions')
  })
})
