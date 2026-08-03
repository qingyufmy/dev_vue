import { assertProviderCapability } from './model-provider-capabilities.js'

export function classifyModelProviderError(error, { requestSubmitted = false, providerRequestId = null } = {}) {
  if (Number(error?.providerStatus) > 0) {
    const retryable = Number(error.providerStatus) === 429 || Number(error.providerStatus) >= 500
    return { state:retryable ? 'retry_wait' : 'failed_terminal', retryable, statusUnknown:false,
      code:String(error.code || error.message || 'provider_rejected') }
  }
  if (!requestSubmitted) return { state:'retry_wait', retryable:true, statusUnknown:false,
    code:String(error?.code || error?.message || 'provider_submit_failed') }
  if (providerRequestId) return { state:'provider_quiet', retryable:false, statusUnknown:false,
    code:'provider_status_query_required' }
  return { state:'status_unknown', retryable:false, statusUnknown:true, code:'provider_status_unknown' }
}

export function createModelProviderAdapter(capabilities, implementation = {}) {
  const guarded = (capability, method) => async (...args) => {
    assertProviderCapability(capabilities, capability)
    if (typeof implementation[method] !== 'function') throw new Error(`model_provider_adapter_missing:${method}`)
    return implementation[method](...args)
  }
  return {
    submit:async (...args) => {
      if (typeof implementation.submit !== 'function') throw new Error('model_provider_adapter_missing:submit')
      return implementation.submit(...args)
    },
    stream:guarded('supports_stream', 'stream'),
    poll:guarded('supports_poll', 'poll'),
    cancel:guarded('supports_cancel', 'cancel'),
    classifyError:classifyModelProviderError,
  }
}
