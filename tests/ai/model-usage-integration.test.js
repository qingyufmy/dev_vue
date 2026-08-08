import { beforeEach, describe, expect, it, vi } from 'vitest'

const mockQueryOne = vi.fn()
const mockQueryRun = vi.fn()
const capacity = vi.hoisted(() => ({ acquire:vi.fn(), release:vi.fn(), retain:vi.fn() }))

vi.mock('../../server/db.js', () => ({
  queryOne: (...args) => mockQueryOne(...args),
  queryAll: vi.fn(),
  queryRun: (...args) => mockQueryRun(...args),
  withTransaction: vi.fn(),
  beijingNow: () => '2026-07-15 12:00:00',
  parseBeijing: value => value ? new Date(value) : null,
}))
vi.mock('../../server/routes/ai/model-task-capacity.js', () => ({
  acquireModelTaskCapacity: (...args) => capacity.acquire(...args),
  releaseModelTaskCapacityLease: (...args) => capacity.release(...args),
  retainModelTaskCapacityLease: (...args) => capacity.retain(...args),
}))

import { requestJsonObject } from '../../server/routes/ai/llm.js'

const mockFetch = vi.fn()
vi.stubGlobal('fetch', mockFetch)

function streamBody(parts) {
  const encoder = new TextEncoder()
  return { async *[Symbol.asyncIterator]() {
    for (const part of parts) yield encoder.encode(part)
  } }
}

const usageContext = {
  userId: 7,
  profileId: 10,
  credentialSource: 'user',
  usage: 'manual',
  strategyId: null,
}

beforeEach(() => {
  vi.clearAllMocks()
  mockQueryRun.mockResolvedValueOnce({ insertId: 41 }).mockResolvedValueOnce({ changes: 1 })
  capacity.acquire.mockResolvedValue({ leaseId:'capacity-lease', ownerToken:'capacity-owner' })
  capacity.release.mockResolvedValue(true)
  capacity.retain.mockResolvedValue(true)
})

