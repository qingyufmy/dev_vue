import { assertSafeModelEndpoint } from './model-endpoint-security.js'
import { KIMI_CODE_CLIENT_IDENTITY, MODEL_PROVIDER_DEFAULTS, isKimiCodeRequest, modelProviderProtocol } from './model-providers.js'
import { buildLlmRequestBody, deriveProviderSseLimits, parseProviderSseResponse } from './llm.js'

// A transport probe is deliberately much smaller than a real analysis request.
// Its only purpose is to prove that the configured endpoint emits an actual,
// unbuffered SSE delta and a terminal event. All values are server controlled.
export const MODEL_STREAM_PROBE_LIMITS = Object.freeze({
  maxOutputTokens:16,
  maxEvents:128,
  maxBytes:64 * 1024,
  maxLineBytes:16 * 1024,
  totalTimeoutMs:30_000,
  firstDeltaTimeoutMs:15_000,
  maxJsonBytes:64 * 1024,
})

function probeResult(status, fields = {}) {
  return { status, ...fields }
}

function boundedTimeout(value) {
  const parsed = Number(value)
  if (!Number.isFinite(parsed) || parsed <= 0) return MODEL_STREAM_PROBE_LIMITS.totalTimeoutMs
  return Math.min(Math.trunc(parsed), MODEL_STREAM_PROBE_LIMITS.totalTimeoutMs)
}

function responseHeader(response, name) {
  return String(response?.headers?.get?.(name) || '').toLowerCase()
}

function isMeaningfulStreamEvent(event, protocol) {
  if (!event || event.done) return false
  const data = event.data
  if (!data || typeof data !== 'object' || Array.isArray(data)) return false
  if (protocol === 'responses') {
    const type = String(event.eventType || data.type || '').trim()
    if (type !== 'response.output_text.delta') return false
    const delta = data.delta ?? data.text ?? data.output_text_delta
    return typeof delta === 'string' && delta.trim().length > 0
  }
  const choice = Array.isArray(data.choices) ? data.choices[0] : null
  const source = choice?.delta && typeof choice.delta === 'object'
    ? choice.delta
    : choice?.message && typeof choice.message === 'object' ? choice.message : null
  if (!source) return false
  return ['content', 'reasoning_content', 'reasoning']
    .some(key => typeof source[key] === 'string' && source[key].trim().length > 0)
}

function normalJsonLooksValid(value) {
  // A 2xx JSON response with no provider error means the endpoint ignored the
  // stream flag. The basic connection probe already verified credentials and
  // model access; do not require the probe prompt's exact output here.
  return Boolean(value && typeof value === 'object' && !Array.isArray(value)
    && !value.error)
}

function streamUnsupportedError(value) {
  const parts = [
    value?.code,
    value?.type,
    value?.message,
    value?.error?.code,
    value?.error?.type,
    value?.error?.message,
    value?.error?.param,
  ].filter(Boolean).map(item => String(item).toLowerCase())
  const text = parts.join(' ')
  if (!text) return false
  return /(?:stream|streaming)/.test(text)
    && /(?:unsupported|not supported|not available|unavailable|not allowed|unknown parameter|invalid parameter|does not support|禁用|不支持)/.test(text)
}

async function readJsonSafely(response) {
  const contentLength = Number(response?.headers?.get?.('content-length'))
  if (Number.isFinite(contentLength) && contentLength > MODEL_STREAM_PROBE_LIMITS.maxJsonBytes) return null
  try {
    if (response?.body?.getReader) {
      const reader = response.body.getReader()
      const chunks = []
      let total = 0
      try {
        while (true) {
          const next = await reader.read()
          if (next.done) break
          const chunk = next.value instanceof Uint8Array ? next.value : new Uint8Array(next.value || [])
          total += chunk.byteLength
          if (total > MODEL_STREAM_PROBE_LIMITS.maxJsonBytes) {
            try { await reader.cancel() } catch {}
            return null
          }
          chunks.push(chunk)
        }
      } finally {
        try { reader.releaseLock?.() } catch {}
      }
      const text = new TextDecoder().decode(Buffer.concat(chunks.map(chunk => Buffer.from(chunk))))
      const parsed = JSON.parse(text)
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null
    }
    if (typeof response?.text === 'function') {
      const text = await response.text()
      if (Buffer.byteLength(text, 'utf8') > MODEL_STREAM_PROBE_LIMITS.maxJsonBytes) return null
      const parsed = JSON.parse(text)
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null
    }
    if (typeof response?.json === 'function') {
      const parsed = await response.json()
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null
    }
  } catch {}
  return null
}

function probeError(reason) {
  return probeResult('unverified', { reason })
}

/**
 * Probe a pending/stored model with a server-controlled stream request.
 * This function never logs or returns a provider response body.
 */
