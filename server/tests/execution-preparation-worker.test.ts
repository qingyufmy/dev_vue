import { describe, expect, it } from 'vitest'
import { ExecutionPreparationWorker } from '../src/modules/execution/application/execution-preparation-worker.js'
import { BridgeCommandService } from '../src/modules/execution/application/bridge-command-service.js'

describe('ExecutionPreparationWorker', () => {
  it('creates one durable queued command without crossing the transport boundary', async () => {
    const calls: string[] = []
    const commands = {
      findByIntent: async () => null,
      create: async (input: { executionIntentId: string }) => {
        calls.push(`create:${input.executionIntentId}`)
        return { id: 'cmd-12345678', status: 'queued' }
      },
    }
    const source = {
      loadPrepared: async () => ({ intentId: 'intent-12345678', accountId: '7', command: { executionIntentId: 'intent-12345678' } }),
    }
    const leases = {
      acquire: async () => { calls.push('lease:acquire'); return true },
      renew: async () => true,
      release: async () => { calls.push('lease:release') },
    }
    const worker = new ExecutionPreparationWorker(source as never, leases, commands as never)

    await expect(worker.run('intent-12345678')).resolves.toMatchObject({ kind: 'queued', command: { id: 'cmd-12345678' } })
    expect(calls).toEqual(['lease:acquire', 'create:intent-12345678', 'lease:release'])
  })

  it('treats a duplicate queue delivery as existing work without acquiring an account lease', async () => {
    const commands = {
      findByIntent: async () => ({ id: 'cmd-12345678', status: 'dispatched' }),
      create: async () => { throw new Error('must_not_create') },
    }
    const source = { loadPrepared: async () => { throw new Error('must_not_load') } }
    const leases = {
      acquire: async () => { throw new Error('must_not_lease') }, renew: async () => true, release: async () => undefined,
    }
    const worker = new ExecutionPreparationWorker(source as never, leases, commands as never)
    await expect(worker.run('intent-12345678')).resolves.toMatchObject({ kind: 'existing', command: { status: 'dispatched' } })
  })

  it('never replays a command that has already crossed the durable dispatched boundary', async () => {
    let sends = 0
    const repository = { get: async () => ({ id: 'cmd-12345678', status: 'dispatched' }) }
    const service = new BridgeCommandService(repository as never)
    const transport = { currentRoute: async () => null, send: async () => { sends += 1 } }
    await expect(service.dispatchQueued('cmd-12345678', transport as never)).resolves.toMatchObject({ dispatched: false })
    expect(sends).toBe(0)
  })
})


it.each([1, 2])('keeps an account blocked by an unresolved command pending at read %s', async blockedRead => {
  let reads = 0, created = 0, released = 0
  const source = { loadPrepared: async () => ++reads === blockedRead
    ? { blocked: true, accountId: '7' }
    : { intentId: 'intent-1', accountId: '7', command: {} } }
  const leases = { acquire: async () => true, renew: async () => true, release: async () => { released++ } }
  const commands = { findByIntent: async () => null, create: async () => { created++; return {} } }
  const worker = new ExecutionPreparationWorker(source as never, leases, commands as never)
  expect(await worker.run('intent-1')).toEqual({ kind: 'busy', accountId: '7' })
  expect(created).toBe(0)
  expect(released).toBe(blockedRead === 2 ? 1 : 0)
})
