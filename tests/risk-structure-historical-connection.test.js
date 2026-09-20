import test from 'node:test'
import assert from 'node:assert/strict'
import { riskStructureHistoricalConnection } from '../scripts/lib/risk-structure-historical-connection.mjs'

const query = 'SELECT TABLE_NAME name,TABLE_TYPE kind FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE()'
test('hides only seven named tables in the exact metadata query; unknown objects and history remain visible', async () => {
  const rows = [{ name: 'users' }, { name: 'risk_manual_releases' }, { name: 'unexpected_table' }]
  const journal = [{ id: 'inplace_043_01_risk_policy_sets_v4' }, { id: 'unexpected_step' }]
  const connection = { async query(sql) { return [sql === query ? rows : journal, []] } }
  const view = riskStructureHistoricalConnection(connection)
  assert.deepEqual((await view.query(query))[0], [{ name: 'users' }, { name: 'unexpected_table' }])
  assert.equal(rows.length, 3)
  assert.deepEqual((await view.query('SELECT id FROM database_upgrade_steps_v4'))[0], journal)
})
test('rejects writes, hidden-table access, executable comments and lock changes before sending SQL', async () => {
  let calls = 0
  const view = riskStructureHistoricalConnection({ async query() { calls++; return [[]] }, async execute() { calls++; return [[]] } })
  for (const sql of ['DELETE FROM users', 'SELECT * FROM RISK_MANUAL_RELEASES', "SELECT GET_LOCK('x',0)",
    'SELECT 1; SELECT 2', 'SELECT 1 /*!50000 INTO OUTFILE x */', 'SELECT id FROM users FOR UPDATE']) {
    await assert.rejects(view.query(sql), /not_allowed/)
  }
  await assert.rejects(view.execute('SELECT TABLE_NAME FROM information_schema.TABLES WHERE TABLE_NAME=?', ['risk_manual_releases']), /not_allowed/)
  assert.equal(calls, 0)
})
test('old row streams are forwarded without filtering and hidden streams are rejected', () => {
  const token = {}, connection = { connection: { query() { return token } } }
  const view = riskStructureHistoricalConnection(connection)
  assert.equal(view.connection.query({ sql: 'SELECT id FROM users', rowsAsArray: true }), token)
  assert.throws(() => view.connection.query({ sql: 'SELECT id FROM risk_policy_sets_v4', rowsAsArray: true }), /not_allowed/)
  assert.throws(() => view.connection.query({ sql: 'SELECT id FROM users', rowsAsArray: false }), /not_allowed/)
})
