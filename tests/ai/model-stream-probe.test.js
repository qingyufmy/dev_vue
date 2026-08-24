import { afterEach, describe, expect, it, vi } from 'vitest'
import { probeModelStreamCapability } from '../../server/routes/ai/model-transport-probe.js'

const model = (overrides = {}) => ({
  provider:'openai_compatible', model_name:'probe-model',
  api_base_url:'https://gateway.example.test/v1', api_key_encrypted:'probe-key',
  ...overrides,
})

function sseResponse(text, headers = {}) {
  const body = text.endsWith('\n\n') ? text : `${text}\n`
  return new Response(body, { status:200, headers:{ 'content-type':'text/event-stream', ...headers } })
}

afterEach(() => vi.restoreAllMocks())

describe('model stream capability probe', () => {
  it('requires a meaningful Chat Completions delta before [DONE]', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(sseResponse([
      'data: {"id":"chatcmpl-probe","choices":[{"delta":{"role":"assistant"}}]}',
      '',
      'data: {"choices":[{"delta":{"content":"OK"}}]}',
      '',
      'data: [DONE]',
      '',
    ].join('\n')))
    await expect(probeModelStreamCapability(model())).resolves.toMatchObject({ status:'supported' })
    expect(fetch).toHaveBeenCalledOnce()
    const body = JSON.parse(fetch.mock.calls[0][1].body)
    expect(body.stream).toBe(true)
    expect(body.max_tokens).toBe(16)
  })

  it('supports Responses API output_text deltas', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(sseResponse([
      'event: response.output_text.delta',
      'data: {"type":"response.output_text.delta","delta":"OK"}',
      '',
      'event: response.completed',
      'data: {"type":"response.completed","response":{"status":"completed"}}',
      '',
    ].join('\n')))
    await expect(probeModelStreamCapability(model({
      provider:'volcengine_agent_plan', api_base_url:'https://gateway.example.test/v1',
    }))).resolves.toMatchObject({ status:'supported' })
    const body = JSON.parse(fetch.mock.calls[0][1].body)
    expect(body.stream).toBe(true)
    expect(body.input).toBeTruthy()
    expect(JSON.stringify(body.input).toLowerCase()).toContain('json')
  })

  it('accepts a non-empty Responses reasoning delta before response.incomplete', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(sseResponse([
      'event: response.reasoning_summary_text.delta',
      'data: {"type":"response.reasoning_summary_text.delta","delta":"thinking"}',
      '',
      'event: response.incomplete',
      'data: {"type":"response.incomplete","response":{"status":"incomplete"}}',
      '',
    ].join('\n')))
    await expect(probeModelStreamCapability(model({
      provider:'volcengine_agent_plan', api_base_url:'https://gateway.example.test/v1',
    }))).resolves.toMatchObject({ status:'supported' })
  })

  it('marks a valid ordinary JSON response as verified unsupported', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(new Response(
      JSON.stringify({ id:'chatcmpl-probe', choices:[{ message:{ content:'OK' } }] }),
      { status:200, headers:{ 'content-type':'application/json' } },
    ))
    await expect(probeModelStreamCapability(model())).resolves.toMatchObject({ status:'unsupported' })
  })

  it('recognizes a JSON body even when a gateway labels it text/plain', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(new Response(
      JSON.stringify({ id:'chatcmpl-probe', choices:[{ message:{ content:'OK' } }] }),
      { status:200, headers:{ 'content-type':'text/plain' } },
    ))
    await expect(probeModelStreamCapability(model())).resolves.toMatchObject({ status:'unsupported' })
  })

  it('does not convert a 524 or malformed SSE response into unsupported', async () => {
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response('', { status:524 }))
      .mockResolvedValueOnce(sseResponse('data: {not-json}\n\n'))
    await expect(probeModelStreamCapability(model())).resolves.toMatchObject({ status:'unverified' })
    await expect(probeModelStreamCapability(model())).resolves.toMatchObject({ status:'unverified' })
  })

  it('only treats explicit stream contract rejection as unsupported for bounded 4xx statuses', async () => {
    const body = JSON.stringify({ error:{ message:'streaming is not supported' } })
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(body, { status:400, headers:{ 'content-type':'application/json' } }))
      .mockResolvedValueOnce(new Response(body, { status:500, headers:{ 'content-type':'application/json' } }))
    await expect(probeModelStreamCapability(model())).resolves.toMatchObject({ status:'unsupported', httpStatus:400 })
    await expect(probeModelStreamCapability(model())).resolves.toMatchObject({ status:'unverified', reason:'http_500' })
  })

  it('does not accept a terminal-only stream as supported', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(sseResponse([
      'data: {"choices":[{"delta":{"role":"assistant"}}]}', '',
      'data: [DONE]', '',
    ].join('\n')))
    await expect(probeModelStreamCapability(model())).resolves.toMatchObject({
      status:'unverified', reason:'stream_terminal_without_delta',
    })
  })
})
