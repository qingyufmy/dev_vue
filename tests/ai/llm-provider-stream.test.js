import { beforeEach, describe, expect, it, vi } from 'vitest'

import { deriveProviderSseLimits, parseProviderSseResponse, requestJsonObject } from '../../server/routes/ai/llm.js'

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

  it('accepts a completed chat choice when a compatible gateway omits trailing DONE', async () => {
    mockFetch.mockResolvedValue(response(streamBody([
      'data: {"id":"ds-eof","choices":[{"delta":{"content":"{\\"ok\\":true}"}}]}\n\n',
      'data: {"choices":[{"finish_reason":"stop"}],"usage":{"prompt_tokens":2,"completion_tokens":3,"total_tokens":5}}\n\n',
    ])))
    const activities = vi.fn()
    const result = await requestJsonObject({
      url:'https://api.deepseek.com/chat/completions', provider:'deepseek', apiKey:'key', model:'deepseek-chat',
      maxTokens:100, messages:[{ role:'user', content:'test' }], onProviderActivity:activities,
    })
    expect(result).toEqual({ ok:true })
    expect(activities.mock.calls.at(-1)[0]).toMatchObject({
      state:'provider_terminal', providerEventType:'chat.finish_reason', responseReceived:true,
    })
  })

  it('keeps a completed chat choice when the transport closes after finish_reason', async () => {
    const encoder = new TextEncoder()
    const transportBody = {
      [Symbol.asyncIterator]:() => {
        let index = 0
        const parts = [
          'data: {"id":"ds-terminated","choices":[{"delta":{"content":"{\\"ok\\":true}"}}]}\n\n',
          'data: {"choices":[{"finish_reason":"stop"}]}\n\n',
        ]
        return {
          next:async () => index < parts.length
            ? { done:false, value:encoder.encode(parts[index++]) }
            : Promise.reject(new TypeError('terminated')),
          return:vi.fn(async () => ({ done:true })),
        }
      },
    }
    const usage = vi.fn()
    await expect(requestJsonObject({
      url:'https://api.deepseek.com/chat/completions', provider:'deepseek', apiKey:'key', model:'deepseek-chat',
      maxTokens:100, messages:[{ role:'user', content:'test' }], onProviderUsage:usage,
    })).resolves.toEqual({ ok:true })
    expect(usage).toHaveBeenCalledWith(expect.objectContaining({ status:'success', responseReceived:true }))
  })

  it('keeps a complete JSON result when the transport closes before finish metadata', async () => {
    const encoder = new TextEncoder()
    const transportBody = {
      [Symbol.asyncIterator]:() => {
        let sent = false
        return {
          next:async () => sent
            ? Promise.reject(new TypeError('terminated'))
            : (sent = true, { done:false, value:encoder.encode(
              'data: {"choices":[{"delta":{"content":"{\\"ok\\":true}"}}]}\n\n',
            ) }),
          return:vi.fn(async () => ({ done:true })),
        }
      },
    }
    const terminal = vi.fn()
    const parsed = await parseProviderSseResponse(response(transportBody), { onEvent:terminal })
    expect(parsed.data.choices[0].message.content).toBe('{"ok":true}')
    expect(parsed.terminalEvent).toMatchObject({ eventType:'chat.complete_json', done:true })
    expect(terminal.mock.calls.at(-1)[0]).toMatchObject({ eventType:'chat.complete_json' })
  })

  it('still rejects streamed length truncation even when the JSON is complete', async () => {
    mockFetch.mockResolvedValue(response(streamBody([
      'data: {"choices":[{"delta":{"content":"{\\"ok\\":true}"},"finish_reason":"length"}]}\n\n',
    ])))
    await expect(requestJsonObject({
      url:'https://api.deepseek.com/chat/completions', provider:'deepseek', apiKey:'key', model:'deepseek-chat',
      maxTokens:100, messages:[{ role:'user', content:'test' }],
    })).rejects.toMatchObject({ code:'output_truncated', finishReason:'length' })
  })

  it('fails closed when the transport closes before finish_reason', async () => {
    const encoder = new TextEncoder()
    const transportBody = {
      [Symbol.asyncIterator]:() => {
        let sent = false
        return {
          next:async () => sent
            ? Promise.reject(new TypeError('terminated'))
            : (sent = true, { done:false, value:encoder.encode(
              'data: {"choices":[{"delta":{"content":"{\\"ok\\":"}}]}\n\n',
            ) }),
          return:vi.fn(async () => ({ done:true })),
        }
      },
    }
    await expect(parseProviderSseResponse(response(transportBody)))
      .rejects.toThrow('terminated')
  })

  it('does not hide parser failures that happen after finish_reason', async () => {
    await expect(parseProviderSseResponse(response(streamBody([
      'data: {"choices":[{"delta":{"content":"{\\"ok\\":true}"},"finish_reason":"stop"}]}\n\n',
      'garbage\n\n',
    ])))).rejects.toMatchObject({ code:'provider_sse_malformed' })
  })

  it('rejects malformed and oversized SSE events', async () => {
    await expect(parseProviderSseResponse(response(streamBody(['garbage\n\n']))))
      .rejects.toMatchObject({ code:'provider_sse_malformed' })
    await expect(parseProviderSseResponse(response(streamBody(['data: {"ok":true}\n\n', 'data: [DONE]\n\n'])), {
      limits:{ maxEvents:1, maxBytes:1024, maxLineBytes:1024 },
    })).rejects.toMatchObject({ code:'provider_sse_event_limit_exceeded' })
  })

  it('derives bounded stream limits from the physical output allowance', () => {
    const limits = deriveProviderSseLimits(393216)
    expect(limits.maxEvents).toBeGreaterThan(20_000)
    expect(limits.maxBytes).toBeGreaterThan(16 * 1024 * 1024)
    expect(limits.maxEvents).toBeLessThanOrEqual(4_000_000)
    expect(limits.maxBytes).toBeLessThanOrEqual(128 * 1024 * 1024)
    expect(limits.maxLineBytes).toBe(256 * 1024)
  })

  it('does not truncate a physically valid stream after the old 20k event default', async () => {
    const parts = ['data: {"choices":[{"delta":{"content":"{\\"ok\\":true"}}]}\n\n']
    for (let index = 0; index < 20_050; index++) {
      parts.push('data: {"choices":[{"delta":{"content":" "}}]}\n\n')
    }
    parts.push('data: {"choices":[{"delta":{"content":"}"},"finish_reason":"stop"}]}\n\n')
    parts.push('data: [DONE]\n\n')
    mockFetch.mockResolvedValue(response(streamBody(parts)))

    await expect(requestJsonObject({
      url:'https://api.deepseek.com/chat/completions', provider:'deepseek', apiKey:'key', model:'deepseek-chat',
      maxTokens:393216, messages:[{ role:'user', content:'test' }],
    })).resolves.toEqual({ ok:true })
  })

  it('closes the provider iterator after both a terminal event and a parser failure', async () => {
    const encoder = new TextEncoder()
    const terminalReturn = vi.fn(async () => ({ done:true }))
    const terminalBody = {
      [Symbol.asyncIterator]:() => {
        let sent = false
        return {
          next:async () => sent
            ? { done:true }
            : (sent = true, { done:false, value:encoder.encode('data: [DONE]\n\n') }),
          return:terminalReturn,
        }
      },
    }
    await parseProviderSseResponse(response(terminalBody))
    expect(terminalReturn).toHaveBeenCalledTimes(1)

    const malformedReturn = vi.fn(async () => ({ done:true }))
    const malformedBody = {
      [Symbol.asyncIterator]:() => ({
        next:async () => ({ done:false, value:encoder.encode('garbage\n\n') }),
        return:malformedReturn,
      }),
    }
    await expect(parseProviderSseResponse(response(malformedBody)))
      .rejects.toMatchObject({ code:'provider_sse_malformed' })
    expect(malformedReturn).toHaveBeenCalledTimes(1)
  })
})
