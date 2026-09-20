import { expect, it, vi } from 'vitest'
import type { Pool } from 'mysql2/promise'
import { createMysqlInstrumentCollectionRequester } from '../src/modules/trading/infrastructure/mysql-instrument-collection-requester.js'

const input = { userId: 7, accountId: '11', symbol: 'US 500.a' }
function fixture(options: { duplicate?: boolean; revoked?: boolean; outboxFailure?: boolean; commitUnknown?: boolean } = {}) {
  const execute = vi.fn(async (sql: string, _values?: unknown[]) => {
    if (sql.includes('SELECT o.user_id')) return [options.revoked ? [] : [{ user_id: 7 }]]
    if (sql.includes('FLOOR(UNIX_TIMESTAMP')) return [[{ bucket: '30000', now: new Date('2026-09-09T00:00:00Z') }]]
    if (sql.startsWith('SELECT id FROM instrument_collection')) return [options.duplicate ? [{ id: 'existing-request' }] : []]
    if (sql.startsWith('INSERT INTO outbox') && options.outboxFailure) throw new Error('outbox failed')
    return [[{ id: '11' }]]
  })
  const connection = { execute, beginTransaction: vi.fn(), commit: vi.fn(async () => { if (options.commitUnknown) throw new Error('lost acknowledgement') }),
    rollback: vi.fn(), release: vi.fn() }
  const pool = { getConnection: vi.fn(async () => connection) } as unknown as Pool
  return { connection, execute, requester: createMysqlInstrumentCollectionRequester(pool) }
}
it('persists one request and an ID-only outbox event before commit', async () => {
  const f = fixture()
  const result = await f.requester.request(input)
  expect(result.created).toBe(true)
  const inserts = f.execute.mock.calls.filter(([sql]) => sql.startsWith('INSERT'))
  expect(inserts).toHaveLength(2)
  expect(JSON.parse(inserts[1]![1]![3] as string)).toEqual({ request_id: result.requestId })
  expect(f.connection.commit).toHaveBeenCalledOnce()
})
it('returns a same-minute request without another outbox event', async () => {
  const f = fixture({ duplicate: true })
  expect(await f.requester.request(input)).toEqual({ requestId: 'existing-request', created: false })
  expect(f.execute.mock.calls.some(([sql]) => sql.startsWith('INSERT'))).toBe(false)
})
it('requires current ownership even for a duplicate', async () => {
  const f = fixture({ duplicate: true, revoked: true })
  await expect(f.requester.request(input)).rejects.toThrow('trading_account_forbidden')
  expect(f.connection.rollback).toHaveBeenCalledOnce()
  expect(f.connection.commit).not.toHaveBeenCalled()
})
it('rolls back the request when outbox persistence fails', async () => {
  const f = fixture({ outboxFailure: true })
  await expect(f.requester.request(input)).rejects.toThrow('outbox failed')
  expect(f.connection.rollback).toHaveBeenCalledOnce()
  expect(f.connection.commit).not.toHaveBeenCalled()
})
it('reports a lost commit acknowledgement without claiming rollback proved absence', async () => {
  await expect(fixture({ commitUnknown: true }).requester.request(input)).rejects.toThrow('instrument_request_commit_unknown')
})

it.each(['pending', 'running'])('reuses a %s request from a prior minute without queuing another collection', async status => {
  const f = fixture()
  const original = f.execute.getMockImplementation()!
  f.execute.mockImplementation(async (sql, values) => {
    if (sql.startsWith('SELECT id FROM instrument_collection')) {
      // Model an earlier-minute row: only the active-status branch may select it.
      const activeIncluded = sql.includes("status IN ('pending','running')")
      return [activeIncluded ? [{ id: 'older-active-request', status }] : []]
    }
    return original(sql, values)
  })
  expect(await f.requester.request(input)).toEqual({ requestId: 'older-active-request', created: false })
  expect(f.execute.mock.calls.filter(([sql]) => sql.startsWith('INSERT'))).toHaveLength(0)
  expect(f.connection.commit).toHaveBeenCalledOnce()
})
