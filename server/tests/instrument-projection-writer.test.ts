import { expect, it, vi } from 'vitest'
import type { Pool } from 'mysql2/promise'
import type { InstrumentProjectionWrite } from '../src/modules/trading/application/instrument-projection-writer.js'
import { writeInstrumentProjection } from '../src/modules/trading/infrastructure/mysql-trading-repository.js'

const input: InstrumentProjectionWrite = { route: { userId: 7, accountId: '11', terminalProfileId: 'profile-1', terminalInstanceId: 'terminal-1',
  connectionEpoch: 3, connectionId: 'connection-1', installationId: 'installation-1', credentialGeneration: 2, ownershipRevision: '4',
  brokerServer: 'Broker', login: '123' }, symbol: 'XAUUSD', observedAt: '2026-09-09T00:00:00.000Z', sourceRevision: 'source-1', expectedRevision: 0,
  raw: { symbol: 'XAUUSD', point: '0.01', tick_size: '0.01', tick_value: '1', volume_min: '0.01', volume_max: '10', volume_step: '0.01', trade_mode: 4 } }
function fixture(current: object[] = [], revoked = false, leaseChecks: boolean[] = []) {
  const execute = vi.fn(async (sql: string) => {
    if (sql.includes('FROM instrument_collection_requests_v4')) return [leaseChecks.shift() ? [{ id: 'request-1' }] : []]
    if (sql.includes('trading_account_ownership_intervals')) return [[{ interval_id: 'interval-1', ownership_revision: '4' }]]
    if (sql.includes('bridge_refresh_sessions')) return [revoked ? [] : [{ id: 'credential-1' }]]
    if (sql.startsWith('SELECT broker_server')) return [[{ broker_server: 'Broker', account_login: '123' }]]
    if (sql.startsWith('SELECT payload_json')) return [current]
    return [[{ id: '1' }]]
  })
  const connection = { execute, beginTransaction: vi.fn(), commit: vi.fn(), rollback: vi.fn(), release: vi.fn() }
  const pool = { getConnection: vi.fn(async () => connection) } as unknown as Pool
  return { pool, connection, execute }
}
it('validates current route before committing normalized facts and source evidence', async () => {
  const f = fixture()
  expect(await writeInstrumentProjection(f.pool, input)).toEqual({ applied: true, revision: 1 })
  const call = f.execute.mock.calls.find(([sql]) => sql.startsWith('INSERT INTO market_instrument'))
  expect(call).toBeDefined()
  expect(f.connection.commit).toHaveBeenCalledOnce()
  expect(f.connection.rollback).not.toHaveBeenCalled()
})
it('rolls back without writes when device authorization has been revoked', async () => {
  const f = fixture([], true)
  await expect(writeInstrumentProjection(f.pool, input)).rejects.toThrow('trading_context_invalid')
  expect(f.execute.mock.calls.some(([sql]) => sql.startsWith('INSERT'))).toBe(false)
  expect(f.connection.rollback).toHaveBeenCalledOnce()
})
it('rejects version conflicts and older observations without writing', async () => {
  for (const expectedRevision of [0, 2]) {
    const f = fixture([{ revision: 2, payload_json: {}, observed_at_utc: new Date('2026-09-09T00:00:01.000Z') }])
    await expect(writeInstrumentProjection(f.pool, { ...input, expectedRevision })).rejects.toThrow(
      expectedRevision === 0 ? 'revision_conflict' : 'instrument_projection_observation_stale')
    expect(f.execute.mock.calls.some(([sql]) => sql.startsWith('INSERT'))).toBe(false)
  }
})
it('rejects missing production proof before opening a transaction', async () => {
  const f = fixture()
  await expect(writeInstrumentProjection(f.pool, { ...input, route: { ...input.route, connectionId: '' } })).rejects.toThrow('instrument_projection_invalid')
  expect(f.connection.beginTransaction).not.toHaveBeenCalled()
})

it('rejects a lost collection lease before attempting a fact write', async () => {
  const f = fixture([], false, [false])
  await expect(writeInstrumentProjection(f.pool, { ...input, collectionLease: { requestId: 'request-1', leaseToken: 'old-token' } }))
    .rejects.toThrow('instrument_collection_lease_lost')
  expect(f.execute.mock.calls.some(([sql]) => sql.startsWith('INSERT'))).toBe(false)
  expect(f.connection.rollback).toHaveBeenCalledOnce()
})
it('rolls back a fact write when the lease expires while obtaining the instrument lock', async () => {
  const f = fixture([], false, [true, false])
  await expect(writeInstrumentProjection(f.pool, { ...input, collectionLease: { requestId: 'request-1', leaseToken: 'token-1' } }))
    .rejects.toThrow('instrument_collection_lease_lost')
  expect(f.execute.mock.calls.some(([sql]) => sql.startsWith('INSERT'))).toBe(true)
  expect(f.connection.commit).not.toHaveBeenCalled()
  expect(f.connection.rollback).toHaveBeenCalledOnce()
})