describe('provider-call usage integration', () => {
  it('waits for durable capacity before the submitted callback and provider fetch', async () => {
    const order = []
    capacity.acquire.mockImplementation(async () => { order.push('capacity'); return { leaseId:'lease-1', ownerToken:'owner-1' } })
    mockFetch.mockImplementationOnce(async () => { order.push('fetch'); return {
      ok:true, status:200,
      json:async () => ({ choices:[{ message:{ content:'{"ok":true}' } }], usage:{ total_tokens:10 } }),
    } })
    await requestJsonObject({
      url:'https://api.test/v1/chat/completions', apiKey:'test-key', model:'test-model',
      temperature:0.3, maxTokens:500, messages:[{ role:'user', content:'test' }],
      usageContext, onProviderRequest:async () => { order.push('submitted') },
    })
    expect(order).toEqual(['capacity', 'submitted', 'fetch'])
    expect(capacity.release).toHaveBeenCalledWith(expect.objectContaining({ leaseId:'lease-1' }), 'provider_response')
  })

  it('releases capacity on HTTP 429 but retains it after a post-submit transport failure', async () => {
    mockFetch.mockResolvedValueOnce({ ok:false, status:429, headers:{ get:() => 'req-429' } })
    await expect(requestJsonObject({
      url:'https://api.test/v1/chat/completions', apiKey:'test-key', model:'test-model',
      temperature:0.3, maxTokens:500, messages:[], usageContext,
    })).rejects.toThrow('model_quota_exhausted')
    expect(capacity.release).toHaveBeenCalledWith(expect.any(Object), 'provider_http_response')
    expect(capacity.retain).not.toHaveBeenCalled()

    vi.clearAllMocks()
    mockQueryRun.mockResolvedValueOnce({ insertId:41 }).mockResolvedValueOnce({ changes:1 })
    capacity.acquire.mockResolvedValue({ leaseId:'lease-unknown', ownerToken:'owner-unknown' })
    capacity.retain.mockResolvedValue(true)
    mockFetch.mockRejectedValueOnce(new Error('socket_reset'))
    await expect(requestJsonObject({
      url:'https://api.test/v1/chat/completions', apiKey:'test-key', model:'test-model',
      temperature:0.3, maxTokens:500, messages:[], usageContext,
    })).rejects.toThrow('socket_reset')
    expect(capacity.retain).toHaveBeenCalledWith(expect.objectContaining({ leaseId:'lease-unknown' }), expect.objectContaining({ reason:'provider_response_unknown' }))
  })

  it('retains capacity after stream headers when the provider disconnects before terminal', async () => {
    mockFetch.mockResolvedValueOnce({ ok:true, status:200, headers:{ get:() => 'req-stream' },
      body:streamBody(['data: {"id":"req-stream","choices":[{"delta":{"content":"{"}}]}\n\n']) })
    await expect(requestJsonObject({
      url:'https://api.deepseek.com/chat/completions', provider:'deepseek', apiKey:'test-key', model:'deepseek-chat',
      temperature:0.3, maxTokens:500, messages:[], usageContext,
    })).rejects.toMatchObject({ code:'provider_sse_terminal_missing' })
    expect(capacity.release).not.toHaveBeenCalled()
    expect(capacity.retain).toHaveBeenCalledWith(expect.objectContaining({ leaseId:'capacity-lease' }),
      expect.objectContaining({ reason:'provider_response_unknown' }))
  })

  it('releases capacity only after a terminal stream event', async () => {
    mockFetch.mockResolvedValueOnce({ ok:true, status:200, headers:{ get:() => 'req-stream' },
      body:streamBody([
        'data: {"id":"req-stream","choices":[{"delta":{"content":"{\\"ok\\":true}"}}]}\n\n',
        'data: {"choices":[{"finish_reason":"stop"}],"usage":{"total_tokens":3}}\n\n',
        'data: [DONE]\n\n',
      ]) })
    await requestJsonObject({
      url:'https://api.deepseek.com/chat/completions', provider:'deepseek', apiKey:'test-key', model:'deepseek-chat',
      temperature:0.3, maxTokens:500, messages:[], usageContext,
    })
    expect(capacity.release).toHaveBeenCalledWith(expect.objectContaining({ leaseId:'capacity-lease' }), 'provider_stream_terminal')
    expect(capacity.retain).not.toHaveBeenCalled()
  })

  it('logs the exact UTF-8 request size for automatic provider calls without exposing content', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({
        choices: [{ message: { content: '{"ok":true}' } }],
        usage: { total_tokens: 21 },
      }),
    })

    try {
      await requestJsonObject({
        url: 'https://api.test/v1/chat/completions', apiKey: 'secret-test-key', model: 'test-model',
        temperature: 0.3, maxTokens: 500,
        messages: [{ role: 'user', content: '敏感提示词-sensitive-marker' }],
        usageContext: { ...usageContext, usage: 'auto_platform', strategyId: 19 },
      })

      const requestBody = mockFetch.mock.calls[0][1].body
      const expectedBytes = Buffer.byteLength(requestBody, 'utf8')
      const logLine = logSpy.mock.calls
        .map(call => String(call[0]))
        .find(line => line.startsWith('[AI Auto] Model request '))

      expect(logLine).toContain('usage=auto_platform')
      expect(logLine).toContain('phase=request')
      expect(logLine).toContain('strategy=19')
      expect(logLine).toContain(`request_bytes=${expectedBytes}`)
      expect(logLine).toContain('request_size=')
      expect(logLine).not.toContain('sensitive-marker')
      expect(logLine).not.toContain('secret-test-key')
    } finally {
      logSpy.mockRestore()
    }
  })

  it('counts Responses API input items instead of reporting messages=0', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ output_text: '{"ok":true}', usage: { total_tokens: 18 } }),
    })

    try {
      await requestJsonObject({
        url: 'https://api.test/v3/responses', apiKey: 'secret-test-key',
        provider: 'volcengine_agent_plan', protocol: 'responses', model: 'test-model',
        temperature: 0.3, maxTokens: 500,
        messages: [
          { role: 'system', content: '只返回 JSON' },
          { role: 'user', content: '市场数据' },
        ],
        usageContext: { ...usageContext, usage: 'auto_platform', strategyId: 19 },
      })

      const logLine = logSpy.mock.calls
        .map(call => String(call[0]))
        .find(line => line.startsWith('[AI Auto] Model request '))
      expect(logLine).toContain('messages=1')
      expect(logLine).not.toContain('messages=0')
    } finally {
      logSpy.mockRestore()
    }
  })

  it('records actual provider token usage after a successful call', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({
        choices: [{ message: { content: '{"ok":true}' } }],
        usage: { prompt_tokens: 80, completion_tokens: 43, total_tokens: 123 },
      }),
    })

    await requestJsonObject({
      url: 'https://api.test/v1/chat/completions', apiKey: 'test-key', model: 'test-model',
      temperature: 0.3, maxTokens: 500, messages: [{ role: 'user', content: 'test' }], usageContext,
    })

    expect(mockQueryRun).toHaveBeenCalledTimes(2)
    expect(mockQueryRun.mock.calls[1][1]).toEqual([
      123, 80, 43, 0, 0, 'success', null, null, null, null, 'settled',
      expect.any(Number), expect.any(Number), expect.any(Number), 41,
    ])
    expect(mockQueryRun.mock.calls[1][1][11]).toBeGreaterThan(0)
    expect(mockQueryRun.mock.calls[1][1][12]).toBeGreaterThan(0)
  })

  it('finalizes a reserved row as error when the provider fails', async () => {
    mockFetch.mockResolvedValueOnce({ ok: false, status: 429 })

    await expect(requestJsonObject({
      url: 'https://api.test/v1/chat/completions', apiKey: 'test-key', model: 'test-model',
      temperature: 0.3, maxTokens: 500, messages: [], usageContext,
    })).rejects.toThrow('model_quota_exhausted')

    expect(mockQueryRun.mock.calls[1][1]).toEqual([
      0, 0, 0, 0, 0, 'error', 'model_quota_exhausted', null, null, null, 'settled',
      expect.any(Number), 0, expect.any(Number), 41,
    ])
    expect(mockQueryRun.mock.calls[1][1][11]).toBeGreaterThan(0)
  })

  it('finalizes the usage reservation when an active request is cancelled', async () => {
    const controller = new AbortController()
    let markFetchStarted
    const fetchStarted = new Promise(resolve => { markFetchStarted = resolve })
    mockFetch.mockImplementationOnce((_url, options) => new Promise((_resolve, reject) => {
      markFetchStarted()
      if (options.signal.aborted) return reject(options.signal.reason)
      options.signal.addEventListener('abort', () => reject(options.signal.reason), { once:true })
    }))

    const request = requestJsonObject({
      url:'https://api.test/v1/chat/completions', apiKey:'test-key', model:'test-model',
      temperature:0.3, maxTokens:500, messages:[], usageContext, signal:controller.signal,
    })
    await fetchStarted
    controller.abort(new Error('history_compare_cancelled'))

    await expect(request).rejects.toThrow('history_compare_cancelled')
    expect(mockQueryRun.mock.calls[1][1]).toEqual([
      0, 0, 0, 0, 'error', 'history_compare_cancelled', null, null, null, 'usage_unknown',
      expect.any(Number), 0, expect.any(Number), 41,
    ])
    expect(mockQueryRun.mock.calls[1][0]).toContain('token_count = token_count')
  })
})
