import { beforeEach, describe, expect, it, vi } from 'vitest'

import { parseProviderSseResponse, requestJsonObject } from '../../server/routes/ai/llm.js'

const mockFetch = vi.fn()
vi.stubGlobal('fetch', mockFetch)

function streamBody(parts) {
  const encoder = new TextEncoder()
  return { async *[Symbol.asyncIterator]() {
    for (const part of parts) yield typeof part === 'string' ? encoder.encode(part) : part
  } }
}

function response(body) {
  return { ok:true, status:200, headers:{ get:() => null }, body }
}

describe('official provider SSE requests', () => {
  beforeEach(() => vi.clearAllMocks())

  it('streams DeepSeek chat, accumulates content/reasoning/finish/usage and emits activity', async () => {
    mockFetch.mockResolvedValue(response(streamBody([
      'data: {"id":"ds-1","choices":[{"delta":{"role":"assistant","reasoning_content":"思考"}}]}\n\n',
      'data: {"choices":[{"delta":{"content":"{\\"ok\\":true"}}]}\n\n',
      'data: {"choices":[{"delta":{"content":"}"},"finish_reason":"stop"}],"usage":{"prompt_tokens":2,"completion_tokens":3,"total_tokens":5}}\n\n',
      'data: [DONE]\n\n',
    ])))
    const activities = vi.fn()
    const result = await requestJsonObject({
      url:'https://api.deepseek.com/chat/completions', provider:'deepseek', apiKey:'key', model:'deepseek-chat',
      maxTokens:100, messages:[{ role:'user', content:'test' }], onProviderActivity:activities,
    })
    expect(result).toEqual({ ok:true })
    expect(mockFetch).toHaveBeenCalledTimes(1)
    const body = JSON.parse(mockFetch.mock.calls[0][1].body)
    expect(body).toMatchObject({ stream:true, stream_options:{ include_usage:true } })
    expect(activities.mock.calls.length).toBeGreaterThanOrEqual(5)
    expect(activities.mock.calls[0][0]).toMatchObject({ state:'response_headers', responseReceived:false })
    expect(activities.mock.calls.at(-1)[0]).toMatchObject({ state:'provider_terminal', responseReceived:true })
  })

  it('streams Agent Plan Responses events and synthesizes output_text deltas', async () => {
    mockFetch.mockResolvedValue(response(streamBody([
      'event: response.created\ndata: {"type":"response.created","response":{"id":"r-1","status":"in_progress"}}\n\n',
      'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"{\\"ok\\":true}"}\n\n',
      'event: response.completed\ndata: {"type":"response.completed","response":{"id":"r-1","status":"completed","usage":{"input_tokens":1,"output_tokens":2,"total_tokens":3}}}\n\n',
    ])))
    const usage = vi.fn()
    const result = await requestJsonObject({
      url:'https://ark.cn-beijing.volces.com/api/plan/v3/responses', provider:'volcengine_agent_plan', protocol:'responses',
      apiKey:'key', model:'ark-model', maxTokens:100, messages:[{ role:'user', content:'test' }],
      onProviderUsage:usage,
    })
    expect(result).toEqual({ ok:true })
    expect(JSON.parse(mockFetch.mock.calls[0][1].body)).toMatchObject({ stream:true })
    expect(usage).toHaveBeenCalledWith(expect.objectContaining({
      status:'success', providerRequestId:'r-1', responseReceived:true,
    }))
  })

  it('does not stream custom endpoints', async () => {
    mockFetch.mockResolvedValue({ ok:true, status:200, headers:{ get:() => null },
      json:async () => ({ choices:[{ message:{ content:'{"ok":true}' } }] }) })
    await requestJsonObject({
      url:'https://custom.example.test/v1/chat/completions', provider:'deepseek', apiKey:'key', model:'custom',
      maxTokens:100, messages:[{ role:'user', content:'test' }],
    })
    expect(JSON.parse(mockFetch.mock.calls[0][1].body)).not.toHaveProperty('stream')
  })

  it('fails closed on a stream without terminal event and keeps raw byte accounting bounded', async () => {
    const activities = vi.fn()
    mockFetch.mockResolvedValue(response(streamBody(['data: {"choices":[{"delta":{"content":"{"}}]}\n\n'])))
    const usage = vi.fn()
    await expect(requestJsonObject({
      url:'https://api.deepseek.com/chat/completions', provider:'deepseek', apiKey:'key', model:'deepseek-chat',
      maxTokens:100, messages:[{ role:'user', content:'test' }], onProviderActivity:activities, onProviderUsage:usage,
    })).rejects.toMatchObject({ code:'provider_sse_terminal_missing' })
    expect(usage).toHaveBeenCalledWith(expect.objectContaining({ status:'error', responseReceived:false, responseBytes:expect.any(Number) }))
  })

  it('rejects malformed and oversized SSE events', async () => {
    await expect(parseProviderSseResponse(response(streamBody(['garbage\n\n']))))
      .rejects.toMatchObject({ code:'provider_sse_malformed' })
    await expect(parseProviderSseResponse(response(streamBody(['data: {"ok":true}\n\n', 'data: [DONE]\n\n'])), {
      limits:{ maxEvents:1, maxBytes:1024, maxLineBytes:1024 },
    })).rejects.toMatchObject({ code:'provider_sse_event_limit_exceeded' })
  })
})
