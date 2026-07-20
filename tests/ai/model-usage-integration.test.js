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
    expect(mockQueryRun.mock.calls[1][1]).toEqual([123, 'success', null, 41])
  })

  it('finalizes a reserved row as error when the provider fails', async () => {
    mockFetch.mockResolvedValueOnce({ ok: false, status: 429 })

    await expect(requestJsonObject({
      url: 'https://api.test/v1/chat/completions', apiKey: 'test-key', model: 'test-model',
      temperature: 0.3, maxTokens: 500, messages: [], usageContext,
    })).rejects.toThrow('LLM HTTP 429')

    expect(mockQueryRun.mock.calls[1][1]).toEqual([0, 'error', 'LLM HTTP 429', 41])
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
    expect(mockQueryRun.mock.calls[1][1]).toEqual([0, 'error', 'history_compare_cancelled', 41])
  })
})
