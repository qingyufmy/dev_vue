import { beforeEach, describe, expect, it, vi } from 'vitest'

const queryOne = vi.fn()
vi.mock('../../server/db.js', () => ({
  queryOne: (...args) => queryOne(...args),
  queryRun: vi.fn(),
}))

import { normalizeProviderCapabilities, resolveModelProviderCapabilities } from '../../server/routes/ai/model-provider-capabilities.js'

describe('runtime model provider capability resolver', () => {
  beforeEach(() => queryOne.mockReset())

  it('attests only exact official HTTPS endpoints', async () => {
    await expect(resolveModelProviderCapabilities({
      provider:'deepseek', protocol:'chat_completions', url:'https://api.deepseek.com/chat/completions',
    })).resolves.toMatchObject({
      supports_stream:true, supports_request_id:true, verification_status:'verified', capability_source:'builtin_verified',
    })
    await expect(resolveModelProviderCapabilities({
      provider:'volcengine_agent_plan', protocol:'responses', url:'https://ark.cn-beijing.volces.com/api/plan/v3/responses',
    })).resolves.toMatchObject({ supports_stream:true, supports_request_id:true })
    await expect(resolveModelProviderCapabilities({
      provider:'deepseek', protocol:'chat_completions', url:'https://proxy.example.test/chat/completions',
    })).resolves.toMatchObject({ supports_stream:false, supports_request_id:false, verification_status:'unverified',
      context_window_tokens:1048576, max_input_tokens:1048576, max_output_tokens:393216,
      token_limits_source:'generic_default', token_limits_status:'default_unconfirmed' })
    await expect(resolveModelProviderCapabilities({
      provider:'kimi_code', protocol:'chat_completions', url:'https://api.kimi.com/coding/v1/chat/completions',
    })).resolves.toMatchObject({ supports_stream:false })
  })

  it('uses a verified database row before builtin fallback', async () => {
    queryOne.mockResolvedValue({
      verification_status:'verified', supports_stream:0, supports_request_id:1,
      context_window_tokens:4096, max_output_tokens:1024,
    })
    await expect(resolveModelProviderCapabilities({
      modelProfileId:17, provider:'deepseek', protocol:'chat_completions', url:'https://api.deepseek.com/chat/completions',
    })).resolves.toMatchObject({
      supports_stream:false, supports_request_id:true, context_window_tokens:4096,
      max_output_tokens:1024, capability_source:'db_verified',
    })
    expect(queryOne).toHaveBeenCalledWith(expect.stringContaining('ai_model_provider_capabilities'), [17])
  })

  it('preserves manual token limits even when provider transport is unverified', () => {
    expect(normalizeProviderCapabilities({
      verification_status:'unverified', supports_stream:1,
      context_window_tokens:128000, max_input_tokens:120000, max_output_tokens:64000,
      token_limits_source:'manual_confirmed', token_limits_status:'confirmed',
    })).toMatchObject({
      supports_stream:false, context_window_tokens:128000, max_input_tokens:120000,
      max_output_tokens:64000, token_limits_source:'manual_confirmed', token_limits_status:'confirmed',
    })
  })
})
