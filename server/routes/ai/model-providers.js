import { normalizeModelBaseUrl } from './model-endpoint-security.js'

export const KIMI_CODE_PROVIDER = 'kimi_code'
export const KIMI_CODE_BASE_URL = 'https://api.kimi.com/coding/v1'
export const KIMI_CODE_MODELS = new Set(['k3', 'kimi-for-coding', 'kimi-for-coding-highspeed'])
export const KIMI_CODE_CLIENT_IDENTITY = 'Aurum-AI-Trading-Lab/2.3.4'

export const MODEL_PROVIDER_DEFAULTS = Object.freeze({
  deepseek: 'https://api.deepseek.com',
  gpt: 'https://api.openai.com/v1',
  kimi: 'https://api.moonshot.cn/v1',
  [KIMI_CODE_PROVIDER]: KIMI_CODE_BASE_URL,
  qwen: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
  zhipu: 'https://open.bigmodel.cn/api/paas/v4',
  doubao: 'https://ark.cn-beijing.volces.com/api/v3',
  volcengine_agent_plan: 'https://ark.cn-beijing.volces.com/api/plan/v3',
  openai_compatible: null,
})

export function modelProviderProtocol(provider) {
  return provider === 'volcengine_agent_plan' ? 'responses' : 'chat_completions'
}

export function normalizeModelProviderProfile(payload = {}, existing = {}) {
  const provider = payload.provider ?? existing.provider ?? 'deepseek'
  if (!Object.hasOwn(MODEL_PROVIDER_DEFAULTS, provider)) throw new Error('unsupported_model_provider')
  const modelName = payload.model_name ?? existing.model_name ?? (provider === KIMI_CODE_PROVIDER ? 'kimi-for-coding' : 'deepseek-chat')
  if (provider === KIMI_CODE_PROVIDER && !KIMI_CODE_MODELS.has(modelName)) {
    throw new Error('kimi_code_model_not_supported')
  }
  const providerChanged = payload.provider !== undefined && payload.provider !== existing.provider
  const requestedBaseUrl = payload.api_base_url !== undefined ? payload.api_base_url : (providerChanged ? null : existing.api_base_url)
  return {
    provider,
    model_name: modelName,
    api_base_url: normalizeModelBaseUrl(requestedBaseUrl || MODEL_PROVIDER_DEFAULTS[provider]),
    thinking_enabled: provider === KIMI_CODE_PROVIDER
      ? 1
      : (payload.thinking_enabled !== undefined ? (payload.thinking_enabled ? 1 : 0) : (existing.thinking_enabled ?? 1)),
    reasoning_effort: provider === KIMI_CODE_PROVIDER && modelName === 'k3'
      ? 'max'
      : (payload.reasoning_effort || existing.reasoning_effort || 'max'),
  }
}

export function isPlatformShareableProvider(provider) {
  return Object.hasOwn(MODEL_PROVIDER_DEFAULTS, provider)
}

export function isKimiCodeRequest(url, provider) {
  if (provider === KIMI_CODE_PROVIDER) return true
  try {
    const parsed = new URL(url)
    return parsed.hostname === 'api.kimi.com' && parsed.pathname.startsWith('/coding/')
  } catch {
    return false
  }
}
