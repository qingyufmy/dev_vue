import Fastify from 'fastify'
import { expect, it, vi } from 'vitest'
import { createApiClient } from '../frontend/packages/api-client/src/index.ts'
import { createContextCommandSession } from '../frontend/apps/trade/src/features/trading-context/context-command-session.ts'
import { tradingRoutes } from '../server/src/modules/trading/transport/http/trading-routes.ts'
import { contextCommandPort } from '../server/tests/helpers/context-command-port.ts'

const key = 'd97382ac-4b49-42db-b1f1-850ec403848a', csrf = 'valid-test-csrf-token'
const session = { user: { id: '42' }, authenticated_at: '2026-09-08T12:00:00.000Z', csrf_token: csrf }
async function fixture() {
  const memory = contextCommandPort(), execute = vi.fn(memory.port.execute)
  let userId = 42, mode = 'normal'
  const app = Fastify()
  await app.register(tradingRoutes, { prefix: '/api/v4', service: { context: memory.context }, contextCommands: { ...memory.port, execute },
    capacity: {}, auth: { async authenticate() { return { userId } }, async assertWrite() { return { userId } } } })
  const requests = []
  const fetchImpl = async (input, init) => {
    const url = String(input), headers = Object.fromEntries(new Headers(init?.headers)), method = init?.method ?? 'GET'
    requests.push({ url, method, headers, body: init?.body, cache: init?.cache })
    if (method === 'PUT' && mode === 'before') throw Error('before-dispatch')
    const result = await app.inject({ method, url, headers, ...(typeof init?.body === 'string' ? { payload: init.body } : {}) })
    if (method === 'PUT' && mode === 'after') throw Error('after-commit')
    return new Response(result.body, { status: result.statusCode, headers: { 'content-type': String(result.headers['content-type']) } })
  }
  const client = createApiClient({ fetchImpl }), saved = new Map()
  const storage = { getItem: key => saved.get(key) ?? null, setItem: (key, value) => saved.set(key, value), removeItem: key => saved.delete(key) }
  return { app, client, execute, memory, saved, requests, controller: () => createContextCommandSession(client, storage),
    user: value => { userId = value }, mode: value => { mode = value } }
}

it('uses the real client and Fastify contract for keyed replay, conflicts, observation and receipt isolation', async () => {
  const f = await fixture()
  try {
    expect((await f.client.selectTradingAccount(csrf, '7', 0, key)).data).toMatchObject({ accountId: '7', revision: 1 })
    expect((await f.client.selectTradingAccount(csrf, '7', 0, key)).data.revision).toBe(1)
    await expect(f.client.selectTradingAccount(csrf, '8', 0, key)).rejects.toMatchObject({ status: 409, problem: { code: 'trading_context_idempotency_conflict' } })
    await expect(f.client.selectTradingAccount(csrf, '7', 0, key.replace(/a$/, 'b'))).rejects.toMatchObject({ status: 409, problem: { code: 'revision_conflict' } })
    expect((await f.client.enterObserverMode(csrf, 'obs', 1, key.replace(/a$/, 'c'))).data).toMatchObject({ mode: 'observer', observerChannelId: 'obs', revision: 2 })
    expect((await f.client.leaveObserverMode(csrf, 2, key.replace(/a$/, 'd'))).data).toMatchObject({ mode: 'blocked', accountId: null, revision: 3 })
    const receipt = await f.client.getTradingContextReceipt(key)
    expect(receipt.data).toMatchObject({ requestId: key, action: 'select_account', priorRevision: 0, result: { userId: '42', accountId: '7', revision: 1 } })
    f.user(43)
    expect((await f.client.getTradingContextReceipt(key)).data).toBeNull()
    expect(f.requests.every(request => request.cache === 'no-store')).toBe(true)
  } finally { await f.app.close() }
})

it('confirms a committed command after response loss through the actual frontend recovery transport', async () => {
  const f = await fixture(); f.mode('after')
  try {
    const result = await f.controller().start(session, 'select_account', '7', 0)
    expect(result.data).toMatchObject({ accountId: '7', revision: 1 })
    expect(f.execute).toHaveBeenCalledTimes(1)
    expect(f.saved.size).toBe(0)
    expect(f.requests.map(request => request.method)).toEqual(['PUT', 'GET', 'GET'])
    expect(f.requests[1].url).toContain(f.requests[0].headers['idempotency-key'])
  } finally { await f.app.close() }
})

it('keeps a missing receipt pending across reload and retries only the original key and body', async () => {
  const f = await fixture(); f.mode('before')
  try {
    await expect(f.controller().start(session, 'select_account', '7', 0)).rejects.toMatchObject({ code: 'context_command_uncertain' })
    const original = f.requests[0]
    const reloaded = f.controller()
    await expect(reloaded.recover(session)).rejects.toMatchObject({ code: 'context_command_uncertain' })
    expect(f.execute).not.toHaveBeenCalled()
    f.mode('normal')
    expect((await reloaded.retry(session)).data).toMatchObject({ accountId: '7', revision: 1 })
    const retry = f.requests.findLast(request => request.method === 'PUT')
    expect(retry.headers['idempotency-key']).toBe(original.headers['idempotency-key'])
    expect(retry.body).toBe(original.body)
    expect(f.execute).toHaveBeenCalledTimes(1)
    expect(f.saved.size).toBe(0)
  } finally { await f.app.close() }
})

it('returns the newer current context rather than applying the historical receipt result', async () => {
  const f = await fixture()
  f.execute.mockImplementationOnce(async command => {
    const receipt = await f.memory.port.execute(command)
    await f.memory.port.execute({ ...command, requestId: key, expectedRevision: 1, targetId: '8' })
    return receipt
  })
  try {
    expect((await f.controller().start(session, 'select_account', '7', 0)).data).toMatchObject({ accountId: '8', revision: 2 })
  } finally { await f.app.close() }
})

it('reports malformed write output as unknown and preserves the committed receipt for recovery', async () => {
  const f = await fixture()
  f.execute.mockImplementationOnce(async command => { await f.memory.port.execute(command); return { secret: 'invalid-result' } })
  try {
    await expect(f.client.selectTradingAccount(csrf, '7', 0, key)).rejects.toMatchObject({ status: 503, problem: { code: 'trading_context_commit_unknown' } })
    expect((await f.client.getTradingContextReceipt(key)).data.result.accountId).toBe('7')
  } finally { await f.app.close() }
})

it('lets a new workspace join an in-flight command without a duplicate write or confirmation query', async () => {
  const f = await fixture(), shared = f.controller()
  let release
  const gate = new Promise(resolve => { release = resolve })
  f.execute.mockImplementationOnce(async command => { await gate; return f.memory.port.execute(command) })
  try {
    const first = shared.start(session, 'select_account', '7', 0)
    await expect(shared.start(session, 'select_account', '8', 0)).rejects.toMatchObject({ code: 'context_command_pending' })
    const joined = shared.recover(session)
    release()
    expect((await first).data.accountId).toBe('7')
    expect((await joined).data.accountId).toBe('7')
    expect(f.execute).toHaveBeenCalledTimes(1)
    expect(f.requests.map(request => request.method)).toEqual(['PUT', 'GET', 'GET'])
  } finally { await f.app.close() }
})
