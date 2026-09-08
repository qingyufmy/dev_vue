import { expect, it, vi } from 'vitest'
import { ApiClientError } from '@aurum/api-client'
import type { ApiProblem, TradingContext } from '@aurum/contracts'
import { createContextCommandController, type ContextCommandIntent, type ContextCommandReceipt, type ContextCommandStorage } from '../src/features/trading-context/context-command-controller'

const scope = { userId: '42', sessionKey: 'session-1' }
const id = 'd97382ac-4b49-42db-b1f1-850ec403848a'
const context = (accountId = '7', revision = 1): TradingContext => ({ userId: '42', mode: 'full', accountId, observerChannelId: null, readOnly: false, revision })
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(done => { resolve = done })
  return { promise, resolve }
}
function fixture(shared?: Map<string, string>) {
  const saved = shared ?? new Map<string, string>()
  const storage: ContextCommandStorage = { getItem: key => saved.get(key) ?? null, setItem: (key, value) => { saved.set(key, value) }, removeItem: key => { saved.delete(key) } }
  let receipt: ContextCommandReceipt | null = null
  const transport = {
    execute: vi.fn(async (command: Readonly<ContextCommandIntent>) => {
      receipt = { requestId: command.requestId, action: command.action, targetId: command.targetId, priorRevision: command.expectedRevision, result: context() }
    }),
    receipt: vi.fn(async () => receipt),
    current: vi.fn(async () => context()),
  }
  const controller = createContextCommandController({ transport, storage, newRequestId: () => id })
  return { controller, transport, storage, saved, receipt: () => receipt }
}

it('persists only session-bound intent before sending and returns current context rather than the historical result', async () => {
  const f = fixture()
  const original = f.transport.execute.getMockImplementation()!
  f.transport.execute.mockImplementation(async command => {
    expect(f.saved.size).toBe(1)
    expect(JSON.parse([...f.saved.values()][0]!)).toEqual({ scope, intent: command })
    await original(command)
  })
  f.transport.current.mockResolvedValue(context('8', 2))
  await expect(f.controller.start(scope, 'select_account', '7', 0)).resolves.toEqual(context('8', 2))
  expect(f.transport.execute).toHaveBeenCalledTimes(1)
  expect(f.saved.size).toBe(0)
  expect(f.controller.state).toEqual({ status: 'idle', busy: false, intent: null })
})

it('confirms a lost response from the original receipt without resending the write', async () => {
  const f = fixture(), original = f.transport.execute.getMockImplementation()!
  f.transport.execute.mockImplementation(async command => { await original(command); throw Error('lost-response') })
  await expect(f.controller.start(scope, 'select_account', '7', 0)).resolves.toEqual(context())
  expect(f.transport.execute).toHaveBeenCalledTimes(1)
})

it('keeps the exact key and revision when no receipt is visible and blocks a different command', async () => {
  const f = fixture()
  f.transport.execute.mockRejectedValue(Error('network-failed'))
  await expect(f.controller.start(scope, 'select_account', '7', 0)).rejects.toMatchObject({ code: 'context_command_uncertain' })
  const pending = f.controller.state.intent
  await expect(f.controller.start(scope, 'select_account', '8', 1)).rejects.toMatchObject({ code: 'context_command_pending' })
  await expect(f.controller.recover(scope)).rejects.toMatchObject({ code: 'context_command_uncertain' })
  expect(f.controller.state.intent).toEqual(pending)
  expect(f.transport.execute).toHaveBeenCalledTimes(1)
  await expect(f.controller.retry(scope)).rejects.toMatchObject({ code: 'context_command_uncertain' })
  expect(f.transport.execute.mock.calls[1]![0]).toEqual(pending)
})

it('restores pending intent after reload and performs only a receipt/current query', async () => {
  const first = fixture()
  first.transport.receipt.mockRejectedValue(Error('receipt-unavailable'))
  await expect(first.controller.start(scope, 'select_account', '7', 0)).rejects.toThrow('receipt-unavailable')
  const next = fixture(first.saved)
  next.transport.receipt.mockResolvedValue(first.receipt())
  next.transport.current.mockResolvedValue(context('8', 2))
  await expect(next.controller.recover(scope)).resolves.toEqual(context('8', 2))
  expect(next.transport.execute).not.toHaveBeenCalled()
  expect(next.saved.size).toBe(0)
})

it('retains intent when receipt succeeds but current context is unavailable or older', async () => {
  const f = fixture(); f.transport.current.mockRejectedValueOnce(Error('current-unavailable'))
  await expect(f.controller.start(scope, 'select_account', '7', 0)).rejects.toThrow('current-unavailable')
  expect(f.controller.state.intent?.requestId).toBe(id)
  f.transport.current.mockResolvedValueOnce(context('7', 0))
  await expect(f.controller.recover(scope)).rejects.toMatchObject({ code: 'context_command_receipt_invalid' })
  await expect(f.controller.recover(scope)).resolves.toEqual(context())
  expect(f.transport.execute).toHaveBeenCalledTimes(1)
})

