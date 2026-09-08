import { createHash } from 'node:crypto'
import type { Pool } from 'mysql2/promise'
import { expect, it, vi } from 'vitest'

const sample = vi.hoisted(() => ({ ddl: 'CREATE TABLE `accounts` (\n  `id` bigint NOT NULL AUTO_INCREMENT,\n  PRIMARY KEY (`id`)\n) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4' }))
vi.mock('../src/modules/trading/infrastructure/inplace-account-schema.js', () => ({
  inplaceAccountSchema: { steps: [{ id: 'required', checksum: 'checksum' }],
    tables: ['accounts', 'users'].map(table => ({ table, schemaSha256: createHash('sha256').update(sample.ddl).digest('hex') })) },
}))
import { assertMysqlTradingSchemaReady } from '../src/modules/trading/infrastructure/mysql-schema-readiness.js'

function fixture() {
  const state = { timezone: '+00:00', acquired: 1, released: 1, ddl: sample.ddl,
    history: [{ id: 'required', checksum: 'checksum', status: 'completed' }], triggers: [] as { tableName: string }[],
    registry: [{ revision: '0' }] as { revision: unknown }[] }
  const connection = {
    query: vi.fn(async (sql: string) => {
      if (sql.startsWith('SELECT DATABASE')) return [[{ db: 'dev_vue', timezone: state.timezone }]]
      if (sql.startsWith('SELECT id,')) return [state.history]
      if (sql.startsWith('SHOW CREATE')) return [[{ 'Create Table': state.ddl }]]
      if (sql.includes('information_schema.TRIGGERS')) return [state.triggers]
      if (sql.includes('FROM observer_management_registry')) return [state.registry]
      throw Error('unexpected_sql')
    }),
    execute: vi.fn(async (sql: string) => sql.includes('GET_LOCK') ? [[{ acquired: state.acquired }]] : [[{ released: state.released }]]),
    release: vi.fn(), destroy: vi.fn(),
  }
  const pool = { getConnection: vi.fn(async () => connection) }
  return { state, connection, pool, run: () => assertMysqlTradingSchemaReady(pool as unknown as Pool) }
}

it('accepts compatible metadata and requires the bounded management singleton without writing data', async () => {
  const f = fixture()
  f.state.history.push({ id: 'later', checksum: 'later', status: 'completed' })
  f.state.ddl = sample.ddl.replace(' DEFAULT CHARSET', ' AUTO_INCREMENT=999 DEFAULT CHARSET')
  await f.run()
  expect(f.connection.release).toHaveBeenCalledOnce()
  expect(f.connection.destroy).not.toHaveBeenCalled()
  expect(f.connection.query.mock.calls.every(([sql]) => /^(SELECT (DATABASE|id,|EVENT_OBJECT_TABLE|CAST)|SHOW CREATE)/.test(sql))).toBe(true)
})

it.each([[], [{ revision: '-1' }], [{ revision: '01' }], [{ revision: 0 }], [{ revision: '9007199254740991' }]].map(registry => ({ registry })))('rejects missing or unusable observer coordination state $registry', async ({ registry }) => {
  const f = fixture(); f.state.registry = registry
  await expect(f.run()).rejects.toThrow(/^trading_schema_not_ready$/)
  expect(f.connection.release).toHaveBeenCalledOnce()
})

it('preserves a nonzero management revision and only checks readiness', async () => {
  const f = fixture(); f.state.registry = [{ revision: '42' }]
  await f.run()
  expect(f.connection.query.mock.calls.every(([sql]) => !/INSERT|UPDATE|DELETE/.test(sql))).toBe(true)
})

it.each(['missing', 'checksum', 'unfinished', 'duplicate', 'budget'])('rejects invalid migration history: %s', async issue => {
  const f = fixture()
  if (issue === 'missing') f.state.history = []
  if (issue === 'checksum') f.state.history[0]!.checksum = 'changed'
  if (issue === 'unfinished') f.state.history.push({ id: 'later', checksum: 'later', status: 'started' })
  if (issue === 'duplicate') f.state.history.push({ ...f.state.history[0]! })
  if (issue === 'budget') f.state.history = Array.from({ length: 1001 }, (_, n) => ({ id: String(n), checksum: 'x', status: 'completed' }))
  await expect(f.run()).rejects.toThrow('trading_schema_not_ready')
  expect(f.connection.release).toHaveBeenCalledOnce()
  expect(f.connection.execute).toHaveBeenLastCalledWith('SELECT RELEASE_LOCK(?) released', ['aurum:inplace:dev_vue'])
})

it.each(['timezone', 'schema', 'trigger', 'driver'])('fails closed without disclosing driver details: %s', async issue => {
  const f = fixture()
  if (issue === 'timezone') f.state.timezone = 'SYSTEM'
  if (issue === 'schema') f.state.ddl = sample.ddl.replace('bigint', 'int')
  if (issue === 'trigger') f.state.triggers.push({ tableName: 'accounts' })
  if (issue === 'driver') f.connection.query.mockRejectedValueOnce(Error('private database connection detail'))
  await expect(f.run()).rejects.toThrow(/^trading_schema_not_ready$/)
  expect(f.connection.release).toHaveBeenCalledOnce()
})

it('does not release another connection upgrade lock when acquisition is refused', async () => {
  const f = fixture(); f.state.acquired = 0
  await expect(f.run()).rejects.toThrow('trading_schema_not_ready')
  expect(f.connection.execute).toHaveBeenCalledTimes(1)
  expect(f.connection.query).toHaveBeenCalledTimes(1)
})

it('destroys the connection and fails readiness when release cannot be confirmed', async () => {
  const f = fixture(); f.state.released = 0
  await expect(f.run()).rejects.toThrow('trading_schema_not_ready')
  expect(f.connection.destroy).toHaveBeenCalledOnce()
  expect(f.connection.release).not.toHaveBeenCalled()
})

it('sanitizes failure to obtain a connection', async () => {
  const f = fixture(); f.pool.getConnection.mockRejectedValueOnce(Error('secret'))
  await expect(f.run()).rejects.toThrow(/^trading_schema_not_ready$/)
})

it('delegates users to the owner under the same upgrade lock, retaining other table and trigger checks', async () => {
  const f = fixture()
  const owner = vi.fn(async (connection: unknown) => {
    expect(connection).toBe(f.connection)
    expect(f.connection.execute).toHaveBeenLastCalledWith('SELECT GET_LOCK(?,0) acquired', ['aurum:inplace:dev_vue'])
  })
  await assertMysqlTradingSchemaReady(f.pool as unknown as Pool, owner)
  expect(owner).toHaveBeenCalledOnce()
  expect(f.connection.query.mock.calls.filter(([sql]) => sql.startsWith('SHOW CREATE'))).toEqual([['SHOW CREATE TABLE `accounts`']])
  f.state.triggers.push({ tableName: 'users' })
  await expect(assertMysqlTradingSchemaReady(f.pool as unknown as Pool, owner)).rejects.toThrow('trading_schema_not_ready')
})

it('does not fall back to full-table acceptance after an owner check fails', async () => {
  const f = fixture(), owner = vi.fn(async () => { throw Error('secret') })
  await expect(assertMysqlTradingSchemaReady(f.pool as unknown as Pool, owner)).rejects.toThrow(/^trading_schema_not_ready$/)
  expect(f.connection.release).toHaveBeenCalledOnce()
  expect(f.connection.execute).toHaveBeenLastCalledWith('SELECT RELEASE_LOCK(?) released', ['aurum:inplace:dev_vue'])
})
