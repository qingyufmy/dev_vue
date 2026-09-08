import { expect, it } from 'vitest'
import { Readable } from 'node:stream'
import { contextChangesHistoricalConnection } from '../scripts/lib/context-changes-historical-connection.mjs'
import { readAccountRootSnapshot } from '../scripts/lib/mysql-account-root-snapshot.mjs'

function fixture() {
  const called = []
  const column = table_name => ({ table_name, column_name: 'id', column_key: 'PRI', data_type: 'int', extra: '' })
  const connection = {
    async query(sql) {
      called.push(sql)
      if (sql.includes('FROM information_schema.COLUMNS')) return [[column('old_table'), column('unexpected_table'), column('trading_context_changes_v4')], []]
      if (sql.includes('FROM information_schema.TABLES')) return [[{ name: 'old_table', kind: 'BASE TABLE' }, { name: 'unexpected_table', kind: 'BASE TABLE' }, { name: 'trading_context_changes_v4', kind: 'BASE TABLE' }], []]
      if (sql.startsWith('SHOW CREATE TABLE')) return [[{ 'Create Table': sql.includes('old_table') ? 'CREATE TABLE old_table (id int PRIMARY KEY)' : 'CREATE TABLE unexpected_table (id int PRIMARY KEY)' }], []]
      return [[{ id: 'new-step-must-remain' }], []]
    },
    async execute(sql, values) { called.push(values); return this.query(sql) },
    connection: { query({ sql }) { called.push(sql); return { stream: () => Readable.from([[1], [2]]) } } },
  }
  return { wrapped: contextChangesHistoricalConnection(connection), called }
}

it('runs the actual historical snapshot reader while retaining unknown tables and all old rows', async () => {
  const f = fixture()
  const snapshot = await readAccountRootSnapshot(f.wrapped)
  expect(snapshot.tables.map(row => [row.name, row.rows])).toEqual([['old_table', 2], ['unexpected_table', 2]])
  expect(snapshot.tables.every(row => row.rowsSha256.length === 64)).toBe(true)
  expect(f.called.every(sql => typeof sql !== 'string' || !sql.includes('FROM `trading_context_changes_v4`'))).toBe(true)
})

it('filters only the known table in exact metadata listings and never filters the journal', async () => {
  const f = fixture()
  const [tables] = await f.wrapped.query('SELECT TABLE_NAME name,TABLE_TYPE kind FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE()')
  expect(tables.map(row => row.name)).toEqual(['old_table', 'unexpected_table'])
  expect(await f.wrapped.query('SELECT id FROM database_upgrade_steps_v4')).toEqual([[{ id: 'new-step-must-remain' }], []])
})

it('rejects writes, lock mutation, multiple statements and direct access to the separately checked table', async () => {
  const f = fixture()
  for (const sql of ['DELETE FROM old_table', 'RENAME TABLE old_table TO x', 'SELECT 1; DELETE FROM old_table',
    'SELECT GET_LOCK(?)', 'SELECT * FROM old_table FOR UPDATE', 'SHOW CREATE TABLE trading_context_changes_v4']) {
    await expect(f.wrapped.query(sql)).rejects.toThrow('context_history_query_not_allowed')
  }
  await expect(f.wrapped.execute('SELECT TABLE_TYPE type FROM information_schema.TABLES WHERE TABLE_NAME=?', ['trading_context_changes_v4'])).rejects.toThrow('context_history_query_not_allowed')
  expect(() => f.wrapped.connection.query({ sql: 'DELETE FROM old_table', rowsAsArray: true })).toThrow('context_history_query_not_allowed')
  expect(f.called).toHaveLength(0)
})
