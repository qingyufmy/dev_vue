import { describe, expect, it, vi } from 'vitest'
import { normalizeProviderCapabilities } from '../../server/routes/ai/model-provider-capabilities.js'
import { classifyModelProviderError, createModelProviderAdapter } from '../../server/routes/ai/model-provider-adapters.js'

describe('model provider capabilities and adapters', () => {
  it('defaults every unverified optional capability to off', () => {
    expect(normalizeProviderCapabilities()).toMatchObject({
      supports_stream:false, supports_request_id:false, supports_poll:false,
      supports_cancel:false, supports_idempotency:false, supports_usage_split:false,
      verification_status:'unverified',
    })
  })

  it('never calls poll or cancel when the exact profile capability is unverified', async () => {
    const implementation = { poll:vi.fn(), cancel:vi.fn(), submit:vi.fn() }
    const adapter = createModelProviderAdapter(normalizeProviderCapabilities(), implementation)
    await expect(adapter.poll('req-1')).rejects.toThrow('model_provider_capability_unsupported:supports_poll')
    await expect(adapter.cancel('req-1')).rejects.toThrow('model_provider_capability_unsupported:supports_cancel')
    expect(implementation.poll).not.toHaveBeenCalled()
    expect(implementation.cancel).not.toHaveBeenCalled()
  })

  it('separates explicit provider rejection from an unknown post-submit result', () => {
    expect(classifyModelProviderError({ providerStatus:429, code:'quota' }, { requestSubmitted:true }))
      .toMatchObject({ state:'retry_wait', retryable:true, statusUnknown:false })
    expect(classifyModelProviderError(new Error('connection lost'), { requestSubmitted:true }))
      .toMatchObject({ state:'status_unknown', retryable:false, statusUnknown:true })
    expect(classifyModelProviderError(new Error('connection lost'), { requestSubmitted:true, providerRequestId:'req-1' }))
      .toMatchObject({ state:'provider_quiet', retryable:false, statusUnknown:false })
  })
})