export async function probeModelStreamCapability(model = {}, { timeoutMs = null } = {}) {
  const provider = model.provider || model.api_provider
  const protocol = model.protocol || modelProviderProtocol(provider)
  const base = String(model.api_base_url || MODEL_PROVIDER_DEFAULTS[provider] || '').replace(/\/+$/, '')
  if (!base) return probeError('unsupported_model_provider')
  const url = `${base}/${protocol === 'responses' ? 'responses' : 'chat/completions'}`
  try { await assertSafeModelEndpoint(url) } catch { return probeError('unsafe_endpoint') }
  const maxOutputTokens = MODEL_STREAM_PROBE_LIMITS.maxOutputTokens
  const messages = protocol === 'responses'
    ? [{ role:'user', content:'Return the single word OK.' }]
    : [{ role:'system', content:'Return the single word OK.' }, { role:'user', content:'OK' }]
  const body = buildLlmRequestBody({
    protocol, provider, model:model.model_name, temperature:0, maxTokens:maxOutputTokens,
    messages, thinkingEnabled:false, reasoningEffort:'low', supportsStream:true,
  })
  const controller = new AbortController()
  const totalTimer = setTimeout(() => controller.abort(), boundedTimeout(timeoutMs))
  let firstDeltaTimer = null
  let firstDeltaAt = null
  let firstByteAt = null
  const startedAt = Date.now()
  let meaningfulDelta = false
  let eventCount = 0
  let responseBytes = 0
  try {
    if (model.api_key_encrypted && /[^ -~]/.test(model.api_key_encrypted)) return probeError('invalid_api_key')
    const headers = {
      Authorization:`Bearer ${model.api_key_encrypted}`,
      Accept:'text/event-stream',
      'Content-Type':'application/json',
    }
    if (isKimiCodeRequest(url, provider)) headers['User-Agent'] = KIMI_CODE_CLIENT_IDENTITY
    const response = await fetch(url, {
      method:'POST', headers, body:JSON.stringify(body), signal:controller.signal, redirect:'error',
    })
    const httpStatus = Number(response?.status) || null
    if (!response?.ok) {
      const errorBody = await readJsonSafely(response)
      // Only a bounded set of client-contract errors can conclusively prove
      // that the stream option is unsupported. Authentication, rate limiting,
      // Cloudflare errors and every 5xx remain transient/unverified even when
      // their prose happens to mention streaming.
      if ([400, 404, 405, 415, 422].includes(httpStatus) && streamUnsupportedError(errorBody)) {
        return probeResult('unsupported', { httpStatus })
      }
      return probeError(httpStatus === 524 ? 'cloudflare_timeout' : `http_${httpStatus || 'unknown'}`)
    }

    const contentType = responseHeader(response, 'content-type')
    if (contentType.includes('json') || (!response?.body && typeof response?.json === 'function')) {
      const value = await readJsonSafely(response)
      return normalJsonLooksValid(value)
        ? probeResult('unsupported', { httpStatus, first_byte_ms:Date.now() - startedAt })
        : probeError('invalid_non_stream_response')
    }
    // Some gateways incorrectly label a normal JSON response as text/plain.
    // Inspect a bounded clone so a real SSE body remains available to the
    // parser below.
    if (!contentType.includes('event-stream') && typeof response?.clone === 'function') {
      const value = await readJsonSafely(response.clone())
      if (normalJsonLooksValid(value)) return probeResult('unsupported', { httpStatus, first_byte_ms:Date.now() - startedAt })
    }
    if (!response?.body) return probeError('stream_body_unavailable')

    firstDeltaTimer = setTimeout(() => controller.abort(), MODEL_STREAM_PROBE_LIMITS.firstDeltaTimeoutMs)
    const parsed = await parseProviderSseResponse(response, {
      protocol,
      limits:deriveProviderSseLimits(0, {
        maxEvents:MODEL_STREAM_PROBE_LIMITS.maxEvents,
        maxBytes:MODEL_STREAM_PROBE_LIMITS.maxBytes,
        maxLineBytes:MODEL_STREAM_PROBE_LIMITS.maxLineBytes,
      }),
      onEvent:event => {
        eventCount = Number(event?.eventCount || eventCount + 1)
        responseBytes = Math.max(responseBytes, Number(event?.responseBytes) || 0)
        if (!firstByteAt) firstByteAt = Date.now()
        if (!meaningfulDelta && isMeaningfulStreamEvent(event, protocol)) {
          meaningfulDelta = true
          firstDeltaAt = Date.now()
          if (firstDeltaTimer) { clearTimeout(firstDeltaTimer); firstDeltaTimer = null }
        }
      },
    })
    responseBytes = Number(parsed.responseBytes) || responseBytes
    eventCount = Number(parsed.eventCount) || eventCount
    if (!meaningfulDelta) return probeError('stream_terminal_without_delta')
    return probeResult('supported', {
      httpStatus, first_byte_ms:firstByteAt == null ? null : firstByteAt - startedAt,
      first_delta_ms:firstDeltaAt == null ? null : firstDeltaAt - startedAt,
      total_latency_ms:Date.now() - startedAt, event_count:eventCount, response_bytes:responseBytes,
    })
  } catch (error) {
    // Abort/HTTP/parser failures deliberately collapse to unverified. The
    // caller must not persist a false "unsupported" result for a transient
    // gateway, Cloudflare 524, timeout, or malformed SSE body.
    const safeCode = String(error?.code || '')
    const reason = error?.name === 'AbortError' ? 'probe_timeout'
      : /^provider_(?:sse|stream|response)_/.test(safeCode) ? safeCode
        : 'stream_probe_failed'
    return probeError(reason)
  } finally {
    clearTimeout(totalTimer)
    if (firstDeltaTimer) clearTimeout(firstDeltaTimer)
  }
}
