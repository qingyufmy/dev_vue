import { expect, it, vi } from 'vitest'
import { createPolicyWriteRecovery, type PendingPolicyWrite } from '../model/policy-write-recovery'

const scope = { userId: '42', accountId: '7' }
const input = { revision: 0, body: { max_risk_per_trade_percent: '0.5', reason: ' original reason ' } }
function fixture() {
  const values = new Map<string, string>()
  const storage = { getItem: (key: string) => values.get(key) ?? null,
    setItem: vi.fn((key: string, value: string) => { values.set(key, value) }), removeItem: vi.fn((key: string) => { values.delete(key) }) }
  const send = vi.fn(async (_request: PendingPolicyWrite) => {})
  const query = vi.fn(async (_request: PendingPolicyWrite): Promise<'confirmed' | 'unconfirmed'> => 'unconfirmed')
  const current = vi.fn(() => true), key = vi.fn(() => 'original-policy-key')
  const deps = { storage, send, query, current, key, lock: async <T>(_name: string, work: () => Promise<T>) => work() }
  return { ...deps, create: () => createPolicyWriteRecovery(deps) }
}

it('keeps original policy body, key and zero revision through timeout, refresh and explicit retry', async () => {
  const f = fixture(), first = f.create()
  f.send.mockImplementationOnce(async request => { expect(first.read(scope)).toEqual(request); throw Error('timeout') })
  await expect(first.run(scope, 'create', input)).rejects.toThrow('timeout')
  const restored = f.create()
  expect(await restored.run(scope, 'create', { revision: 9, body: { account_kill_switch: true, reason: 'edited reason' } })).toBe('unconfirmed')
  expect(f.send).toHaveBeenCalledTimes(1)
  expect(await restored.run(scope, 'retry')).toBe('confirmed')
  expect(f.send.mock.calls[1]?.[0]).toMatchObject({ key: 'original-policy-key', revision: 0,
    body: { max_risk_per_trade_percent: '0.5', reason: 'original reason' } })
  expect(f.key).toHaveBeenCalledTimes(1)
  expect(restored.read(scope)).toBeNull()
})

it('queries without sending, isolates scopes and stops after identity changes', async () => {
  const f = fixture(), recovery = f.create()
  f.send.mockRejectedValueOnce(Error('unknown'))
  await expect(recovery.run(scope, 'create', input)).rejects.toThrow()
  expect(recovery.read({ ...scope, userId: '43' })).toBeNull()
  expect(recovery.read({ ...scope, accountId: '8' })).toBeNull()
  f.query.mockImplementationOnce(async () => { f.current.mockReturnValue(false); return 'unconfirmed' })
  await expect(recovery.run(scope, 'retry')).rejects.toThrow('policy_scope_changed')
  expect(f.send).toHaveBeenCalledTimes(1)
  f.current.mockReturnValue(true)
  f.query.mockResolvedValueOnce('confirmed')
  expect(await recovery.run(scope, 'query')).toBe('confirmed')
  expect(f.send).toHaveBeenCalledTimes(1)
})

it('rejects empty changes and prevents sending when durable request storage fails', async () => {
  const f = fixture(), recovery = f.create()
  await expect(recovery.run(scope, 'create', { revision: 0, body: { reason: 'no changes' } })).rejects.toThrow('policy_changes_required')
  f.storage.setItem.mockImplementationOnce(() => { throw Error('quota') })
  await expect(recovery.run(scope, 'create', input)).rejects.toThrow('quota')
  expect(f.send).not.toHaveBeenCalled()
})