it('does not accept a receipt for a different request, body or user', async () => {
  for (const changed of [{ requestId: id.replace(/a$/, 'b') }, { targetId: '8' }, { priorRevision: 1 }, { result: { ...context(), userId: '43' } }]) {
    const f = fixture()
    f.transport.receipt.mockImplementation(async () => ({ ...f.receipt()!, ...changed }))
    await expect(f.controller.start(scope, 'select_account', '7', 0)).rejects.toMatchObject({ code: 'context_command_receipt_invalid' })
    expect(f.saved.size).toBe(1)
    expect(f.transport.current).not.toHaveBeenCalled()
  }
})

it('prevents duplicate in-flight writes and discards late responses after the session changes', async () => {
  const f = fixture(), response = deferred<TradingContext>()
  f.transport.current.mockReturnValue(response.promise)
  const pending = f.controller.start(scope, 'select_account', '7', 0)
  await expect(f.controller.start(scope, 'select_account', '8', 0)).rejects.toMatchObject({ code: 'context_command_pending' })
  await vi.waitFor(() => expect(f.transport.current).toHaveBeenCalledTimes(1))
  await expect(f.controller.recover({ userId: '43', sessionKey: 'session-2' })).resolves.toBeNull()
  response.resolve(context())
  await expect(pending).rejects.toMatchObject({ code: 'context_command_scope_changed' })
  expect(f.controller.state.intent).toBeNull()
  expect(f.transport.execute).toHaveBeenCalledTimes(1)
})

it('clears known first-attempt rejection but preserves an earlier uncertain command after a later denial', async () => {
  const conflict = new ApiClientError(409, { code: 'revision_conflict', detail: 'changed' } as ApiProblem)
  const f = fixture(); f.transport.execute.mockRejectedValueOnce(conflict)
  await expect(f.controller.start(scope, 'select_account', '7', 0)).rejects.toBe(conflict)
  expect(f.saved.size).toBe(0)
  expect(f.transport.receipt).not.toHaveBeenCalled()
  f.transport.execute.mockRejectedValueOnce(Error('lost-response'))
  await expect(f.controller.start(scope, 'select_account', '7', 0)).rejects.toMatchObject({ code: 'context_command_uncertain' })
  f.transport.execute.mockRejectedValueOnce(conflict)
  await expect(f.controller.retry(scope)).rejects.toMatchObject({ code: 'context_command_uncertain' })
  expect(f.saved.size).toBe(1)
})

it('does not send if storage fails, and does not bypass an unread pending record on the next attempt', async () => {
  const f = fixture()
  f.storage.getItem = () => { throw Error('denied') }
  for (let attempt = 0; attempt < 2; attempt++) {
    await expect(f.controller.start(scope, 'select_account', '7', 0)).rejects.toMatchObject({ code: 'context_command_storage_unavailable' })
  }
  expect(f.transport.execute).not.toHaveBeenCalled()
  f.storage.getItem = () => null
  f.storage.setItem = () => { throw Error('quota-exceeded') }
  await expect(f.controller.start(scope, 'select_account', '7', 0)).rejects.toMatchObject({ code: 'context_command_storage_unavailable' })
  expect(f.transport.execute).not.toHaveBeenCalled()
})

it('rejects corrupted stored intent, invalid targets and unsafe revisions before any write', async () => {
  const f = fixture()
  for (const raw of ['{invalid-json', '{}', JSON.stringify({ scope, intent: { userId: '43' } })]) {
    f.saved.set('aurum:trading-context-command:v1', raw)
    for (let attempt = 0; attempt < 2; attempt++) await expect(f.controller.recover(scope)).rejects.toMatchObject({ code: 'context_command_invalid' })
  }
  f.controller.clear()
  for (const revision of [-1, Number.MAX_SAFE_INTEGER, 0.5]) await expect(f.controller.start(scope, 'select_account', '7', revision)).rejects.toMatchObject({ code: 'context_command_invalid' })
  await expect(f.controller.start(scope, 'leave_observer', '7', 0)).rejects.toMatchObject({ code: 'context_command_invalid' })
  expect(f.transport.execute).not.toHaveBeenCalled()
})

it('confirms observer entry and blocked exit, but rejects writable observation and mixed context results', async () => {
  const observer: TradingContext = { userId: '42', mode: 'observer', accountId: null, observerChannelId: '12', readOnly: true, revision: 1 }
  const blocked: TradingContext = { userId: '42', mode: 'blocked', accountId: null, observerChannelId: null, readOnly: true, revision: 1 }
  for (const result of [observer, blocked, { ...observer, readOnly: false }, { ...blocked, accountId: '7' }]) {
    const f = fixture(), action = result.mode === 'observer' ? 'enter_observer' : 'leave_observer', target = result.mode === 'observer' ? '12' : null
    f.transport.receipt.mockImplementation(async () => ({ requestId: id, action, targetId: target, priorRevision: 0, result }))
    f.transport.current.mockResolvedValue(result)
    const operation = f.controller.start(scope, action, target, 0)
    if (result === observer || result === blocked) await expect(operation).resolves.toEqual(result)
    else await expect(operation).rejects.toMatchObject({ code: 'context_command_receipt_invalid' })
  }
})
