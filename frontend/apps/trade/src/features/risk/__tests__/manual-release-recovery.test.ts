import { expect, it, vi } from 'vitest'
import { createManualReleaseRecovery, type PendingManualRelease } from '../model/manual-release-recovery'

const scope = { userId: '42', accountId: '7' }
function fixture() {
  const values = new Map<string, string>()
  const storage = { getItem: (key: string) => values.get(key) ?? null,
    setItem: vi.fn((key: string, value: string) => { values.set(key, value) }), removeItem: vi.fn((key: string) => { values.delete(key) }) }
  const send = vi.fn(async (_request: PendingManualRelease) => {})
  const query = vi.fn(async (_request: PendingManualRelease): Promise<'confirmed' | 'unconfirmed'> => 'unconfirmed')
  const current = vi.fn(() => true)
  const key = vi.fn(() => 'original-key')
  let tail = Promise.resolve()
  const lock = async <T>(_name: string, work: () => Promise<T>): Promise<T> => {
    const previous = tail; let release!: () => void
    tail = new Promise<void>(resolve => { release = resolve })
    await previous
    try { return await work() } finally { release() }
  }
  const deps = { storage, send, query, current, key, lock }
  return { ...deps, values, create: () => createManualReleaseRecovery(deps) }
}

it('persists before sending and restores the exact request after timeout and refresh', async () => {
  const f = fixture(), first = f.create()
  f.send.mockImplementationOnce(async request => {
    expect(first.read(scope)).toEqual(request)
    throw Error('timeout')
  })
  await expect(first.run(scope, 'create', { reason: ' original reason ', revision: 8 })).rejects.toThrow('timeout')
  const restored = f.create()
  expect(await restored.run(scope, 'create', { reason: 'edited reason', revision: 9 })).toBe('unconfirmed')
  expect(f.send).toHaveBeenCalledTimes(1)
  expect(await restored.run(scope, 'retry')).toBe('confirmed')
  expect(f.send.mock.calls[1]?.[0]).toMatchObject({ key: 'original-key', revision: 8, body: { reason: 'original reason', acknowledge_risk: true } })
  expect(f.key).toHaveBeenCalledTimes(1)
  expect(restored.read(scope)).toBeNull()
})

it('confirms via receipt without re-sending and does not mix user or account scopes', async () => {
  const f = fixture(), recovery = f.create()
  f.send.mockRejectedValueOnce(Error('unknown'))
  await expect(recovery.run(scope, 'create', { reason: 'reason', revision: 8 })).rejects.toThrow()
  expect(recovery.read({ ...scope, accountId: '8' })).toBeNull()
  expect(recovery.read({ ...scope, userId: '43' })).toBeNull()
  f.query.mockResolvedValueOnce('confirmed')
  expect(await recovery.run(scope, 'retry')).toBe('confirmed')
  expect(f.send).toHaveBeenCalledTimes(1)
})

it('does not send if storage fails or if the account changes during receipt lookup', async () => {
  const f = fixture(), recovery = f.create()
  f.storage.setItem.mockImplementationOnce(() => { throw Error('quota') })
  await expect(recovery.run(scope, 'create', { reason: 'reason', revision: 8 })).rejects.toThrow('quota')
  expect(f.send).not.toHaveBeenCalled()
  f.send.mockRejectedValueOnce(Error('unknown'))
  await expect(recovery.run(scope, 'create', { reason: 'reason', revision: 8 })).rejects.toThrow()
  f.query.mockImplementationOnce(async () => { f.current.mockReturnValue(false); return 'unconfirmed' })
  await expect(recovery.run(scope, 'retry')).rejects.toThrow('release_scope_changed')
  expect(f.send).toHaveBeenCalledTimes(1)
  expect(recovery.read(scope)).not.toBeNull()
})

it('serializes simultaneous tabs so an uncertain first request cannot be replaced', async () => {
  const f = fixture(), first = f.create(), second = f.create()
  f.send.mockRejectedValueOnce(Error('unknown'))
  const results = await Promise.allSettled([
    first.run(scope, 'create', { reason: 'first reason', revision: 8 }),
    second.run(scope, 'create', { reason: 'second reason', revision: 9 }),
  ])
  expect(results[0]?.status).toBe('rejected')
  expect(results[1]).toEqual({ status: 'fulfilled', value: 'unconfirmed' })
  expect(f.send).toHaveBeenCalledTimes(1)
  expect(first.read(scope)?.body.reason).toBe('first reason')
})

it('retains evidence when clearing a successful operation fails', async () => {
  const f = fixture(), recovery = f.create()
  f.storage.removeItem.mockImplementationOnce(() => { throw Error('storage unavailable') })
  await expect(recovery.run(scope, 'create', { reason: 'reason', revision: 8 })).rejects.toThrow()
  f.query.mockResolvedValueOnce('confirmed')
  expect(await recovery.run(scope, 'query')).toBe('confirmed')
  expect(f.send).toHaveBeenCalledTimes(1)
})

it('clears only an initial explicit pre-write rejection, preserving requests with prior uncertainty', async () => {
  const f = fixture()
  const recovery = createManualReleaseRecovery({ ...f, knownPreWriteRejection: error => error instanceof Error && error.message === 'known rejection' })
  f.send.mockRejectedValueOnce(Error('known rejection'))
  expect(await recovery.run(scope, 'create', { reason: 'reason', revision: 8 })).toBe('rejected')
  expect(recovery.read(scope)).toBeNull()
  f.send.mockRejectedValueOnce(Error('unknown'))
  await expect(recovery.run(scope, 'create', { reason: 'reason', revision: 8 })).rejects.toThrow('unknown')
  f.send.mockRejectedValueOnce(Error('known rejection'))
  await expect(recovery.run(scope, 'retry')).rejects.toThrow('known rejection')
  expect(recovery.read(scope)).not.toBeNull()
})
