import { beforeEach, describe, expect, it, vi } from 'vitest'

const mockQueryOne = vi.fn()
const mockQueryRun = vi.fn()

vi.mock('../../server/db.js', () => ({
  queryOne: (...args) => mockQueryOne(...args),
  queryAll: vi.fn(),
  queryRun: (...args) => mockQueryRun(...args),
  withTransaction: vi.fn(),
  beijingNow: () => '2026-07-15 12:00:00',
  parseBeijing: value => value ? new Date(value) : null,
}))

import { requestJsonObject } from '../../server/routes/ai/llm.js'

const mockFetch = vi.fn()
vi.stubGlobal('fetch', mockFetch)

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
})

describe('provider-call usage integration', () => {
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
      123, 'success', null, expect.any(Number), expect.any(Number), expect.any(Number), 41,
    ])
    expect(mockQueryRun.mock.calls[1][1][3]).toBeGreaterThan(0)
    expect(mockQueryRun.mock.calls[1][1][4]).toBeGreaterThan(0)
  })

  it('finalizes a reserved row as error when the provider fails', async () => {
    mockFetch.mockResolvedValueOnce({ ok: false, status: 429 })

    await expect(requestJsonObject({
      url: 'https://api.test/v1/chat/completions', apiKey: 'test-key', model: 'test-model',
      temperature: 0.3, maxTokens: 500, messages: [], usageContext,
    })).rejects.toThrow('model_quota_exhausted')

    expect(mockQueryRun.mock.calls[1][1]).toEqual([
      0, 'error', 'model_quota_exhausted', expect.any(Number), 0, expect.any(Number), 41,
    ])
    expect(mockQueryRun.mock.calls[1][1][3]).toBeGreaterThan(0)
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
      0, 'error', 'history_compare_cancelled', expect.any(Number), 0, expect.any(Number), 41,
    ])
  })
})
