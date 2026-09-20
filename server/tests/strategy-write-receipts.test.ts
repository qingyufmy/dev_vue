import { expect, it, vi } from 'vitest'
import type { Pool } from 'mysql2/promise'
import { executeStrategyWrite as execute, type StrategyWriteResult } from '../src/modules/strategies/infrastructure/mysql-strategy-write-receipts.js'
import { strategyCommandHash, type StrategyWriteCommand } from '../src/modules/strategies/application/strategy-write-command.js'

const command: StrategyWriteCommand = { actorUserId: 7, idempotencyKey: 'strategy-request-001',
  action: 'create_strategy', targetId: null, expectedRevision: null, payload: { name: 'original', config: { b: 2, a: 1 } } }
const result = { resourceId: '17', revision: 1, value: { name: 'original' } }
const executeStrategyWrite = (pool: Pool, input: StrategyWriteCommand,
  work: Parameters<typeof execute<{ name: string }>>[2], check: typeof validate) => execute(pool, input, work, check, async () => {})
function validate(value: unknown): value is StrategyWriteResult<{ name: string }> {
  const item = value as typeof result | null
  return !!item && typeof item === 'object' && typeof item.value?.name === 'string'
}

// Models transactional durability and actor serialization, not actual MySQL locking.
function fixture() {
  const receipts = new Map<string, Record<string, unknown>>()
  let tail = Promise.resolve(), authorized = true, loseAck = false
  const queries: string[] = []
  const pool = { getConnection: vi.fn(async () => {
    let unlock: (() => void) | undefined
    let pending: [string, Record<string, unknown>] | undefined
    return {
      beginTransaction: async () => {},
      execute: async (sql: string, args: unknown[]) => {
        queries.push(sql)
        if (sql.startsWith('SELECT id FROM users')) {
          const previous = tail
          tail = new Promise<void>(resolve => { unlock = resolve })
          await previous
          return [authorized ? [{ id: args[0] }] : [], []]
        }
        if (sql.startsWith('SELECT action')) {
          const receipt = receipts.get(`${args[0]}:${args[1]}`)
          return [receipt ? [receipt] : [], []]
        }
        if (sql.startsWith('INSERT INTO strategy_write_receipts_v4')) {
          pending = [`${args[0]}:${args[1]}`, { action: args[2], request_sha256: args[3], resource_id: args[4],
            result_revision: String(args[5]), result_json: args[6], result_sha256: args[7] }]
          return [{ affectedRows: 1 }, []]
        }
        throw new Error('unexpected SQL')
      },
      commit: async () => { if (pending) receipts.set(...pending); if (loseAck) { loseAck = false; throw new Error('ack lost') } },
      rollback: async () => { pending = undefined },
      release: () => unlock?.(), destroy: () => unlock?.(),
    }
  }) }
  return { pool: pool as unknown as Pool, receipts, queries,
    revoke: () => { authorized = false }, loseNextAck: () => { loseAck = true } }
}

it('replays the exact original snapshot after concurrent same-key writes and lost acknowledgement', async () => {
  const f = fixture(), work = vi.fn(async () => structuredClone(result))
  f.loseNextAck()
  await expect(executeStrategyWrite(f.pool, command, work, validate)).rejects.toMatchObject({ code: 'strategy_commit_unknown' })
  const recovered = await Promise.all(Array.from({ length: 3 }, () => executeStrategyWrite(f.pool, command, work, validate)))
  expect(recovered).toEqual([result, result, result])
  expect(work).toHaveBeenCalledTimes(1)
  expect(f.receipts.size).toBe(1)
})

it('serializes simultaneous first submissions, conflicts on different content and reauthorizes replay', async () => {
  const f = fixture(), work = vi.fn(async () => result)
  await Promise.all([executeStrategyWrite(f.pool, command, work, validate), executeStrategyWrite(f.pool, command, work, validate)])
  expect(work).toHaveBeenCalledTimes(1)
  for (const changed of [{ payload: { name: 'changed' } }, { action: 'retire_strategy' as const }, { expectedRevision: 2 }]) {
    await expect(executeStrategyWrite(f.pool, { ...command, ...changed }, work, validate)).rejects.toMatchObject({ code: 'strategy_idempotency_conflict' })
  }
  f.revoke()
  await expect(executeStrategyWrite(f.pool, command, work, validate)).rejects.toMatchObject({ code: 'strategy_actor_forbidden' })
  expect(work).toHaveBeenCalledTimes(1)
})

it('isolates actors and refuses damaged receipts without running the write again', async () => {
  const f = fixture(), work = vi.fn(async () => result)
  await executeStrategyWrite(f.pool, command, work, validate)
  await executeStrategyWrite(f.pool, { ...command, actorUserId: 8 }, work, validate)
  expect(f.receipts.size).toBe(2)
  f.receipts.get('7:strategy-request-001')!.result_json = JSON.stringify({ ...result, revision: 2 })
  await expect(executeStrategyWrite(f.pool, command, work, validate)).rejects.toMatchObject({ code: 'strategy_receipt_invalid' })
  expect(work).toHaveBeenCalledTimes(2)
})

it('rolls back failed work or invalid output without creating a success receipt', async () => {
  const f = fixture()
  await expect(executeStrategyWrite(f.pool, command, async () => { throw Error('business failed') }, validate)).rejects.toThrow('business failed')
  await expect(executeStrategyWrite(f.pool, command, async () => ({ ...result, revision: 0 }), validate)).rejects.toMatchObject({ code: 'strategy_write_result_invalid' })
  expect(f.receipts.size).toBe(0)
  expect(f.queries.some(sql => sql.startsWith('INSERT'))).toBe(false)
})

it('requires current target authorization before replaying a stored result', async () => {
  const f = fixture(), work = vi.fn(async () => result)
  const authorize = vi.fn(async () => {})
  await execute(f.pool, command, work, validate, authorize)
  authorize.mockRejectedValueOnce(new Error('account ownership revoked'))
  await expect(execute(f.pool, command, work, validate, authorize)).rejects.toThrow('account ownership revoked')
  expect(authorize).toHaveBeenCalledTimes(2)
  expect(work).toHaveBeenCalledTimes(1)
})

it('hashes explicit request content canonically and rejects lossy JSON before connecting', async () => {
  expect(strategyCommandHash(command)).toBe(strategyCommandHash({ ...command, payload: { config: { a: 1, b: 2 }, name: 'original' } }))
  const f = fixture(), work = vi.fn(async () => result)
  for (const payload of [{ missing: undefined }, { n: NaN }, { date: new Date() }, { value: BigInt(1) }]) {
    await expect(executeStrategyWrite(f.pool, { ...command, payload }, work, validate)).rejects.toMatchObject({ code: 'strategy_write_invalid' })
  }
  await expect(executeStrategyWrite(f.pool, { ...command, idempotencyKey: command.idempotencyKey + '\n' }, work, validate)).rejects.toMatchObject({ code: 'strategy_write_invalid' })
  expect(f.pool.getConnection).not.toHaveBeenCalled()
})
